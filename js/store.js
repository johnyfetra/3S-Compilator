// Stockage du travail de l'élève.
//
// Deux niveaux : LocalStore garde une copie dans le navigateur (fonctionne hors ligne),
// et `api` envoie le devoir au serveur (classe, bimestre, nom de l'élève).
//
// Interface de LocalStore :
//   list()            -> [{ id, name, lang, updatedAt, sent, className, bimestre }]
//   get(id)           -> { id, name, lang, code, stdin, updatedAt } | null
//   save(file)        -> fichier enregistré (id créé si absent)
//   remove(id)

const FILES_KEY = '3s:files';
const PREFS_KEY = '3s:prefs';

// localStorage peut être indisponible (navigation privée, stockage bloqué) : on ne plante jamais.
function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export class LocalStore {
  async list() {
    return read(FILES_KEY, [])
      .map(({ id, name, lang, updatedAt, remote, className, bimestre }) => ({ id, name, lang, updatedAt, sent: Boolean(remote), className, bimestre }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id) {
    return read(FILES_KEY, []).find((f) => f.id === id) || null;
  }

  async save(file) {
    const files = read(FILES_KEY, []);
    const saved = { ...file, id: file.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8), updatedAt: Date.now() };
    const i = files.findIndex((f) => f.id === saved.id);
    if (i === -1) files.push(saved); else files[i] = saved;
    if (!write(FILES_KEY, files)) throw new Error('Stockage du navigateur plein ou indisponible.');
    return saved;
  }

  async remove(id) {
    write(FILES_KEY, read(FILES_KEY, []).filter((f) => f.id !== id));
  }
}

// Préférences et brouillons (un par langage), sauvegardés automatiquement.
export const prefs = {
  load: () => read(PREFS_KEY, {}),
  save: (value) => write(PREFS_KEY, value),
};

// ---------------------------------------------------------------- API du serveur
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch('api/' + path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error('Serveur injoignable (pas de connexion ?).'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
}

export const api = {
  settings: () => request('settings'),

  // Crée ou met à jour le devoir de l'élève ; remote = { id, token } d'un envoi précédent.
  async submit(submission, remote) {
    if (remote) {
      try {
        await request(`submissions/${remote.id}`, { method: 'PUT', body: submission, headers: { 'X-Edit-Token': remote.token } });
        return remote;
      } catch (e) {
        if (e.status !== 404) throw e; // devoir supprimé par l'enseignant : on le renvoie
      }
    }
    const created = await request('submissions', { method: 'POST', body: submission });
    return { id: created.id, token: created.editToken };
  },

  login: (username, password) => request('admin/login', { method: 'POST', body: { username, password } }),
  logout: () => request('admin/logout', { method: 'POST', body: {} }),
  me: () => request('admin/me'),
  list: (filter) => request('admin/submissions?' + new URLSearchParams(filter)),
  get: (id) => request(`admin/submissions/${encodeURIComponent(id)}`),
  remove: (id) => request(`admin/submissions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  saveSettings: (settings) => request('admin/settings', { method: 'PUT', body: settings }),
  teachers: () => request('admin/teachers'),
  createTeacher: (t) => request('admin/teachers', { method: 'POST', body: t }),
  updateTeacher: (id, t) => request(`admin/teachers/${encodeURIComponent(id)}`, { method: 'PUT', body: t }),
  deleteTeacher: (id) => request(`admin/teachers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
