// Construit vendor/jscpp-2.0.9.min.js (interpréteur C/C++) pour le navigateur.
// JSCPP lit toute l'entrée au démarrage ; on la rend « paresseuse » pour une console interactive :
// cin et scanf demandent une nouvelle ligne (stdio.drain) seulement quand il n'y a plus rien à lire.
// Usage : node scripts/build-jscpp.mjs
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'module';

var require = createRequire(import.meta.url);
var module = { exports: {} };

const PATCHES = {
  'includes/iostream.js': [
    ['buf: stdio.drain(),',
      `_buf: '',
                get buf() {
                    if (/^\\s*$/.test(this._buf)) { const more = stdio.drain(); if (more != null) this._buf += more; }
                    return this._buf;
                },
                set buf(v) { this._buf = v; },`],
  ],
  'includes/cstdio.js': [
    ['let input_stream = stdio.drain();',
      `let input_stream = '';
        const _refill = function () {
            if (/^\\s*$/.test(input_stream)) { const more = stdio.drain(); if (more != null) input_stream += more; }
        };`],
    ['const _consume_next_char = function () {', 'const _consume_next_char = function () {\n            _refill();'],
    ['const _consume_next_line = function () {', 'const _consume_next_line = function () {\n            _refill();'],
    ['const _scanf = function (rt, _this, pchar, ...args) {', 'const _scanf = function (rt, _this, pchar, ...args) {\n            _refill();'],
  ],
};

// Modules Node utilisés seulement dans des cas jamais atteints dans le navigateur.
const stubs = {
  stream: 'module.exports = { Stream: function Stream() {} };',
  util: 'module.exports = { inspect: (o) => { try { return JSON.stringify(o); } catch (e) { return String(o); } } };',
};

const patchPlugin = {
  name: 'jscpp-lazy-input',
  setup(b) {
    b.onResolve({ filter: /^(stream|util)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
    b.onLoad({ filter: /JSCPP[\\/]lib[\\/]includes[\\/](iostream|cstdio)\.js$/ }, async (a) => {
      let src = await readFile(a.path, 'utf8');
      const key = Object.keys(PATCHES).find((k) => a.path.replace(/\\/g, '/').endsWith(k));
      for (const [from, to] of PATCHES[key]) {
        if (!src.includes(from)) throw new Error(`Patch introuvable dans ${key} : ${from}`);
        src = src.replace(from, to);
      }
      return { contents: src, loader: 'js' };
    });
  },
};

await build({
  stdin: { contents: "self.JSCPP = require('JSCPP');", resolveDir: process.cwd() },
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2018',
  outfile: 'vendor/jscpp-2.0.9.min.js',
  plugins: [patchPlugin],
  logLevel: 'info',
});
