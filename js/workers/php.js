/* 3S Compilator : worker PHP (php-wasm, chargé comme module ES). Protocole : voir shared.js. */
import './shared.js';

const PHP_URL = 'https://cdn.jsdelivr.net/npm/php-wasm@0.2.0/PhpWeb.mjs';

// Le build « web » de php-wasm lit document et window au démarrage (API d'événements DOM
// jamais utilisées ici) : dans un worker, de simples remplaçants suffisent.
self.document = self.document || { querySelector: () => null };
self.window = self.window || self;
const FILE = 'main.php';
const { createOutput, TRACE_LIMIT } = self.ThreeS;

// Constantes absentes du SAPI « embed » de php-wasm (fgets(STDIN) doit fonctionner).
const PRELUDE_RUN = "foreach (['STDIN' => 'php://stdin', 'STDOUT' => 'php://stdout', 'STDERR' => 'php://stderr'] as $__3s_k => $__3s_f) { if (!defined($__3s_k)) define($__3s_k, fopen($__3s_f, $__3s_k === 'STDIN' ? 'r' : 'w')); } unset($__3s_k, $__3s_f);";

// Pas à pas : declare(ticks=1) appelle notre fonction après chaque instruction ; elle écrit
// sur stderr la ligne, les variables et la longueur de la sortie (comptée par ob_start).
// Les fonctions sont définies AVANT declare(ticks) pour ne pas être elles-mêmes tracées.
const PRELUDE_TRACE = PRELUDE_RUN + ` $GLOBALS['__3s_n'] = 0; $GLOBALS['__3s_c'] = 0; $GLOBALS['__3s_e'] = fopen('php://stderr', 'w');`
  + ` ob_start(function ($b) { $GLOBALS['__3s_n'] += strlen($b); return $b; }, 1);`
  + ` register_tick_function(function () {`
  + ` if (++$GLOBALS['__3s_c'] > ${TRACE_LIMIT}) { fwrite($GLOBALS['__3s_e'], "\\x02\\n"); exit; }`
  + ` $show = fn($x) => is_scalar($x) || $x === null ? var_export($x, true) : (is_array($x) ? json_encode($x, JSON_PARTIAL_OUTPUT_ON_ERROR) : get_debug_type($x));`
  + ` $bt = debug_backtrace(); $f = $bt[1] ?? null; $v = []; $a = null;`
  + ` foreach ($GLOBALS as $k => $x) { if ($k !== 'GLOBALS' && !str_starts_with($k, '__3s') && !preg_match('/^_[A-Z]+$/', $k) && $k !== 'argv' && $k !== 'argc') $v[$k] = $show($x); }`
  + ` if ($f && isset($f['function']) && function_exists($f['function'])) { $a = []; $p = (new ReflectionFunction($f['function']))->getParameters();`
  + ` foreach ($f['args'] ?? [] as $i => $x) $a[isset($p[$i]) ? '$' . $p[$i]->getName() : '#' . $i] = $show($x); }`
  + ` fwrite($GLOBALS['__3s_e'], "\\x01" . json_encode(['l' => $bt[0]['line'] ?? 0, 'v' => $v, 'o' => $GLOBALS['__3s_n'], 'f' => $f['function'] ?? null, 'a' => $a], JSON_PARTIAL_OUTPUT_ON_ERROR) . "\\n"); });`
  + ' declare(ticks=1);';

const ERROR_LINE = /^\n?(?:PHP )?(Fatal error|Parse error|Warning|Notice|Deprecated): /m;

let modulePromise = null;
let spare = null; // instance préchargée : chaque exécution repart d'un PHP neuf

function loadModule() {
  if (!modulePromise) {
    self.postMessage({ type: 'status', text: 'Chargement de PHP… (environ 12 Mo la première fois, ensuite gardé en cache)' });
    modulePromise = import(PHP_URL).then((m) => m.PhpWeb);
    modulePromise.catch(() => { modulePromise = null; });
  }
  return modulePromise;
}

// Lecture de STDIN octet par octet par PHP : quand il n'y a plus rien, on demande
// une ligne à l'élève (fgets(STDIN) attend la saisie dans la console).
let readLine = null;
let current = null;
let pendingBytes = [];
let lineDelivered = false;
const encoder = new TextEncoder();

function stdinByte() {
  if (!pendingBytes.length) {
    // Fin de ligne livrée : on termine cette lecture ; la suivante redemandera une ligne.
    if (lineDelivered) { lineDelivered = false; return null; }
    if (!readLine) return null;
    current.flush(); // affiche la question avant d'attendre la réponse
    const line = readLine();
    if (line === null) return null;
    pendingBytes = [...encoder.encode(line + '\n')];
  }
  const byte = pendingBytes.shift();
  if (!pendingBytes.length) lineDelivered = true;
  return byte;
}

function prepare() {
  spare = loadModule().then((PhpWeb) => {
    const php = new PhpWeb({ stdin: stdinByte });
    return php.binary.then(() => php);
  });
  spare.catch(() => { spare = null; });
}

async function take() {
  if (!spare) prepare();
  const next = spare;
  spare = null;
  try {
    return await next;
  } catch (e) {
    throw new Error('Impossible de charger PHP : vérifiez la connexion internet (nécessaire au premier lancement).');
  } finally {
    prepare(); // prépare l'instance suivante en arrière-plan
  }
}

prepare();

// Insère le prélude sur la même ligne que « <?php » pour garder les numéros de ligne.
function withPrelude(code, prelude) {
  const i = code.indexOf('<?php');
  if (i === -1) return `<?php ${prelude} ?>` + code;
  return code.slice(0, i + 5) + ' ' + prelude + code.slice(i + 5);
}

// « Fatal error: Uncaught X: msg in main.php:13 Stack trace: #0 … » -> erreur structurée.
function parseFatal(text) {
  const m = /(Fatal error|Parse error): ([\s\S]*?) in main\.php(?: on line |:)(\d+)/.exec(text);
  if (!m) return { type: 'Fatal error', message: text.trim(), line: null };
  let type = m[1];
  let message = m[2].trim();
  const uncaught = /^Uncaught (\w+): ([\s\S]*)$/.exec(message);
  if (uncaught) { type = uncaught[1]; message = uncaught[2]; }
  const stack = (/Stack trace:\n([\s\S]*?)\n\s*thrown/.exec(text) || [, ''])[1]
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '#0 {main}' && !/\{main\}$/.test(l));
  return { type, message, line: Number(m[3]), column: null, stack };
}

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'run') return;
  let php;
  try {
    php = await take();
  } catch (e) {
    self.postMessage({ type: 'end', error: { message: e.message, line: null }, output: '' });
    return;
  }

  const out = createOutput(!data.trace);
  const clean = (s) => s.split('php-wasm run script').join(FILE);
  let stderr = '';
  let fatal = null; // texte de l'erreur fatale, affiché à part (comme une vraie console)
  let phpBytes = 0; // octets écrits par PHP (sans les saisies de l'élève)
  let phpText = '';
  const inputs = []; // { at: octets PHP au moment de la saisie, chars: longueur affichée }
  php.addEventListener('output', (e) => {
    const raw = e.detail.join('');
    phpBytes += encoder.encode(raw).length;
    phpText += raw;
    const text = clean(raw);
    if (fatal !== null) { fatal += text; return; }
    const m = ERROR_LINE.exec(text);
    if (m && /Fatal|Parse/.test(m[1])) {
      out.write(text.slice(0, m.index), 'out');
      fatal = text.slice(m.index);
      return;
    }
    out.write(text, m ? 'err' : 'out');
  });
  php.addEventListener('error', (e) => { stderr += e.detail.join(''); });

  const ask = self.ThreeS.createInput(data.input, out);
  current = php;
  pendingBytes = [];
  lineDelivered = false;
  readLine = () => {
    const line = ask();
    if (line !== null) inputs.push({ at: phpBytes, chars: line.length + 1 });
    return line;
  };
  self.postMessage({ type: 'start' });
  try {
    await php.run(withPrelude(data.code, data.trace ? PRELUDE_TRACE : PRELUDE_RUN));
  } catch (e) {
    out.write(String(e.message || e), 'err');
  }
  php.flush();
  out.flush();
  readLine = null;

  const output = out.text;
  const error = fatal !== null ? parseFatal(fatal) : null;
  let steps = null;
  let truncated = false;

  if (data.trace) {
    truncated = stderr.includes('\x02');
    const records = [];
    for (const chunk of stderr.split('\x01').slice(1)) {
      try { records.push(JSON.parse(chunk)); } catch (e) { /* enregistrement illisible : ignoré */ }
    }
    records.shift(); // le tout premier tick correspond à declare(ticks=1) lui-même

    // PHP compte sa sortie en octets, sans les saisies de l'élève : conversion en position
    // dans le texte affiché (caractères, saisies comprises).
    const phpOnly = encoder.encode(phpText);
    const decoder = new TextDecoder();
    const chars = (n) => {
      let extra = 0;
      for (const i of inputs) if (i.at <= n) extra += i.chars;
      return Math.min(output.length, decoder.decode(phpOnly.slice(0, n)).length + extra);
    };
    const scopesOf = (r) => {
      const s = [];
      if (r.f && r.a && Object.keys(r.a).length) s.push({ name: r.f + '()', vars: r.a });
      if (r.v && Object.keys(r.v).length) s.push({ name: 'global', vars: r.v });
      return s;
    };

    // Un tick est émis APRÈS une instruction : l'étape k (ligne à exécuter) prend l'état du tick k-1.
    steps = records.map((r, k) => {
      const prev = records[k - 1];
      return { line: r.l, scopes: prev ? scopesOf(prev) : [], out: prev ? chars(prev.o) : 0 };
    });
    const last = records[records.length - 1];
    steps.push({ line: error ? error.line : null, scopes: last ? scopesOf(last) : [], out: output.length, final: true });
  }

  self.postMessage({ type: 'end', error, output, steps, truncated });
};
