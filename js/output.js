// Console de sortie : affichage regroupé (fluide même avec beaucoup de print)
// et erreurs présentées comme dans une vraie console, avec code couleur.

const MAX_CHARS = 300_000; // au-delà, les lignes les plus anciennes sont retirées

export class Output {
  constructor(el) {
    this.el = el;
    this.queue = [];
    this.scheduled = false;
    this.size = 0;
    this.atLineStart = true;
  }

  clear() {
    this.queue = [];
    this.size = 0;
    this.atLineStart = true;
    this.el.textContent = '';
  }

  // kind : '' (sortie normale), 'input' (saisie de l'élève), 'err', 'info', 'path', 'code', 'caret',
  //        'type', 'stack', 'fail', 'ok', 'end-fail'
  write(text, kind = '') {
    if (!text) return;
    this.atLineStart = text.endsWith('\n');
    this.queue.push([text, kind]);
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  flush() {
    this.scheduled = false;
    const frag = document.createDocumentFragment();
    for (const [text, kind] of this.queue) {
      const last = frag.lastChild || this.el.lastChild;
      // Fusionne les morceaux consécutifs du même style : moins de nœuds DOM.
      if (last && last.dataset && last.dataset.kind === kind && last.textContent.length < 4000) {
        last.textContent += text;
      } else {
        const span = document.createElement('span');
        span.dataset.kind = kind;
        if (kind) span.className = 't-' + kind;
        span.textContent = text;
        frag.appendChild(span);
      }
      this.size += text.length;
    }
    this.queue = [];
    this.el.appendChild(frag);
    while (this.size > MAX_CHARS && this.el.firstChild) {
      this.size -= this.el.firstChild.textContent.length;
      this.el.removeChild(this.el.firstChild);
    }
    this.el.scrollTop = this.el.scrollHeight;
  }

  // Erreur au format console : fichier:ligne, ligne de code, ^^^ sous l'erreur, type et pile.
  error(error, file, code) {
    if (!this.atLineStart) this.write('\n');
    this.write('ERREUR !\n', 'fail');

    const stack = error.stack && error.stack.length ? error.stack : null;
    if (stack && error.stackTitle) {
      this.write(error.stackTitle + '\n', 'stack');
      for (const frame of stack) this.write('  ' + frame + '\n', 'stack');
    }

    if (error.line) {
      const source = (code.split('\n')[error.line - 1] || '').replace(/\r$/, '');
      this.write(`${file}:${error.line}${error.column ? ':' + error.column : ''}\n`, 'path');
      this.write('  ' + source + '\n', 'code');
      if (error.column) {
        // Les tabulations sont recopiées pour que le ^ tombe au bon endroit.
        const pad = source.slice(0, error.column - 1).replace(/[^\t]/g, ' ');
        const width = Math.max(1, Math.min(error.length || 1, source.length - error.column + 1 || 1));
        this.write('  ' + pad + '^'.repeat(width) + '\n', 'caret');
      }
      this.write('\n');
    }

    const sep = /^[a-z]/.test(error.type) || error.type === 'Erreur' ? ' : ' : ': ';
    this.write(error.type ? error.type + sep : '', 'type');
    this.write((error.message || '') + '\n', 'err');

    if (stack && !error.stackTitle) for (const frame of stack) this.write('    ' + frame + '\n', 'stack');
  }

  // Saisie directement dans la console, à la suite de la question, comme dans un terminal.
  // Renvoie la ligne tapée, ou null avec Ctrl+D (fin de saisie).
  prompt() {
    this.flush();
    return new Promise((resolve) => {
      const field = document.createElement('span');
      field.className = 'console-input';
      field.contentEditable = 'plaintext-only';
      if (field.contentEditable !== 'plaintext-only') field.contentEditable = 'true';
      field.spellcheck = false;
      field.setAttribute('role', 'textbox');
      field.setAttribute('aria-label', 'Saisie du programme');
      this.el.appendChild(field);
      this.el.scrollTop = this.el.scrollHeight;
      field.focus();

      const done = (value) => {
        field.remove();
        this.pending = null;
        this.write(value === null ? '\n' : value + '\n', 'input');
        this.flush();
        resolve(value);
      };
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(field.textContent.replace(/\n/g, '')); }
        else if (e.key === 'd' && e.ctrlKey) { e.preventDefault(); done(null); }
      });
      this.pending = { field, cancel: () => { field.remove(); this.pending = null; } };
    });
  }

  // Arrêt du programme pendant une saisie : le champ disparaît.
  cancelPrompt() {
    if (this.pending) this.pending.cancel();
  }

  focusPrompt() {
    if (this.pending) this.pending.field.focus();
  }

  footer(ok, seconds) {
    const time = seconds != null ? ` (${seconds.toFixed(2).replace('.', ',')} s)` : '';
    this.write(`\n=== ${ok ? 'Code exécuté avec succès' : 'Code terminé avec des erreurs'}${time} ===\n`, ok ? 'ok' : 'end-fail');
  }
}
