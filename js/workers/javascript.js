/* 3S Compilator : worker JavaScript. Protocole : voir shared.js. */
importScripts('shared.js', '../../vendor/acorn-8.15.0.min.js', '../engines/js-instrument.js');

const { createOutput, createTrace, createInput, inspect } = self.ThreeS;
const AsyncFunction = (async () => {}).constructor;
const native = {
  setTimeout: self.setTimeout.bind(self),
  clearTimeout: self.clearTimeout.bind(self),
  setInterval: self.setInterval.bind(self),
  clearInterval: self.clearInterval.bind(self),
};

// Le code est placé dans une fonction créée par AsyncFunction : son corps commence à la ligne 3.
const BODY_LINE_OFFSET = 2;

class StepLimit extends Error {}

// Erreur structurée façon console : type, message, ligne/colonne et pile limitée au code de l'élève.
const FRAME = /(?:<anonymous>|AsyncFunction|Function):(\d+):(\d+)/;

function toError(err, traceLine) {
  const isError = err && typeof err === 'object' && 'message' in err && 'name' in err;
  const error = isError
    ? { type: err.name, message: err.message }
    : { type: 'Uncaught', message: inspect(err, true) };
  const stack = [];
  for (const raw of String((isError && err.stack) || '').split('\n').slice(1)) {
    const m = FRAME.exec(raw);
    if (!m) continue;
    const line = Number(m[1]) - BODY_LINE_OFFSET;
    const col = Number(m[2]);
    const fn = (/^\s*at\s+(?:async\s+)?([\w$.<>]+)\s+\(/.exec(raw) || [])[1];
    const name = fn && !/^(eval|anonymous)$/.test(fn) ? fn : null;
    if (error.line === undefined) { error.line = line; error.column = col; }
    stack.push(name ? `at ${name} (main.js:${line}:${col})` : `at main.js:${line}:${col}`);
  }
  if (traceLine) { error.line = traceLine; error.column = null; error.stack = null; return error; }
  if (error.line === undefined) { error.line = null; error.column = null; }
  error.stack = stack;
  return error;
}

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'run') return;
  const { code, trace } = data;
  const out = createOutput();
  const readLine = createInput(data.input, out);
  const steps = trace ? createTrace() : null;
  let error = null;
  let lastLine = null;
  let finished = false;
  let endScopes = null;

  // ---- Vérification de la syntaxe avec un message clair et un numéro de ligne
  try {
    self.JsInstrument.parse(code);
  } catch (e) {
    const error = {
      type: 'SyntaxError',
      message: e.message.replace(/\s*\(\d+:\d+\)$/, ''),
      line: e.loc ? e.loc.line : null,
      column: e.loc ? e.loc.column + 1 : null,
      length: Math.max(1, (e.raisedAt || 0) - (e.pos || 0)),
    };
    self.postMessage({ type: 'end', error, output: '', steps: null });
    return;
  }

  // ---- Environnement fourni au code de l'élève
  const write = (stream) => (...args) => out.write(args.map((a) => inspect(a)).join(' ') + '\n', stream);
  self.console = {
    log: write('out'), info: write('out'), debug: write('out'),
    warn: write('err'), error: write('err'),
    table: (v) => out.write(inspect(v) + '\n'),
    clear() {},
  };
  // prompt() affiche la question dans la console et attend la réponse tapée par l'élève.
  self.prompt = (message = '') => {
    if (message) out.write(String(message) + (/\s$/.test(message) ? '' : ' '));
    return readLine();
  };

  // Minuteries suivies : l'exécution se termine quand plus aucune n'est en attente.
  const timers = new Set();
  let onIdle = null;
  const checkIdle = () => {
    if (timers.size === 0 && onIdle) native.setTimeout(() => { if (timers.size === 0 && onIdle) onIdle(); }, 0);
  };
  const fail = (err) => {
    if (finished || error) return;
    if (err instanceof StepLimit) { if (onIdle) onIdle(); return; }
    error = toError(err, trace ? lastLine : null);
    if (onIdle) onIdle();
  };
  const guard = (cb) => function (...args) {
    try {
      const r = cb.apply(this, args);
      if (r && typeof r.then === 'function') r.then(null, fail);
    } catch (e) { fail(e); }
  };
  self.setTimeout = (cb, ms, ...args) => {
    const id = native.setTimeout(() => { timers.delete(id); guard(cb)(...args); checkIdle(); }, ms);
    timers.add(id);
    return id;
  };
  self.setInterval = (cb, ms, ...args) => {
    const id = native.setInterval(() => guard(cb)(...args), ms);
    timers.add(id);
    return id;
  };
  self.clearTimeout = self.clearInterval = (id) => {
    native.clearTimeout(id);
    native.clearInterval(id);
    timers.delete(id);
    checkIdle();
  };
  self.onunhandledrejection = (e) => { e.preventDefault(); fail(e.reason); };

  // ---- Pas à pas : photographie des variables visibles
  const __3s = {
    s(line, getScopes) {
      if (line === 0) { endScopes = collect(getScopes); return; }
      lastLine = line;
      if (!steps.push(line, collect(getScopes), out.length)) throw new StepLimit();
    },
  };
  function collect(getScopes) {
    return getScopes().map(([name, getters]) => {
      const vars = {};
      for (const key of Object.keys(getters)) {
        try {
          const v = getters[key]();
          if (typeof v !== 'function') vars[key] = inspect(v, true);
        } catch (e) { /* variable pas encore déclarée (let/const) */ }
      }
      return { name, vars };
    }).filter((s) => Object.keys(s.vars).length);
  }

  let source = code;
  if (trace) source = self.JsInstrument.instrument(code);

  self.postMessage({ type: 'start' });
  try {
    await new AsyncFunction('__3s', source)(__3s);
  } catch (e) {
    fail(e);
  }
  if (!error && timers.size) await new Promise((resolve) => { onIdle = resolve; checkIdle(); });
  finished = true;
  for (const id of timers) { native.clearTimeout(id); native.clearInterval(id); }
  out.flush();

  if (steps) {
    const last = steps.steps[steps.steps.length - 1];
    const scopes = !error && endScopes && endScopes.length ? endScopes : (last ? last.scopes : []);
    steps.finish(error ? error.line : null, scopes, out.length);
  }
  self.postMessage({ type: 'end', error, output: out.text, steps: steps && steps.steps, truncated: steps ? steps.full : false });
};
