import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {
  buildFoldMap,
  resolveFoldedIdentifier,
  resolveStringArg,
} from '../src/fold-string-literals.js';

function parse(code, filename = 'sample.ts') {
  return ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** Find the first `<storage>.setItem(<arg>, …)` call's first argument. */
function firstSetItemArg(sf) {
  let found = null;
  function visit(node) {
    if (
      !found
      && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.name)
      && node.expression.name.text === 'setItem'
    ) {
      found = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/** Find the Nth Identifier node whose text matches `name`. */
function findIdentifier(sf, name, occurrence = 0) {
  let found = null;
  let seen = 0;
  function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      if (seen === occurrence) {
        found = node;
        return;
      }
      seen++;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

// ---------- buildFoldMap / resolveFoldedIdentifier ----------

test('folds module-scope const string literal', () => {
  const sf = parse(`
    const K = 'app.session';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  const arg = firstSetItemArg(sf);
  const result = resolveFoldedIdentifier(arg, foldMap);
  assert.deepEqual(result, { value: 'app.session', name: 'K' });
});

test('folds const initialised with a no-substitution template literal', () => {
  const sf = parse('const K = `app.session`;\nlocalStorage.setItem(K, v);');
  const foldMap = buildFoldMap(sf);
  const result = resolveFoldedIdentifier(firstSetItemArg(sf), foldMap);
  assert.deepEqual(result, { value: 'app.session', name: 'K' });
});

test('folds never-reassigned let bindings', () => {
  const sf = parse(`
    let K = 'app.session';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  const result = resolveFoldedIdentifier(firstSetItemArg(sf), foldMap);
  assert.deepEqual(result, { value: 'app.session', name: 'K' });
});

test('does NOT fold a let that is reassigned anywhere in the file', () => {
  const sf = parse(`
    let K = 'app.session';
    K = 'other';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  const result = resolveFoldedIdentifier(firstSetItemArg(sf), foldMap);
  assert.equal(result, null);
});

test('does NOT fold when a compound assignment targets the binding', () => {
  const sf = parse(`
    let K = 'app.';
    K += 'session';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('does NOT fold when the binding is ++/-- mutated', () => {
  // contrived — wrong type but syntactically valid; the fold must still bail
  const sf = parse(`
    let K = 'app.session';
    K++;
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('does NOT fold when the binding is a destructuring-assignment target', () => {
  const sf = parse(`
    let K = 'app.session';
    ({ K } = { K: 'other' });
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('does NOT fold destructured declarations', () => {
  const sf = parse(`
    const { K } = { K: 'app.session' };
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('does NOT fold initializers that are not string literals', () => {
  const sf = parse(`
    const K = 'app' + '.session';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('does NOT fold template literals with substitutions', () => {
  const sf = parse('const K = `app.${scope}`;\nlocalStorage.setItem(K, v);');
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('does NOT fold `var` bindings in v1', () => {
  const sf = parse(`
    var K = 'app.session';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('use-before-decl (temporal dead zone) does not fold', () => {
  // The .setItem call comes BEFORE the const declaration in source order.
  // v1 requires decl.start < use.start.
  const sf = parse(`
    localStorage.setItem(K, v);
    const K = 'app.session';
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('function-local const folds inside its function', () => {
  const sf = parse(`
    function load() {
      const K = 'app.flags';
      localStorage.setItem(K, v);
    }
  `);
  const foldMap = buildFoldMap(sf);
  const result = resolveFoldedIdentifier(firstSetItemArg(sf), foldMap);
  assert.deepEqual(result, { value: 'app.flags', name: 'K' });
});

test('sibling-scope bindings do not leak across functions', () => {
  const sf = parse(`
    function a() {
      const K = 'a.key';
    }
    function b() {
      localStorage.setItem(K, v);
    }
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

test('nearest-scope wins: inner const shadows outer one', () => {
  const sf = parse(`
    const K = 'outer';
    function inner() {
      const K = 'inner';
      localStorage.setItem(K, v);
    }
  `);
  const foldMap = buildFoldMap(sf);
  const result = resolveFoldedIdentifier(firstSetItemArg(sf), foldMap);
  assert.deepEqual(result, { value: 'inner', name: 'K' });
});

test('module-scope declaration visible inside a nested function', () => {
  const sf = parse(`
    const K = 'app.session';
    function inner() {
      localStorage.setItem(K, v);
    }
  `);
  const foldMap = buildFoldMap(sf);
  const result = resolveFoldedIdentifier(firstSetItemArg(sf), foldMap);
  assert.deepEqual(result, { value: 'app.session', name: 'K' });
});

test('non-Identifier nodes return null from resolveFoldedIdentifier', () => {
  const sf = parse(`localStorage.setItem('inline', v);`);
  const foldMap = buildFoldMap(sf);
  const result = resolveFoldedIdentifier(firstSetItemArg(sf), foldMap);
  assert.equal(result, null);
});

test('reassignment inside a function body still invalidates the name', () => {
  // The reassignment check is file-wide; once a name is ever written to,
  // no binding of that name folds (conservative-but-safe).
  const sf = parse(`
    const K = 'app.session';
    function dirty() {
      K = 'oops'; // TS error at runtime, but syntactically present
    }
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  assert.equal(resolveFoldedIdentifier(firstSetItemArg(sf), foldMap), null);
});

// ---------- resolveStringArg: the uniform surface used by detectors ----------

test('resolveStringArg: inline literal', () => {
  const sf = parse(`localStorage.setItem('app.session', v);`);
  const foldMap = buildFoldMap(sf);
  const arg = firstSetItemArg(sf);
  assert.deepEqual(resolveStringArg(arg, sf, foldMap), {
    value: 'app.session',
    dynamic: false,
    expressionText: 'app.session',
    foldedFrom: null,
  });
});

test('resolveStringArg: folded identifier', () => {
  const sf = parse(`
    const K = 'app.session';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  const arg = firstSetItemArg(sf);
  assert.deepEqual(resolveStringArg(arg, sf, foldMap), {
    value: 'app.session',
    dynamic: false,
    expressionText: 'K',
    foldedFrom: 'K',
  });
});

test('resolveStringArg: unresolvable identifier returns dynamic', () => {
  const sf = parse(`
    let K = 'a';
    K = 'b';
    localStorage.setItem(K, v);
  `);
  const foldMap = buildFoldMap(sf);
  const arg = firstSetItemArg(sf);
  const out = resolveStringArg(arg, sf, foldMap);
  assert.equal(out.value, null);
  assert.equal(out.dynamic, true);
  assert.equal(out.foldedFrom, null);
  assert.equal(out.expressionText, 'K');
});

test('resolveStringArg: non-identifier, non-literal arg returns dynamic', () => {
  const sf = parse(`
    localStorage.setItem(getKey(), v);
  `);
  const foldMap = buildFoldMap(sf);
  const arg = firstSetItemArg(sf);
  const out = resolveStringArg(arg, sf, foldMap);
  assert.equal(out.value, null);
  assert.equal(out.dynamic, true);
  assert.equal(out.foldedFrom, null);
  assert.equal(out.expressionText, 'getKey()');
});

test('resolveStringArg: missing arg is dynamic with empty expression', () => {
  const foldMap = buildFoldMap(parse(''));
  const out = resolveStringArg(undefined, parse(''), foldMap);
  assert.deepEqual(out, { value: null, dynamic: true, expressionText: '', foldedFrom: null });
});

test('same name folds differently per use site (inner shadow + outer use)', () => {
  const sf = parse(`
    const K = 'outer';
    function inner() {
      const K = 'inner';
      localStorage.setItem(K, 1); // inner
    }
    localStorage.setItem(K, 2);   // outer
  `);
  const foldMap = buildFoldMap(sf);

  // First setItem call is inside `inner`.
  let calls = [];
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.name)
      && node.expression.name.text === 'setItem'
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  assert.equal(calls.length, 2);

  const innerResult = resolveFoldedIdentifier(calls[0].arguments[0], foldMap);
  const outerResult = resolveFoldedIdentifier(calls[1].arguments[0], foldMap);
  assert.deepEqual(innerResult, { value: 'inner', name: 'K' });
  assert.deepEqual(outerResult, { value: 'outer', name: 'K' });
});

test('unused identifier lookup on an absent binding returns null without crashing', () => {
  const sf = parse(`const OTHER = 'x'; localStorage.setItem(NOPE, v);`);
  const foldMap = buildFoldMap(sf);
  const ident = findIdentifier(sf, 'NOPE');
  assert.ok(ident, 'should have found NOPE identifier');
  assert.equal(resolveFoldedIdentifier(ident, foldMap), null);
});
