import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeProjects,
  ANALYZER_ID,
  SCHEMA_VERSION,
  PLATFORM_PROPS,
  HOSTS,
} from '../src/proxied-platform-global.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-proxied-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ---------- positive — canonical cases ----------

test('detects window.history = new Proxy(...)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.kind, 'proxied-platform-global');
  assert.equal(f.host, 'window');
  assert.equal(f.property, 'history');
  assert.equal(f.occurrences.length, 1);
  assert.equal(f.occurrences[0].op, 'install');
});

test('detects globalThis.fetch = new Proxy(globalThis.fetch, handler)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/net.ts', `const handler = {}; globalThis.fetch = new Proxy(globalThis.fetch, handler);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.host, 'globalThis');
  assert.equal(f.property, 'fetch');
});

test('detects self.localStorage = new Proxy(self.localStorage, traps)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/storage.ts', `const traps = {}; self.localStorage = new Proxy(self.localStorage, traps);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.host, 'self');
  assert.equal(f.property, 'localStorage');
});

// ---------- catalogue completeness ----------

test('catalogue completeness: all PLATFORM_PROPS are detected when assigned on window', () => {
  for (const prop of PLATFORM_PROPS) {
    const a = mktmp();
    write(a, 'package.json', JSON.stringify({ name: 'app' }));
    write(a, 'src/test.ts', `window.${prop} = new Proxy(window.${prop}, {});`);

    const result = analyzeProjects([a]);
    const f = result.findings.find((x) => x.property === prop);
    assert.ok(f, `Expected finding for PLATFORM_PROP '${prop}'`);
    assert.equal(f.host, 'window');
    assert.equal(f.property, prop);
  }
});

// ---------- negative — must NOT detect ----------

test('non-platform property is NOT detected', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // window.myAppState is not in PLATFORM_PROPS
  write(a, 'src/app.ts', `window.myAppState = new Proxy(myAppState, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('non-platform host is NOT detected', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // someObj is not in HOSTS
  write(a, 'src/app.ts', `someObj.history = new Proxy(something, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('non-Proxy RHS is NOT detected', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/app.ts', `window.history = aFunction();`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('RHS NewExpression with non-Proxy callee is NOT detected', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/app.ts', `window.history = new SomethingElse(window.history, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('aliased host is NOT detected (v1 recall gap — D22 "Aliased hosts")', () => {
  // const w = window; w.history = new Proxy(...) — v1 misses this because
  // w is not a bare HOSTS identifier. Documented in D22 out-of-scope.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/app.ts', `const w = window; w.history = new Proxy(w.history, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'aliased host is a known v1 miss (D22)');
});

test('descriptor-based replacement is NOT detected (v1 recall gap — D22 "Descriptor-based")', () => {
  // Object.defineProperty(window, 'history', { value: new Proxy(...) })
  // v1 only detects BinaryExpression assignment shape. Documented in D22 out-of-scope.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/app.ts', `Object.defineProperty(window, 'history', { value: new Proxy(window.history, {}) });`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'descriptor-based is a known v1 miss (D22)');
});

test('one-hop indirect Proxy is NOT detected (v1 recall gap — D22 "One-hop indirect")', () => {
  // const PatchedHistory = new Proxy(window.history, {}); window.history = PatchedHistory;
  // RHS is an identifier, not a NewExpression, so v1 misses this. Documented in D22.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/app.ts',
    `const PatchedHistory = new Proxy(window.history, {});
     window.history = PatchedHistory;`,
  );

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'one-hop indirect is a known v1 miss (D22)');
});

// ---------- grouping & multiplicity ----------

test('two installs in same file produce one finding with two occurrences', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/nav.ts',
    `window.history = new Proxy(window.history, { get(t,p,r){return Reflect.get(t,p,r);} });
     window.history = new Proxy(window.history, {});`,
  );

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].occurrences.length, 2);
});

test('two installs in different files in same project produce one finding with two occurrences', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.ts', `window.history = new Proxy(window.history, {});`);
  write(a, 'src/nav2.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].occurrences.length, 2);
  const files = result.findings[0].occurrences.map((o) => o.file).sort();
  assert.deepEqual(files, ['src/nav.ts', 'src/nav2.ts']);
});

test('window.history AND window.fetch installs produce two findings (different properties)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/both.ts',
    `window.history = new Proxy(window.history, {});
     window.fetch = new Proxy(window.fetch, {});`,
  );

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 2);
  const properties = result.findings.map((f) => f.property).sort();
  assert.deepEqual(properties, ['fetch', 'history']);
});

test('same (host, property) across two projects groups into one finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/nav.ts', `window.history = new Proxy(window.history, {});`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/nav.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.host, 'window');
  assert.equal(f.property, 'history');
  assert.equal(f.occurrences.length, 2);
  const projects = new Set(f.occurrences.map((o) => o.project));
  assert.deepEqual([...projects].sort(), ['app-a', 'app-b']);
});

// ---------- scope coverage ----------

test('install at module scope emits finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.ts', `export {};\nwindow.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
});

test('install inside a function body emits finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/nav.ts',
    `function setup() {
      window.history = new Proxy(window.history, {});
    }`,
  );

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
});

test('install inside an if-branch emits finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/nav.ts',
    `if (FEATURE_FLAG) {
      window.history = new Proxy(window.history, {});
    }`,
  );

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
});

test('install inside an arrow function emits finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/nav.ts',
    `const init = () => {
      window.history = new Proxy(window.history, {});
    };`,
  );

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
});

// ---------- schema ----------

test('raw output schema: finding has kind, host, property, occurrences; occurrence has required fields; no fingerprint/severity/confidence in raw output', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a]);
  assert.equal(result.version, SCHEMA_VERSION);
  assert.equal(result.analyzer, ANALYZER_ID);
  assert.ok(Array.isArray(result.findings));
  assert.ok(Array.isArray(result.projects));

  const f = result.findings[0];
  assert.equal(f.kind, 'proxied-platform-global');
  assert.ok(typeof f.host === 'string' && f.host.length > 0);
  assert.ok(typeof f.property === 'string' && f.property.length > 0);
  assert.ok(Array.isArray(f.occurrences));

  const o = f.occurrences[0];
  assert.ok(typeof o.project === 'string');
  assert.ok(typeof o.file === 'string');
  assert.ok(typeof o.line === 'number' && o.line > 0);
  assert.ok(typeof o.column === 'number' && o.column > 0);
  assert.equal(o.op, 'install');
  assert.ok(typeof o.snippet === 'string' && o.snippet.length > 0);

  // Raw output should NOT carry impact-decoration fields
  assert.equal(f.fingerprint, undefined, 'raw output should not have fingerprint');
  assert.equal(f.severity, undefined, 'raw output should not have severity');
  assert.equal(f.confidence, undefined, 'raw output should not have confidence');
  assert.equal(f.confidenceReason, undefined, 'raw output should not have confidenceReason');
  assert.equal(f.patternFingerprint, undefined, 'raw output should not have patternFingerprint');
});

// ---------- option threading regression smokes ----------

test('includeTestContext: finding emitted when install is in .test.ts with includeTestContext: true', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.test.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a], { includeTestContext: true });
  assert.equal(result.findings.length, 1, 'should detect when includeTestContext is true');
});

test('default: finding NOT emitted when install is in .test.ts file', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.test.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a]); // default: skip test-context
  assert.equal(result.findings.length, 0, 'should skip test-context files by default');
});

test('exclude option: matching files are excluded', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.ts', `window.history = new Proxy(window.history, {});`);
  write(a, 'vendor/nav.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a], { exclude: ['vendor'] });
  // Only src/nav.ts should be scanned (vendor is excluded)
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].occurrences.length, 1);
  assert.ok(result.findings[0].occurrences[0].file.startsWith('src/'));
});
