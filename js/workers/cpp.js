/* 3S Compilator : worker C / C++ (interpréteur JSCPP). Protocole : voir shared.js. */
importScripts('shared.js', '../../vendor/jscpp-2.0.9.min.js');

const LIBRARIES = 'iostream, iomanip, cmath, cstdio (stdio.h), cstdlib, cstring, cctype, ctime';
const MAX_RAW_STEPS = 3_000_000;
const HIDDEN = new Set(['cin', 'cout', 'cerr', 'endl']);

// Messages de JSCPP traduits en erreurs structurées (type, message, ligne, colonne).
function translate(raw) {
  let message = raw.replace(/^ERROR:\s*/, '');
  let line = null;
  let column = null;
  let m;
  if ((m = /^Parsing Failure:\s*\nline (\d+) \(column (\d+)\)/.exec(message))) {
    const found = /but (".*?"|end of input) found/.exec(message);
    message = (found ? `${found[1]} inattendu` : 'syntaxe invalide')
      + (/";"/.test(raw) ? ' (il manque peut-être un « ; » à la fin de la ligne précédente)' : '');
    return { type: 'error', message, line: Number(m[1]), column: Number(m[2]) };
  }
  if ((m = /^(\d+):(\d+)\s+([\s\S]*)$/.exec(message))) {
    line = Number(m[1]);
    column = Number(m[2]);
    message = m[3];
  }
  if ((m = /cannot find library: (\S+)/.exec(message))) {
    message = `bibliothèque <${m[1]}> non disponible dans ce compilateur pédagogique (disponibles : ${LIBRARIES})`;
  } else if ((m = /variable (\S+) does not exist/.exec(message))) {
    message = `« ${m[1]} » n'est pas déclarée`;
  } else if (/overflow of Infinity/.test(message)) {
    message = 'division par zéro (ou nombre trop grand)';
  } else if (/overflow of NaN/.test(message)) {
    message = 'valeur invalide : l\'entrée (STDIN) est peut-être vide ou ne contient pas un nombre';
  }
  return { type: 'error', message, line, column };
}

function variables(debug) {
  const vars = {};
  for (const v of debug.variable()) {
    if (!v.type || HIDDEN.has(v.name) || /stream$/.test(v.type) || v.name in vars) continue;
    vars[v.name] = String(v.value);
  }
  return Object.keys(vars).length ? [{ name: 'variables', vars }] : [];
}

self.onmessage = ({ data }) => {
  if (data.cmd !== 'run') return;
  const out = self.ThreeS.createOutput();
  const readLine = self.ThreeS.createInput(data.input, out);
  // drain() est appelé par cin et scanf quand ils ont besoin d'une nouvelle ligne.
  const drain = () => { const line = readLine(); return line === null ? null : line + '\n'; };
  const config = { stdio: { write: (s) => out.write(s), drain }, unsigned_overflow: 'error' };
  let error = null;
  let steps = null;
  self.postMessage({ type: 'start' });

  if (!data.trace) {
    try {
      const code = self.JSCPP.run(data.code, '', config);
      if (code !== 0) out.write(`\n[Programme terminé avec le code ${code}]\n`, 'err');
    } catch (e) {
      error = translate(e.message || String(e));
    }
  } else {
    const trace = self.ThreeS.createTrace();
    steps = trace;
    let lastLine = null;
    let scopes = [];
    try {
      const debug = self.JSCPP.run(data.code, '', { ...config, debug: true });
      for (let n = 0; ; n++) {
        if (n > MAX_RAW_STEPS) { trace.full = true; break; }
        const node = debug.nextNode();
        lastLine = node && node.sLine ? node.sLine : lastLine;
        scopes = variables(debug);
        if (lastLine !== null && !trace.push(lastLine, scopes, out.length)) break;
        if (debug.next() !== false) break;
      }
    } catch (e) {
      error = translate(e.message || String(e));
      if (error.line == null) error.line = lastLine;
    }
    trace.finish(error ? error.line : null, scopes, out.length);
  }

  out.flush();
  self.postMessage({
    type: 'end', error, output: out.text,
    steps: steps && steps.steps, truncated: steps ? steps.full : false,
  });
};
