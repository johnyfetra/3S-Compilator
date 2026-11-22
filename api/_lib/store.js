'use strict';
// Stockage des devoirs et des réglages.
//   - FileStore : un fichier JSON (développement, ou serveur de l'école sans base de données).
//   - PgStore   : PostgreSQL, choisi automatiquement si DATABASE_URL est défini (Vercel, production).
// Les deux exposent exactement les mêmes méthodes (réglages, devoirs, professeurs).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = {
  classes: ['6ème', '5ème', '4ème', '3ème', 'Seconde', 'Première', 'Terminale'],
  bimestres: ['Bimestre I', 'Bimestre II', 'Bimestre III', 'Bimestre IV', 'Bimestre V', 'Bimestre VI'],
};

const newId = () => crypto.randomUUID();
const publicTeacher = ({ passwordHash, sessionVersion, ...t }) => t;
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Résumé sans le code (liste du tableau de bord).
const summary = ({ code, stdin, tokenHash, ...rest }) => ({ ...rest, lines: code.split('\n').length });

function matches(s, f) {
  if (f.className && s.className !== f.className) return false;
  if (f.bimestre && s.bimestre !== f.bimestre) return false;
  if (f.lang && s.lang !== f.lang) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!s.student.toLowerCase().includes(q) && !s.title.toLowerCase().includes(q)) return false;
  }
  return true;
}

class FileStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve(); // écritures l'une après l'autre
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return { settings: DEFAULT_SETTINGS, submissions: [], teachers: [] };
    }
  }

  // Écriture atomique : fichier temporaire puis renommage (pas de fichier à moitié écrit).
  mutate(fn) {
    const run = this.queue.then(() => {
      const db = this.read();
      const result = fn(db);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, this.file);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async getSettings() { return this.read().settings; }

  saveSettings(settings) {
    return this.mutate((db) => { db.settings = settings; return settings; });
  }

  createSubmission(data) {
    const token = crypto.randomBytes(24).toString('base64url');
    const now = new Date().toISOString();
    const s = { id: newId(), ...data, tokenHash: hash(token), createdAt: now, updatedAt: now };
    return this.mutate((db) => { db.submissions.push(s); return { ...summary(s), editToken: token }; });
  }

  updateSubmission(id, token, data) {
    return this.mutate((db) => {
      const s = db.submissions.find((x) => x.id === id);
      if (!s || s.tokenHash !== hash(token)) return null;
      Object.assign(s, data, { updatedAt: new Date().toISOString() });
      return summary(s);
    });
  }

  async listSubmissions(filter) {
    return this.read().submissions.filter((s) => matches(s, filter))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summary);
  }

  async getSubmission(id) {
    const s = this.read().submissions.find((x) => x.id === id);
    if (!s) return null;
    const { tokenHash, ...rest } = s;
    return rest;
  }

  deleteSubmission(id) {
    return this.mutate((db) => {
      const before = db.submissions.length;
      db.submissions = db.submissions.filter((s) => s.id !== id);
      return db.submissions.length < before;
    });
  }

  // ---- Professeurs : { id, username, name, classes, passwordHash, sessionVersion }
  async listTeachers() {
    return (this.read().teachers || []).map(publicTeacher).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  async getTeacher(id) {
    return (this.read().teachers || []).find((t) => t.id === id) || null;
  }

  async findTeacher(username) {
    const u = username.toLowerCase();
    return (this.read().teachers || []).find((t) => t.username === u) || null;
  }

  createTeacher(data) {
    return this.mutate((db) => {
      db.teachers = db.teachers || [];
      if (db.teachers.some((t) => t.username === data.username)) return null;
      const t = { id: newId(), ...data, sessionVersion: 1, createdAt: new Date().toISOString() };
      db.teachers.push(t);
      return publicTeacher(t);
    });
  }

  updateTeacher(id, data) {
    return this.mutate((db) => {
      const t = (db.teachers || []).find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, data);
      if (data.passwordHash) t.sessionVersion += 1; // nouveau mot de passe : anciennes sessions fermées
      return publicTeacher(t);
    });
  }

  deleteTeacher(id) {
    return this.mutate((db) => {
      const before = (db.teachers || []).length;
      db.teachers = (db.teachers || []).filter((t) => t.id !== id);
      return db.teachers.length < before;
    });
  }
}

class PgStore {
  constructor(url) {
    const postgres = require('postgres');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    // Les paramètres d'URL (sslmode, supa…) seraient envoyés au serveur comme options de
    // connexion et le pooler Supabase coupe alors la connexion : SSL est réglé ci-dessous.
    url = url.split('?')[0];
    this.sql = postgres(url, {
      max: 3,
      idle_timeout: 20,
      ssl: local ? false : 'require',
      // Pooler en mode transaction (Supabase, port 6543) : pas de requêtes préparées.
      prepare: !/:6543\//.test(url),
    });
    this.ready = null;
  }

  init() {
    if (!this.ready) {
      const sql = this.sql;
      this.ready = (async () => {
        await sql`CREATE TABLE IF NOT EXISTS settings (id int PRIMARY KEY, data jsonb NOT NULL)`;
        await sql`CREATE TABLE IF NOT EXISTS submissions (
          id uuid PRIMARY KEY,
          student text NOT NULL,
          class_name text NOT NULL,
          bimestre text NOT NULL,
          title text NOT NULL,
          lang text NOT NULL,
          code text NOT NULL,
          stdin text NOT NULL DEFAULT '',
          token_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`;
        await sql`CREATE INDEX IF NOT EXISTS submissions_class_idx ON submissions (class_name, bimestre)`;
        await sql`CREATE TABLE IF NOT EXISTS teachers (
          id uuid PRIMARY KEY,
          username text NOT NULL UNIQUE,
          name text NOT NULL,
          classes jsonb NOT NULL DEFAULT '[]',
          password_hash text NOT NULL,
          session_version int NOT NULL DEFAULT 1,
          created_at timestamptz NOT NULL DEFAULT now()
        )`;
        // RLS sans règle = tables fermées à l'API publique de Supabase (clé anon) ;
        // le serveur se connecte en propriétaire des tables et n'est pas concerné.
        for (const table of ['settings', 'submissions', 'teachers']) {
          await sql`ALTER TABLE ${sql(table)} ENABLE ROW LEVEL SECURITY`;
        }
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  static row(r) {
    return {
      id: r.id, student: r.student, className: r.class_name, bimestre: r.bimestre, title: r.title,
      lang: r.lang, code: r.code, stdin: r.stdin,
      createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  async getSettings() {
    await this.init();
    const [r] = await this.sql`SELECT data FROM settings WHERE id = 1`;
    return r ? r.data : DEFAULT_SETTINGS;
  }

  async saveSettings(settings) {
    await this.init();
    await this.sql`INSERT INTO settings (id, data) VALUES (1, ${this.sql.json(settings)})
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
    return settings;
  }

  async createSubmission(d) {
    await this.init();
    const token = crypto.randomBytes(24).toString('base64url');
    const [r] = await this.sql`INSERT INTO submissions (id, student, class_name, bimestre, title, lang, code, stdin, token_hash)
      VALUES (${newId()}, ${d.student}, ${d.className}, ${d.bimestre}, ${d.title}, ${d.lang}, ${d.code}, ${d.stdin}, ${hash(token)})
      RETURNING *`;
    return { ...summary(PgStore.row(r)), editToken: token };
  }

  async updateSubmission(id, token, d) {
    await this.init();
    const [r] = await this.sql`UPDATE submissions SET student = ${d.student}, class_name = ${d.className},
      bimestre = ${d.bimestre}, title = ${d.title}, lang = ${d.lang}, code = ${d.code}, stdin = ${d.stdin}, updated_at = now()
      WHERE id = ${id} AND token_hash = ${hash(token)} RETURNING *`;
    return r ? summary(PgStore.row(r)) : null;
  }

  async listSubmissions(f) {
    await this.init();
    const sql = this.sql;
    const q = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
    const rows = await sql`SELECT * FROM submissions WHERE true
      ${f.className ? sql`AND class_name = ${f.className}` : sql``}
      ${f.bimestre ? sql`AND bimestre = ${f.bimestre}` : sql``}
      ${f.lang ? sql`AND lang = ${f.lang}` : sql``}
      ${q ? sql`AND (student ILIKE ${q} OR title ILIKE ${q})` : sql``}
      ORDER BY updated_at DESC LIMIT 2000`;
    return rows.map((r) => summary(PgStore.row(r)));
  }

  async getSubmission(id) {
    await this.init();
    const [r] = await this.sql`SELECT * FROM submissions WHERE id = ${id}`;
    return r ? PgStore.row(r) : null;
  }

  async deleteSubmission(id) {
    await this.init();
    const r = await this.sql`DELETE FROM submissions WHERE id = ${id}`;
    return r.count > 0;
  }

  static teacher(r) {
    return {
      id: r.id, username: r.username, name: r.name, classes: r.classes,
      passwordHash: r.password_hash, sessionVersion: r.session_version, createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async listTeachers() {
    await this.init();
    const rows = await this.sql`SELECT * FROM teachers ORDER BY name`;
    return rows.map((r) => publicTeacher(PgStore.teacher(r)));
  }

  async getTeacher(id) {
    await this.init();
    const [r] = await this.sql`SELECT * FROM teachers WHERE id = ${id}`;
    return r ? PgStore.teacher(r) : null;
  }

  async findTeacher(username) {
    await this.init();
    const [r] = await this.sql`SELECT * FROM teachers WHERE username = ${username.toLowerCase()}`;
    return r ? PgStore.teacher(r) : null;
  }

  async createTeacher(d) {
    await this.init();
    const [r] = await this.sql`INSERT INTO teachers (id, username, name, classes, password_hash)
      VALUES (${newId()}, ${d.username}, ${d.name}, ${this.sql.json(d.classes)}, ${d.passwordHash})
      ON CONFLICT (username) DO NOTHING RETURNING *`;
    return r ? publicTeacher(PgStore.teacher(r)) : null;
  }

  async updateTeacher(id, d) {
    await this.init();
    const sql = this.sql;
    const [r] = await sql`UPDATE teachers SET
      name = ${d.name}, classes = ${sql.json(d.classes)}
      ${d.passwordHash ? sql`, password_hash = ${d.passwordHash}, session_version = session_version + 1` : sql``}
      WHERE id = ${id} RETURNING *`;
    return r ? publicTeacher(PgStore.teacher(r)) : null;
  }

  async deleteTeacher(id) {
    await this.init();
    const r = await this.sql`DELETE FROM teachers WHERE id = ${id}`;
    return r.count > 0;
  }
}

function createStore(env = process.env) {
  const url = env.DATABASE_URL || env.POSTGRES_URL;
  if (url) return new PgStore(url);
  if (env.VERCEL) return null; // pas de disque persistant sur Vercel : une base est obligatoire
  return new FileStore(path.resolve(env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'db.json'));
}

module.exports = { createStore, FileStore, DEFAULT_SETTINGS };
