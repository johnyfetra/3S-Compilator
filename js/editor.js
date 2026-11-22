// Éditeur de code : Monaco (l'éditeur de VS Code) chargé depuis le CDN.
// Si Monaco ne se charge pas (pas de réseau), un simple <textarea> prend le relais.

const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';

const PSEUDO_KEYWORDS = [
  'ALGORITHME', 'VARIABLE', 'VARIABLES', 'VAR', 'CONSTANTE', 'DEBUT', 'DÉBUT', 'FIN',
  'ENTIER', 'REEL', 'RÉEL', 'CHAINE', 'CHAÎNE', 'CARACTERE', 'CARACTÈRE', 'BOOLEEN', 'BOOLÉEN', 'TABLEAU',
  'ECRIRE', 'ÉCRIRE', 'AFFICHER', 'LIRE', 'SAISIR', 'SI', 'ALORS', 'SINON', 'FINSI',
  'TANTQUE', 'TANT', 'QUE', 'FAIRE', 'FINTANTQUE', 'POUR', 'DE', 'A', 'À', 'PAS', 'FINPOUR',
  'REPETER', 'RÉPÉTER', 'JUSQUA', 'ET', 'OU', 'NON', 'DIV', 'MOD',
];

function loadMonaco() {
  return new Promise((resolve, reject) => {
    // Les workers de Monaco viennent du CDN : on les démarre via un petit script blob.
    window.MonacoEnvironment = {
      getWorkerUrl: () => URL.createObjectURL(new Blob(
        [`self.MonacoEnvironment = { baseUrl: '${MONACO_BASE}/' }; importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`],
        { type: 'text/javascript' },
      )),
    };
    const script = document.createElement('script');
    script.src = `${MONACO_BASE}/vs/loader.js`;
    script.onerror = () => reject(new Error('Monaco indisponible'));
    script.onload = () => {
      window.require.config({ paths: { vs: `${MONACO_BASE}/vs` }, 'vs/nls': { availableLanguages: { '*': 'fr' } } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    document.head.appendChild(script);
  });
}

function setupMonaco(monaco) {
  monaco.languages.register({ id: 'pseudocode3s' });
  monaco.languages.setMonarchTokensProvider('pseudocode3s', {
    ignoreCase: true,
    keywords: PSEUDO_KEYWORDS,
    constants: ['VRAI', 'FAUX'],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/#.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"[^"]*"?/, 'string'],
        [/'[^']*'?/, 'string'],
        [/«[^»]*»?/, 'string'],
        [/\d+(\.\d+)?/, 'number'],
        [/jusqu['’][aà]/i, 'keyword'],
        [/[\p{L}_][\p{L}\p{N}_]*/u, { cases: { '@keywords': 'keyword', '@constants': 'constant', '@default': 'identifier' } }],
        [/<-|←|:=|<=|>=|<>|!=|[+\-*/%^=<>&:,()[\]]/, 'operator'],
      ],
      comment: [[/\*\//, 'comment', '@pop'], [/./, 'comment']],
    },
  });
  monaco.languages.setLanguageConfiguration('pseudocode3s', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['(', ')'], ['[', ']']],
    autoClosingPairs: [{ open: '(', close: ')' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
  });

  // Thèmes aux couleurs de l'école (bleu 3S, rouge des « S »).
  monaco.editor.defineTheme('threes-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '0026A8', fontStyle: 'bold' },
      { token: 'constant', foreground: 'C40000' },
      { token: 'string', foreground: 'B3261E' },
      { token: 'comment', foreground: '6B7280', fontStyle: 'italic' },
      { token: 'number', foreground: '0B7A4B' },
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editorLineNumber.foreground': '#9AA3B5',
      'editorLineNumber.activeForeground': '#0026A8',
      'editor.lineHighlightBackground': '#F3F5FB',
      'editorCursor.foreground': '#0026A8',
    },
  });
  monaco.editor.defineTheme('threes-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '7C9BFF', fontStyle: 'bold' },
      { token: 'constant', foreground: 'FF7A7A' },
      { token: 'string', foreground: 'F2A27E' },
      { token: 'comment', foreground: '7D869C', fontStyle: 'italic' },
      { token: 'number', foreground: '7FD1A8' },
    ],
    colors: {
      'editor.background': '#121725',
      'editorLineNumber.foreground': '#4E5874',
      'editorLineNumber.activeForeground': '#7C9BFF',
      'editor.lineHighlightBackground': '#182034',
      'editorCursor.foreground': '#7C9BFF',
    },
  });

  // Le JavaScript de l'élève peut utiliser await au niveau principal.
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ diagnosticCodesToIgnore: [1375, 1378] });
}

class MonacoEditor {
  constructor(monaco, host, { value, language, theme, onChange, onRun, onSave }) {
    this.monaco = monaco;
    this.decorations = null;
    this.editor = monaco.editor.create(host, {
      value,
      language,
      theme,
      fontSize: 15,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 4,
      glyphMargin: true,
      renderLineHighlight: 'all',
      padding: { top: 12 },
      smoothScrolling: true,
    });
    this.decorations = this.editor.createDecorationsCollection();
    this.editor.onDidChangeModelContent(() => onChange());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, onRun);
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
  }

  getValue() { return this.editor.getValue(); }

  setValue(value, language) {
    const model = this.editor.getModel();
    this.monaco.editor.setModelLanguage(model, language);
    if (model.getValue() !== value) model.setValue(value);
  }

  setTheme(theme) { this.monaco.editor.setTheme(theme); }
  setReadOnly(readOnly) { this.editor.updateOptions({ readOnly }); }
  focus() { this.editor.focus(); }

  // kind : 'current' (prochaine ligne en pas à pas) ou 'error'
  mark(line, kind) {
    if (!line) { this.decorations.clear(); return; }
    this.decorations.set([{
      range: new this.monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: `line-${kind}`, glyphMarginClassName: `glyph-${kind}` },
    }]);
    this.editor.revealLineInCenterIfOutsideViewport(line);
  }
}

// Éditeur de secours (sans coloration) quand Monaco n'a pas pu être chargé.
class PlainEditor {
  constructor(host, { value, onChange, onRun, onSave }) {
    this.area = document.createElement('textarea');
    this.area.className = 'plain-editor';
    this.area.spellcheck = false;
    this.area.value = value;
    this.area.setAttribute('aria-label', 'Code');
    this.area.addEventListener('input', onChange);
    this.area.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave(); }
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '    '); }
    });
    host.appendChild(this.area);
  }

  getValue() { return this.area.value; }
  setValue(value) { this.area.value = value; }
  setTheme() {}
  setReadOnly(readOnly) { this.area.readOnly = readOnly; }
  focus() { this.area.focus(); }

  mark(line) {
    if (!line) return;
    const lines = this.area.value.split('\n');
    const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    this.area.setSelectionRange(start, start + (lines[line - 1] || '').length);
  }
}

export async function createEditor(host, options) {
  try {
    const monaco = await loadMonaco();
    setupMonaco(monaco);
    return new MonacoEditor(monaco, host, options);
  } catch (e) {
    return new PlainEditor(host, options);
  }
}
