/* 3S Compilator : worker Python (Pyodide = CPython compilé en WebAssembly). Protocole : voir shared.js. */
importScripts('shared.js');

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';

// Exécuteur écrit en Python : capture print/input, traceback filtré et trace ligne par ligne.
const RUNNER = String.raw`
import sys, builtins, traceback, json, linecache

FILE = 'main.py'

def _3s_run(src, read_line, trace, emit, max_steps):
    out_len = 0
    steps = []

    class Out:
        def __init__(self, stream): self.stream = stream
        def write(self, s):
            nonlocal out_len
            out_len += len(s)
            emit(s, self.stream)
            return len(s)
        def flush(self): pass

    # input() : la question s'affiche, puis le programme attend la ligne tapée dans la console.
    def _input(prompt=''):
        nonlocal out_len
        if prompt:
            sys.stdout.write(str(prompt))
        value = read_line()
        if value is None:
            raise EOFError('input() : aucune valeur saisie.')
        out_len += len(value) + 1  # la saisie apparaît dans la console
        return value

    class In:
        def readline(self, size=-1):
            value = _input()
            return value + '\n'
        def read(self, size=-1):
            return self.readline()
        def __iter__(self):
            return self
        def __next__(self):
            try:
                return self.readline()
            except EOFError:
                raise StopIteration

    def short(v):
        try:
            r = repr(v)
        except Exception:
            r = '<?>'
        return r if len(r) <= 200 else r[:197] + '...'

    def snapshot(frame):
        scopes = []
        f = frame
        while f is not None and f.f_code.co_filename == FILE:
            is_module = f.f_code.co_name == '<module>'
            names = f.f_globals if is_module else f.f_locals
            vs = {}
            for k, v in list(names.items()):
                if k.startswith('__') or type(v).__name__ in ('module', 'function', 'type', 'builtin_function_or_method'):
                    continue
                vs[k] = short(v)
            scopes.append({'name': 'global' if is_module else f.f_code.co_name + '()', 'vars': vs})
            f = f.f_back
        return [s for s in scopes if s['vars']]

    class StepLimit(BaseException):
        pass

    final = {'scopes': None}

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != FILE:
            return None
        if event == 'line':
            if len(steps) >= max_steps:
                raise StepLimit()
            steps.append({'line': frame.f_lineno, 'scopes': snapshot(frame), 'out': out_len})
        elif event == 'return' and frame.f_code.co_name == '<module>':
            final['scopes'] = snapshot(frame)
        return tracer

    linecache.cache[FILE] = (len(src), None, src.splitlines(True), FILE)  # lignes de code dans le traceback
    env = {'__name__': '__main__', '__builtins__': builtins}
    saved = sys.stdout, sys.stderr, sys.stdin, builtins.input
    sys.stdout, sys.stderr, sys.stdin, builtins.input = Out('out'), Out('err'), In(), _input
    error = None
    truncated = False
    try:
        code = compile(src, FILE, 'exec')
        if trace:
            sys.settrace(tracer)
        exec(code, env)
    except StepLimit:
        truncated = True
    except BaseException as e:
        tb = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == FILE]
        line = col = None
        length = 1
        if isinstance(e, SyntaxError) and e.filename == FILE:
            line, col, message = e.lineno, e.offset, e.msg
            if e.end_offset and e.end_lineno == e.lineno and e.end_offset > (col or 0):
                length = e.end_offset - col
        else:
            message = str(e)
            if tb:
                last = tb[-1]
                line = last.lineno
                if last.colno is not None:
                    col = last.colno + 1
                    if last.end_colno and last.end_lineno == last.lineno:
                        length = max(1, last.end_colno - last.colno)
        error = {
            'type': type(e).__name__, 'message': message, 'line': line, 'column': col, 'length': length,
            'stack': [f'File "{FILE}", line {f.lineno}, in {f.name}' for f in tb],
            'stackTitle': 'Traceback (most recent call last):' if tb else None,
        }
    finally:
        sys.settrace(None)
        sys.stdout, sys.stderr, sys.stdin, builtins.input = saved
    if trace:
        last = steps[-1]['scopes'] if steps else []
        steps.append({'line': error['line'] if error else None, 'scopes': final['scopes'] if final['scopes'] is not None and not error else last, 'out': out_len, 'final': True})
    return json.dumps({'error': error, 'steps': steps if trace else None, 'truncated': truncated})
`;

let ready = null;

function loadEngine() {
  if (!ready) {
    ready = (async () => {
      self.postMessage({ type: 'status', text: 'Chargement de Python… (seulement la première fois, ensuite il est gardé en cache)' });
      importScripts(PYODIDE_URL + 'pyodide.js');
      const pyodide = await self.loadPyodide({ indexURL: PYODIDE_URL });
      pyodide.runPython(RUNNER);
      return pyodide;
    })();
    ready.catch(() => { ready = null; }); // permet de réessayer si le réseau revient
  }
  return ready;
}

loadEngine().catch(() => {}); // préchargement dès que l'onglet Python est ouvert

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'run') return;
  let pyodide;
  try {
    pyodide = await loadEngine();
  } catch (e) {
    const detail = e && e.message ? ` (${e.message})` : '';
    self.postMessage({ type: 'end', error: { message: `Impossible de charger Python : vérifiez la connexion internet (nécessaire au premier lancement)${detail}.`, line: null }, output: '' });
    return;
  }

  const out = self.ThreeS.createOutput();
  const readLine = self.ThreeS.createInput(data.input, out);
  const run = pyodide.globals.get('_3s_run');
  self.postMessage({ type: 'start' });
  let result;
  try {
    result = JSON.parse(run(data.code, readLine, data.trace, (text, stream) => out.write(text, stream), self.ThreeS.TRACE_LIMIT));
  } finally {
    run.destroy();
  }
  out.flush();
  self.postMessage({ type: 'end', error: result.error, output: out.text, steps: result.steps, truncated: result.truncated });
};
