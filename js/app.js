// 3S Compilator : point d'entrée de l'application (assemble les modules).
import { LANGUAGES, byId } from './languages.js';
import { createEditor } from './editor.js';
import { Output } from './output.js';
import { Runner, TIME_LIMIT_SECONDS, canAskInput } from './runner.js';
import { Stepper } from './stepper.js';
import { LocalStore, prefs, api } from './store.js';
import { initTheme, editorTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const store = new LocalStore();

// ---------------------------------------------------------------- État
// Un brouillon par langage : { code, fileId, name, savedCode }
// student = { name, className, bimestre } : rempli une fois, proposé aux enregistrements suivants.
const saved = prefs.load();
const state = {
  lang: byId[saved.lang] ? saved.lang : LANGUAGES[0].id,
  drafts: saved.drafts || {},
  student: saved.student || {},
  layout: saved.layout || { split: 55, collapsed: null },
};

// Les anciens exemples parlaient du panneau « Entrée », supprimé : on les remplace par les nouveaux.
for (const [id, d] of Object.entries(state.drafts)) {
  if (byId[id] && !d.fileId && d.code.includes('panneau « Entrée »')) d.code = byId[id].sample;
}

function draft(id = state.lang) {
  if (!state.drafts[id]) {
    const l = byId[id];
    state.drafts[id] = { code: l.sample, fileId: null, name: l.file, savedCode: null };
  }
  return state.drafts[id];
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(savePrefs, 300);
}

// Les préférences sont partagées avec theme.js : on fusionne au lieu d'écraser.
function savePrefs() {
  prefs.save({ ...prefs.load(), lang: state.lang, drafts: state.drafts, student: state.student, layout: state.layout });
}

// ---------------------------------------------------------------- UI
const output = new Output($('console'));
let editor = null;

function setStatus(kind, text) {
  $('status').dataset.kind = kind;
  $('status').textContent = text;
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

function renderRail() {
  const rail = $('langRail');
  rail.textContent = '';
  for (const l of LANGUAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lang-btn';
    b.dataset.lang = l.id;
    b.setAttribute('aria-pressed', String(l.id === state.lang));
    const img = document.createElement('img');
    img.src = `assets/icons/${l.id}.svg`;
    img.alt = '';
    const span = document.createElement('span');
    span.textContent = l.name;
    b.append(img, span);
    rail.appendChild(b);
  }
}

function updateFileTab() {
  const d = draft();
  $('fileName').textContent = d.name;
  $('fileIcon').src = `assets/icons/${state.lang}.svg`;
  $('dirtyDot').hidden = !d.fileId || d.code === d.savedCode;
}

function setBusy(busy) {
  $('runBtn').hidden = busy;
  $('stopBtn').hidden = !busy;
  $('stepBtn').disabled = busy;
}

// ---------------------------------------------------------------- Langage
function switchLanguage(id) {
  if (id === state.lang || runner.busy) return;
  stepper.close();
  syncDraft();
  state.lang = id;
  for (const b of document.querySelectorAll('.lang-btn')) b.setAttribute('aria-pressed', String(b.dataset.lang === id));
  loadDraft();
  runner.preload(byId[id]);
  persist();
}

function loadDraft() {
  const d = draft();
  if (editor) editor.setValue(d.code, byId[state.lang].monaco);
  updateFileTab();
}

function syncDraft() {
  const d = draft();
  if (editor) d.code = editor.getValue();
}

// ---------------------------------------------------------------- Exécution
const runner = new Runner({
  onStatus: (text) => {
    if (text) { setStatus('loading', 'Chargement…'); output.write(text + '\n', 'info'); }
    else setStatus('running', 'Exécution…');
  },
  onOutput: (text, stream) => output.write(text, stream === 'err' ? 'err' : ''),
  onInput: () => {
    setStatus('loading', 'En attente de saisie');
    return output.prompt().then((line) => { setStatus('running', 'Exécution…'); return line; });
  },
});

async function execute(trace) {
  if (runner.busy || !editor) return;
  stepper.close();
  syncDraft();
  persist();
  const lang = byId[state.lang];
  const d = draft();
  if (state.layout.collapsed === 'output') { state.layout.collapsed = null; applyLayout(); }
  output.clear();
  editor.mark(null);
  setBusy(true);
  setStatus('running', 'Exécution…');

  if (trace) output.write('Pas à pas : le programme s\'exécute une première fois (répondez aux questions s\'il y en a), puis vous le suivez ligne par ligne.\n\n', 'info');
  const r = await runner.run(lang, { code: d.code, trace });
  output.cancelPrompt();
  setBusy(false);

  if (r.stopped || r.timedOut) {
    output.write(r.stopped ? '\nExécution arrêtée.\n' : `\nArrêt : le programme a dépassé ${TIME_LIMIT_SECONDS} secondes (boucle infinie ?).\n`, 'err');
    setStatus('error', r.stopped ? 'Arrêté' : 'Temps dépassé');
    return;
  }

  if (r.noInput) {
    output.write('\nCe programme attend une saisie, mais le site n\'a pas été lancé avec « npm start » :\nla console ne peut pas recevoir votre réponse. Arrêtez « python3 -m http.server » et lancez « npm start ».\n', 'err');
    setStatus('error', 'Saisie impossible');
    return;
  }

  if (trace && r.steps && r.steps.length) {
    setStatus('running', 'Pas à pas');
    editor.setReadOnly(true);
    stepper.open({ steps: r.steps, output: r.output || '', error: r.error, truncated: r.truncated, file: d.name, code: d.code });
    return;
  }

  // Erreur avant toute exécution (syntaxe) : affichée même en mode pas à pas.
  if (r.error) {
    output.error(r.error, d.name, d.code);
    editor.mark(r.error.line, 'error');
  }
  output.footer(!r.error, r.seconds);
  setStatus(r.error ? 'error' : 'ok', r.error ? 'Erreur' : 'Terminé');
}

const stepper = new Stepper({
  bar: $('stepBar'),
  label: $('stepLabel'),
  slider: $('stepSlider'),
  vars: $('varsPanel'),
  editor: () => editor,
  output,
  onExit: () => {
    editor.setReadOnly(false);
    setStatus('idle', 'Prêt');
  },
});

// ---------------------------------------------------------------- Enregistrement
// Le devoir est toujours gardé sur l'appareil, puis envoyé au serveur (classe, bimestre, élève).
let settingsCache = null;

async function save() {
  syncDraft();
  const d = draft();
  const file = d.fileId ? await store.get(d.fileId) : null;
  // Déjà enregistré avec un nom d'élève : Ctrl+S met simplement à jour.
  if (file && file.student) {
    await writeFile({ title: d.name, student: file.student, className: file.className, bimestre: file.bimestre });
    return;
  }
  openSaveDialog();
}

async function openSaveDialog() {
  const d = draft();
  $('saveName').value = d.name;
  $('saveStudent').value = state.student.name || '';
  $('saveError').hidden = true;
  $('saveDialog').showModal();
  ($('saveStudent').value ? $('saveName') : $('saveStudent')).focus();

  try {
    settingsCache = settingsCache || await api.settings();
    fillSelect($('saveClass'), settingsCache.classes, state.student.className);
    fillSelect($('saveBimestre'), settingsCache.bimestres, state.student.bimestre);
    $('saveNote').textContent = 'Votre programme sera envoyé à l\'enseignant.';
  } catch (e) {
    // Hors ligne ou site sans serveur : on garde quand même la classe et le bimestre saisis avant.
    fillSelect($('saveClass'), [state.student.className].filter(Boolean), state.student.className, true);
    fillSelect($('saveBimestre'), [state.student.bimestre].filter(Boolean), state.student.bimestre, true);
    $('saveNote').textContent = 'Serveur injoignable : le programme sera enregistré sur cet appareil seulement.';
  }
}

function fillSelect(select, items, selected, optional = false) {
  select.textContent = '';
  const empty = new Option(optional ? 'Non précisé' : 'Choisir…', '');
  empty.disabled = !optional;
  select.add(empty);
  for (const item of items) select.add(new Option(item, item, false, item === selected));
  if (!items.includes(selected)) select.value = '';
  select.required = !optional;
}

async function writeFile({ title, student, className, bimestre }) {
  const d = draft();
  const previous = d.fileId ? await store.get(d.fileId) : null;
  let file;
  try {
    file = await store.save({
      ...(previous || {}), id: d.fileId, name: title, lang: state.lang, code: d.code, student, className, bimestre,
    });
  } catch (e) {
    toast(e.message);
    return;
  }
  Object.assign(d, { fileId: file.id, name: file.name, savedCode: d.code });
  state.student = { name: student, className, bimestre };
  updateFileTab();
  persist();

  if (!className || !bimestre) { toast(`« ${file.name} » enregistré sur cet appareil`); return; }
  try {
    const remote = await api.submit({ student, className, bimestre, title, lang: state.lang, code: d.code }, file.remote);
    await store.save({ ...file, remote });
    toast(`« ${file.name} » envoyé à l'enseignant (${className}, ${bimestre})`);
  } catch (e) {
    toast(`Enregistré sur cet appareil. Envoi impossible : ${e.message}`);
  }
}

function withExtension(name) {
  const ext = byId[state.lang].file.split('.').pop();
  const clean = name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'programme';
  return /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}.${ext}`;
}

async function showFiles() {
  const list = $('filesList');
  list.textContent = '';
  const files = await store.list();
  if (!files.length) {
    const li = document.createElement('li');
    li.className = 'files-empty';
    li.textContent = 'Aucun programme enregistré pour le moment. Utilisez le bouton Enregistrer (Ctrl+S).';
    list.appendChild(li);
  }
  for (const f of files) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    const img = document.createElement('img');
    img.src = `assets/icons/${f.lang}.svg`;
    img.alt = byId[f.lang] ? byId[f.lang].name : '';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    const date = document.createElement('span');
    date.className = 'date';
    const when = new Date(f.updatedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    date.textContent = [byId[f.lang] ? byId[f.lang].name : f.lang, f.className, f.bimestre, when].filter(Boolean).join(' · ');
    meta.append(name, date);
    if (f.sent) {
      const badge = document.createElement('span');
      badge.className = 'badge-sent';
      badge.textContent = 'Envoyé';
      meta.appendChild(badge);
    }
    open.append(img, meta);
    open.addEventListener('click', () => openFile(f.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-icon';
    del.title = 'Supprimer';
    del.setAttribute('aria-label', `Supprimer ${f.name}`);
    del.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';
    del.addEventListener('click', async () => {
      // Deux clics pour supprimer : évite les suppressions accidentelles.
      if (del.dataset.confirm) {
        await store.remove(f.id);
        for (const d of Object.values(state.drafts)) if (d.fileId === f.id) d.fileId = null;
        updateFileTab();
        persist();
        showFiles();
      } else {
        del.dataset.confirm = '1';
        del.classList.add('btn-danger');
        del.title = 'Cliquer encore pour confirmer';
      }
    });
    li.append(open, del);
    list.appendChild(li);
  }
  if (!$('filesDialog').open) $('filesDialog').showModal();
}

async function openFile(id) {
  const f = await store.get(id);
  if (!f || !byId[f.lang]) return;
  $('filesDialog').close();
  if (state.lang !== f.lang) switchLanguage(f.lang);
  stepper.close();
  Object.assign(draft(), { code: f.code, fileId: f.id, name: f.name, savedCode: f.code });
  loadDraft();
  persist();
}

function download() {
  syncDraft();
  const d = draft();
  const url = URL.createObjectURL(new Blob([d.code], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = d.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetSample() {
  stepper.close();
  const l = byId[state.lang];
  Object.assign(draft(), { code: l.sample, fileId: null, name: l.file, savedCode: null });
  loadDraft();
  persist();
}

// ---------------------------------------------------------------- Événements
function bind() {
  $('langRail').addEventListener('click', (e) => {
    const b = e.target.closest('.lang-btn');
    if (b) switchLanguage(b.dataset.lang);
  });
  $('runBtn').addEventListener('click', () => execute(false));
  $('stepBtn').addEventListener('click', () => execute(true));
  $('stopBtn').addEventListener('click', () => runner.stop());
  $('clearBtn').addEventListener('click', () => { stepper.close(); output.clear(); editor && editor.mark(null); setStatus('idle', 'Prêt'); });
  $('resetBtn').addEventListener('click', resetSample);
  $('saveBtn').addEventListener('click', save);
  $('downloadBtn').addEventListener('click', download);
  $('filesBtn').addEventListener('click', showFiles);
  // Un clic dans la console remet le curseur dans la saisie en cours.
  $('console').addEventListener('click', () => { if (!getSelection().toString()) output.focusPrompt(); });

  initTheme($('themeBtn'), () => editor && editor.setTheme(editorTheme()));

  $('saveForm').addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    writeFile({
      title: withExtension($('saveName').value),
      student: $('saveStudent').value.trim().replace(/\s+/g, ' '),
      className: $('saveClass').value,
      bimestre: $('saveBimestre').value,
    });
  });

  bindLayout();

  $('stepBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    const action = b.dataset.step;
    if (action === 'exit') stepper.close(); else stepper[action]();
  });
  $('stepSlider').addEventListener('input', (e) => stepper.go(Number(e.target.value)));

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); execute(false); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (stepper.active && e.key === 'F10') { e.preventDefault(); if (e.shiftKey) stepper.prev(); else stepper.next(); }
    else if (stepper.active && e.key === 'Escape' && !document.querySelector('dialog[open]')) stepper.close();
  });

  window.addEventListener('beforeunload', () => { syncDraft(); savePrefs(); });
}

// ---------------------------------------------------------------- Colonnes
// Largeur réglable avec la poignée, et chaque colonne peut être réduite à une fine bande.
function applyLayout() {
  const ws = $('workspace');
  ws.style.setProperty('--split', `${state.layout.split}%`);
  ws.classList.toggle('collapsed-editor', state.layout.collapsed === 'editor');
  ws.classList.toggle('collapsed-output', state.layout.collapsed === 'output');
}

function bindLayout() {
  applyLayout();
  const ws = $('workspace');
  ws.addEventListener('click', (e) => {
    const c = e.target.closest('[data-collapse]');
    const x = e.target.closest('[data-expand]');
    if (c) state.layout.collapsed = c.dataset.collapse;
    else if (x) state.layout.collapsed = null;
    else return;
    applyLayout();
    persist();
  });

  const splitter = $('splitter');
  const setSplit = (pct) => {
    state.layout.split = Math.round(Math.min(80, Math.max(20, pct)));
    applyLayout();
  };
  splitter.addEventListener('pointerdown', (e) => {
    if (state.layout.collapsed) return;
    splitter.setPointerCapture(e.pointerId);
    ws.classList.add('resizing');
    const box = ws.getBoundingClientRect();
    const move = (ev) => setSplit(((ev.clientX - box.left) / box.width) * 100);
    const up = () => {
      ws.classList.remove('resizing');
      splitter.removeEventListener('pointermove', move);
      persist();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up, { once: true });
  });
  splitter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSplit(state.layout.split + (e.key === 'ArrowLeft' ? -5 : 5));
      persist();
    }
  });
  splitter.addEventListener('dblclick', () => { setSplit(55); persist(); });
}

// L'enseignant ouvre un devoir depuis l'espace admin : /?devoir=<id>
async function openSubmissionFromUrl() {
  const id = new URLSearchParams(location.search).get('devoir');
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  try {
    const s = await api.get(id);
    if (!byId[s.lang]) return;
    if (state.lang !== s.lang) switchLanguage(s.lang);
    Object.assign(draft(), { code: s.code, fileId: null, name: s.title, savedCode: null });
    loadDraft();
    toast(`Devoir de ${s.student} (${s.className}, ${s.bimestre}) ouvert`);
  } catch (e) {
    toast(`Impossible d'ouvrir ce devoir : ${e.message}`);
  }
}

// ---------------------------------------------------------------- Démarrage
async function start() {
  renderRail();
  bind();
  draft();
  updateFileTab();
  runner.preload(byId[state.lang]);
  output.write('Bienvenue sur 3S Compilator ! Écrivez votre code puis cliquez sur « Exécuter » (Ctrl+Entrée), ou sur « Pas à pas » pour suivre l\'exécution ligne par ligne. Quand le programme pose une question, répondez directement ici.\n', 'info');
  if (!canAskInput) output.write('\nAttention : la saisie au clavier (input, prompt, LIRE, cin, scanf) demande de lancer le site avec « npm start ».\n', 'err');

  editor = await createEditor($('editor'), {
    value: draft().code,
    language: byId[state.lang].monaco,
    theme: editorTheme(),
    onChange: () => {
      const d = draft();
      d.code = editor.getValue();
      updateFileTab();
      persist();
    },
    onRun: () => execute(false),
    onSave: save,
  });

  openSubmissionFromUrl();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
