// Gestion des workers d'exécution : un worker par langage, gardé entre deux exécutions
// (Python et PHP restent chargés), détruit en cas d'arrêt ou de dépassement de temps.

const TIME_LIMIT_MS = 10_000;
const INPUT_BYTES = 64 * 1024;

// La saisie interactive demande une page « isolée » (en-têtes COOP/COEP, voir server/index.js).
export const canAskInput = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;

export class Runner {
  constructor({ onStatus, onOutput, onInput }) {
    this.onStatus = onStatus;
    this.onOutput = onOutput;
    this.onInput = onInput; // () => Promise<string | null>
    this.workers = new Map();
    this.current = null; // { lang, finish }
  }

  get busy() { return this.current !== null; }

  worker(lang) {
    let w = this.workers.get(lang.id);
    if (!w) {
      w = new Worker(lang.worker, lang.module ? { type: 'module' } : undefined);
      w.onmessage = (e) => this.handle(lang, e.data);
      w.onerror = (e) => {
        e.preventDefault();
        this.kill(lang.id);
        if (this.current) this.current.finish({ error: { type: 'Erreur interne', message: e.message || 'le moteur d\'exécution a planté.', line: null } });
      };
      this.workers.set(lang.id, w);
    }
    return w;
  }

  // Charge le moteur à l'avance (Python, PHP) quand l'élève choisit le langage.
  preload(lang) { this.worker(lang); }

  handle(lang, msg) {
    if (msg.type === 'status') { this.onStatus(msg.text); return; }
    const cur = this.current;
    if (!cur || cur.lang !== lang.id) return;
    if (msg.type === 'start') {
      cur.started = performance.now();
      this.startTimer(cur);
      this.onStatus(null);
    } else if (msg.type === 'input') {
      // Le temps d'attente de la saisie ne compte pas dans la limite de 10 secondes.
      clearTimeout(cur.timer);
      const waitStart = performance.now();
      this.onInput().then((line) => {
        if (this.current !== cur) return;
        cur.waited += performance.now() - waitStart;
        this.answer(cur.input, line);
        this.startTimer(cur);
      });
    } else if (msg.type === 'no-input') {
      cur.noInput = true;
    } else if (msg.type === 'out') {
      this.onOutput(msg.text, msg.stream);
    } else if (msg.type === 'end') {
      cur.finish(msg);
    }
  }

  startTimer(cur) {
    clearTimeout(cur.timer);
    cur.timer = setTimeout(() => {
      this.kill(cur.lang);
      cur.finish({ timedOut: true });
    }, TIME_LIMIT_MS);
  }

  // Écrit la ligne dans la mémoire partagée puis réveille le worker (voir createInput dans shared.js).
  answer(sab, line) {
    const ctrl = new Int32Array(sab, 0, 2);
    if (line === null) {
      Atomics.store(ctrl, 0, 2);
    } else {
      const bytes = new TextEncoder().encode(line).slice(0, INPUT_BYTES);
      new Uint8Array(sab, 8, INPUT_BYTES).set(bytes);
      Atomics.store(ctrl, 1, bytes.length);
      Atomics.store(ctrl, 0, 1);
    }
    Atomics.notify(ctrl, 0);
  }

  run(lang, { code, trace }) {
    if (this.busy) return Promise.reject(new Error('Une exécution est déjà en cours.'));
    return new Promise((resolve) => {
      const cur = {
        lang: lang.id,
        started: null,
        timer: null,
        input: canAskInput ? new SharedArrayBuffer(8 + INPUT_BYTES) : null,
        waited: 0, // temps passé à attendre la saisie (exclu de la durée affichée)
        finish: (result) => {
          clearTimeout(cur.timer);
          this.current = null;
          const seconds = cur.started ? (performance.now() - cur.started - cur.waited) / 1000 : null;
          resolve({ ...result, seconds, noInput: cur.noInput });
        },
      };
      this.current = cur;
      this.worker(lang).postMessage({ cmd: 'run', code, trace, input: cur.input });
    });
  }

  stop() {
    if (!this.current) return;
    this.kill(this.current.lang);
    this.current.finish({ stopped: true });
  }

  kill(id) {
    const w = this.workers.get(id);
    if (w) w.terminate();
    this.workers.delete(id);
  }
}

export const TIME_LIMIT_SECONDS = TIME_LIMIT_MS / 1000;
