// Service worker : l'application et les moteurs (Monaco, Pyodide, PHP) restent disponibles hors ligne
// après une première visite. Changer VERSION à chaque mise en ligne pour rafraîchir le cache.
const VERSION = '3s-v8';
const SHELL = [
  './', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/admin.js', 'js/theme.js', 'js/languages.js', 'js/editor.js', 'js/output.js', 'js/runner.js', 'js/stepper.js', 'js/store.js',
  'js/engines/pseudocode.js', 'js/engines/js-instrument.js',
  'js/workers/shared.js', 'js/workers/javascript.js', 'js/workers/python.js', 'js/workers/php.js',
  'js/workers/cpp.js', 'js/workers/pseudocode.js',
  'vendor/acorn-8.15.0.min.js', 'vendor/jscpp-2.0.9.min.js',
  'assets/logo-3s.svg', 'assets/logo-192.png',
  'assets/icons/javascript.svg', 'assets/icons/python.svg', 'assets/icons/php.svg',
  'assets/icons/c.svg', 'assets/icons/cpp.svg', 'assets/icons/pseudocode.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Fichiers du CDN : versions figées dans l'URL, donc le cache suffit (cache d'abord).
  // Fichiers du CDN : versions figées dans l'URL, donc le cache suffit (cache d'abord).
  // Toujours téléchargés en CORS : une réponse « opaque » serait illisible sur une page isolée
  // (COOP/COEP), et une même réponse CORS sert aussi bien un <script> qu'un fetch().
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(request.url).then((hit) => hit || fetch(request.url, { mode: 'cors', credentials: 'omit' }).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request.url, copy));
      }
      return res;
    })));
    return;
  }

  // L'API (devoirs, connexion) n'est jamais mise en cache.
  if (url.origin === location.origin && url.pathname.startsWith('/api')) return;

  // Fichiers de l'application : réseau d'abord (toujours à jour), cache si hors ligne.
  if (url.origin === location.origin) {
    e.respondWith(fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy));
      }
      return res;
    }).catch(() => caches.match(request, { ignoreSearch: true })));
  }
});
