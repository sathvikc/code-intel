import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSource,
  analyzeProjects,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/paired-keys.js';

// ---------- analyzeSource (unit) ----------

test('detects a two-key cluster in one function body', () => {
  const clusters = analyzeSource(
    `export function cacheFlags(v) {
       sessionStorage.setItem('app.flags', JSON.stringify(v));
       sessionStorage.setItem('app.flags.ts', String(Date.now()));
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].storage, 'sessionStorage');
  assert.deepEqual(clusters[0].keys, ['app.flags', 'app.flags.ts']);
  assert.equal(clusters[0].occurrences.length, 2);
});

test('detects a three-key cluster with distinct keys', () => {
  const clusters = analyzeSource(
    `export function persist(v) {
       localStorage.setItem('payload', JSON.stringify(v));
       localStorage.setItem('payload.ts', String(Date.now()));
       localStorage.setItem('payload.version', '2');
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].keys, ['payload', 'payload.ts', 'payload.version']);
});

test('single-key setItem does NOT form a cluster', () => {
  const clusters = analyzeSource(
    `export function cacheOnly(v) {
       sessionStorage.setItem('app.flags', JSON.stringify(v));
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 0);
});

test('two setItems on the SAME key (reassignment) is not a cluster', () => {
  const clusters = analyzeSource(
    `export function set(v) {
       localStorage.setItem('k', v);
       localStorage.setItem('k', v + '!');
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 0);
});

test('gap > 5 statements splits the cluster', () => {
  const clusters = analyzeSource(
    `export function f(v) {
       localStorage.setItem('k1', v);
       const a = 1;
       const b = 2;
       const c = 3;
       const d = 4;
       const e = 5;
       const g = 6;
       localStorage.setItem('k2', v);
     }`,
    'f.ts',
  );
  // First setItem is statement 0, second is statement 7. Gap = 7 > 5.
  // Each ends up in its own partial cluster of length 1, neither emits.
  assert.equal(clusters.length, 0);
});

test('gap <= 5 keeps the cluster together', () => {
  const clusters = analyzeSource(
    `export function f(v) {
       localStorage.setItem('k1', v);
       const a = 1;
       const b = 2;
       localStorage.setItem('k2', v);
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].keys, ['k1', 'k2']);
});

test('two different functions -> two separate clusters', () => {
  const clusters = analyzeSource(
    `export function a(v) {
       sessionStorage.setItem('a.payload', v);
       sessionStorage.setItem('a.ts', String(Date.now()));
     }
     export function b(v) {
       localStorage.setItem('b.payload', v);
       localStorage.setItem('b.ts', String(Date.now()));
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((c) => c.keys).sort(), [
    ['a.payload', 'a.ts'],
    ['b.payload', 'b.ts'],
  ].sort());
});

test('method in a class body is clustered like any function body', () => {
  const clusters = analyzeSource(
    `class Cache {
       save(v) {
         sessionStorage.setItem('c.payload', v);
         sessionStorage.setItem('c.ts', Date.now());
       }
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].keys, ['c.payload', 'c.ts']);
});

test('arrow function with block body is clustered', () => {
  const clusters = analyzeSource(
    `export const persist = (v) => {
       localStorage.setItem('p', v);
       localStorage.setItem('p.ts', Date.now());
     };`,
    'f.ts',
  );
  assert.equal(clusters.length, 1);
});

test('nested function inner cluster does NOT merge with outer', () => {
  // Outer has one setItem; inner has two paired setItems. Only the inner
  // should form a cluster.
  const clusters = analyzeSource(
    `export function outer() {
       localStorage.setItem('outer.k', 1);
       function inner() {
         localStorage.setItem('inner.k', 1);
         localStorage.setItem('inner.k.ts', Date.now());
       }
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].keys, ['inner.k', 'inner.k.ts']);
});

test('top-level (module-scope) setItems are NOT clustered in v1', () => {
  const clusters = analyzeSource(
    `localStorage.setItem('k1', 1);
     localStorage.setItem('k2', 1);`,
    'f.ts',
  );
  // v1 clusters only function-like bodies; top-level is a known recall gap.
  assert.equal(clusters.length, 0);
});

test('dynamic (non-literal) keys are skipped', () => {
  const clusters = analyzeSource(
    `export function f(v) {
       const k = 'x';
       localStorage.setItem(k, v);
       localStorage.setItem('y', v);
     }`,
    'f.ts',
  );
  // Only one literal-key setItem in the body — not a cluster.
  assert.equal(clusters.length, 0);
});

test('mixed localStorage + sessionStorage do NOT merge', () => {
  const clusters = analyzeSource(
    `export function f(v) {
       localStorage.setItem('a', v);
       sessionStorage.setItem('b', v);
     }`,
    'f.ts',
  );
  // Different storages break the cluster; neither side alone has 2+ keys.
  assert.equal(clusters.length, 0);
});

test('window.localStorage resolves the same as localStorage', () => {
  const clusters = analyzeSource(
    `export function f(v) {
       window.localStorage.setItem('k1', v);
       globalThis.localStorage.setItem('k2', v);
     }`,
    'f.ts',
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].storage, 'localStorage');
  assert.deepEqual(clusters[0].keys, ['k1', 'k2']);
});

test('parses tsx without crashing', () => {
  const clusters = analyzeSource(
    `export const C = () => {
       const handler = () => {
         sessionStorage.setItem('t.a', 1);
         sessionStorage.setItem('t.b', 2);
       };
       return <button onClick={handler}>x</button>;
     };`,
    'f.tsx',
  );
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].keys, ['t.a', 't.b']);
});

// ---------- analyzeProjects (integration, tmp fs) ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-paired-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('integration: emits one finding per cluster with full key set', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/cache.ts',
    `export function cacheFlags(v) {
       sessionStorage.setItem('app.flags', JSON.stringify(v));
       sessionStorage.setItem('app.flags.ts', String(Date.now()));
     }`,
  );
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.kind, 'paired-keys');
  assert.equal(f.storage, 'sessionStorage');
  assert.deepEqual(f.keys, ['app.flags', 'app.flags.ts']);
  assert.equal(f.occurrences.length, 2);
  assert.ok(f.occurrences.every((o) => o.project === 'app'));
  assert.ok(f.occurrences.every((o) => o.file === 'src/cache.ts'));
  assert.ok(f.occurrences.every((o) => o.op === 'write'));
  assert.ok(f.occurrences.every((o) => o.detectedVia === 'paired-setItem-cluster'));
});

test('integration: single-key function emits NO finding; regression fixture for §2.2', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/cache.ts',
    `export function cacheFlagsMissingTs(v) {
       // The IXP bug shape — forgot to touch the ts sibling.
       sessionStorage.setItem('app.flags', JSON.stringify(v));
     }
     export function unrelatedWrite(v) {
       sessionStorage.setItem('other.key', v);
     }`,
  );
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 0);
});

test('integration: two functions each with a paired-write -> two findings', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/one.ts',
    `export function saveA(v) {
       localStorage.setItem('a.payload', v);
       localStorage.setItem('a.ts', Date.now());
     }
     export function saveB(v) {
       sessionStorage.setItem('b.payload', v);
       sessionStorage.setItem('b.ts', Date.now());
     }`,
  );
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 2);
  const keySets = r.findings.map((f) => f.keys.join(',')).sort();
  assert.deepEqual(keySets, ['a.payload,a.ts', 'b.payload,b.ts']);
});

test('integration: skips node_modules and dist', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/real.ts', `export function f(v) {
    localStorage.setItem('r1', v);
    localStorage.setItem('r2', v);
  }`);
  write(
    a,
    'node_modules/pkg/dist/index.js',
    `function f(v) {
      localStorage.setItem('n1', v);
      localStorage.setItem('n2', v);
    }`,
  );
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].keys, ['r1', 'r2']);
});

test('integration: schema shape', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/cache.ts',
    `export function f(v) {
       localStorage.setItem('k1', v);
       localStorage.setItem('k2', v);
     }`,
  );
  const r = analyzeProjects([a]);
  assert.equal(r.version, SCHEMA_VERSION);
  assert.equal(r.analyzer, ANALYZER_ID);
  assert.equal(r.analyzer, 'paired-keys');
  const f = r.findings[0];
  assert.equal(f.kind, 'paired-keys');
  assert.ok(Array.isArray(f.keys));
  assert.ok(Array.isArray(f.occurrences));
  const o = f.occurrences[0];
  assert.equal(typeof o.project, 'string');
  assert.equal(typeof o.file, 'string');
  assert.ok(typeof o.line === 'number' && o.line > 0);
  assert.ok(typeof o.column === 'number' && o.column > 0);
  assert.equal(typeof o.key, 'string');
  assert.equal(typeof o.snippet, 'string');
});
