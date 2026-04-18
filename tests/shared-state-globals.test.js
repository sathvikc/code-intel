import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSource,
  analyzeProjects,
  fileIsModuleLike,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/shared-state-globals.js';

import ts from 'typescript';

// ---------- fileIsModuleLike ----------

function parse(code, filePath = 'f.ts') {
  return ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
}

test('fileIsModuleLike: import makes a module', () => {
  assert.equal(fileIsModuleLike(parse(`import x from 'y';`)), true);
});

test('fileIsModuleLike: export makes a module', () => {
  assert.equal(fileIsModuleLike(parse(`export const x = 1;`)), true);
});

test('fileIsModuleLike: export function makes a module', () => {
  assert.equal(fileIsModuleLike(parse(`export function foo() {}`)), true);
});

test('fileIsModuleLike: require makes a module (CommonJS)', () => {
  assert.equal(fileIsModuleLike(parse(`const x = require('y');`)), true);
});

test('fileIsModuleLike: module.exports makes a module (CommonJS)', () => {
  assert.equal(fileIsModuleLike(parse(`module.exports = {};`)), true);
});

test('fileIsModuleLike: exports.X makes a module (CommonJS)', () => {
  assert.equal(fileIsModuleLike(parse(`exports.foo = 1;`)), true);
});

test('fileIsModuleLike: plain script (no import/export/require) is NOT a module', () => {
  assert.equal(fileIsModuleLike(parse(`function foo() {} var x = 1;`)), false);
});

// ---------- analyzeSource: explicit global assignments ----------

test('detects window.X = expr as an assign occurrence', () => {
  const { occurrences } = analyzeSource(`window.myGlobal = 1;`, 'f.ts');
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].op, 'assign');
  assert.equal(occurrences[0].name, 'myGlobal');
  assert.equal(occurrences[0].host, 'window');
  assert.equal(occurrences[0].detectedVia, 'explicit-global');
});

test('detects globalThis.X = expr and self.X = expr', () => {
  const { occurrences } = analyzeSource(
    `globalThis.a = 1;
     self.b = 2;`,
    'f.ts',
  );
  assert.equal(occurrences.length, 2);
  const hosts = occurrences.map(o => o.host).sort();
  assert.deepEqual(hosts, ['globalThis', 'self']);
});

test('detects indexed-access assignment window["X"] = expr', () => {
  const { occurrences } = analyzeSource(`window['myGlobal'] = 1;`, 'f.ts');
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].detectedVia, 'explicit-global-indexed');
  assert.equal(occurrences[0].name, 'myGlobal');
});

test('skips builtin globals like window.location, window.fetch', () => {
  const { occurrences } = analyzeSource(
    `window.location = 'x';
     window.fetch = myFetch;
     globalThis.document = null;`,
    'f.ts',
  );
  assert.equal(occurrences.length, 0);
});

test('dynamic indexed access (non-literal) is not flagged in v1', () => {
  const { occurrences } = analyzeSource(`window[k] = 1;`, 'f.ts');
  assert.equal(occurrences.length, 0);
});

// ---------- analyzeSource: delete ----------

test('detects delete window.X as remove', () => {
  const { occurrences } = analyzeSource(`delete window.myGlobal;`, 'f.ts');
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].op, 'remove');
  assert.equal(occurrences[0].detectedVia, 'delete');
});

// ---------- analyzeSource: classic-script declarations ----------

test('classic script: top-level function X() is detected as declare', () => {
  const { isModule, occurrences } = analyzeSource(
    `function parseCookie(name) { return null; }`,
    'f.js',
  );
  assert.equal(isModule, false);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].op, 'declare');
  assert.equal(occurrences[0].name, 'parseCookie');
  assert.equal(occurrences[0].detectedVia, 'classic-script-function');
  assert.equal(occurrences[0].host, 'global');
});

test('classic script: top-level var/const/let are detected', () => {
  const { occurrences } = analyzeSource(
    `var a = 1;
     const b = 2;
     let c = 3;`,
    'f.js',
  );
  assert.equal(occurrences.length, 3);
  assert.ok(occurrences.every(o => o.detectedVia === 'classic-script-variable'));
  assert.deepEqual(occurrences.map(o => o.name).sort(), ['a', 'b', 'c']);
});

test('classic script: top-level class is detected', () => {
  const { occurrences } = analyzeSource(`class Foo {}`, 'f.js');
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].detectedVia, 'classic-script-class');
  assert.equal(occurrences[0].name, 'Foo');
});

test('module script: top-level function X() is NOT detected', () => {
  const { isModule, occurrences } = analyzeSource(
    `import y from 'y';
     function foo() {}
     export function bar() {}`,
    'f.ts',
  );
  assert.equal(isModule, true);
  // Only explicit window.X would count; function declarations in modules are local.
  assert.equal(occurrences.length, 0);
});

test('module script: still flags explicit window.X inside it', () => {
  const { occurrences } = analyzeSource(
    `import y from 'y';
     window.myThing = 42;`,
    'f.ts',
  );
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].name, 'myThing');
});

test('IIFE-wrapped code is NOT flagged as top-level', () => {
  const { occurrences } = analyzeSource(
    `(function() {
       function helper() {}
       var x = 1;
     })();`,
    'f.js',
  );
  // The IIFE ExpressionStatement is at top level, but the inner function is not.
  assert.equal(occurrences.length, 0);
});

test('anonymous function declarations are not flagged', () => {
  // export default function() {} — no name. But also `export` makes this a module.
  const { isModule, occurrences } = analyzeSource(
    `export default function() {}`,
    'f.ts',
  );
  assert.equal(isModule, true);
  assert.equal(occurrences.length, 0);
});

// ---------- analyzeProjects (integration) ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-globals-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('integration: single-file self-declaration emits NO finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'solo' }));
  write(a, 'src/only.js', `function onlyOne() {}`);
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('integration: multiple writes to same global in ONE file emit NO finding (regression: meganav §2.6)', () => {
  // Three explicit window.X writes inside one file is intra-file code
  // (reassignment / reset), not a cross-bundle collision. Before the fix,
  // the detector counted occurrences >= 2 and emitted a finding even when
  // all occurrences came from the same file — the meganav dogfood flagged
  // this as a false positive on __meganavScrollLockOverlays.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'solo' }));
  write(
    a,
    'src/blurBgUtils.js',
    `window.__scrollLockOverlays = new Set();
     function add(id) { window.__scrollLockOverlays.add(id); }
     window.__scrollLockOverlays = null;`,
  );
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('integration: classic-script redeclaration inside one file emits NO finding', () => {
  // Two top-level `function X()` in the SAME classic-script file.
  // Technically the second shadows the first, but that's a runtime
  // concern in one file — not coupling to another file. No finding.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'solo' }));
  write(
    a,
    'src/legacy.js',
    `function dupe() { return 1; }
     function dupe() { return 2; }`,
  );
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('integration: same name declared in two files -> one finding with 2 occurrences', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.js', `function parseCookie(n) { return 'a'; }`);
  write(a, 'src/b.js', `function parseCookie(n) { return 'b'; }`);
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.kind, 'shared-global-binding');
  assert.equal(f.name, 'parseCookie');
  assert.equal(f.occurrences.length, 2);
  assert.deepEqual(f.occurrences.map(o => o.file).sort(), ['src/a.js', 'src/b.js']);
});

test('integration: cross-project collision (app-a and app-b)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/cookies.js', `function parseCookie(n) { return 'a'; }`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/cookies.js', `function parseCookie(n) { return 'b'; }`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.name, 'parseCookie');
  assert.equal(f.occurrences.length, 2);
  const projs = new Set(f.occurrences.map(o => o.project));
  assert.deepEqual([...projs].sort(), ['app-a', 'app-b']);
});

test('integration: module-script + classic-script same-named do NOT group together', () => {
  // app-a exports function parseCookie (module -> not a global)
  // app-b has classic parseCookie (global). Only 1 occurrence total -> no finding.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/cookies.ts', `export function parseCookie(n) { return 'a'; }`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/cookies.js', `function parseCookie(n) { return 'b'; }`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.findings.length, 0);
});

test('integration: explicit window.X write + classic-script declare collide', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/cookies.js', `function parseCookie(n) { return 'a'; }`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/setup.ts', `import x from 'x';
    window.parseCookie = function(n) { return 'b'; };`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.name, 'parseCookie');
  assert.equal(f.occurrences.length, 2);
  const ops = f.occurrences.map(o => o.op).sort();
  assert.deepEqual(ops, ['assign', 'declare']);
});

test('integration: skips node_modules and dist', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.js', `function X() {}`);
  write(a, 'src/b.js', `function X() {}`);
  write(a, 'node_modules/pkg/dist/index.js', `function X() {}`);
  write(a, 'dist/bundle.js', `function X() {}`);
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].occurrences.length, 2);
});

test('integration: schema shape', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.js', `function dupe() {}`);
  write(a, 'src/y.js', `function dupe() {}`);

  const result = analyzeProjects([a]);
  assert.equal(result.version, SCHEMA_VERSION);
  assert.equal(result.analyzer, ANALYZER_ID);
  assert.equal(result.analyzer, 'shared-state.globals');
  const f = result.findings[0];
  assert.equal(f.kind, 'shared-global-binding');
  const o = f.occurrences[0];
  assert.ok(typeof o.line === 'number' && o.line > 0);
  assert.ok(typeof o.column === 'number' && o.column > 0);
  assert.ok(typeof o.snippet === 'string');
  assert.equal(typeof o.isModuleLike, 'boolean');
});
