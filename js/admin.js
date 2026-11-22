// Espace enseignant : connexion, liste des devoirs filtrée, lecture du code, réglages.
import { byId, LANGUAGES } from './languages.js';
import { createEditor } from './editor.js';
import { api } from './store.js';
import { initTheme, editorTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
let editor = null;
let current = null; // devoir affiché
let settings = { classes: [], bimestres: [] };
let me = null; // { role, username, name, classes }
let searchTimer = null;

let toastTimer = null;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}

const fmtDate = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

function show(view) {
  const isSuper = view === 'dash' && me && me.role === 'superadmin';
  $('loginView').hidden = view !== 'login';
  $('dashView').hidden = view !== 'dash';
  $('logoutBtn').hidden = view !== 'dash';
  $('userBadge').hidden = view !== 'dash';
  $('settingsBtn').hidden = !isSuper;
  $('teachersBtn').hidden = !isSuper;
}

function fillOptions(select, items, label) {
  const value = select.value;
  select.textContent = '';
  select.add(new Option(label, ''));
  for (const i of items) select.add(new Option(i, i));
  select.value = items.includes(value) ? value : '';
}

// ---------------------------------------------------------------- Connexion
async function start() {
  initTheme($('themeBtn'), () => editor && editor.setTheme(editorTheme()));
  try {
    await openDashboard();
  } catch (e) {
    show('login');
    if (e.status === 503) showLoginError(e.message);
    $('loginUser').focus();
  }
}

function showLoginError(message) {
  $('loginError').textContent = message;
  $('loginError').hidden = false;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').hidden = true;
  try {
    await api.login($('loginUser').value.trim(), $('loginPass').value);
    $('loginPass').value = '';
    await openDashboard();
  } catch (err) {
    showLoginError(err.message);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  current = null;
  me = null;
  $('detailBody').hidden = true;
  $('detailEmpty').hidden = false;
  show('login');
});

// ---------------------------------------------------------------- Tableau de bord
// Classes visibles : toutes pour le super admin, seulement les siennes pour un professeur.
const myClasses = () => (me.role === 'superadmin' ? settings.classes : settings.classes.filter((c) => me.classes.includes(c)));

async function openDashboard() {
  me = await api.me();
  settings = await api.settings();
  show('dash');
  $('userBadge').textContent = me.role === 'superadmin' ? 'Super admin' : `${me.name} · ${me.classes.length} classe${me.classes.length > 1 ? 's' : ''}`;
  $('userBadge').title = me.role === 'superadmin' ? '' : me.classes.join(', ');
  fillOptions($('fClass'), myClasses(), me.role === 'superadmin' ? 'Toutes les classes' : 'Toutes mes classes');
  fillOptions($('fBimestre'), settings.bimestres, 'Tous les bimestres');
  const langSelect = $('fLang');
  if (langSelect.options.length === 1) for (const l of LANGUAGES) langSelect.add(new Option(l.name, l.id));
  await refresh();
}

function filters() {
  return { className: $('fClass').value, bimestre: $('fBimestre').value, lang: $('fLang').value, q: $('fSearch').value.trim() };
}

async function refresh() {
  let subs;
  try {
    subs = await api.list(filters());
  } catch (e) {
    if (e.status === 401) { show('login'); return; }
    toast(e.message);
    return;
  }

  const students = new Map(); // élève -> nombre de devoirs
  for (const s of subs) {
    const key = `${s.student} · ${s.className}`;
    students.set(key, (students.get(key) || 0) + 1);
  }
  $('statDevoirs').textContent = subs.length;
  $('statEleves').textContent = new Set(subs.map((s) => s.student.toLowerCase())).size;
  $('statClasses').textContent = new Set(subs.map((s) => s.className)).size;

  const chips = $('studentChips');
  chips.textContent = '';
  for (const [name, count] of [...students].sort((a, b) => a[0].localeCompare(b[0], 'fr'))) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `${name} (${count})`;
    chip.addEventListener('click', () => { $('fSearch').value = name.split(' · ')[0]; refresh(); });
    chips.appendChild(chip);
  }

  // Devoirs rangés automatiquement : classe (ordre des réglages), puis bimestre, puis élève.
  const rank = (list, v) => { const i = list.indexOf(v); return i === -1 ? list.length : i; };
  subs.sort((a, b) => rank(settings.classes, a.className) - rank(settings.classes, b.className)
    || a.className.localeCompare(b.className, 'fr')
    || rank(settings.bimestres, a.bimestre) - rank(settings.bimestres, b.bimestre)
    || a.student.localeCompare(b.student, 'fr')
    || b.updatedAt.localeCompare(a.updatedAt));

  const body = $('subsBody');
  body.textContent = '';
  $('emptyMsg').hidden = subs.length > 0;
  const counts = new Map();
  for (const s of subs) counts.set(`${s.className} · ${s.bimestre}`, (counts.get(`${s.className} · ${s.bimestre}`) || 0) + 1);
  let group = null;
  for (const s of subs) {
    const key = `${s.className} · ${s.bimestre}`;
    if (key !== group) {
      group = key;
      const count = counts.get(key);
      const head = document.createElement('tr');
      head.className = 'group';
      const th = document.createElement('th');
      th.colSpan = 3;
      th.textContent = `${key}  (${count} devoir${count > 1 ? 's' : ''})`;
      head.appendChild(th);
      body.appendChild(head);
    }

    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.id = s.id;
    if (current && current.id === s.id) tr.classList.add('selected');
    const student = document.createElement('td');
    student.textContent = s.student;
    const prog = document.createElement('td');
    prog.className = 'prog';
    const img = document.createElement('img');
    img.src = `assets/icons/${s.lang}.svg`;
    img.alt = byId[s.lang] ? byId[s.lang].name : s.lang;
    img.width = 16;
    img.height = 16;
    const title = document.createElement('span');
    title.textContent = s.title;
    prog.append(img, title);
    const date = document.createElement('td');
    date.textContent = fmtDate(s.updatedAt);
    tr.append(student, prog, date);
    tr.addEventListener('click', () => select(s.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(s.id); });
    body.appendChild(tr);
  }
}

async function select(id) {
  let s;
  try {
    s = await api.get(id);
  } catch (e) {
    toast(e.message);
    return;
  }
  current = s;
  for (const tr of $('subsBody').children) tr.classList.toggle('selected', tr.dataset.id === id);
  $('detailEmpty').hidden = true;
  $('detailBody').hidden = false;
  $('dLangIcon').src = `assets/icons/${s.lang}.svg`;
  $('dStudent').textContent = `${s.student} · ${s.title}`;
  $('dMeta').textContent = `${s.className} · ${s.bimestre} · ${byId[s.lang] ? byId[s.lang].name : s.lang} · rendu le ${fmtDate(s.updatedAt)}`;
  $('dOpen').href = `./?devoir=${encodeURIComponent(s.id)}`;
  delete $('dDelete').dataset.confirm;
  $('dDelete').classList.remove('btn-danger');

  const monacoLang = byId[s.lang] ? byId[s.lang].monaco : 'plaintext';
  if (!editor) {
    editor = await createEditor($('dEditor'), {
      value: s.code, language: monacoLang, theme: editorTheme(),
      onChange() {}, onRun() {}, onSave() {},
    });
    editor.setReadOnly(true);
  } else {
    editor.setValue(s.code, monacoLang);
  }
}

$('dDownload').addEventListener('click', () => {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([current.code], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${current.student} - ${current.title}`.replace(/[\\/:*?"<>|]/g, '-');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('dDelete').addEventListener('click', async () => {
  const btn = $('dDelete');
  if (!current) return;
  // Deux clics pour supprimer : évite les suppressions accidentelles.
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.classList.add('btn-danger');
    btn.title = 'Cliquer encore pour supprimer définitivement';
    return;
  }
  try {
    await api.remove(current.id);
    toast('Devoir supprimé');
    current = null;
    $('detailBody').hidden = true;
    $('detailEmpty').hidden = false;
    refresh();
  } catch (e) {
    toast(e.message);
  }
});

for (const id of ['fClass', 'fBimestre', 'fLang']) $(id).addEventListener('change', refresh);
$('fSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 250);
});

// ---------------------------------------------------------------- Réglages
$('settingsBtn').addEventListener('click', () => {
  $('sClasses').value = settings.classes.join('\n');
  $('sBimestres').value = settings.bimestres.join('\n');
  $('settingsError').hidden = true;
  $('settingsDialog').showModal();
});

$('settingsForm').addEventListener('submit', async (e) => {
  if (!e.submitter || e.submitter.value !== 'ok') return;
  e.preventDefault();
  const lines = (id) => $(id).value.split('\n').map((l) => l.trim()).filter(Boolean);
  try {
    settings = await api.saveSettings({ classes: lines('sClasses'), bimestres: lines('sBimestres') });
    $('settingsDialog').close();
    fillOptions($('fClass'), myClasses(), 'Toutes les classes');
    fillOptions($('fBimestre'), settings.bimestres, 'Tous les bimestres');
    toast('Listes enregistrées');
  } catch (err) {
    $('settingsError').textContent = err.message;
    $('settingsError').hidden = false;
  }
});

// ---------------------------------------------------------------- Professeurs (super admin)
let editing = null; // professeur en cours de modification

function resetTeacherForm() {
  editing = null;
  $('teacherForm').reset();
  $('teacherFormTitle').textContent = 'Ajouter un professeur';
  $('teacherSubmit').textContent = 'Ajouter';
  $('teacherCancel').hidden = true;
  $('tUser').disabled = false;
  $('tPass').required = true;
  $('tPassLabel').textContent = 'Mot de passe (8 caractères minimum)';
  $('teacherError').hidden = true;
  renderClassPicks([]);
}

function renderClassPicks(selected) {
  const box = $('tClasses');
  box.textContent = '';
  for (const c of settings.classes) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = c;
    input.checked = selected.includes(c);
    label.append(input, c);
    box.appendChild(label);
  }
}

async function renderTeachers() {
  const list = $('teachersList');
  list.textContent = '';
  let teachers;
  try {
    teachers = await api.teachers();
  } catch (e) {
    toast(e.message);
    return;
  }
  if (!teachers.length) {
    const li = document.createElement('li');
    li.className = 'files-empty';
    li.textContent = 'Aucun professeur pour le moment.';
    list.appendChild(li);
  }
  for (const t of teachers) {
    const li = document.createElement('li');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.style.flex = '1';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${t.name} (${t.username})`;
    const classes = document.createElement('span');
    classes.className = 'date';
    classes.textContent = t.classes.length ? t.classes.join(', ') : 'Aucune classe';
    meta.append(name, classes);

    const actions = document.createElement('span');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-icon';
    edit.title = 'Modifier';
    edit.setAttribute('aria-label', `Modifier ${t.name}`);
    edit.innerHTML = '<svg class="icon"><use href="#i-edit"/></svg>';
    edit.addEventListener('click', () => {
      editing = t;
      $('teacherFormTitle').textContent = `Modifier ${t.name}`;
      $('teacherSubmit').textContent = 'Enregistrer';
      $('teacherCancel').hidden = false;
      $('tName').value = t.name;
      $('tUser').value = t.username;
      $('tUser').disabled = true;
      $('tPass').value = '';
      $('tPass').required = false;
      $('tPassLabel').textContent = 'Nouveau mot de passe (laisser vide pour le garder)';
      renderClassPicks(t.classes);
      $('tName').focus();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-icon';
    del.title = 'Supprimer';
    del.setAttribute('aria-label', `Supprimer ${t.name}`);
    del.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';
    del.addEventListener('click', async () => {
      // Deux clics pour supprimer : évite les suppressions accidentelles.
      if (!del.dataset.confirm) {
        del.dataset.confirm = '1';
        del.classList.add('btn-danger');
        del.title = 'Cliquer encore pour supprimer ce professeur';
        return;
      }
      try {
        await api.deleteTeacher(t.id);
        if (editing && editing.id === t.id) resetTeacherForm();
        renderTeachers();
      } catch (e) {
        toast(e.message);
      }
    });
    actions.append(edit, del);
    li.append(meta, actions);
    list.appendChild(li);
  }
}

$('teachersBtn').addEventListener('click', () => {
  resetTeacherForm();
  renderTeachers();
  $('teachersDialog').showModal();
});
$('teacherCancel').addEventListener('click', resetTeacherForm);

$('teacherForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('tName').value.trim(),
    classes: [...$('tClasses').querySelectorAll('input:checked')].map((i) => i.value),
    password: $('tPass').value,
  };
  try {
    if (editing) await api.updateTeacher(editing.id, body);
    else await api.createTeacher({ ...body, username: $('tUser').value.trim() });
    toast(editing ? 'Professeur modifié' : 'Professeur ajouté');
    resetTeacherForm();
    renderTeachers();
  } catch (err) {
    $('teacherError').textContent = err.message;
    $('teacherError').hidden = false;
  }
});

start();
