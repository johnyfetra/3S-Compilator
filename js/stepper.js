// Mode « Pas à pas » : rejoue la trace produite par le worker, étape par étape,
// en avant comme en arrière. Chaque étape = la ligne qui va s'exécuter + l'état avant.

export class Stepper {
  constructor({ bar, label, slider, vars, editor, output, onExit }) {
    Object.assign(this, { bar, label, slider, vars, editor, output, onExit });
    this.trace = null;
    this.index = 0;
  }

  get active() { return this.trace !== null; }

  open(trace) {
    this.trace = trace; // { steps, output, error, truncated, file, code }
    this.slider.max = String(trace.steps.length - 1);
    this.bar.hidden = false;
    this.vars.hidden = false;
    this.go(0);
  }

  close() {
    if (!this.trace) return;
    this.trace = null;
    this.bar.hidden = true;
    this.vars.hidden = true;
    this.editor().mark(null);
    this.onExit();
  }

  next() { this.go(this.index + 1); }
  prev() { this.go(this.index - 1); }
  first() { this.go(0); }
  last() { this.go(this.trace.steps.length - 1); }

  go(i) {
    const { steps } = this.trace;
    this.index = Math.max(0, Math.min(steps.length - 1, i));
    const step = steps[this.index];
    const t = this.trace;
    this.slider.value = String(this.index);

    // Sortie affichée jusqu'à cette étape.
    this.output.clear();
    this.output.write(t.output.slice(0, step.out));

    let text;
    if (step.final) {
      if (t.error) {
        this.output.error(t.error, t.file, t.code);
        text = t.error.line ? `Erreur à la ligne ${t.error.line}` : 'Erreur';
      } else {
        text = t.truncated ? `Arrêt après ${steps.length - 1} étapes (boucle trop longue ?)` : 'Fin du programme';
      }
      this.output.footer(!t.error && !t.truncated);
      this.editor().mark(t.error ? t.error.line : null, 'error');
    } else {
      text = `Prochaine ligne : ${step.line}`;
      this.editor().mark(step.line, 'current');
    }
    this.label.textContent = `Étape ${this.index + 1} / ${steps.length} · ${text}`;
    this.renderVars(step, steps[this.index - 1]);
  }

  // Tableau des variables ; les valeurs qui viennent de changer sont surlignées.
  renderVars(step, previous) {
    const before = new Map();
    if (previous) for (const s of previous.scopes) for (const [k, v] of Object.entries(s.vars)) before.set(s.name + '/' + k, v);

    const body = this.vars.querySelector('.vars-body');
    body.textContent = '';
    if (!step.scopes.length) {
      const p = document.createElement('p');
      p.className = 'vars-empty';
      p.textContent = 'Aucune variable pour le moment.';
      body.appendChild(p);
      return;
    }
    for (const scope of step.scopes) {
      const table = document.createElement('table');
      const caption = document.createElement('caption');
      caption.textContent = scope.name === 'global' ? 'Programme principal' : scope.name;
      table.appendChild(caption);
      for (const [name, value] of Object.entries(scope.vars)) {
        const tr = document.createElement('tr');
        const key = scope.name + '/' + name;
        if (previous && before.get(key) !== value) tr.className = 'changed';
        const th = document.createElement('th');
        th.textContent = name;
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(th, td);
        table.appendChild(tr);
      }
      body.appendChild(table);
    }
  }
}
