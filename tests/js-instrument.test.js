'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { instrument } = require('../js/engines/js-instrument.js');

// Exécute le code instrumenté et renvoie les étapes { line, vars } (portées fusionnées).
function trace(code) {
  const steps = [];
  const __3s = {
    s(line, getScopes) {
      const vars = {};
      for (const [, getters] of getScopes()) {
        for (const k of Object.keys(getters)) {
          try { const v = getters[k](); if (typeof v !== 'function' && !(k in vars)) vars[k] = v; } catch (e) { /* zone morte */ }
        }
      }
      steps.push({ line, vars });
    },
  };
  new Function('__3s', instrument(code))(__3s);
  return steps;
}

test('une étape par instruction, test de boucle compris, étape finale ligne 0', () => {
  const steps = trace('let s = 0;\nfor (let i = 1; i <= 2; i++) {\n  s += i;\n}\nconst fin = s;');
  assert.deepEqual(steps.map((s) => s.line), [1, 2, 2, 3, 2, 3, 2, 5, 0]);
  assert.deepEqual(steps[3].vars, { i: 1, s: 0 });
  assert.deepEqual(steps.at(-1).vars, { s: 3, fin: 3 });
});

test('variables locales des fonctions et let pas encore déclaré ignoré', () => {
  const steps = trace('function carre(x) {\n  const r = x * x;\n  return r;\n}\nconst y = carre(3);');
  const inFn = steps.find((s) => s.line === 3);
  assert.deepEqual(inFn.vars, { r: 9, x: 3 });
  assert.equal('y' in steps[0].vars, false);
});

test('if/else sans accolades, labels et directive conservés', () => {
  const code = "'use strict';\nlet n = 0;\nif (n) n = 1; else n = 2;\nouter: for (const a of [1, 2]) { continue outer; }\nconst r = n;";
  const steps = trace(code);
  assert.equal(steps.at(-1).vars.r, 2);
  assert.doesNotThrow(() => instrument('async function f() { await 1; }\nawait f();'));
});
