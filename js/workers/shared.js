/*
 * 3S Compilator : outils partagés par les workers d'exécution.
 *
 * Protocole commun (identique pour tous les langages) :
 *   page → worker : { cmd: 'run', code, trace, input }   input = SharedArrayBuffer de saisie (ou null)
 *   worker → page : { type: 'status', text }          chargement du moteur
 *                   { type: 'start' }                 l'exécution commence (démarre le chrono)
 *                   { type: 'out', text, stream }     sortie en direct, stream = 'out' | 'err'
 *                   { type: 'input' }                 le programme attend une ligne tapée dans la console
 *                   { type: 'end', error, output, steps, truncated }
 *     error = { message, line } | null
 *     steps = [{ line, scopes: [{ name, vars: { nom: 'valeur' } }], out, final? }] (mode pas à pas)
 *     Chaque étape = ligne qui VA être exécutée + état AVANT ; `out` = longueur de la sortie à cet instant.
 */
(function () {
  'use strict';

  const TRACE_LIMIT = 5000; // étapes maximum enregistrées en mode pas à pas
  const OUTPUT_LIMIT = 2_000_000; // caractères de sortie maximum
  const FLUSH_MS = 40;

  // Sortie regroupée : évite d'inonder la page de messages (print dans une boucle).
  function createOutput() {
    let text = '';
    let pending = '';
    let pendingStream = 'out';
    let last = Date.now();
    let full = false;

    function flush() {
      if (pending) self.postMessage({ type: 'out', text: pending, stream: pendingStream });
      pending = '';
      last = Date.now();
    }

    return {
      // Texte déjà affiché par la page (saisie de l'élève) : seulement mémorisé pour le pas à pas.
      record(chunk) {
        if (!full) text += chunk;
      },
      write(chunk, stream = 'out') {
        if (full || !chunk) return;
        if (text.length + chunk.length > OUTPUT_LIMIT) {
          chunk = chunk.slice(0, OUTPUT_LIMIT - text.length) + '\n… sortie tronquée (trop longue).\n';
          full = true;
        }
        text += chunk;
        if (stream !== pendingStream) flush();
        pendingStream = stream;
        pending += chunk;
        if (Date.now() - last > FLUSH_MS) flush();
      },
      flush,
      get text() { return text; },
      get length() { return text.length; },
    };
  }

  // Enregistreur d'étapes : ignore les doublons consécutifs et s'arrête à la limite.
  function createTrace() {
    const steps = [];
    let lastKey = '';
    return {
      steps,
      full: false,
      push(line, scopes, out) {
        const key = line + '|' + out + '|' + JSON.stringify(scopes);
        if (key === lastKey) return true;
        if (steps.length >= TRACE_LIMIT) { this.full = true; return false; }
        lastKey = key;
        steps.push({ line, scopes, out });
        return true;
      },
      finish(line, scopes, out) {
        steps.push({ line, scopes, out, final: true });
      },
    };
  }

  // Représentation lisible d'une valeur JavaScript (proche de la console de Node).
  function inspect(value, quoteStrings = false, depth = 0, seen = new Set()) {
    const t = typeof value;
    if (t === 'string') {
      if (!quoteStrings) return value;
      return JSON.stringify(value.length > 200 ? value.slice(0, 200) + '…' : value);
    }
    if (t === 'number') return Object.is(value, -0) ? '-0' : String(value);
    if (t === 'bigint') return value + 'n';
    if (t === 'undefined' || value === null || t === 'boolean' || t === 'symbol') return String(value);
    if (t === 'function') {
      const isClass = /^class\b/.test(Function.prototype.toString.call(value));
      return isClass ? `[class ${value.name || 'anonyme'}]` : `ƒ ${value.name || 'anonyme'}()`;
    }
    if (seen.has(value)) return '[Circulaire]';
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof Date) return isNaN(value) ? 'Invalid Date' : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';

    seen.add(value);
    const sub = (v) => inspect(v, true, depth + 1, seen);
    const MAX = 50;
    let res;
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX).map(sub);
      if (value.length > MAX) items.push(`… ${value.length - MAX} de plus`);
      res = `[${items.join(', ')}]`;
    } else if (value instanceof Map) {
      const items = [...value].slice(0, MAX).map(([k, v]) => `${sub(k)} => ${sub(v)}`);
      res = `Map(${value.size}) {${items.join(', ')}}`;
    } else if (value instanceof Set) {
      res = `Set(${value.size}) {${[...value].slice(0, MAX).map(sub).join(', ')}}`;
    } else {
      const keys = Object.keys(value);
      const items = keys.slice(0, MAX).map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${sub(value[k])}`);
      if (keys.length > MAX) items.push('…');
      const ctor = value.constructor && value.constructor.name;
      const prefix = ctor && ctor !== 'Object' ? ctor + ' ' : '';
      res = items.length ? `${prefix}{ ${items.join(', ')} }` : `${prefix}{}`;
    }
    seen.delete(value);
    return res;
  }

  // Saisie interactive : le worker se met en pause (Atomics.wait) jusqu'à ce que l'élève
  // tape une ligne dans la console. Mémoire partagée : [état, longueur] puis les octets UTF-8.
  //   état 0 = en attente, 1 = ligne disponible, 2 = fin de saisie (Ctrl+D).
  // Renvoie la ligne (sans le retour à la ligne) ou null si aucune saisie n'est possible.
  function createInput(sab, out) {
    const decoder = new TextDecoder();
    return function readLine() {
      out.flush(); // la question (« Votre nom ? ») doit s'afficher avant la pause
      if (!sab) {
        self.postMessage({ type: 'no-input' });
        return null;
      }
      const ctrl = new Int32Array(sab, 0, 2);
      Atomics.store(ctrl, 0, 0);
      self.postMessage({ type: 'input' });
      Atomics.wait(ctrl, 0, 0);
      if (Atomics.load(ctrl, 0) === 2) return null;
      const line = decoder.decode(new Uint8Array(sab, 8, Atomics.load(ctrl, 1)).slice());
      out.record(line + '\n');
      return line;
    };
  }

  self.ThreeS = { createOutput, createTrace, createInput, inspect, TRACE_LIMIT };
})();
