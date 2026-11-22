'use strict';
// Connexion à l'espace enseignant.
//   - Super admin : identifiants dans les variables d'environnement (ADMIN_USERNAME, ADMIN_PASSWORD).
//     Il gère les professeurs, les classes et les bimestres, et voit tous les devoirs.
//   - Professeur  : compte créé par le super admin, limité à ses classes.
// La session est un cookie signé (SESSION_SECRET) ; le compte est relu à chaque requête,
// donc un changement de classes ou une suppression s'applique immédiatement.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const COOKIE = '3s_admin';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const attempts = new Map(); // ip -> { count, until } ; limite les essais de mot de passe

// ---------------------------------------------------------------- Mots de passe (scrypt)
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [algo, salt, key] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Hash factice : un identifiant inconnu prend autant de temps qu'un mot de passe faux.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---------------------------------------------------------------- Session signée
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || !secret) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch (e) {
    return null;
  }
}

// Comparaison en temps constant (ne révèle pas, par la durée, combien de caractères sont justes).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function config(env) {
  return {
    username: (env.ADMIN_USERNAME || 'admin').toLowerCase(),
    password: env.ADMIN_PASSWORD || '',
    secret: env.SESSION_SECRET || '',
  };
}

function isConfigured(env) {
  const c = config(env);
  return c.password.length >= 8 && c.secret.length >= 16;
}

// Compte connecté : { role: 'superadmin' | 'teacher', id, username, name, classes } ou null.
async function currentUser(req, env, store) {
  const c = config(env);
  const payload = verify(parseCookies(req.headers.cookie)[COOKIE], c.secret);
  if (!payload) return null;
  if (payload.role === 'superadmin') {
    return payload.sub === c.username ? { role: 'superadmin', id: null, username: c.username, name: 'Super admin', classes: null } : null;
  }
  const t = await store.getTeacher(payload.sub);
  if (!t || t.sessionVersion !== payload.v) return null;
  return { role: 'teacher', id: t.id, username: t.username, name: t.name, classes: t.classes };
}

// Retourne { ok, cookie } ou { ok: false, status, error }.
async function login(ip, username, password, env, store, secure) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.until > now) {
    return { ok: false, status: 429, error: 'Trop d\'essais. Réessayez dans quelques minutes.' };
  }
  const c = config(env);
  const name = String(username).trim().toLowerCase();
  let payload = null;

  if (safeEqual(name, c.username)) {
    if (safeEqual(password, c.password)) payload = { sub: c.username, role: 'superadmin' };
  } else {
    const t = await store.findTeacher(name);
    const ok = await checkPassword(password, t ? t.passwordHash : await DUMMY_HASH);
    if (t && ok) payload = { sub: t.id, role: 'teacher', v: t.sessionVersion };
  }

  if (!payload) {
    const lockExpired = a && a.until && a.until <= now;
    const count = (a && !lockExpired ? a.count : 0) + 1;
    attempts.set(ip, { count, until: count >= MAX_ATTEMPTS ? now + LOCK_MS : 0 });
    return { ok: false, status: 401, error: 'Identifiant ou mot de passe incorrect.' };
  }
  attempts.delete(ip);
  const token = sign({ ...payload, exp: now + SESSION_SECONDS * 1000 }, c.secret);
  return { ok: true, cookie: cookie(token, SESSION_SECONDS, secure) };
}

function cookie(value, maxAge, secure) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const logoutCookie = (secure) => cookie('', 0, secure);

module.exports = { isConfigured, currentUser, login, logoutCookie, hashPassword, checkPassword, superUsername: (env) => config(env).username };
