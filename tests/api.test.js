'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHandler, bimestreState } = require('../api/_lib/api.js');

const env = {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), '3s-')),
  ADMIN_USERNAME: 'prof',
  ADMIN_PASSWORD: 'motdepasse-test',
  SESSION_SECRET: 'secret-de-test-tres-long',
};

let base;
let server;
test.before(async () => {
  server = http.createServer(createHandler(env));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}/api`;
});
test.after(() => server.close());

const call = (p, { method = 'GET', body, headers = {} } = {}) => fetch(base + p, {
  method,
  headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie') }));

const devoir = { title: 'moyenne.py', lang: 'python', code: 'print(1)', stdin: '' };

let superCookie;
const asSuper = async () => {
  superCookie = superCookie || (await call('/admin/login', { method: 'POST', body: { username: 'prof', password: 'motdepasse-test' }, headers: { 'X-Forwarded-For': '10.0.0.1' } })).cookie.split(';')[0];
  return superCookie;
};
// Ajoute un élève à la liste de sa classe et retourne son id.
const enroll = async (name, className) => {
  const r = await call('/admin/students', { method: 'POST', body: { className, names: [name] }, headers: { Cookie: await asSuper() } });
  return r.data[0].id;
};

test('bimestre en cours : automatique depuis la rentrée, ou fixé à la main', () => {
  const bimestres = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'];
  assert.equal(bimestreState({ bimestres }, new Date(2026, 8, 15)).currentBimestre, 'B1');
  assert.equal(bimestreState({ bimestres }, new Date(2026, 10, 1)).currentBimestre, 'B2');
  assert.equal(bimestreState({ bimestres }, new Date(2027, 7, 31)).currentBimestre, 'B6');
  const manual = { bimestres, current: 'B3', currentSince: new Date(2026, 9, 10).toISOString() };
  assert.deepEqual(bimestreState(manual, new Date(2026, 11, 9)), { currentBimestre: 'B3', manual: true });
  assert.equal(bimestreState(manual, new Date(2026, 11, 10)).currentBimestre, 'B4');
  // Rentrée suivante : retour au calcul automatique.
  assert.deepEqual(bimestreState(manual, new Date(2027, 8, 2)), { currentBimestre: 'B1', manual: false });
});

test('un élève choisi dans la liste enregistre puis met à jour son exercice avec son jeton', async () => {
  const settings = await call('/settings');
  assert.deepEqual(settings.data.classes, ['6ème', '5ème', '4ème', '3ème', 'Seconde', 'Première', 'Terminale']);
  assert.equal(settings.data.bimestres.length, 6);
  assert.ok(settings.data.bimestres.includes(settings.data.currentBimestre));

  const studentId = await enroll('Rasoa', 'Seconde');
  assert.deepEqual((await call('/students?className=Seconde')).data, [{ id: studentId, name: 'Rasoa' }]);

  const created = await call('/submissions', { method: 'POST', body: { ...devoir, studentId, bimestre: 'Bimestre VI' } });
  assert.equal(created.status, 201);
  assert.ok(created.data.editToken);
  assert.equal(created.data.code, undefined);
  assert.deepEqual([created.data.student, created.data.className, created.data.bimestre], ['Rasoa', 'Seconde', settings.data.currentBimestre]);

  const updated = await call(`/submissions/${created.data.id}`, { method: 'PUT', body: { ...devoir, studentId, code: 'print(2)' }, headers: { 'X-Edit-Token': created.data.editToken } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.bimestre, created.data.bimestre);

  const stolen = await call(`/submissions/${created.data.id}`, { method: 'PUT', body: { ...devoir, studentId }, headers: { 'X-Edit-Token': 'faux' } });
  assert.equal(stolen.status, 404);
});

test('validation : élève hors liste, classe inconnue, programme vide', async () => {
  const studentId = await enroll('Hery', 'Seconde');
  assert.equal((await call('/submissions', { method: 'POST', body: { ...devoir, student: 'Hery', className: 'Seconde' } })).status, 400);
  assert.equal((await call('/submissions', { method: 'POST', body: { ...devoir, studentId: crypto.randomUUID() } })).status, 400);
  assert.equal((await call('/submissions', { method: 'POST', body: { ...devoir, studentId, code: '' } })).status, 400);
  assert.equal((await call('/students?className=Inconnue')).status, 400);
});

test('liste des élèves : doublons ignorés, renommage répercuté sur les exercices', async () => {
  const cookie = await asSuper();
  const added = await call('/admin/students', { method: 'POST', body: { className: '3ème', names: ['Bema', 'bema', '  ', 'Soa'] }, headers: { Cookie: cookie } });
  assert.deepEqual(added.data.map((x) => x.name).sort(), ['Bema', 'Soa']);
  assert.equal((await call('/admin/students', { method: 'POST', body: { className: '3ème', names: ['BEMA'] }, headers: { Cookie: cookie } })).data.length, 0);

  const bema = added.data.find((x) => x.name === 'Bema');
  const sub = await call('/submissions', { method: 'POST', body: { ...devoir, studentId: bema.id } });
  assert.equal((await call(`/admin/students/${bema.id}`, { method: 'PUT', body: { name: 'Soa' }, headers: { Cookie: cookie } })).status, 409);
  assert.equal((await call(`/admin/students/${bema.id}`, { method: 'PUT', body: { name: 'Bema Rabe' }, headers: { Cookie: cookie } })).status, 200);
  const list = await call(`/admin/submissions?studentId=${bema.id}`, { headers: { Cookie: cookie } });
  assert.deepEqual(list.data.map((s) => [s.id, s.student]), [[sub.data.id, 'Bema Rabe']]);

  assert.equal((await call(`/admin/students/${bema.id}`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call(`/admin/submissions/${sub.data.id}`, { headers: { Cookie: cookie } })).status, 200); // exercice gardé
});

test('espace admin : connexion obligatoire, liste filtrée, lecture du code, suppression', async () => {
  assert.equal((await call('/admin/submissions')).status, 401);
  assert.equal((await call('/admin/login', { method: 'POST', body: { username: 'prof', password: 'faux' } })).status, 401);

  const login = await call('/admin/login', { method: 'POST', body: { username: 'prof', password: 'motdepasse-test' } });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly/);
  const cookie = login.cookie.split(';')[0];

  await call('/submissions', { method: 'POST', body: { ...devoir, studentId: await enroll('Faly', 'Terminale') } });
  const all = await call('/admin/submissions', { headers: { Cookie: cookie } });
  assert.ok(all.data.length >= 2);
  const filtered = await call('/admin/submissions?className=Terminale', { headers: { Cookie: cookie } });
  assert.deepEqual(filtered.data.map((s) => s.student), ['Faly']);

  const full = await call(`/admin/submissions/${filtered.data[0].id}`, { headers: { Cookie: cookie } });
  assert.equal(full.data.code, 'print(1)');
  assert.equal(full.data.tokenHash, undefined);

  assert.equal((await call(`/admin/submissions/${filtered.data[0].id}`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);

  const settings = await call('/admin/settings', { method: 'PUT', body: { classes: ['L1'], bimestres: ['B1', 'B2'], currentBimestre: 'B2' }, headers: { Cookie: cookie } });
  assert.deepEqual(settings.data, { classes: ['L1'], bimestres: ['B1', 'B2'], currentBimestre: 'B2', manual: true });
  assert.equal((await call('/admin/settings', { method: 'PUT', body: { classes: ['L1'], bimestres: ['B1'], currentBimestre: 'B9' }, headers: { Cookie: cookie } })).status, 400);
});

test('blocage après 5 mauvais mots de passe', async () => {
  const body = { username: 'prof', password: 'mauvais' };
  const headers = { 'X-Forwarded-For': '10.0.0.9' };
  for (let i = 0; i < 5; i++) await call('/admin/login', { method: 'POST', body, headers });
  const r = await call('/admin/login', { method: 'POST', body: { username: 'prof', password: 'motdepasse-test' }, headers });
  assert.equal(r.status, 429);
});

test('super admin crée un prof ; le prof ne voit que ses classes', async () => {
  const admin = (await call('/admin/login', { method: 'POST', body: { username: 'prof', password: 'motdepasse-test' }, headers: { 'X-Forwarded-For': '10.0.0.20' } })).cookie.split(';')[0];
  await call('/admin/settings', { method: 'PUT', body: { classes: ['6ème', 'Terminale'], bimestres: ['Bimestre I'] }, headers: { Cookie: admin } });

  const t = await call('/admin/teachers', { method: 'POST', body: { username: 'Rakoto', name: 'M. Rakoto', password: 'secret-rakoto', classes: ['6ème', 'Inconnue'] }, headers: { Cookie: admin } });
  assert.equal(t.status, 201);
  assert.deepEqual(t.data.classes, ['6ème']);
  assert.equal(t.data.passwordHash, undefined);
  assert.equal((await call('/admin/teachers', { method: 'POST', body: { username: 'rakoto', name: 'X', password: 'autre-secret', classes: [] }, headers: { Cookie: admin } })).status, 409);

  const mine = await call('/submissions', { method: 'POST', body: { ...devoir, studentId: await enroll('Élève 6e', '6ème') } });
  const otherStudent = await enroll('Élève Tle', 'Terminale');
  const other = await call('/submissions', { method: 'POST', body: { ...devoir, studentId: otherStudent } });

  const login = await call('/admin/login', { method: 'POST', body: { username: 'rakoto', password: 'secret-rakoto' }, headers: { 'X-Forwarded-For': '10.0.0.21' } });
  assert.equal(login.status, 200);
  const prof = login.cookie.split(';')[0];

  const me = await call('/admin/me', { headers: { Cookie: prof } });
  assert.deepEqual([me.data.role, me.data.classes], ['teacher', ['6ème']]);

  const list = await call('/admin/submissions', { headers: { Cookie: prof } });
  assert.ok(list.data.every((s) => s.className === '6ème'));
  assert.ok(list.data.some((s) => s.id === mine.data.id));
  assert.equal((await call('/admin/submissions?className=Terminale', { headers: { Cookie: prof } })).data.length, 0);
  assert.equal((await call(`/admin/submissions/${other.data.id}`, { headers: { Cookie: prof } })).status, 404);
  assert.equal((await call(`/admin/submissions/${other.data.id}`, { method: 'DELETE', headers: { Cookie: prof } })).status, 404);
  assert.equal((await call('/admin/teachers', { headers: { Cookie: prof } })).status, 403);
  // Élèves : le prof gère seulement ceux de ses classes.
  assert.ok((await call('/admin/students', { headers: { Cookie: prof } })).data.every((x) => x.className === '6ème'));
  assert.equal((await call('/admin/students', { method: 'POST', body: { className: 'Terminale', names: ['X'] }, headers: { Cookie: prof } })).status, 403);
  assert.equal((await call('/admin/students', { method: 'POST', body: { className: '6ème', names: ['Nouvel élève'] }, headers: { Cookie: prof } })).status, 201);
  assert.equal((await call(`/admin/students/${otherStudent}`, { method: 'DELETE', headers: { Cookie: prof } })).status, 404);
  assert.equal((await call('/admin/settings', { method: 'PUT', body: { classes: ['X'], bimestres: ['Y'] }, headers: { Cookie: prof } })).status, 403);

  // Nouveau mot de passe : l'ancienne session du prof est fermée.
  await call(`/admin/teachers/${t.data.id}`, { method: 'PUT', body: { name: 'M. Rakoto', classes: ['6ème'], password: 'nouveau-secret' }, headers: { Cookie: admin } });
  assert.equal((await call('/admin/me', { headers: { Cookie: prof } })).status, 401);

  // Prof supprimé : plus d'accès.
  assert.equal((await call(`/admin/teachers/${t.data.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status, 200);
  assert.equal((await call('/admin/login', { method: 'POST', body: { username: 'rakoto', password: 'nouveau-secret' }, headers: { 'X-Forwarded-For': '10.0.0.22' } })).status, 401);
});
