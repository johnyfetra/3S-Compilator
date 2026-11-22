/*
 * 3S Compilator : Instrumentation du JavaScript pour le mode « Pas à pas ».
 *
 * Le code de l'élève est analysé avec acorn, puis on insère avant chaque
 * instruction (et avant chaque test de boucle) un appel :
 *
 *     __3s.s(LIGNE, () => [["nomPortée", { a: () => a, b: () => b }], …])
 *
 * Le runtime appelle chaque « getter » pour photographier les variables visibles
 * (portée la plus proche en premier). Les variables encore en zone morte
 * temporelle (let/const pas encore déclarés) lèvent une erreur : le runtime les ignore.
 */
(function (global) {
  'use strict';

  const acorn = typeof module !== 'undefined' && module.exports ? require('acorn') : global.acorn;

  const PARSE_OPTIONS = {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  };

  const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
  const LOOP_TEST = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement']);

  function parse(code) {
    return acorn.parse(code, PARSE_OPTIONS);
  }

  // Noms introduits par un motif (x, {a, b}, [c, ...d], e = 1).
  function patternNames(node, out = []) {
    if (!node) return out;
    switch (node.type) {
      case 'Identifier': out.push(node.name); break;
      case 'ObjectPattern': node.properties.forEach((p) => patternNames(p.type === 'RestElement' ? p.argument : p.value, out)); break;
      case 'ArrayPattern': node.elements.forEach((e) => patternNames(e, out)); break;
      case 'RestElement': patternNames(node.argument, out); break;
      case 'AssignmentPattern': patternNames(node.left, out); break;
    }
    return out;
  }

  // Parcours générique des enfants d'un nœud AST.
  function children(node) {
    const list = [];
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && list.push(c));
      else if (v && typeof v.type === 'string') list.push(v);
    }
    return list;
  }

  // Déclarations « var » d'une fonction (hissées), sans descendre dans les fonctions imbriquées.
  function collectVars(node, out) {
    if (node.type === 'VariableDeclaration' && node.kind === 'var') node.declarations.forEach((d) => patternNames(d.id, out));
    for (const c of children(node)) if (!FUNCTION_TYPES.has(c.type)) collectVars(c, out);
    return out;
  }

  // let/const/class déclarés directement dans une liste d'instructions.
  function lexicalNames(statements) {
    const out = [];
    for (const s of statements) {
      if (s.type === 'VariableDeclaration' && s.kind !== 'var') s.declarations.forEach((d) => patternNames(d.id, out));
    }
    return out;
  }

  function instrument(code) {
    const ast = parse(code);
    const inserts = []; // { pos, text, order } ; order : 0 = fermeture, 1 = ouverture
    // Pile de portées : { label, names: Set }
    const scopes = [];

    // Portées de la plus proche à la plus lointaine, regroupées par fonction.
    const snapshot = () => {
      const groups = [];
      const seen = new Set();
      for (let i = scopes.length - 1; i >= 0; i--) {
        const s = scopes[i];
        let g = groups[groups.length - 1];
        if (!g || g.label !== s.label) groups.push(g = { label: s.label, names: [] });
        for (const n of s.names) if (!seen.has(n)) { seen.add(n); g.names.push(n); }
      }
      const parts = groups.filter((g) => g.names.length)
        .map((g) => `[${JSON.stringify(g.label)},{${g.names.map((n) => `${n}:()=>${n}`).join(',')}}]`);
      return `()=>[${parts.join(',')}]`;
    };

    const stepCall = (line) => `__3s.s(${line},${snapshot()})`;

    function withScope(label, names, fn) {
      scopes.push({ label, names: new Set(names) });
      fn();
      scopes.pop();
    }

    function visitStatementList(statements) {
      for (const s of statements) {
        const skip = s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration' || s.type === 'EmptyStatement' || s.directive;
        if (!skip) inserts.push({ pos: s.start, text: `;${stepCall(s.loc.start.line)};`, order: 1 });
        visit(s);
      }
    }

    // Corps d'instruction hors liste (if sans accolades, boucle sans accolades…).
    function visitSingle(stmt) {
      if (!stmt) return;
      if (stmt.type === 'BlockStatement') { visit(stmt); return; }
      inserts.push({ pos: stmt.start, text: `{${stepCall(stmt.loc.start.line)};`, order: 1 });
      inserts.push({ pos: stmt.end, text: '}', order: 0 });
      visit(stmt);
    }

    function visitFunction(fn, name) {
      const label = name || (fn.id ? fn.id.name : (fn.type === 'ArrowFunctionExpression' ? 'fonction fléchée' : 'fonction'));
      const names = [];
      fn.params.forEach((p) => patternNames(p, names));
      if (fn.body.type === 'BlockStatement') collectVars(fn.body, names);
      withScope(label + '()', names, () => {
        fn.params.forEach(visit);
        if (fn.body.type === 'BlockStatement') {
          withScope(label + '()', lexicalNames(fn.body.body), () => visitStatementList(fn.body.body));
        } else {
          visit(fn.body);
        }
      });
    }

    function visit(node) {
      if (!node) return;
      if (FUNCTION_TYPES.has(node.type)) { visitFunction(node); return; }

      switch (node.type) {
        case 'MethodDefinition':
          visitFunction(node.value, node.key.name || 'méthode');
          return;
        case 'VariableDeclarator':
          // const carre = (x) => … : la fonction prend le nom de la variable
          if (node.init && FUNCTION_TYPES.has(node.init.type) && node.id.type === 'Identifier') { visitFunction(node.init, node.id.name); return; }
          children(node).forEach(visit);
          return;
        case 'BlockStatement':
          withScope(scopes[scopes.length - 1].label, lexicalNames(node.body), () => visitStatementList(node.body));
          return;
        case 'IfStatement':
          visit(node.test);
          visitSingle(node.consequent);
          visitSingle(node.alternate);
          return;
        case 'LabeledStatement':
          visit(node.body); // pas d'insertion : le label doit précéder directement la boucle
          return;
        case 'ForStatement':
        case 'ForInStatement':
        case 'ForOfStatement': {
          const decl = node.init || node.left;
          const names = decl && decl.type === 'VariableDeclaration' && decl.kind !== 'var'
            ? decl.declarations.flatMap((d) => patternNames(d.id)) : [];
          withScope(scopes[scopes.length - 1].label, names, () => {
            children(node).filter((c) => c !== node.body).forEach(visit);
            if (node.type === 'ForStatement' && node.test) wrapTest(node);
            visitSingle(node.body);
          });
          return;
        }
        case 'WhileStatement':
        case 'DoWhileStatement':
          visit(node.test);
          wrapTest(node);
          visitSingle(node.body);
          return;
        case 'SwitchStatement':
          visit(node.discriminant);
          withScope(scopes[scopes.length - 1].label, node.cases.flatMap((c) => lexicalNames(c.consequent)), () => {
            node.cases.forEach((c) => { visit(c.test); visitStatementList(c.consequent); });
          });
          return;
        case 'TryStatement':
          visit(node.block);
          if (node.handler) {
            withScope(scopes[scopes.length - 1].label, patternNames(node.handler.param), () => visit(node.handler.body));
          }
          visit(node.finalizer);
          return;
        default:
          children(node).forEach(visit);
      }
    }

    // Test de boucle : chaque évaluation devient une étape sur la ligne de la boucle.
    function wrapTest(loop) {
      if (!LOOP_TEST.has(loop.type) || !loop.test) return;
      inserts.push({ pos: loop.test.start, text: `(${stepCall(loop.loc.start.line)},`, order: 1 });
      inserts.push({ pos: loop.test.end, text: ')', order: 0 });
    }

    const globalNames = collectVars(ast, []).concat(lexicalNames(ast.body));
    withScope('global', globalNames, () => {
      visitStatementList(ast.body);
      // Étape « fin » (ligne 0) : photographie des variables globales après la dernière instruction.
      inserts.push({ pos: code.length, text: `\n;${stepCall(0)};`, order: 1 });
    });

    // Application des insertions dans l'ordre des positions.
    inserts.sort((a, b) => a.pos - b.pos || a.order - b.order);
    let result = '';
    let last = 0;
    for (const ins of inserts) {
      result += code.slice(last, ins.pos) + ins.text;
      last = ins.pos;
    }
    return result + code.slice(last);
  }

  const api = { instrument, parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.JsInstrument = api;
})(typeof self !== 'undefined' ? self : globalThis);
