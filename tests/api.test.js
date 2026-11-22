'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHandler } = require('../server/api.js');

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

const devoir = { student: 'Rasoa', className: 'Seconde', bimestre: 'Bimestre I', title: 'moyenne.py', lang: 'python', code: 'print(1)', stdin: '' };

test('un élève enregistre puis met à jour son devoir avec son jeton', async () => {
  const settings = await call('/settings');
  assert.deepEqual(settings.data.classes, ['6ème', '5ème', '4ème', '3ème', 'Seconde', 'Première', 'Terminale']);
  assert.equal(settings.data.bimestres.length, 6);

  const created = await call('/submissions', { method: 'POST', body: devoir });
  assert.equal(created.status, 201);
  assert.ok(created.data.editToken);
  assert.equal(created.data.code, undefined);

  const updated = await call(`/submissions/${created.data.id}`, { method: 'PUT', body: { ...devoir, code: 'print(2)' }, headers: { 'X-Edit-Token': created.data.editToken } });
  assert.equal(updated.status, 200);

  const stolen = await call(`/submissions/${created.data.id}`, { method: 'PUT', body: devoir, headers: { 'X-Edit-Token': 'faux' } });
  assert.equal(stolen.status, 404);
});

test('validation : classe inconnue, champ manquant, programme vide', async () => {
  assert.equal((await call('/submissions', { method: 'POST', body: { ...devoir, className: 'Inconnue' } })).status, 400);
  assert.equal((await call('/submissions', { method: 'POST', body: { ...devoir, student: ' ' } })).status, 400);
  assert.equal((await call('/submissions', { method: 'POST', body: { ...devoir, code: '' } })).status, 400);
});

test('espace admin : connexion obligatoire, liste filtrée, lecture du code, suppression', async () => {
  assert.equal((await call('/admin/submissions')).status, 401);
  assert.equal((await call('/admin/login', { method: 'POST', body: { username: 'prof', password: 'faux' } })).status, 401);

  const login = await call('/admin/login', { method: 'POST', body: { username: 'prof', password: 'motdepasse-test' } });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly/);
  const cookie = login.cookie.split(';')[0];

  await call('/submissions', { method: 'POST', body: { ...devoir, student: 'Faly', className: 'Terminale' } });
  const all = await call('/admin/submissions', { headers: { Cookie: cookie } });
  assert.ok(all.data.length >= 2);
  const filtered = await call('/admin/submissions?className=Terminale', { headers: { Cookie: cookie } });
  assert.deepEqual(filtered.data.map((s) => s.student), ['Faly']);

  const full = await call(`/admin/submissions/${filtered.data[0].id}`, { headers: { Cookie: cookie } });
  assert.equal(full.data.code, 'print(1)');
  assert.equal(full.data.tokenHash, undefined);

  assert.equal((await call(`/admin/submissions/${filtered.data[0].id}`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);

  const settings = await call('/admin/settings', { method: 'PUT', body: { classes: ['L1'], bimestres: ['B1'] }, headers: { Cookie: cookie } });
  assert.deepEqual(settings.data, { classes: ['L1'], bimestres: ['B1'] });
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

  const base6 = { ...devoir, className: '6ème', bimestre: 'Bimestre I' };
  const mine = await call('/submissions', { method: 'POST', body: { ...base6, student: 'Élève 6e' } });
  const other = await call('/submissions', { method: 'POST', body: { ...base6, className: 'Terminale', student: 'Élève Tle' } });

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
  assert.equal((await call('/admin/settings', { method: 'PUT', body: { classes: ['X'], bimestres: ['Y'] }, headers: { Cookie: prof } })).status, 403);

  // Nouveau mot de passe : l'ancienne session du prof est fermée.
  await call(`/admin/teachers/${t.data.id}`, { method: 'PUT', body: { name: 'M. Rakoto', classes: ['6ème'], password: 'nouveau-secret' }, headers: { Cookie: admin } });
  assert.equal((await call('/admin/me', { headers: { Cookie: prof } })).status, 401);

  // Prof supprimé : plus d'accès.
  assert.equal((await call(`/admin/teachers/${t.data.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status, 200);
  assert.equal((await call('/admin/login', { method: 'POST', body: { username: 'rakoto', password: 'nouveau-secret' }, headers: { 'X-Forwarded-For': '10.0.0.22' } })).status, 401);
});
