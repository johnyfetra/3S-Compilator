'use strict';
// API HTTP de 3S Compilator. Un seul gestionnaire (req, res) utilisé à la fois
// par le serveur local (server/index.js) et par la fonction Vercel (api/index.js).
// Placé dans api/_lib : Vercel n'en fait pas une fonction et ne le publie pas.
//
//   GET    /api/settings                    classes, bimestres et bimestre en cours (public)
//   GET    /api/students?className=         élèves d'une classe, pour que l'élève choisisse son nom (public)
//   POST   /api/submissions                 l'élève enregistre son exercice { studentId, title, lang, code }
//                                           -> { id, editToken } ; bimestre en cours fixé par le serveur
//   PUT    /api/submissions/:id             mise à jour (en-tête X-Edit-Token) ; le bimestre ne change pas
//   POST   /api/admin/login | /logout       connexion (super admin ou professeur)
//   GET    /api/admin/me                    { role, username, name, classes }
//   GET    /api/admin/submissions?className=&studentId=&bimestre=&lang=&q=    (prof : ses classes seulement)
//   GET    /api/admin/submissions/:id       devoir complet (code)
//   DELETE /api/admin/submissions/:id
//   PUT    /api/admin/settings              { classes, bimestres, currentBimestre } (super admin ; '' = automatique)
//   GET    /api/admin/students?className=   élèves (prof : ses classes seulement)
//   POST   /api/admin/students              { className, names: [...] } -> élèves ajoutés
//   PUT    /api/admin/students/:id          { name }
//   DELETE /api/admin/students/:id          (les exercices déjà rendus sont gardés)
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

// L'élève choisit son nom dans la liste de sa classe : nom et classe viennent de cette liste.
async function validSubmission(body, store) {
  const student = UUID.test(String(body.studentId)) ? await store.getStudent(body.studentId) : null;
  if (!student) throw new HttpError(400, 'Élève inconnu : choisissez votre nom dans la liste de votre classe.');
  const data = {
    studentId: student.id,
    student: student.name,
    className: student.className,
    title: text(body.title, 'nom du programme', 80),
    lang: text(body.lang, 'langage', 20),
    code: typeof body.code === 'string' ? body.code : '',
    stdin: typeof body.stdin === 'string' ? body.stdin.slice(0, 10_000) : '',
  };
  if (!LANGS.has(data.lang)) throw new HttpError(400, 'Langage inconnu.');
  if (!data.code.trim()) throw new HttpError(400, 'Le programme est vide.');
  if (data.code.length > MAX_CODE) throw new HttpError(413, 'Programme trop volumineux.');
  return data;
}

// ---------------------------------------------------------------- Bimestre en cours
// Sans réglage, le bimestre I commence à la rentrée (1er septembre) et chaque bimestre dure
// deux mois. Le super admin peut fixer le bimestre en cours : le décompte repart de ce jour-là,
// jusqu'à la rentrée suivante où l'on revient au calcul automatique.
function schoolYearStart(now) {
  return new Date(now.getFullYear() - (now.getMonth() < 8 ? 1 : 0), 8, 1);
}

function bimestreState(settings, now = new Date()) {
  const list = settings.bimestres;
  const start = schoolYearStart(now);
  const manual = Boolean(settings.current && list.includes(settings.current) && settings.currentSince && new Date(settings.currentSince) >= start);
  const since = manual ? new Date(settings.currentSince) : start;
  const from = manual ? list.indexOf(settings.current) : 0;
  const months = (now.getFullYear() - since.getFullYear()) * 12 + now.getMonth() - since.getMonth() - (now.getDate() < since.getDate() ? 1 : 0);
  return { currentBimestre: list[Math.min(list.length - 1, from + Math.floor(Math.max(0, months) / 2))], manual };
}

const publicSettings = (s) => ({ classes: s.classes, bimestres: s.bimestres, ...bimestreState(s) });

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

// Un professeur ne voit que les devoirs et les élèves de ses classes.
const canSee = (user, item) => user.role === 'superadmin' || user.classes.includes(item.className);

const personName = (value) => text(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, 'nom de l\'élève', 80);

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
        return send(res, 200, publicSettings(await store.getSettings()));
      }

      if (route === '/students' && method === 'GET') {
        const className = url.searchParams.get('className') || '';
        if (!(await store.getSettings()).classes.includes(className)) throw new HttpError(400, 'Classe inconnue.');
        return send(res, 200, (await store.listStudents(className)).map(({ id, name }) => ({ id, name })));
      }

      if (route === '/submissions' && method === 'POST') {
        const data = await validSubmission(await readJson(req), store);
        data.bimestre = publicSettings(await store.getSettings()).currentBimestre;
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
          const filter = { className: p.get('className') || '', studentId: p.get('studentId') || '', bimestre: p.get('bimestre') || '', lang: p.get('lang') || '', q: (p.get('q') || '').slice(0, 80) };
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

        if (route === '/admin/students' && method === 'GET') {
          const students = await store.listStudents(url.searchParams.get('className') || '');
          return send(res, 200, students.filter((x) => canSee(user, x)));
        }
        if (route === '/admin/students' && method === 'POST') {
          const body = await readJson(req);
          const className = text(body.className, 'classe', 60);
          if (!(await store.getSettings()).classes.includes(className)) throw new HttpError(400, 'Classe inconnue.');
          if (!canSee(user, { className })) throw new HttpError(403, 'Cette classe ne vous est pas attribuée.');
          if (!Array.isArray(body.names) || body.names.length > 200) throw new HttpError(400, 'Entre 1 et 200 noms à la fois.');
          const seen = new Set();
          const names = body.names.map((n) => (typeof n === 'string' ? n.trim() : ''))
            .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
            .map(personName);
          if (!names.length) throw new HttpError(400, 'Entre 1 et 200 noms à la fois.');
          return send(res, 201, await store.addStudents(className, names));
        }
        m = /^\/admin\/students\/([^/]+)$/.exec(route);
        if (m) {
          const st = UUID.test(m[1]) ? await store.getStudent(m[1]) : null;
          if (!st || !canSee(user, st)) throw new HttpError(404, 'Élève introuvable.');
          if (method === 'PUT') {
            const renamed = await store.renameStudent(st.id, personName((await readJson(req)).name));
            if (renamed === false) throw new HttpError(409, 'Ce nom existe déjà dans la classe.');
            if (!renamed) throw new HttpError(404, 'Élève introuvable.');
            return send(res, 200, renamed);
          }
          if (method === 'DELETE') {
            await store.deleteStudent(st.id);
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
          const previous = await store.getSettings();
          const next = { classes: list(body.classes), bimestres: list(body.bimestres) };
          const wanted = text(body.currentBimestre, 'bimestre en cours', 60, false);
          if (wanted && !next.bimestres.includes(wanted)) throw new HttpError(400, 'Bimestre en cours inconnu.');
          if (wanted) {
            // Bimestre choisi à la main : le décompte de deux mois repart d'aujourd'hui,
            // sauf s'il est déjà le bimestre en cours (rien ne change alors).
            const kept = bimestreState({ ...previous, bimestres: next.bimestres });
            Object.assign(next, wanted === kept.currentBimestre && kept.manual
              ? { current: previous.current, currentSince: previous.currentSince }
              : { current: wanted, currentSince: new Date().toISOString() });
          }
          return send(res, 200, publicSettings(await store.saveSettings(next)));
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

module.exports = { createHandler, bimestreState };
