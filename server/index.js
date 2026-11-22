'use strict';
// Serveur local (développement ou serveur de l'école) : fichiers du site + API.
// Lancement : npm start  (port 8080 par défaut, variable PORT pour changer)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Charge .env (format CLE=valeur) sans dépendance.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv(path.join(ROOT, '.env'));

const { createHandler } = require('./api');
const api = createHandler(process.env);

// Seuls ces fichiers et dossiers sont publics (jamais server/, data/, .env, node_modules/).
const PUBLIC = new Set(['index.html', 'admin.html', 'sw.js', 'manifest.webmanifest']);
const PUBLIC_DIRS = new Set(['css', 'js', 'assets', 'vendor']);
// Page « isolée » : nécessaire à SharedArrayBuffer, utilisé pour la saisie dans la console.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (rel === 'admin') rel = 'admin.html';
  const top = rel.split('/')[0];
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || !(PUBLIC.has(rel) || PUBLIC_DIRS.has(top))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Introuvable');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...ISOLATION,
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/api') return api(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  return serveStatic(req, res);
});

const port = Number(process.env.PORT) || 8080;
server.listen(port, () => {
  console.log(`3S Compilator : http://localhost:${port}`);
  console.log(`Espace admin   : http://localhost:${port}/admin`);
  if (!process.env.ADMIN_PASSWORD) console.log('Attention : ADMIN_PASSWORD non défini (voir .env.example), l\'espace admin est désactivé.');
});
