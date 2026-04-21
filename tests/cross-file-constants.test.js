import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import {
  collectExports,
  collectImports,
  buildConstantsIndex,
  makeCrossFileResolver,
} from '../src/cross-file-constants.js';
import { createAstCache } from '../src/ast-cache.js';
import { resolveProject } from '../src/project.js';
import { buildFoldMap, resolveStringArg } from '../src/fold-string-literals.js';

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function parse(code, filePath = 'x.ts') {
  return ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-xfile-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function makeProject(root) {
  // Minimal package.json so resolveProject picks up a stable id.
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'tst' }));
  }
  return resolveProject(root);
}

function buildResolverFor(rootDir) {
  const project = makeProject(rootDir);
  const astCache = createAstCache();
  const index = buildConstantsIndex([project], { astCache });
  return makeCrossFileResolver(index);
}

// ==========================================================================
// collectExports — unit
// ==========================================================================

test('collectExports: `export const X = "lit"` registers literal', () => {
  const sf = parse(`export const K_SESSION = 'app.session';`);
  const { namedExports, starReexports } = collectExports(sf);
  assert.deepEqual(starReexports, []);
  assert.equal(namedExports.size, 1);
  assert.deepEqual(namedExports.get('K_SESSION'), { kind: 'literal', value: 'app.session' });
});

test('collectExports: multiple declarations in one `export const` list', () => {
  const sf = parse(`export const A = 'a', B = 'b';`);
  const { namedExports } = collectExports(sf);
  assert.equal(namedExports.get('A').value, 'a');
  assert.equal(namedExports.get('B').value, 'b');
});

test('collectExports: `const X = "lit"; export { X }` registers literal', () => {
  const sf = parse(`
    const X = 'hello';
    export { X };
  `);
  const { namedExports } = collectExports(sf);
  assert.deepEqual(namedExports.get('X'), { kind: 'literal', value: 'hello' });
});

test('collectExports: `export { X as Y }` renames on export (literal)', () => {
  const sf = parse(`
    const X = 'value';
    export { X as Y };
  `);
  const { namedExports } = collectExports(sf);
  assert.equal(namedExports.has('X'), false, 'X is local-only, not exported');
  assert.deepEqual(namedExports.get('Y'), { kind: 'literal', value: 'value' });
});

test('collectExports: `export { X } from "./mod"` is a reexport entry', () => {
  const sf = parse(`export { X } from './mod';`);
  const { namedExports, starReexports } = collectExports(sf);
  assert.deepEqual(starReexports, []);
  assert.deepEqual(namedExports.get('X'), {
    kind: 'reexport',
    module: './mod',
    originalName: 'X',
  });
});

test('collectExports: `export { X as Y } from "./mod"` renames at reexport', () => {
  const sf = parse(`export { X as Y } from './mod';`);
  const { namedExports } = collectExports(sf);
  assert.deepEqual(namedExports.get('Y'), {
    kind: 'reexport',
    module: './mod',
    originalName: 'X',
  });
});

test('collectExports: `export * from "./mod"` records star reexport', () => {
  const sf = parse(`export * from './mod';`);
  const { namedExports, starReexports } = collectExports(sf);
  assert.equal(namedExports.size, 0);
  assert.deepEqual(starReexports, ['./mod']);
});

test('collectExports: `export default "lit"` registers under default', () => {
  const sf = parse(`export default 'the-value';`);
  const { namedExports } = collectExports(sf);
  assert.deepEqual(namedExports.get('default'), { kind: 'literal', value: 'the-value' });
});

test('collectExports: `export default X` where X is a local literal resolves', () => {
  const sf = parse(`
    const X = 'dflt';
    export default X;
  `);
  const { namedExports } = collectExports(sf);
  assert.deepEqual(namedExports.get('default'), { kind: 'literal', value: 'dflt' });
});

test('collectExports: reassigned local is not exported as literal', () => {
  const sf = parse(`
    let X = 'initial';
    X = 'reassigned';
    export { X };
  `);
  const { namedExports } = collectExports(sf);
  assert.equal(namedExports.has('X'), false);
});

test('collectExports: non-literal initializer is not exported as literal', () => {
  const sf = parse(`
    export const K = \`dynamic-\${foo}\`;
    export const J = 'x' + 'y';
    export const M = getKey();
  `);
  const { namedExports } = collectExports(sf);
  assert.equal(namedExports.has('K'), false);
  assert.equal(namedExports.has('J'), false);
  assert.equal(namedExports.has('M'), false);
});

test('collectExports: no-substitution template literal counts as literal', () => {
  const sf = parse('export const K = `just-a-string`;');
  const { namedExports } = collectExports(sf);
  assert.equal(namedExports.get('K').value, 'just-a-string');
});

test('collectExports: var declarations excluded (hoisting)', () => {
  const sf = parse(`export var K = 'lit';`);
  const { namedExports } = collectExports(sf);
  assert.equal(namedExports.has('K'), false);
});

test('collectExports: object literal + named bindings in non-top scope ignored', () => {
  // Non-top-level `export` would be a syntax error; test that random
  // literal-looking things nested in functions don't leak out.
  const sf = parse(`
    function makeKeys() {
      const K_LOCAL = 'inside';
      return K_LOCAL;
    }
    export const K_TOP = 'outside';
  `);
  const { namedExports } = collectExports(sf);
  assert.equal(namedExports.has('K_LOCAL'), false);
  assert.equal(namedExports.get('K_TOP').value, 'outside');
});

// ==========================================================================
// collectImports — unit
// ==========================================================================

test('collectImports: `import { A } from "x"` maps local A to exported A', () => {
  const sf = parse(`import { A } from 'x';`);
  const imports = collectImports(sf);
  assert.deepEqual(imports.get('A'), { module: 'x', exportedName: 'A' });
});

test('collectImports: `import { A as B } from "x"` maps local B to exported A', () => {
  const sf = parse(`import { A as B } from 'x';`);
  const imports = collectImports(sf);
  assert.equal(imports.has('A'), false);
  assert.deepEqual(imports.get('B'), { module: 'x', exportedName: 'A' });
});

test('collectImports: `import Def from "x"` maps Def to default', () => {
  const sf = parse(`import Def from 'x';`);
  const imports = collectImports(sf);
  assert.deepEqual(imports.get('Def'), { module: 'x', exportedName: 'default' });
});

test('collectImports: `import Def, { A } from "x"` covers both', () => {
  const sf = parse(`import Def, { A } from 'x';`);
  const imports = collectImports(sf);
  assert.deepEqual(imports.get('Def'), { module: 'x', exportedName: 'default' });
  assert.deepEqual(imports.get('A'), { module: 'x', exportedName: 'A' });
});

test('collectImports: `import * as NS from "x"` is skipped in v2', () => {
  const sf = parse(`import * as NS from 'x';`);
  const imports = collectImports(sf);
  assert.equal(imports.size, 0);
});

test('collectImports: `import type { K } from "x"` is skipped', () => {
  const sf = parse(`import type { K } from 'x';`);
  const imports = collectImports(sf);
  assert.equal(imports.size, 0);
});

test('collectImports: per-specifier type imports are skipped', () => {
  const sf = parse(`import { type T, K } from 'x';`);
  const imports = collectImports(sf);
  assert.equal(imports.has('T'), false);
  assert.deepEqual(imports.get('K'), { module: 'x', exportedName: 'K' });
});

// ==========================================================================
// buildConstantsIndex + makeCrossFileResolver — integration
// ==========================================================================

test('resolver: named import of a literal export resolves', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K_SESSION = 'app.session';`);
  write(tmp, 'src/consumer.ts', `
    import { K_SESSION } from './keys';
    localStorage.setItem(K_SESSION, 'x');
  `);
  const resolve = buildResolverFor(tmp);
  const got = resolve('K_SESSION', path.join(tmp, 'src/consumer.ts'));
  assert.ok(got, 'resolver hits');
  assert.equal(got.value, 'app.session');
  assert.equal(got.moduleSource, './keys');
  assert.equal(got.importedAs, 'K_SESSION');
});

test('resolver: rename on import resolves to the original export', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'lit';`);
  write(tmp, 'src/consumer.ts', `
    import { K as J } from './keys';
    console.log(J);
  `);
  const resolve = buildResolverFor(tmp);
  const got = resolve('J', path.join(tmp, 'src/consumer.ts'));
  assert.equal(got.value, 'lit');
  assert.equal(got.importedAs, 'J');
});

test('resolver: rename on export resolves on the import side', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `
    const _K = 'lit';
    export { _K as K };
  `);
  write(tmp, 'src/consumer.ts', `
    import { K } from './keys';
    console.log(K);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('K', path.join(tmp, 'src/consumer.ts')).value, 'lit');
});

test('resolver: re-export chain resolves transitively', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'deep';`);
  write(tmp, 'src/index.ts', `export { K } from './keys';`);
  write(tmp, 'src/consumer.ts', `
    import { K } from './index';
    console.log(K);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('K', path.join(tmp, 'src/consumer.ts')).value, 'deep');
});

test('resolver: re-export chain with rename at the barrel', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'v';`);
  write(tmp, 'src/index.ts', `export { K as J } from './keys';`);
  write(tmp, 'src/consumer.ts', `
    import { J } from './index';
    console.log(J);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('J', path.join(tmp, 'src/consumer.ts')).value, 'v');
});

test('resolver: star re-export surfaces downstream', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'starred';`);
  write(tmp, 'src/index.ts', `export * from './keys';`);
  write(tmp, 'src/consumer.ts', `
    import { K } from './index';
    console.log(K);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('K', path.join(tmp, 'src/consumer.ts')).value, 'starred');
});

test('resolver: default export of a literal', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export default 'dflt-literal';`);
  write(tmp, 'src/consumer.ts', `
    import K from './keys';
    console.log(K);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('K', path.join(tmp, 'src/consumer.ts')).value, 'dflt-literal');
});

test('resolver: default export of a local literal identifier', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `
    const X = 'dflt-ident';
    export default X;
  `);
  write(tmp, 'src/consumer.ts', `
    import D from './keys';
    console.log(D);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('D', path.join(tmp, 'src/consumer.ts')).value, 'dflt-ident');
});

test('resolver: bare (node_modules) import returns null', () => {
  const tmp = mktmp();
  write(tmp, 'src/consumer.ts', `
    import { something } from 'lodash';
    console.log(something);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('something', path.join(tmp, 'src/consumer.ts')), null);
});

test('resolver: unknown identifier (no matching import) returns null', () => {
  const tmp = mktmp();
  write(tmp, 'src/consumer.ts', `
    const local = 'x';
    console.log(local);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('local', path.join(tmp, 'src/consumer.ts')), null);
  assert.equal(resolve('NotDeclared', path.join(tmp, 'src/consumer.ts')), null);
});

test('resolver: import target file with no matching export returns null', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const OTHER = 'lit';`);
  write(tmp, 'src/consumer.ts', `
    import { MISSING } from './keys';
    console.log(MISSING);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('MISSING', path.join(tmp, 'src/consumer.ts')), null);
});

test('resolver: cycle in re-export chain is broken, returns null', () => {
  const tmp = mktmp();
  // a.ts exports X from b.ts, b.ts exports X from a.ts. Neither has a
  // real definition; resolver must not blow up.
  write(tmp, 'src/a.ts', `export { X } from './b';`);
  write(tmp, 'src/b.ts', `export { X } from './a';`);
  write(tmp, 'src/consumer.ts', `
    import { X } from './a';
    console.log(X);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('X', path.join(tmp, 'src/consumer.ts')), null);
});

test('resolver: reassigned exported binding returns null (guard preserved)', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `
    export let K = 'init';
    K = 'reassigned';
  `);
  write(tmp, 'src/consumer.ts', `
    import { K } from './keys';
    console.log(K);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('K', path.join(tmp, 'src/consumer.ts')), null);
});

test('resolver: resolves through an index.ts directory import', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys/index.ts', `export const K = 'from-dir';`);
  write(tmp, 'src/consumer.ts', `
    import { K } from './keys';
    console.log(K);
  `);
  const resolve = buildResolverFor(tmp);
  assert.equal(resolve('K', path.join(tmp, 'src/consumer.ts')).value, 'from-dir');
});

test('resolver: namespace import (import * as NS) is not resolvable in v2', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'v';`);
  write(tmp, 'src/consumer.ts', `
    import * as Keys from './keys';
    console.log(Keys.K);
  `);
  const resolve = buildResolverFor(tmp);
  // `Keys` itself is not a literal; `NS.K` access isn't handled in v2.
  assert.equal(resolve('Keys', path.join(tmp, 'src/consumer.ts')), null);
});

// ==========================================================================
// resolveStringArg + crossFileResolver integration
// ==========================================================================

test('resolveStringArg: with resolver, imported constant resolves with foldedFromModule', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'app.session';`);
  const consumerPath = write(tmp, 'src/consumer.ts', `
    import { K } from './keys';
    localStorage.setItem(K, 'v');
  `);
  const resolver = buildResolverFor(tmp);

  const sf = ts.createSourceFile(
    consumerPath,
    fs.readFileSync(consumerPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const foldMap = buildFoldMap(sf);

  // Find `K` as used in setItem(K, 'v').
  let kUse = null;
  function find(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'setItem'
    ) {
      kUse = node.arguments[0];
    }
    ts.forEachChild(node, find);
  }
  find(sf);
  assert.ok(kUse, 'found K use site');

  const result = resolveStringArg(kUse, sf, foldMap, resolver);
  assert.equal(result.dynamic, false);
  assert.equal(result.value, 'app.session');
  assert.equal(result.foldedFrom, 'K');
  assert.equal(result.foldedFromModule, './keys');
});

test('resolveStringArg: same-file fold wins over cross-file shadow', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'from-import';`);
  const consumerPath = write(tmp, 'src/consumer.ts', `
    import { K } from './keys';
    const K_LOCAL = 'from-local';
    localStorage.setItem(K_LOCAL, 'v');
  `);
  const resolver = buildResolverFor(tmp);

  const sf = ts.createSourceFile(
    consumerPath,
    fs.readFileSync(consumerPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const foldMap = buildFoldMap(sf);

  // Find K_LOCAL use; resolver shouldn't be consulted (local wins).
  let kUse = null;
  function find(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'setItem'
    ) {
      kUse = node.arguments[0];
    }
    ts.forEachChild(node, find);
  }
  find(sf);

  const result = resolveStringArg(kUse, sf, foldMap, resolver);
  assert.equal(result.value, 'from-local');
  assert.equal(result.foldedFrom, 'K_LOCAL');
  assert.equal(result.foldedFromModule, undefined, 'cross-file field absent when same-file wins');
});

test('resolveStringArg: null resolver falls back to v1 behaviour', () => {
  const tmp = mktmp();
  write(tmp, 'src/keys.ts', `export const K = 'app.session';`);
  const consumerPath = write(tmp, 'src/consumer.ts', `
    import { K } from './keys';
    localStorage.setItem(K, 'v');
  `);
  // No resolver.
  const sf = ts.createSourceFile(
    consumerPath,
    fs.readFileSync(consumerPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const foldMap = buildFoldMap(sf);

  let kUse = null;
  function find(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'setItem'
    ) {
      kUse = node.arguments[0];
    }
    ts.forEachChild(node, find);
  }
  find(sf);

  const result = resolveStringArg(kUse, sf, foldMap /* no resolver */);
  assert.equal(result.dynamic, true, 'without resolver, imported K is dynamic');
  assert.equal(result.value, null);
  assert.equal(result.foldedFrom, null);
});
