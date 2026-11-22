/*
 * 3S Compilator : Interpréteur du langage « Algorithme » (pseudocode français).
 *
 * Syntaxe (mots-clés insensibles à la casse et aux accents : ÉCRIRE = ecrire) :
 *
 *   ALGORITHME NomDeLAlgorithme              (en-tête optionnel)
 *   VARIABLES                                (ou VARIABLE / VAR)
 *       a, b : ENTIER                        types : ENTIER, REEL, CHAINE, CARACTERE, BOOLEEN
 *       t : TABLEAU[10] DE REEL              tableau (indices 0 à 10 acceptés)
 *       total <- 0                           déclaration avec valeur initiale
 *   DEBUT
 *       x <- expression                      affectation (←, := et = acceptés)
 *       ECRIRE("texte", x)                   ou AFFICHER ; parenthèses optionnelles
 *       LIRE(x)                              lit une ligne de l'entrée (STDIN)
 *       SI c ALORS … SINON SI c ALORS … SINON … FINSI        (ou FIN SI)
 *       TANTQUE c FAIRE … FINTANTQUE                         (ou TANT QUE / FIN TANT QUE)
 *       POUR i DE 1 A n [PAS p] FAIRE … FINPOUR              (ou POUR i <- 1 A n)
 *       REPETER … JUSQU'A c
 *   FIN
 *
 * Opérateurs : + - * / DIV MOD % ^ & (concaténation)
 *              = <> != < > <= >= (≠ ≤ ≥)   ET OU NON   VRAI FAUX
 * Fonctions  : ABS RACINE ARRONDI ENT LONGUEUR MAJUSCULE MINUSCULE ALEA(a, b)
 * Commentaires : // …   # …   /* … *\/
 *
 * Exécution :
 *   const r = runPseudocode(source, { readLine, trace: true, onOutput });
 *   readLine() renvoie la ligne tapée par l'élève, ou null s'il n'y en a plus ({ stdin: [...] } pour les tests).
 *   r = { output, error: { type, message, line, column } | null, steps: [{ line, scopes, out }] }
 * En mode trace, chaque étape décrit la ligne qui VA être exécutée et l'état AVANT.
 */
(function (global) {
  'use strict';

  const MAX_STEPS = 2_000_000; // garde-fou contre les boucles infinies (mode normal)

  const KEYWORDS = new Set([
    'ALGORITHME', 'VARIABLE', 'VARIABLES', 'VAR', 'CONSTANTE', 'DEBUT', 'FIN',
    'ENTIER', 'REEL', 'CHAINE', 'CARACTERE', 'BOOLEEN', 'TABLEAU',
    'ECRIRE', 'AFFICHER', 'LIRE', 'SAISIR',
    'SI', 'ALORS', 'SINON', 'FINSI',
    'TANTQUE', 'TANT', 'QUE', 'FAIRE', 'FINTANTQUE',
    'POUR', 'DE', 'A', 'PAS', 'FINPOUR',
    'REPETER', 'JUSQUA',
    'ET', 'OU', 'NON', 'VRAI', 'FAUX', 'DIV', 'MOD',
  ]);

  const TYPES = new Set(['ENTIER', 'REEL', 'CHAINE', 'CARACTERE', 'BOOLEEN']);

  const BUILTINS = {
    ABS: [1, (x) => Math.abs(num(x))],
    RACINE: [1, (x) => {
      if (num(x) < 0) throw new Error('RACINE d\'un nombre négatif.');
      return Math.sqrt(x);
    }],
    ARRONDI: [1, (x) => Math.round(num(x))],
    ENT: [1, (x) => Math.floor(num(x))],
    LONGUEUR: [1, (x) => String(x).length],
    MAJUSCULE: [1, (x) => String(x).toUpperCase()],
    MINUSCULE: [1, (x) => String(x).toLowerCase()],
    ALEA: [2, (a, b) => Math.floor(Math.random() * (num(b) - num(a) + 1)) + num(a)],
  };

  function num(x) {
    if (typeof x !== 'number') throw new Error(`Un nombre est attendu, reçu ${show(x)}.`);
    return x;
  }

  class PseudoError extends Error {
    constructor(message, line, col) {
      super(message);
      this.line = line;
      this.col = col;
    }
  }

  // Signal interne : limite d'étapes atteinte en mode trace (pas une erreur de l'élève).
  class StepLimit extends Error {}

  // Valeur d'une variable déclarée mais jamais affectée.
  const UNSET = Symbol('non initialisée');

  const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // ------------------------------------------------------------------ Lexer
  function tokenize(src) {
    const tokens = [];
    let i = 0;
    let line = 1;
    let lineStart = 0;
    const n = src.length;
    const col = () => i - lineStart + 1;
    const push = (type, value) => tokens.push({ type, value, line, col: col() });

    while (i < n) {
      const c = src[i];

      if (c === '\n') { push('NL', null); line++; i++; lineStart = i; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

      if ((c === '/' && src[i + 1] === '/') || c === '#') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const start = line;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { line++; lineStart = i + 1; } i++; }
        if (i >= n) throw new PseudoError('Commentaire /* … non fermé.', start);
        i += 2;
        continue;
      }

      if (c === '"' || c === '\'' || c === '«' || c === '“') {
        const close = c === '«' ? '»' : c === '“' ? '”' : c;
        let j = i + 1;
        let s = '';
        while (j < n && src[j] !== close) {
          if (src[j] === '\n') throw new PseudoError('Texte non fermé : il manque ' + close + ' avant la fin de la ligne.', line, col());
          if (src[j] === '\\' && j + 1 < n) { s += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; }
          s += src[j++];
        }
        if (j >= n) throw new PseudoError('Texte non fermé : il manque ' + close + '.', line, col());
        push('STRING', s);
        i = j + 1;
        continue;
      }

      if (/[0-9]/.test(c)) {
        let j = i;
        while (j < n && /[0-9]/.test(src[j])) j++;
        if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
        push('NUMBER', parseFloat(src.slice(i, j)));
        i = j;
        continue;
      }

      if (/[\p{L}_]/u.test(c)) {
        let j = i;
        while (j < n && /[\p{L}\p{N}_]/u.test(src[j])) j++;
        const word = src.slice(i, j);
        let up = strip(word).toUpperCase();
        // JUSQU'A / jusqu’à
        if (up === 'JUSQU' && (src[j] === '\'' || src[j] === '’')) {
          const m = /^[aAàÀ]\b/.exec(src.slice(j + 1, j + 3));
          if (m) { push('JUSQUA', word); i = j + 2; continue; }
        }
        push(KEYWORDS.has(up) ? up : 'IDENT', word);
        i = j;
        continue;
      }

      const two = src.substr(i, 2);
      const twoOps = { '<-': '<-', ':=': '<-', '<=': '<=', '>=': '>=', '==': '=', '!=': '<>', '<>': '<>' };
      if (twoOps[two]) { push('OP', twoOps[two]); i += 2; continue; }
      const oneOps = { '←': '<-', '≤': '<=', '≥': '>=', '≠': '<>', '×': '*', '÷': '/' };
      if (oneOps[c]) { push('OP', oneOps[c]); i++; continue; }
      if ('+-*/%^=<>()[],:&;'.includes(c)) { push('OP', c); i++; continue; }

      throw new PseudoError(`Caractère inattendu : « ${c} »`, line, col());
    }
    push('NL', null);
    push('EOF', null);
    return tokens;
  }

  const describe = (t) => (t.type === 'EOF' ? 'la fin du programme'
    : t.type === 'NL' ? 'la fin de la ligne'
      : t.type === 'STRING' ? `"${t.value}"` : `« ${t.value} »`);

  // ----------------------------------------------------------------- Parser
  class Parser {
    constructor(tokens) {
      this.t = tokens;
      this.p = 0;
    }

    cur() { return this.t[this.p]; }
    next() { return this.t[this.p + 1]; }
    advance() { return this.t[this.p++]; }
    is(type, value) {
      const t = this.cur();
      return t.type === type && (value === undefined || t.value === value);
    }
    isOp(v) { return this.is('OP', v); }
    accept(type, value) { return this.is(type, value) ? this.advance() : null; }
    expect(type, value, what) {
      if (this.is(type, value)) return this.advance();
      throw new PseudoError(`${what || `« ${value || type} »`} attendu, mais trouvé ${describe(this.cur())}.`, this.cur().line, this.cur().col);
    }
    skipNL() { while (this.is('NL') || this.isOp(';')) this.advance(); }
    endOfStatement() {
      if (this.is('NL') || this.isOp(';') || this.is('EOF')) return;
      throw new PseudoError(`Fin d'instruction attendue, mais trouvé ${describe(this.cur())}.`, this.cur().line, this.cur().col);
    }

    // Mots de fin composés : FINSI ou « FIN SI », FINTANTQUE ou « FIN TANT QUE »…
    isEnd(kind) {
      if (this.is('FIN' + kind)) return true;
      if (!this.is('FIN')) return false;
      const nx = this.next();
      if (kind === 'TANTQUE') return nx.type === 'TANTQUE' || nx.type === 'TANT';
      return nx.type === kind;
    }
    eatEnd(kind, label) {
      if (this.accept('FIN' + kind)) return;
      if (this.isEnd(kind)) {
        this.advance();
        if (kind === 'TANTQUE' && this.accept('TANT')) this.expect('QUE');
        else this.advance();
        return;
      }
      throw new PseudoError(`${label} attendu, mais trouvé ${describe(this.cur())}.`, this.cur().line, this.cur().col);
    }

    parseProgram() {
      const body = [];
      this.skipNL();
      if (this.accept('ALGORITHME')) {
        this.accept('IDENT');
        this.endOfStatement();
      }
      this.skipNL();
      let hasDebut = false;
      while (!this.is('EOF')) {
        if (this.accept('DEBUT')) { hasDebut = true; this.skipNL(); continue; }
        if (hasDebut && this.is('FIN') && !['SI', 'POUR', 'TANTQUE', 'TANT'].includes(this.next().type)) {
          this.advance();
          this.skipNL();
          if (!this.is('EOF')) throw new PseudoError('Instruction après FIN : le programme est déjà terminé.', this.cur().line, this.cur().col);
          break;
        }
        body.push(this.parseStatement());
        this.skipNL();
      }
      return body;
    }

    parseBlock(stop) {
      const body = [];
      this.skipNL();
      while (!stop() && !this.is('EOF')) {
        body.push(this.parseStatement());
        this.skipNL();
      }
      return body;
    }

    parseStatement() {
      const t = this.cur();
      switch (t.type) {
        case 'VARIABLE': case 'VARIABLES': case 'VAR': case 'CONSTANTE': return this.parseDeclarations();
        case 'TABLEAU': return this.parseDeclarations();
        case 'ECRIRE': case 'AFFICHER': return this.parseEcrire();
        case 'LIRE': case 'SAISIR': return this.parseLire();
        case 'SI': return this.parseSi();
        case 'TANTQUE': case 'TANT': return this.parseTantQue();
        case 'POUR': return this.parsePour();
        case 'REPETER': return this.parseRepeter();
        case 'IDENT': return this.parseAssign();
        case 'FIN': case 'FINSI': case 'FINPOUR': case 'FINTANTQUE': case 'SINON': case 'JUSQUA':
          throw new PseudoError(`« ${t.value} » inattendu : aucun bloc correspondant n'est ouvert.`, t.line, t.col);
        default:
          throw new PseudoError(`Instruction inattendue : ${describe(t)}.`, t.line, t.col);
      }
    }

    // VARIABLES  a, b : ENTIER   (sur la même ligne ou sur les lignes suivantes)
    parseDeclarations() {
      const first = this.advance();
      const decls = [];
      const isArrayHeader = first.type === 'TABLEAU';
      this.skipNL();
      do {
        decls.push(...this.parseDeclLine(isArrayHeader));
        this.skipNL();
      } while (this.is('IDENT') && this.looksLikeDecl());
      return { type: 'Decl', decls, line: first.line, col: first.col };
    }

    looksLikeDecl() {
      const nx = this.next();
      return nx.type === 'OP' && (nx.value === ',' || nx.value === ':' || nx.value === '[');
    }

    parseDeclLine(arrayHeader) {
      const line = this.cur().line;
      const names = [];
      do {
        const name = this.expect('IDENT', undefined, 'Nom de variable').value;
        let size = null;
        if (this.accept('OP', '[')) { size = this.parseExpr(); this.expect('OP', ']'); }
        names.push({ name, size });
      } while (this.accept('OP', ','));

      let type = null;
      if (this.accept('OP', ':')) type = this.parseType(names);
      for (const n of names) if (arrayHeader && !n.size) throw new PseudoError(`Taille du tableau « ${n.name} » attendue : ${n.name}[10].`, line);

      let init = null;
      if (this.isOp('<-') || this.isOp('=')) {
        if (names.length > 1) throw new PseudoError('Une valeur initiale ne peut être donnée qu\'à une seule variable à la fois.', line);
        this.advance();
        init = this.parseExpr();
      }
      return names.map((n) => ({ ...n, type: type && type.elem ? type.elem : type, size: n.size || (type && type.size) || null, init, line }));
    }

    parseType(names) {
      if (this.accept('TABLEAU')) {
        let size = null;
        if (this.accept('OP', '[')) { size = this.parseExpr(); this.expect('OP', ']'); }
        if (!size && !names.every((n) => n.size)) throw new PseudoError('Taille du tableau attendue : TABLEAU[10] DE ENTIER.', this.cur().line, this.cur().col);
        let elem = null;
        if (this.accept('DE')) elem = this.parseBaseType();
        return { size, elem };
      }
      return this.parseBaseType();
    }

    parseBaseType() {
      const t = this.cur();
      if (TYPES.has(t.type)) { this.advance(); return t.type; }
      throw new PseudoError(`Type attendu (ENTIER, REEL, CHAINE, CARACTERE, BOOLEEN), mais trouvé ${describe(t)}.`, t.line, t.col);
    }

    parseEcrire() {
      const t = this.advance();
      const args = [];
      // ECRIRE("a", b) : la parenthèse entoure la liste ; ECRIRE (a + b) * 2 reste une expression.
      if (this.isOp('(') && this.parenWrapsWholeStatement()) {
        this.advance();
        if (!this.isOp(')')) args.push(...this.parseArgList());
        this.expect('OP', ')', '« ) »');
      } else if (!this.is('NL') && !this.is('EOF')) {
        args.push(...this.parseArgList());
      }
      this.endOfStatement();
      return { type: 'Ecrire', args, line: t.line, col: t.col };
    }

    // Vrai si la parenthèse ouvrante courante se ferme juste avant la fin de l'instruction.
    parenWrapsWholeStatement() {
      let depth = 0;
      for (let k = this.p; k < this.t.length; k++) {
        const tk = this.t[k];
        if (tk.type === 'NL' || tk.type === 'EOF') return false;
        if (tk.type === 'OP' && tk.value === '(') depth++;
        if (tk.type === 'OP' && tk.value === ')' && --depth === 0) {
          const after = this.t[k + 1];
          return after.type === 'NL' || after.type === 'EOF' || (after.type === 'OP' && after.value === ';');
        }
      }
      return false;
    }

    parseArgList() {
      const args = [this.parseExpr()];
      while (this.accept('OP', ',')) args.push(this.parseExpr());
      return args;
    }

    parseLire() {
      const t = this.advance();
      const paren = this.accept('OP', '(');
      const targets = [];
      do targets.push(this.parseTarget()); while (this.accept('OP', ','));
      if (paren) this.expect('OP', ')', '« ) »');
      this.endOfStatement();
      return { type: 'Lire', targets, line: t.line, col: t.col };
    }

    parseTarget() {
      const id = this.expect('IDENT', undefined, 'Nom de variable');
      if (this.accept('OP', '[')) {
        const index = this.parseExpr();
        this.expect('OP', ']', '« ] »');
        return { type: 'Index', name: id.value, index, line: id.line, col: id.col };
      }
      return { type: 'Var', name: id.value, line: id.line, col: id.col };
    }

    parseAssign() {
      const target = this.parseTarget();
      if (!(this.isOp('<-') || this.isOp('='))) {
        throw new PseudoError(`Instruction incomplète après « ${target.name} » : utilisez ${target.name} <- valeur.`, target.line, target.col);
      }
      this.advance();
      const value = this.parseExpr();
      this.endOfStatement();
      return { type: 'Assign', target, value, line: target.line, col: target.col };
    }

    // nested = vrai pour un « SINON SI » : il partage le FINSI du SI parent.
    parseSi(nested = false) {
      const t = this.advance();
      const cond = this.parseExpr();
      this.expect('ALORS', undefined, '« ALORS »');
      const thenBody = this.parseBlock(() => this.is('SINON') || this.isEnd('SI'));
      let elseBody = [];
      if (this.is('SINON')) {
        this.advance();
        if (this.is('SI')) {
          elseBody = [this.parseSi(true)];
          if (!nested) this.eatEnd('SI', '« FINSI »');
          return { type: 'Si', cond, thenBody, elseBody, line: t.line, col: t.col };
        }
        elseBody = this.parseBlock(() => this.isEnd('SI'));
      }
      if (!nested) this.eatEnd('SI', '« FINSI »');
      return { type: 'Si', cond, thenBody, elseBody, line: t.line, col: t.col };
    }

    parseTantQue() {
      const t = this.advance();
      if (t.type === 'TANT') this.expect('QUE', undefined, '« QUE »');
      const cond = this.parseExpr();
      this.expect('FAIRE', undefined, '« FAIRE »');
      const body = this.parseBlock(() => this.isEnd('TANTQUE'));
      this.eatEnd('TANTQUE', '« FINTANTQUE »');
      return { type: 'TantQue', cond, body, line: t.line, col: t.col };
    }

    parsePour() {
      const t = this.advance();
      const target = this.expect('IDENT', undefined, 'Nom du compteur');
      if (!this.accept('DE') && !this.accept('OP', '<-') && !this.accept('OP', '=')) {
        throw new PseudoError(`« DE » attendu après POUR ${target.value}.`, t.line, t.col);
      }
      const from = this.parseExpr();
      this.expect('A', undefined, '« A »');
      const to = this.parseExpr();
      const step = this.accept('PAS') ? this.parseExpr() : null;
      this.expect('FAIRE', undefined, '« FAIRE »');
      const body = this.parseBlock(() => this.isEnd('POUR'));
      this.eatEnd('POUR', '« FINPOUR »');
      return { type: 'Pour', name: target.value, from, to, step, body, line: t.line, col: t.col };
    }

    parseRepeter() {
      const t = this.advance();
      const body = this.parseBlock(() => this.is('JUSQUA'));
      const until = this.expect('JUSQUA', undefined, '« JUSQU\'A »');
      const cond = this.parseExpr();
      this.endOfStatement();
      return { type: 'Repeter', body, cond, line: t.line, col: t.col, untilLine: until.line };
    }

    // ---- Expressions (de la plus faible à la plus forte priorité)
    parseExpr() { return this.parseOr(); }

    parseOr() {
      let left = this.parseAnd();
      while (this.is('OU')) { const t = this.advance(); left = { type: 'Logic', op: 'OU', left, right: this.parseAnd(), line: t.line, col: t.col }; }
      return left;
    }

    parseAnd() {
      let left = this.parseNot();
      while (this.is('ET')) { const t = this.advance(); left = { type: 'Logic', op: 'ET', left, right: this.parseNot(), line: t.line, col: t.col }; }
      return left;
    }

    parseNot() {
      if (this.is('NON')) { const t = this.advance(); return { type: 'Not', value: this.parseNot(), line: t.line, col: t.col }; }
      return this.parseCompare();
    }

    parseCompare() {
      let left = this.parseConcat();
      while (this.cur().type === 'OP' && ['=', '<>', '<', '>', '<=', '>='].includes(this.cur().value)) {
        const t = this.advance();
        left = { type: 'Compare', op: t.value, left, right: this.parseConcat(), line: t.line, col: t.col };
      }
      return left;
    }

    parseConcat() {
      let left = this.parseAdd();
      while (this.isOp('&')) { const t = this.advance(); left = { type: 'Concat', left, right: this.parseAdd(), line: t.line, col: t.col }; }
      return left;
    }

    parseAdd() {
      let left = this.parseMul();
      while (this.isOp('+') || this.isOp('-')) {
        const t = this.advance();
        left = { type: 'Bin', op: t.value, left, right: this.parseMul(), line: t.line, col: t.col };
      }
      return left;
    }

    parseMul() {
      let left = this.parseUnary();
      while (this.isOp('*') || this.isOp('/') || this.isOp('%') || this.is('DIV') || this.is('MOD')) {
        const t = this.advance();
        const op = t.type === 'OP' ? (t.value === '%' ? 'MOD' : t.value) : t.type;
        left = { type: 'Bin', op, left, right: this.parseUnary(), line: t.line, col: t.col };
      }
      return left;
    }

    parseUnary() {
      if (this.isOp('-')) { const t = this.advance(); return { type: 'Neg', value: this.parseUnary(), line: t.line, col: t.col }; }
      if (this.isOp('+')) { this.advance(); return this.parseUnary(); }
      return this.parsePow();
    }

    parsePow() {
      const base = this.parsePrimary();
      if (this.isOp('^')) {
        const t = this.advance();
        return { type: 'Bin', op: '^', left: base, right: this.parseUnary(), line: t.line, col: t.col };
      }
      return base;
    }

    parsePrimary() {
      const t = this.cur();
      if (t.type === 'NUMBER') { this.advance(); return { type: 'Lit', value: t.value, line: t.line, col: t.col }; }
      if (t.type === 'STRING') { this.advance(); return { type: 'Lit', value: t.value, line: t.line, col: t.col }; }
      if (t.type === 'VRAI' || t.type === 'FAUX') { this.advance(); return { type: 'Lit', value: t.type === 'VRAI', line: t.line, col: t.col }; }
      if (t.type === 'IDENT') {
        const up = strip(t.value).toUpperCase();
        if (this.next().type === 'OP' && this.next().value === '(' && BUILTINS[up]) {
          this.advance();
          this.advance();
          const args = this.isOp(')') ? [] : this.parseArgList();
          this.expect('OP', ')', '« ) »');
          if (args.length !== BUILTINS[up][0]) throw new PseudoError(`${up} attend ${BUILTINS[up][0]} argument(s).`, t.line, t.col);
          return { type: 'Call', name: up, args, line: t.line, col: t.col };
        }
        return this.parseTarget();
      }
      if (this.isOp('(')) {
        this.advance();
        const e = this.parseExpr();
        this.expect('OP', ')', '« ) »');
        return e;
      }
      throw new PseudoError(`Valeur ou expression attendue, mais trouvé ${describe(t)}.`, t.line, t.col);
    }
  }

  // ------------------------------------------------------------ Affichage
  function fmtNumber(v) {
    if (Number.isInteger(v)) return String(v);
    if (!Number.isFinite(v)) return String(v);
    return String(Number(v.toPrecision(12))); // 0.1 + 0.2 affiche 0.3
  }

  function fmt(v) {
    if (v === UNSET) return '?';
    if (typeof v === 'boolean') return v ? 'VRAI' : 'FAUX';
    if (typeof v === 'number') return fmtNumber(v);
    if (Array.isArray(v)) return '[' + v.map(show).join(', ') + ']';
    return String(v);
  }

  // Représentation dans le panneau des variables (texte entre guillemets).
  function show(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    return fmt(v);
  }

  // ------------------------------------------------------------ Interpréteur
  class Interpreter {
    constructor({ stdin = [], readLine, trace = false, maxTraceSteps = 5000, onOutput } = {}) {
      const queue = stdin.slice();
      this.readLine = readLine || (() => (queue.length ? queue.shift() : null));
      this.trace = trace;
      this.maxTraceSteps = maxTraceSteps;
      this.onOutput = onOutput || (() => {});
      this.output = '';
      this.vars = new Map(); // nom -> { type, value, size }
      this.steps = [];
      this.count = 0;
    }

    write(text) {
      this.output += text;
      this.onOutput(text);
    }

    step(line) {
      if (++this.count > MAX_STEPS) throw new PseudoError('Arrêt : trop d\'étapes (boucle infinie ?).', line);
      if (!this.trace) return;
      if (this.steps.length >= this.maxTraceSteps) throw new StepLimit();
      const vars = {};
      for (const [name, v] of this.vars) vars[name] = show(v.value);
      this.steps.push({ line, scopes: [{ name: 'global', vars }], out: this.output.length });
    }

    lookup(name, line) {
      const v = this.vars.get(name);
      if (v) return v;
      const close = [...this.vars.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
      throw new PseudoError(`Variable « ${name} » inconnue.` + (close ? ` Vouliez-vous dire « ${close} » ?` : ' Déclarez-la ou donnez-lui une valeur d\'abord.'), line);
    }

    convert(value, type, name, line) {
      if (!type || value === UNSET) return value;
      const bad = () => new PseudoError(`« ${name} » est de type ${type} : impossible d'y mettre ${show(value)}.`, line);
      switch (type) {
        case 'ENTIER':
          if (typeof value !== 'number' || !Number.isInteger(value)) throw bad();
          return value;
        case 'REEL':
          if (typeof value !== 'number') throw bad();
          return value;
        case 'BOOLEEN':
          if (typeof value !== 'boolean') throw bad();
          return value;
        case 'CARACTERE':
          if (typeof value !== 'string' || value.length > 1) throw bad();
          return value;
        default: // CHAINE
          return typeof value === 'string' ? value : fmt(value);
      }
    }

    declare(d) {
      if (this.vars.has(d.name)) throw new PseudoError(`La variable « ${d.name} » est déjà déclarée.`, d.line);
      if (d.size) {
        const size = this.eval(d.size);
        if (!Number.isInteger(size) || size < 1) throw new PseudoError(`Taille de tableau invalide : ${show(size)}.`, d.line);
        this.vars.set(d.name, { type: d.type, size, value: new Array(size + 1).fill(UNSET) });
        return;
      }
      const entry = { type: d.type, value: UNSET };
      this.vars.set(d.name, entry);
      if (d.init) entry.value = this.convert(this.eval(d.init), d.type, d.name, d.line);
    }

    assign(target, value, line) {
      if (target.type === 'Index') {
        const v = this.lookup(target.name, line);
        if (!Array.isArray(v.value)) throw new PseudoError(`« ${target.name} » n'est pas un tableau.`, line);
        const i = this.index(v, target, line);
        v.value[i] = this.convert(value, v.type, `${target.name}[${i}]`, line);
        return;
      }
      const v = this.vars.get(target.name);
      if (!v) { this.vars.set(target.name, { type: null, value }); return; }
      if (Array.isArray(v.value)) throw new PseudoError(`« ${target.name} » est un tableau : précisez une case, par exemple ${target.name}[1].`, line);
      v.value = this.convert(value, v.type, target.name, line);
    }

    index(v, target, line) {
      const i = this.eval(target.index);
      if (!Number.isInteger(i)) throw new PseudoError(`L'indice de « ${target.name} » doit être un entier (reçu ${show(i)}).`, line);
      if (i < 0 || i > v.size) throw new PseudoError(`Indice ${i} hors du tableau « ${target.name} » (0 à ${v.size}).`, line);
      return i;
    }

    eval(node) {
      switch (node.type) {
        case 'Lit': return node.value;
        case 'Var': {
          const v = this.lookup(node.name, node.line, node.col);
          if (v.value === UNSET) throw new PseudoError(`La variable « ${node.name} » est utilisée avant d'avoir reçu une valeur.`, node.line, node.col);
          return v.value;
        }
        case 'Index': {
          const v = this.lookup(node.name, node.line, node.col);
          if (!Array.isArray(v.value)) throw new PseudoError(`« ${node.name} » n'est pas un tableau.`, node.line, node.col);
          const i = this.index(v, node, node.line, node.col);
          if (v.value[i] === UNSET) throw new PseudoError(`La case ${node.name}[${i}] n'a pas encore de valeur.`, node.line, node.col);
          return v.value[i];
        }
        case 'Neg': return -this.number(this.eval(node.value), '-', node.line, node.col);
        case 'Not': return !this.bool(this.eval(node.value), 'NON', node.line, node.col);
        case 'Concat': return fmt(this.eval(node.left)) + fmt(this.eval(node.right));
        case 'Logic': {
          const l = this.bool(this.eval(node.left), node.op, node.line, node.col);
          if (node.op === 'ET') return l && this.bool(this.eval(node.right), node.op, node.line, node.col);
          return l || this.bool(this.eval(node.right), node.op, node.line, node.col);
        }
        case 'Compare': {
          const l = this.eval(node.left);
          const r = this.eval(node.right);
          if (node.op === '=') return l === r;
          if (node.op === '<>') return l !== r;
          if (typeof l !== typeof r) throw new PseudoError(`Comparaison impossible entre ${show(l)} et ${show(r)}.`, node.line, node.col);
          switch (node.op) {
            case '<': return l < r;
            case '>': return l > r;
            case '<=': return l <= r;
            default: return l >= r;
          }
        }
        case 'Bin': {
          const l = this.eval(node.left);
          const r = this.eval(node.right);
          if (node.op === '+' && (typeof l === 'string' || typeof r === 'string')) return fmt(l) + fmt(r);
          const a = this.number(l, node.op, node.line, node.col);
          const b = this.number(r, node.op, node.line, node.col);
          switch (node.op) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '^': return a ** b;
            case '/':
              if (b === 0) throw new PseudoError('Division par zéro.', node.line, node.col);
              return a / b;
            case 'DIV':
              if (b === 0) throw new PseudoError('Division par zéro.', node.line, node.col);
              return Math.trunc(a / b);
            default: // MOD
              if (b === 0) throw new PseudoError('Division par zéro (MOD 0).', node.line, node.col);
              return a % b;
          }
        }
        case 'Call': {
          const args = node.args.map((a) => this.eval(a));
          try { return BUILTINS[node.name][1](...args); } catch (e) { throw new PseudoError(`${node.name} : ${e.message}`, node.line, node.col); }
        }
        default: throw new PseudoError('Expression non reconnue.', node.line, node.col);
      }
    }

    number(v, op, line) {
      if (typeof v !== 'number') throw new PseudoError(`L'opérateur « ${op} » s'applique à des nombres, pas à ${show(v)}.`, line);
      return v;
    }

    bool(v, op, line) {
      if (typeof v !== 'boolean') throw new PseudoError(`« ${op} » s'applique à VRAI/FAUX, pas à ${show(v)}.`, line);
      return v;
    }

    readValue(target, line) {
      const raw = this.readLine();
      if (raw === null) throw new PseudoError('LIRE : aucune valeur saisie.', line);
      const entry = this.lookup(target.name, line);
      const t = entry.type;
      const trimmed = raw.trim().replace(',', '.');
      let value = raw;
      if (t === 'ENTIER' || t === 'REEL' || (!t && trimmed !== '' && !isNaN(Number(trimmed)))) {
        value = Number(trimmed);
        if (trimmed === '' || isNaN(value)) throw new PseudoError(`LIRE : « ${raw} » n'est pas un nombre.`, line);
      } else if (t === 'BOOLEEN') {
        const up = strip(trimmed).toUpperCase();
        if (up !== 'VRAI' && up !== 'FAUX') throw new PseudoError(`LIRE : « ${raw} » n'est ni VRAI ni FAUX.`, line);
        value = up === 'VRAI';
      }
      this.assign(target, value, line);
    }

    truth(node) { return this.bool(this.eval(node), 'condition', node.line, node.col); }

    exec(stmts) {
      for (const s of stmts) this.run1(s);
    }

    run1(s) {
      switch (s.type) {
        case 'Decl':
          this.step(s.line);
          for (const d of s.decls) this.declare(d);
          return;
        case 'Assign':
          this.step(s.line);
          this.assign(s.target, this.eval(s.value), s.line);
          return;
        case 'Ecrire':
          this.step(s.line);
          this.write(s.args.map((a) => fmt(this.eval(a))).join('') + '\n');
          return;
        case 'Lire':
          this.step(s.line);
          for (const t of s.targets) this.readValue(t, s.line);
          return;
        case 'Si':
          this.step(s.line);
          this.exec(this.truth(s.cond) ? s.thenBody : s.elseBody);
          return;
        case 'TantQue':
          for (;;) {
            this.step(s.line);
            if (!this.truth(s.cond)) return;
            this.exec(s.body);
          }
        case 'Repeter':
          for (;;) {
            this.step(s.line);
            this.exec(s.body);
            this.step(s.untilLine);
            if (this.truth(s.cond)) return;
          }
        case 'Pour': {
          this.step(s.line);
          const from = this.number(this.eval(s.from), 'POUR', s.line);
          const to = this.number(this.eval(s.to), 'POUR', s.line);
          const by = s.step ? this.number(this.eval(s.step), 'PAS', s.line) : 1;
          if (by === 0) throw new PseudoError('PAS ne peut pas valoir 0.', s.line);
          const eps = Math.abs(by) * 1e-9; // tolère 0.1 + 0.2 ≈ 0.3
          let first = true;
          for (let i = from; by > 0 ? i <= to + eps : i >= to - eps; i += by) {
            if (!first) this.step(s.line);
            first = false;
            this.assign({ type: 'Var', name: s.name }, Number(i.toPrecision(12)), s.line);
            this.exec(s.body);
          }
          return;
        }
        default:
          throw new PseudoError(`Instruction non reconnue : ${s.type}`, s.line);
      }
    }
  }

  function runPseudocode(source, options = {}) {
    const interp = new Interpreter(options);
    let error = null;
    let truncated = false;
    let lastLine = null;
    try {
      const ast = new Parser(tokenize(source)).parseProgram();
      interp.exec(ast);
    } catch (e) {
      if (e instanceof StepLimit) truncated = true;
      else if (e instanceof PseudoError) { error = { type: 'Erreur', message: e.message, line: e.line ?? null, column: e.col ?? null }; lastLine = e.line; }
      else error = { message: e.message || String(e), line: null };
    }
    if (options.trace) {
      // Étape finale : état après la dernière instruction (ou au moment de l'erreur).
      const vars = {};
      for (const [name, v] of interp.vars) vars[name] = show(v.value);
      interp.steps.push({ line: lastLine, scopes: [{ name: 'global', vars }], out: interp.output.length, final: true });
    }
    return { output: interp.output, error, steps: options.trace ? interp.steps : null, truncated };
  }

  const api = { runPseudocode, tokenize, PseudoError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Pseudocode = api;
})(typeof self !== 'undefined' ? self : globalThis);
