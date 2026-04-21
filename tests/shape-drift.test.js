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
} from '../src/shape-drift.js';
import { createAstCache } from '../src/ast-cache.js';
import { buildConstantsIndex, makeCrossFileResolver } from '../src/cross-file-constants.js';
import { resolveProject } from '../src/project.js';

// ---------- write-shape extraction (unit) ----------

test('write: setItem(key, JSON.stringify({a,b})) → shape {a,b}', () => {
  const { writes } = analyzeSource(
    `sessionStorage.setItem('k', JSON.stringify({ a: 1, b: 2 }));`,
    'f.ts',
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].opaque, false);
  assert.deepEqual(writes[0].keys, ['a', 'b']);
  assert.equal(writes[0].storage, 'sessionStorage');
  assert.equal(writes[0].key, 'k');
});

test('write: shorthand property names in object literal are captured', () => {
  const { writes } = analyzeSource(
    `function f(a,b,c){ localStorage.setItem('k', JSON.stringify({ a, b, c })); }`,
    'f.ts',
  );
  assert.equal(writes[0].opaque, false);
  assert.deepEqual(writes[0].keys, ['a', 'b', 'c']);
});

test('write: string-literal property names are captured', () => {
  const { writes } = analyzeSource(
    `localStorage.setItem('k', JSON.stringify({ "first-name": 'x', 'last-name': 'y' }));`,
    'f.ts',
  );
  assert.deepEqual(writes[0].keys, ['first-name', 'last-name']);
});

test('write: setItem with non-stringify value is opaque', () => {
  const { writes } = analyzeSource(
    `function f(s){ localStorage.setItem('k', s); }`,
    'f.ts',
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].opaque, true);
  assert.equal(writes[0].reason, 'value-not-json-stringify');
});

test('write: JSON.stringify(<identifier>) is opaque', () => {
  const { writes } = analyzeSource(
    `function f(o){ localStorage.setItem('k', JSON.stringify(o)); }`,
    'f.ts',
  );
  assert.equal(writes[0].opaque, true);
  assert.equal(writes[0].reason, 'stringify-arg-not-object-literal');
});

test('write: object with spread is opaque (v1 limitation)', () => {
  const { writes } = analyzeSource(
    `function f(prev){ localStorage.setItem('k', JSON.stringify({ ...prev, x: 1 })); }`,
    'f.ts',
  );
  assert.equal(writes[0].opaque, true);
});

test('write: computed property name is opaque', () => {
  const { writes } = analyzeSource(
    `function f(name){ localStorage.setItem('k', JSON.stringify({ [name]: 1 })); }`,
    'f.ts',
  );
  assert.equal(writes[0].opaque, true);
});

test('write: dynamic storage key is ignored (out of v1 scope)', () => {
  const { writes } = analyzeSource(
    `function f(k){ localStorage.setItem(k, JSON.stringify({ a: 1 })); }`,
    'f.ts',
  );
  assert.equal(writes.length, 0);
});

test('write: resolves window.localStorage and globalThis.sessionStorage', () => {
  const { writes } = analyzeSource(
    `
      window.localStorage.setItem('a', JSON.stringify({ x: 1 }));
      globalThis.sessionStorage.setItem('b', JSON.stringify({ y: 1 }));
    `,
    'f.ts',
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].storage, 'localStorage');
  assert.equal(writes[1].storage, 'sessionStorage');
});

// ---------- read-shape extraction (unit) ----------

test('read: JSON.parse(getItem(k)).name → shape {name}', () => {
  const { reads } = analyzeSource(
    `const x = JSON.parse(sessionStorage.getItem('k')).name;`,
    'f.ts',
  );
  assert.equal(reads.length, 1);
  assert.equal(reads[0].opaque, false);
  assert.deepEqual(reads[0].keys, ['name']);
});

test(`read: JSON.parse(getItem(k))['field'] → shape {field}`, () => {
  const { reads } = analyzeSource(
    `const x = JSON.parse(sessionStorage.getItem('k'))['field'];`,
    'f.ts',
  );
  assert.deepEqual(reads[0].keys, ['field']);
});

test('read: destructured binding: const {a, b} = JSON.parse(getItem(k))', () => {
  const { reads } = analyzeSource(
    `const { a, b } = JSON.parse(localStorage.getItem('k'));`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, false);
  assert.deepEqual(reads[0].keys, ['a', 'b']);
});

test('read: destructured with renamed prop: const {a: x, b: y} = JSON.parse(...)', () => {
  const { reads } = analyzeSource(
    `const { a: x, b: y } = JSON.parse(localStorage.getItem('k'));`,
    'f.ts',
  );
  // The ORIGINAL property names (a, b) are the shape, not the local binding names.
  assert.deepEqual(reads[0].keys, ['a', 'b']);
});

test('read: destructured with rest ...rest → opaque', () => {
  const { reads } = analyzeSource(
    `const { a, ...rest } = JSON.parse(localStorage.getItem('k'));`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, true);
  assert.equal(reads[0].reason, 'rest-destructure');
});

test('read: variable binding + usages in same scope → shape {a,b}', () => {
  const { reads } = analyzeSource(
    `function f() {
       const o = JSON.parse(localStorage.getItem('k'));
       if (o.a > 0) return o.b;
       return 0;
     }`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, false);
  assert.deepEqual(reads[0].keys, ['a', 'b']);
});

test('read: variable binding with literal element access o["x"] → shape {x}', () => {
  const { reads } = analyzeSource(
    `function f() {
       const o = JSON.parse(localStorage.getItem('k'));
       return o['x'];
     }`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, false);
  assert.deepEqual(reads[0].keys, ['x']);
});

test('read: variable binding not accessed → opaque', () => {
  const { reads } = analyzeSource(
    `function f() { const o = JSON.parse(localStorage.getItem('k')); return o; }`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, true);
  assert.equal(reads[0].reason, 'binding-not-accessed');
});

test('read: variable binding with only dynamic accesses → opaque', () => {
  const { reads } = analyzeSource(
    `function f(k) {
       const o = JSON.parse(localStorage.getItem('k'));
       return o[k];
     }`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, true);
  assert.equal(reads[0].reason, 'only-dynamic-accesses-on-binding');
});

test('read: variable binding with mixed literal + dynamic accesses → partial (not opaque)', () => {
  const { reads } = analyzeSource(
    `function f(k) {
       const o = JSON.parse(localStorage.getItem('k'));
       return o.a + o[k];
     }`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, false);
  assert.deepEqual(reads[0].keys, ['a']);
  assert.equal(reads[0].partial, true);
});

test('read: tolerates `getItem(k) || "{}"` fallback', () => {
  const { reads } = analyzeSource(
    `const x = JSON.parse(localStorage.getItem('k') || '{}').name;`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, false);
  assert.deepEqual(reads[0].keys, ['name']);
});

test('read: tolerates `getItem(k) ?? "{}"` fallback', () => {
  const { reads } = analyzeSource(
    `const x = JSON.parse(localStorage.getItem('k') ?? '{}').name;`,
    'f.ts',
  );
  assert.deepEqual(reads[0].keys, ['name']);
});

test('read: tolerates non-null assertion `getItem(k)!`', () => {
  const { reads } = analyzeSource(
    `const x = JSON.parse(localStorage.getItem('k')!).name;`,
    'f.ts',
  );
  assert.deepEqual(reads[0].keys, ['name']);
});

test('read: tolerates parens around the getItem call', () => {
  const { reads } = analyzeSource(
    `const x = JSON.parse((localStorage.getItem('k'))).name;`,
    'f.ts',
  );
  assert.deepEqual(reads[0].keys, ['name']);
});

test('read: JSON.parse not wrapping a getItem call is ignored', () => {
  const { reads } = analyzeSource(
    `function f(s){ return JSON.parse(s).name; }`,
    'f.ts',
  );
  assert.equal(reads.length, 0);
});

test('read: dynamic key is ignored (out of v1 scope)', () => {
  const { reads } = analyzeSource(
    `function f(k){ return JSON.parse(localStorage.getItem(k)).name; }`,
    'f.ts',
  );
  assert.equal(reads.length, 0);
});

test('read: parseCall not directly accessed (e.g. returned) → opaque', () => {
  const { reads } = analyzeSource(
    `function f(){ return JSON.parse(localStorage.getItem('k')); }`,
    'f.ts',
  );
  assert.equal(reads[0].opaque, true);
  assert.equal(reads[0].reason, 'parsed-value-not-directly-accessed');
});

test('parses tsx without crashing', () => {
  const { writes, reads } = analyzeSource(
    `export const C = () => {
       const o = JSON.parse(sessionStorage.getItem('k') || '{}');
       return <div>{o.name}</div>;
     };`,
    'f.tsx',
  );
  assert.equal(reads.length, 1);
  assert.equal(reads[0].opaque, false);
  assert.deepEqual(reads[0].keys, ['name']);
});

// ---------- analyzeProjects: drift detection (integration) ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-shape-drift-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('integration: clean drift — writer {name} vs reader {firstName}', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('user', JSON.stringify({ name: 'x', age: 3 }));`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('user') || '{}'); console.log(u.firstName, u.lastName);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.kind, 'shape-drift');
  assert.equal(f.storage, 'localStorage');
  assert.equal(f.key, 'user');
  assert.deepEqual(f.writeShape, ['age', 'name']);
  assert.deepEqual(f.readShape, ['firstName', 'lastName']);
  assert.deepEqual(f.writeOnlyKeys, ['age', 'name']);
  assert.deepEqual(f.readOnlyKeys, ['firstName', 'lastName']);
  assert.equal(f.opaqueWrites, 0);
  assert.equal(f.opaqueReads, 0);
  assert.equal(f.occurrences.length, 2);
});

test('integration: match on all fields emits NO finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x', age: 3 }));`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.name, u.age);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 0);
});

test('integration: writer-only drift (writes field reader never reads) emits finding with writeOnlyKeys', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x', legacyId: 1 }));`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.name);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].writeOnlyKeys, ['legacyId']);
  assert.deepEqual(r.findings[0].readOnlyKeys, []);
});

test('integration: reader-only drift (reader is a strict superset of writer) emits readOnlyKeys', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Writer shape is a strict subset of reader shape: {name} vs {name, extra}.
  // Expected: readOnlyKeys=['extra'], writeOnlyKeys=[].
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.name, u.extra);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].readOnlyKeys, ['extra']);
  assert.deepEqual(r.findings[0].writeOnlyKeys, []);
});

test('integration: opaque-only write + literal read → NO finding (v1 requires literal on both sides)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `function f(s){ localStorage.setItem('k', s); }`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.name);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 0);
});

test('integration: literal write + opaque read → NO finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/r.ts', `function f(){ return JSON.parse(localStorage.getItem('k') || '{}'); }`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 0);
});

test('integration: mixed writers (one literal, one opaque) + literal reader — literal side pairs with reader', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w1.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/w2.ts', `function f(s){ localStorage.setItem('k', s); }`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.firstName);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.opaqueWrites, 1);
  assert.equal(f.opaqueReads, 0);
  assert.deepEqual(f.readOnlyKeys, ['firstName']);
  assert.deepEqual(f.writeOnlyKeys, ['name']);
  // All three occurrences are kept in the finding (literal + opaque) so a
  // reviewer sees every site.
  assert.equal(f.occurrences.length, 3);
});

test('integration: writer-only with NO reader does NOT emit (need both sides)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ a: 1 }));`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 0);
});

test('integration: reader-only with NO writer does NOT emit (need both sides)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.x);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 0);
});

test('integration: cross-project drift is detected and occurrences span projects', () => {
  const a = mktmp();
  const b = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(a, 'src/w.ts', `localStorage.setItem('shared.user', JSON.stringify({ name: 'x' }));`);
  write(b, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('shared.user') || '{}'); console.log(u.firstName);`);
  const r = analyzeProjects([a, b]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  const projects = new Set(f.occurrences.map((o) => o.project));
  assert.equal(projects.size, 2);
  assert.ok(projects.has('app-a'));
  assert.ok(projects.has('app-b'));
});

test('integration: different keys do not cross-pollinate', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k1', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k2') || '{}'); console.log(u.firstName);`);
  const r = analyzeProjects([a]);
  // Two completely separate channels — neither has BOTH a literal writer
  // and a literal reader — so nothing emits.
  assert.equal(r.findings.length, 0);
});

test('integration: localStorage and sessionStorage with same key are distinct channels', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w1.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/r1.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.firstName);`);
  write(a, 'src/w2.ts', `sessionStorage.setItem('k', JSON.stringify({ age: 1 }));`);
  write(a, 'src/r2.ts', `const u = JSON.parse(sessionStorage.getItem('k') || '{}'); console.log(u.lastName);`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 2);
  const storages = new Set(r.findings.map((f) => f.storage));
  assert.deepEqual([...storages].sort(), ['localStorage', 'sessionStorage']);
});

test('integration: destructuring reader + object-literal writer — clean drift', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x', age: 3 }));`);
  write(a, 'src/r.ts', `const { firstName, lastName } = JSON.parse(localStorage.getItem('k') || '{}');`);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].readOnlyKeys, ['firstName', 'lastName']);
});

test('integration: skips node_modules and dist', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.firstName);`);
  // A vendored copy with no drift shouldn't be considered.
  write(a, 'node_modules/pkg/index.js', `
    localStorage.setItem('k', JSON.stringify({ firstName: 'z' }));
    const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.firstName);
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  // Verify no node_modules file shows up in occurrences.
  for (const o of r.findings[0].occurrences) {
    assert.ok(!o.file.includes('node_modules'), `unexpected node_modules occurrence: ${o.file}`);
  }
});

test('integration: folds same-file `const KEY = "literal"` on both write and read sides', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `
    const PROFILE_KEY = 'user.profile';
    export function save(p) {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: p.name, age: p.age }));
    }
  `);
  write(a, 'src/r.ts', `
    const PROFILE_KEY = 'user.profile';
    export function load() {
      const u = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
      return u.firstName + ' ' + u.lastName;
    }
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.key, 'user.profile');
  assert.deepEqual(f.writeShape, ['age', 'name']);
  assert.deepEqual(f.readShape, ['firstName', 'lastName']);
  const writeOcc = f.occurrences.find((o) => o.op === 'write');
  const readOcc = f.occurrences.find((o) => o.op === 'read');
  assert.equal(writeOcc.foldedFrom, 'PROFILE_KEY');
  assert.equal(readOcc.foldedFrom, 'PROFILE_KEY');
});

test('integration: folded key on one side pairs with inline literal on the other', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('user.profile', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/r.ts', `
    const KEY = 'user.profile';
    const u = JSON.parse(localStorage.getItem(KEY) || '{}');
    console.log(u.firstName);
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.key, 'user.profile');
  const readOcc = f.occurrences.find((o) => o.op === 'read');
  const writeOcc = f.occurrences.find((o) => o.op === 'write');
  assert.equal(readOcc.foldedFrom, 'KEY');
  // The inline-literal write has no foldedFrom.
  assert.equal(writeOcc.foldedFrom, undefined);
});

test('integration: schema shape', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ name: 'x' }));`);
  write(a, 'src/r.ts', `const u = JSON.parse(localStorage.getItem('k') || '{}'); console.log(u.firstName);`);
  const r = analyzeProjects([a]);
  assert.equal(r.version, SCHEMA_VERSION);
  assert.equal(r.analyzer, ANALYZER_ID);
  assert.equal(r.analyzer, 'shape-drift');
  const f = r.findings[0];
  assert.equal(f.kind, 'shape-drift');
  assert.equal(typeof f.storage, 'string');
  assert.equal(typeof f.key, 'string');
  assert.ok(Array.isArray(f.writeShape));
  assert.ok(Array.isArray(f.readShape));
  assert.ok(Array.isArray(f.writeOnlyKeys));
  assert.ok(Array.isArray(f.readOnlyKeys));
  assert.equal(typeof f.opaqueWrites, 'number');
  assert.equal(typeof f.opaqueReads, 'number');
  const o = f.occurrences[0];
  assert.equal(typeof o.project, 'string');
  assert.equal(typeof o.file, 'string');
  assert.ok(typeof o.line === 'number' && o.line > 0);
  assert.ok(typeof o.column === 'number' && o.column > 0);
  assert.match(o.op, /^(read|write)$/);
  assert.equal(typeof o.opaque, 'boolean');
  assert.equal(typeof o.snippet, 'string');
});

// ---------- alias-chain read-follow (Gap F / shape-drift v2) ----------

test('alias-chain read: `const raw = getItem(K); JSON.parse(raw)` surfaces as a read on K', () => {
  const { reads } = analyzeSource(
    `function readUser() {
       const raw = localStorage.getItem('user.profile');
       const data = JSON.parse(raw || '{}');
       return data.firstName;
     }`,
    'f.ts',
  );
  assert.equal(reads.length, 1, 'one read detected through the alias');
  const r = reads[0];
  assert.equal(r.storage, 'localStorage');
  assert.equal(r.key, 'user.profile');
  assert.equal(r.aliasedFrom, 'raw');
  assert.deepEqual(r.keys, ['firstName']);
});

test('alias-chain read: reassigned binding is NOT followed', () => {
  const { reads } = analyzeSource(
    `function readUser() {
       let raw = localStorage.getItem('user.profile');
       raw = 'tampered';
       const data = JSON.parse(raw || '{}');
       return data.firstName;
     }`,
    'f.ts',
  );
  assert.equal(reads.length, 0, 'reassigned alias is not foldable; no read emitted');
});

test('alias-chain read: module-scope alias is still visible from an inner function', () => {
  const { reads } = analyzeSource(
    `const raw = localStorage.getItem('user.profile');
     function readUser() {
       // The module-scope binding is a valid outer scope for the use-site
       // inside readUser, so alias-follow resolves through it.
       return JSON.parse(raw || '{}').firstName;
     }`,
    'f.ts',
  );
  assert.equal(reads.length, 1);
  assert.equal(reads[0].aliasedFrom, 'raw');
});

test('alias-chain read: integration — writer/reader pair with alias-follow surfaces drift', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'alias-drift' }));
  write(a, 'src/writer.ts', `
    localStorage.setItem('profile.v1', JSON.stringify({ firstName: 'a', lastName: 'b' }));
  `);
  write(a, 'src/reader.ts', `
    function readProfile() {
      const raw = localStorage.getItem('profile.v1');
      const data = JSON.parse(raw || '{}');
      return data.first_name;
    }
  `);
  const result = analyzeProjects([a]);
  const finding = result.findings.find((f) => f.key === 'profile.v1');
  assert.ok(finding, 'writer/reader pair found through alias chain');
  assert.deepEqual(finding.writeShape.sort(), ['firstName', 'lastName']);
  assert.deepEqual(finding.readShape, ['first_name']);
  assert.deepEqual(finding.writeOnlyKeys, ['firstName', 'lastName']);
  assert.deepEqual(finding.readOnlyKeys, ['first_name']);
  const readOcc = finding.occurrences.find((o) => o.op === 'read');
  assert.equal(readOcc.aliasedFrom, 'raw', 'occurrence carries aliasedFrom tag');
});

test('alias-chain read: inline form still works (regression — alias path does not break existing behaviour)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'inline-drift' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', JSON.stringify({ firstName: 'a', lastName: 'b' }));`);
  write(a, 'src/r.ts', `const { first_name } = JSON.parse(localStorage.getItem('k') || '{}');`);
  const result = analyzeProjects([a]);
  const finding = result.findings.find((f) => f.key === 'k');
  assert.ok(finding);
  const readOcc = finding.occurrences.find((o) => o.op === 'read');
  assert.equal(readOcc.aliasedFrom, undefined, 'no alias field on inline reads');
});

test('D15: cross-file imported key surfaces drift between writer and reader', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'xfile-drift' }));
  write(a, 'src/keys.ts', `export const K_USER = 'user.profile';`);
  write(a, 'src/writer.ts', `
    import { K_USER } from './keys';
    localStorage.setItem(K_USER, JSON.stringify({ firstName: 'a', lastName: 'b' }));
  `);
  write(a, 'src/reader.ts', `
    import { K_USER } from './keys';
    const { firstName, email } = JSON.parse(localStorage.getItem(K_USER) || '{}');
  `);

  const astCache = createAstCache();
  const index = buildConstantsIndex([resolveProject(a)], { astCache });
  const crossFileResolver = makeCrossFileResolver(index);
  const result = analyzeProjects([a], { astCache, crossFileResolver });

  const finding = result.findings.find(
    (f) => f.storage === 'localStorage' && f.key === 'user.profile',
  );
  assert.ok(finding, 'cross-file writer+reader find each other via shared key');
  assert.deepEqual(finding.writeShape.sort(), ['firstName', 'lastName']);
  assert.deepEqual(finding.readShape.sort(), ['email', 'firstName']);
  assert.deepEqual(finding.writeOnlyKeys, ['lastName']);
  assert.deepEqual(finding.readOnlyKeys, ['email']);
  for (const o of finding.occurrences) {
    assert.equal(o.foldedFrom, 'K_USER');
    assert.equal(o.foldedFromModule, './keys');
  }
});
