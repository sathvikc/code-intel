import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeStructuralDriftProjects,
  analyzeProjects,
  summarize,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/structural-drift.js';
import { collectObjectExports } from '../src/cross-file-constants.js';
import ts from 'typescript';

// ---------- helpers ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-structural-drift-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function parseSource(code, filePath = 'f.ts') {
  return ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

// ---------- collectObjectExports unit tests ----------

test('collectObjectExports: export const with object literal is recorded', () => {
  const sf = parseSource(`export const CFG = { host: 'a', port: 80 };`);
  const result = collectObjectExports(sf);
  assert.ok(result.has('CFG'));
  const entry = result.get('CFG');
  assert.deepEqual(entry.keys, ['host', 'port']);
  assert.equal(entry.line, 1);
});

test('collectObjectExports: export default { ... } is recorded under "default"', () => {
  const sf = parseSource(`export default { x: 1, y: 2 };`);
  const result = collectObjectExports(sf);
  assert.ok(result.has('default'));
  assert.deepEqual(result.get('default').keys, ['x', 'y']);
});

test('collectObjectExports: spread in object literal → opaque, not recorded', () => {
  const sf = parseSource(`export const CFG = { ...base, host: 'a' };`);
  const result = collectObjectExports(sf);
  assert.ok(!result.has('CFG'), 'spread-containing object should be skipped');
});

test('collectObjectExports: computed property → opaque, not recorded', () => {
  const sf = parseSource(`export const CFG = { [key]: 'a' };`);
  const result = collectObjectExports(sf);
  assert.ok(!result.has('CFG'));
});

test('collectObjectExports: reassigned export → not recorded', () => {
  const sf = parseSource(`
    export let CFG = { a: 1 };
    CFG = { b: 2 };
  `);
  const result = collectObjectExports(sf);
  assert.ok(!result.has('CFG'), 'reassigned export should be skipped');
});

test('collectObjectExports: non-object export is ignored', () => {
  const sf = parseSource(`export const K = 'hello';`);
  const result = collectObjectExports(sf);
  assert.ok(!result.has('K'));
});

// ---------- analyzeStructuralDriftProjects integration tests ----------

test('basic positive: declaration {a,b}, reader accesses a and c → readOnlyKeys: [c]', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  write(root, 'src/api.js', `
    import { CFG } from './config.js';
    const x = CFG.a;
    const y = CFG.c;
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.findings.length, 1, 'should emit one finding');
  const f = r.findings[0];
  assert.equal(f.kind, 'structural-drift');
  assert.deepEqual(f.readOnlyKeys, ['c']);
  assert.deepEqual(f.declaredShape, ['a', 'b']);
  assert.deepEqual(f.writeOnlyKeys, ['b']);
  assert.equal(f.exportedName, 'CFG');
  // occurrences should contain declare + read
  const declOcc = f.occurrences.find((o) => o.op === 'declare');
  const readOcc = f.occurrences.find((o) => o.op === 'read');
  assert.ok(declOcc);
  assert.ok(readOcc);
});

test('agreement: declaration {a,b}, reader accesses a and b only → no finding', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  write(root, 'src/api.js', `
    import { CFG } from './config.js';
    const x = CFG.a;
    const y = CFG.b;
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.findings.length, 0, 'matching shape should produce no finding');
});

test('write-only alone: declaration {a,b}, reader accesses only a → writeOnlyKeys [b] but NO finding', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  write(root, 'src/api.js', `
    import { CFG } from './config.js';
    const x = CFG.a;
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.findings.length, 0, 'write-only drift alone should not emit');
});

test('destructure reader: const {a,c} = CFG with declaration {a,b} → readOnlyKeys [c]', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  write(root, 'src/api.js', `
    import { CFG } from './config.js';
    const { a, c } = CFG;
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.deepEqual(f.readOnlyKeys, ['c']);
});

test('dynamic access marks partial: CFG[someVar] → reader is partial, contributes no keys', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  // Two readers: one dynamic-only, one clear drift.
  write(root, 'src/reader-dynamic.js', `
    import { CFG } from './config.js';
    const k = 'someKey';
    const x = CFG[k];
  `);
  write(root, 'src/reader-clear.js', `
    import { CFG } from './config.js';
    const y = CFG.z;
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.findings.length, 1, 'dynamic-only reader should not suppress emission');
  const f = r.findings[0];
  assert.deepEqual(f.readOnlyKeys, ['z']);
  // The partial reader contributes to opaqueReaders
  assert.ok(f.opaqueReaders >= 1, 'dynamic reader should increment opaqueReaders');
});

test('export default: importer accesses .y on default export with shape {x} → readOnlyKeys [y]', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/mod.js', `export default { x: 1 };`);
  write(root, 'src/consumer.js', `
    import CFG from './mod.js';
    const v = CFG.y;
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.exportedName, 'default');
  assert.deepEqual(f.readOnlyKeys, ['y']);
});

test('multi-reader: two importers, only one has drift → only drifted keys in readOnlyKeys', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  // Reader 1: correct access
  write(root, 'src/reader-ok.js', `
    import { CFG } from './config.js';
    const x = CFG.a;
    const y = CFG.b;
  `);
  // Reader 2: accesses a and phantom key 'ghost'
  write(root, 'src/reader-bad.js', `
    import { CFG } from './config.js';
    const x = CFG.a;
    const z = CFG.ghost;
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  // readShape = union of {a,b} and {a,ghost} = {a,b,ghost}
  // readOnlyKeys = readShape - declaredShape = [ghost]
  assert.deepEqual(f.readOnlyKeys, ['ghost']);
  // writeOnlyKeys = declaredShape - readShape = [] (both 'a' and 'b' appear in readShape)
  assert.deepEqual(f.writeOnlyKeys, []);
});

test('fingerprint stability: same finding hashes identically on two calls', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  write(root, 'src/api.js', `
    import { CFG } from './config.js';
    const x = CFG.a;
    const y = CFG.c;
  `);

  const r1 = analyzeStructuralDriftProjects([root]);
  const r2 = analyzeStructuralDriftProjects([root]);
  assert.equal(r1.findings.length, 1);
  assert.equal(r2.findings.length, 1);
  // The findings should be structurally identical (same module, exportedName, keys).
  assert.equal(r1.findings[0].module, r2.findings[0].module);
  assert.equal(r1.findings[0].exportedName, r2.findings[0].exportedName);
  assert.deepEqual(r1.findings[0].readOnlyKeys, r2.findings[0].readOnlyKeys);
  assert.deepEqual(r1.findings[0].declaredShape, r2.findings[0].declaredShape);
});

test('integration: two-file virtual project returns correct finding shape', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'test-app' }));
  write(root, 'src/config.js', `
    export const ENDPOINTS = { host: 'api.example.com', version: 'v2' };
  `);
  write(root, 'src/client.js', `
    import { ENDPOINTS } from './config.js';
    const base = ENDPOINTS.host;
    const v = ENDPOINTS.apiVersion;  // typo: should be 'version'
  `);

  const r = analyzeStructuralDriftProjects([root]);
  assert.equal(r.version, SCHEMA_VERSION);
  assert.equal(r.analyzer, ANALYZER_ID);
  assert.ok(Array.isArray(r.findings));
  assert.equal(r.findings.length, 1);

  const f = r.findings[0];
  assert.equal(f.kind, 'structural-drift');
  assert.equal(f.exportedName, 'ENDPOINTS');
  assert.deepEqual(f.declaredShape, ['host', 'version']);
  assert.deepEqual(f.readOnlyKeys, ['apiVersion']);
  assert.deepEqual(f.writeOnlyKeys, ['version']);
  assert.ok(typeof f.module === 'string');
  assert.ok(Array.isArray(f.occurrences));
  const declOcc = f.occurrences.find((o) => o.op === 'declare');
  assert.ok(declOcc, 'should have a declare occurrence');
  const readOcc = f.occurrences.find((o) => o.op === 'read');
  assert.ok(readOcc, 'should have a read occurrence');
});

// ---------- summarize ----------

test('summarize: returns correct message for findings array', () => {
  const lines = summarize([{ kind: 'structural-drift' }, { kind: 'structural-drift' }]);
  assert.ok(Array.isArray(lines));
  assert.ok(lines[0].includes('2'), 'should report count of 2');
  assert.ok(lines[0].includes('drifted'));
});

test('summarize: zero findings', () => {
  const lines = summarize([]);
  assert.ok(lines[0].includes('0'));
});

// ---------- analyzeProjects alias ----------

test('analyzeProjects is an alias for analyzeStructuralDriftProjects', () => {
  assert.equal(analyzeProjects, analyzeStructuralDriftProjects);
});
