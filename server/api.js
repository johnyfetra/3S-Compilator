'use strict';
// API HTTP de 3S Compilator. Un seul gestionnaire (req, res) utilisé à la fois
// par le serveur local (server/index.js) et par la fonction Vercel (api/index.js).
//
//   GET    /api/settings                    classes et bimestres (public)
//   POST   /api/submissions                 l'élève enregistre son devoir -> { id, editToken }
//   PUT    /api/submissions/:id             mise à jour (en-tête X-Edit-Token)
//   POST   /api/admin/login | /logout       connexion (super admin ou professeur)
//   GET    /api/admin/me                    { role, username, name, classes }
//   GET    /api/admin/submissions?className=&bimestre=&lang=&q=    (prof : ses classes seulement)
//   GET    /api/admin/submissions/:id       devoir complet (code)
//   DELETE /api/admin/submissions/:id
//   PUT    /api/admin/settings              { classes, bimestres }                 (super admin)
//   GET    /api/admin/teachers              liste des professeurs                  (super admin)
//   POST   /api/admin/teachers              { username, name, password, classes }  (super admin)
//   PUT    /api/admin/teachers/:id          { name, classes, password? }           (super admin)
//   DELETE /api/admin/teachers/:id                                                 (super admin)

const { createStore } = require('./store');
const auth = require('./auth');

const LANGS = new Set(['javascript', 'python', 'php', 'c', 'cpp', 'pseudocode']);
const MAX_BODY = 300 * 1024;
const MAX_CODE = 200 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Format attendu : JSON.');
  }
  if (req.body !== undefined) { // déjà lu par la plateforme (Vercel)
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Programme trop volumineux.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (e) {
    throw new HttpError(400, 'JSON invalide.');
  }
}

function text(value, field, max, required = true) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (required && !v) throw new HttpError(400, `Champ obligatoire : ${field}.`);
  if (v.length > max) throw new HttpError(400, `${field} : ${max} caractères au maximum.`);
  return v;
}

async function validSubmission(body, store) {
  const settings = await store.getSettings();
  const data = {
    student: text(body.student, 'nom de l\'élève', 80),
    className: text(body.className, 'classe', 60),
    bimestre: text(body.bimestre, 'bimestre', 60),
    title: text(body.title, 'nom du programme', 80),
    lang: text(body.lang, 'langage', 20),
    code: typeof body.code === 'string' ? body.code : '',
    stdin: typeof body.stdin === 'string' ? body.stdin.slice(0, 10_000) : '',
  };
  if (!settings.classes.includes(data.className)) throw new HttpError(400, 'Classe inconnue.');
  if (!settings.bimestres.includes(data.bimestre)) throw new HttpError(400, 'Bimestre inconnu.');
  if (!LANGS.has(data.lang)) throw new HttpError(400, 'Langage inconnu.');
  if (!data.code.trim()) throw new HttpError(400, 'Le programme est vide.');
  if (data.code.length > MAX_CODE) throw new HttpError(413, 'Programme trop volumineux.');
  return data;
}

const USERNAME = /^[a-z0-9._-]{3,32}$/;

async function validTeacher(body, store, env, creating) {
  const settings = await store.getSettings();
  const data = { name: text(body.name, 'nom du professeur', 80) };
  if (!Array.isArray(body.classes)) throw new HttpError(400, 'Liste de classes attendue.');
  data.classes = [...new Set(body.classes)].filter((c) => settings.classes.includes(c));
  if (creating) {
    data.username = text(body.username, 'identifiant', 32).toLowerCase();
    if (!USERNAME.test(data.username)) throw new HttpError(400, 'Identifiant : 3 à 32 caractères (lettres, chiffres, . _ -).');
    if (data.username === auth.superUsername(env)) throw new HttpError(400, 'Cet identifiant est réservé.');
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (creating || password) {
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Mot de passe : 8 caractères au minimum.');
    data.passwordHash = await auth.hashPassword(password);
  }
  return data;
}

// Un professeur ne voit que les devoirs de ses classes.
const canSee = (user, submission) => user.role === 'superadmin' || user.classes.includes(submission.className);

function list(value) {
  if (!Array.isArray(value)) throw new HttpError(400, 'Liste attendue.');
  const items = [...new Set(value.map((v) => text(v, 'élément', 60, false)).filter(Boolean))];
  if (!items.length || items.length > 100) throw new HttpError(400, 'Entre 1 et 100 éléments.');
  return items;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket && req.socket.encrypted);
}

function createHandler(env = process.env, store = createStore(env)) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Sur Vercel, la réécriture transmet le chemin d'origine dans ?path=…
      const route = '/' + (url.searchParams.get('path') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
      const method = req.method;

      if (!store) throw new HttpError(503, 'Base de données non configurée (DATABASE_URL manquant).');

      if (route === '/settings' && method === 'GET') {
        return send(res, 200, await store.getSettings());
      }

      if (route === '/submissions' && method === 'POST') {
        const data = await validSubmission(await readJson(req), store);
        return send(res, 201, await store.createSubmission(data));
      }

      let m = /^\/submissions\/([^/]+)$/.exec(route);
      if (m && method === 'PUT') {
        if (!UUID.test(m[1])) throw new HttpError(404, 'Devoir introuvable.');
        const data = await validSubmission(await readJson(req), store);
        const saved = await store.updateSubmission(m[1], String(req.headers['x-edit-token'] || ''), data);
        if (!saved) throw new HttpError(404, 'Devoir introuvable ou non modifiable depuis cet appareil.');
        return send(res, 200, saved);
      }

      // ---- Espace admin
      if (route.startsWith('/admin/')) {
        if (!auth.isConfigured(env)) {
          throw new HttpError(503, 'Espace admin non configuré : définir ADMIN_PASSWORD (8 caractères min.) et SESSION_SECRET (16 caractères min.).');
        }
        if (route === '/admin/login' && method === 'POST') {
          const body = await readJson(req);
          const r = await auth.login(clientIp(req), String(body.username || ''), String(body.password || ''), env, store, isHttps(req));
          if (!r.ok) throw new HttpError(r.status, r.error);
          return send(res, 200, { ok: true }, { 'Set-Cookie': r.cookie });
        }
        if (route === '/admin/logout' && method === 'POST') {
          return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logoutCookie(isHttps(req)) });
        }

        const user = await auth.currentUser(req, env, store);
        if (!user) throw new HttpError(401, 'Connexion requise.');
        const superOnly = () => {
          if (user.role !== 'superadmin') throw new HttpError(403, 'Réservé au super admin.');
        };

        if (route === '/admin/me' && method === 'GET') {
          const { role, username, name, classes } = user;
          return send(res, 200, { role, username, name, classes });
        }

        if (route === '/admin/submissions' && method === 'GET') {
          const p = url.searchParams;
          const filter = { className: p.get('className') || '', bimestre: p.get('bimestre') || '', lang: p.get('lang') || '', q: (p.get('q') || '').slice(0, 80) };
          const subs = await store.listSubmissions(filter);
          return send(res, 200, subs.filter((s) => canSee(user, s)));
        }

        m = /^\/admin\/submissions\/([^/]+)$/.exec(route);
        if (m) {
          if (!UUID.test(m[1])) throw new HttpError(404, 'Devoir introuvable.');
          const s = await store.getSubmission(m[1]);
          // Devoir d'une autre classe : réponse identique à « introuvable » (rien n'est révélé).
          if (!s || !canSee(user, s)) throw new HttpError(404, 'Devoir introuvable.');
          if (method === 'GET') return send(res, 200, s);
          if (method === 'DELETE') {
            await store.deleteSubmission(m[1]);
            return send(res, 200, { ok: true });
          }
        }

        if (route === '/admin/teachers' && method === 'GET') {
          superOnly();
          return send(res, 200, await store.listTeachers());
        }
        if (route === '/admin/teachers' && method === 'POST') {
          superOnly();
          const created = await store.createTeacher(await validTeacher(await readJson(req), store, env, true));
          if (!created) throw new HttpError(409, 'Cet identifiant existe déjà.');
          return send(res, 201, created);
        }
        m = /^\/admin\/teachers\/([^/]+)$/.exec(route);
        if (m) {
          superOnly();
          if (!UUID.test(m[1])) throw new HttpError(404, 'Professeur introuvable.');
          if (method === 'PUT') {
            const updated = await store.updateTeacher(m[1], await validTeacher(await readJson(req), store, env, false));
            if (!updated) throw new HttpError(404, 'Professeur introuvable.');
            return send(res, 200, updated);
          }
          if (method === 'DELETE') {
            if (!(await store.deleteTeacher(m[1]))) throw new HttpError(404, 'Professeur introuvable.');
            return send(res, 200, { ok: true });
          }
        }

        if (route === '/admin/settings' && method === 'PUT') {
          superOnly();
          const body = await readJson(req);
          return send(res, 200, await store.saveSettings({ classes: list(body.classes), bimestres: list(body.bimestres) }));
        }
      }

      throw new HttpError(404, 'Route inconnue.');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('[api]', e);
      return send(res, 500, { error: 'Erreur interne du serveur.' });
    }
  };
}

module.exports = { createHandler };
