'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPseudocode } = require('../js/engines/pseudocode.js');

const run = (src, stdin = [], opts = {}) => runPseudocode(src, { stdin, ...opts });

test('programme complet avec en-tête, déclarations et accents', () => {
  const r = run(`Algorithme Somme
Variables
   n, s : Entier
Début
   Écrire("Combien ?")
   Lire(n)
   s <- 0
   Pour i de 1 à n faire
      s ← s + i
   Fin Pour
   Écrire("Somme = ", s)
Fin`, ['4']);
  assert.equal(r.error, null);
  assert.equal(r.output, 'Combien ?\nSomme = 10\n');
});

test('ENTIER non initialisé : erreur claire au lieu de concaténer', () => {
  const r = run('VARIABLE n : ENTIER\nn <- n + 1');
  assert.equal(r.error.line, 2);
  assert.match(r.error.message, /avant d'avoir reçu une valeur/);
});

test('type vérifié à l\'affectation', () => {
  const r = run('VARIABLE n : ENTIER\nn <- 3.5');
  assert.match(r.error.message, /type ENTIER/);
});

test('SI / SINON SI / SINON et FIN SI en deux mots', () => {
  const src = (x) => `x <- ${x}
SI x > 0 ALORS
  ECRIRE "positif"
SINON SI x = 0 ALORS
  ECRIRE "nul"
SINON
  ECRIRE "négatif"
FIN SI`;
  assert.equal(run(src(5)).output, 'positif\n');
  assert.equal(run(src(0)).output, 'nul\n');
  assert.equal(run(src(-2)).output, 'négatif\n');
});

test('TANT QUE, REPETER JUSQU\'A, DIV et MOD', () => {
  const r = run(`n <- 17
TANT QUE n MOD 2 = 1 FAIRE
  n <- n DIV 2
FIN TANT QUE
ECRIRE(n)
k <- 0
REPETER
  k <- k + 1
JUSQU'A k >= 3
ECRIRE(k)`);
  assert.equal(r.error, null);
  assert.equal(r.output, '8\n3\n');
});

test('POUR avec pas décimal inclut la borne', () => {
  const r = run('POUR i DE 0 A 0.3 PAS 0.1 FAIRE\nECRIRE(i)\nFINPOUR');
  assert.equal(r.output, '0\n0.1\n0.2\n0.3\n');
});

test('tableaux', () => {
  const r = run(`VARIABLE t : TABLEAU[3] DE ENTIER
POUR i DE 1 A 3 FAIRE
  t[i] <- i * i
FINPOUR
ECRIRE(t[1] + t[2] + t[3])
ECRIRE(t[4])`);
  assert.equal(r.output, '14\n');
  assert.match(r.error.message, /hors du tableau/);
});

test('erreurs de syntaxe lisibles', () => {
  assert.match(run('ECRIRE("abc)').error.message, /Texte non fermé/);
  assert.match(run('SI 1 > 0 ALORS\nECRIRE(1)').error.message, /FINSI/);
  assert.match(run('ECRIRE((1 + 2)').error.message, /\)/);
  const r = run('Somme <- 1\nECRIRE(somme)');
  assert.match(r.error.message, /Vouliez-vous dire « Somme »/);
});

test('LIRE sans saisie signalé', () => {
  assert.match(run('LIRE(x)').error.message, /aucune valeur saisie/);
});

test('trace : ligne à exécuter + état avant, conditions de boucle incluses', () => {
  const r = run('s <- 0\nPOUR i DE 1 A 2 FAIRE\n  s <- s + i\nFINPOUR\nECRIRE(s)', [], { trace: true });
  assert.deepEqual(r.steps.map((s) => s.line), [1, 2, 3, 2, 3, 5, null]);
  assert.deepEqual(r.steps[2].scopes[0].vars, { s: '0', i: '1' });
  const last = r.steps[r.steps.length - 1];
  assert.equal(last.final, true);
  assert.equal(r.output.slice(0, last.out), '3\n');
});

test('trace limitée sur boucle infinie', () => {
  const r = run('TANTQUE VRAI FAIRE\nx <- 1\nFINTANTQUE', [], { trace: true, maxTraceSteps: 50 });
  assert.equal(r.truncated, true);
  assert.equal(r.steps.length, 51);
});

test('boucle infinie arrêtée en mode normal', () => {
  const r = run('TANTQUE VRAI FAIRE\nFINTANTQUE');
  assert.match(r.error.message, /boucle infinie/);
});
