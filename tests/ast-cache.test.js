import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAstCache } from '../src/ast-cache.js';
import { analyzeProjects as impactAnalyze } from '../src/impact.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-ast-cache-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ---------- createAstCache: unit ----------

test('createAstCache: first get is a miss, second is a hit', () => {
  const tmp = mktmp();
  const file = path.join(tmp, 'a.js');
  fs.writeFileSync(file, 'export const x = 1;\n');

  const cache = createAstCache();

  const first = cache.get(file);
  assert.ok(first, 'first get returns entry');
  assert.equal(typeof first.code, 'string');
  assert.ok(first.sourceFile, 'entry has sourceFile');

  const second = cache.get(file);
  assert.strictEqual(second, first, 'second get returns same reference');

  const stats = cache.stats();
  assert.equal(stats.size, 1, 'size counts distinct files');
  assert.equal(stats.misses, 1, 'one miss');
  assert.equal(stats.hits, 1, 'one hit');
  assert.equal(stats.readErrors, 0);
  assert.equal(stats.parseErrors, 0);
});

test('createAstCache: missing file returns null, does not throw, counted as readError', () => {
  const cache = createAstCache();
  const result = cache.get('/does/not/exist.js');
  assert.equal(result, null);

  // Second call for the same path still returns null without re-reading
  // (cached negative result).
  const again = cache.get('/does/not/exist.js');
  assert.equal(again, null);

  const stats = cache.stats();
  assert.equal(stats.size, 1, 'negative results are cached too');
  assert.equal(stats.readErrors, 1, 'read error counted once');
  assert.equal(stats.hits, 1, 'second call was a hit on the cached null');
});

test('createAstCache: .ts, .tsx, .jsx, .js all parse via correct ScriptKind', () => {
  const tmp = mktmp();
  const files = {
    'a.ts': 'export const x: number = 1;\n',
    'b.tsx': 'export const Foo = (): any => <div />;\n',
    'c.jsx': 'export const Bar = () => <div />;\n',
    'd.js': 'export const y = 1;\n',
  };
  for (const [name, content] of Object.entries(files)) {
    write(tmp, name, content);
  }

  const cache = createAstCache();
  for (const name of Object.keys(files)) {
    const abs = path.join(tmp, name);
    const entry = cache.get(abs);
    assert.ok(entry, `${name} parses`);
    assert.ok(entry.sourceFile, `${name} has sourceFile`);
    assert.equal(entry.code, files[name]);
  }
});

test('createAstCache: distinct paths bump size independently', () => {
  const tmp = mktmp();
  write(tmp, 'a.js', 'export const a = 1;\n');
  write(tmp, 'b.js', 'export const b = 2;\n');

  const cache = createAstCache();
  cache.get(path.join(tmp, 'a.js'));
  cache.get(path.join(tmp, 'b.js'));
  cache.get(path.join(tmp, 'a.js')); // hit

  const stats = cache.stats();
  assert.equal(stats.size, 2);
  assert.equal(stats.misses, 2);
  assert.equal(stats.hits, 1);
});

// ---------- cache + orchestrator: integration ----------

test('impact analyzeProjects: output is structurally identical with and without cache', () => {
  const tmp = mktmp();
  // Write a tiny project with signal across several detectors.
  write(
    tmp,
    'package.json',
    JSON.stringify({ name: 'cache-regress' }, null, 2),
  );
  write(
    tmp,
    'src/user.js',
    `export function saveUser(u) {
  localStorage.setItem('app.session', JSON.stringify({ v: 1, name: u.name }));
  localStorage.setItem('app.profile', JSON.stringify({ v: 1 }));
}
export function readUser() {
  const raw = localStorage.getItem('app.session');
  return raw ? JSON.parse(raw) : null;
}
`,
  );
  write(
    tmp,
    'src/events.js',
    `export function emit(detail) {
  window.dispatchEvent(new CustomEvent('app:update', { detail }));
}
export function listen(cb) {
  window.addEventListener('app:update', cb);
}
`,
  );

  const a = impactAnalyze([tmp], {});
  const b = impactAnalyze([tmp], {});

  // Meta.timestamp will differ run-to-run; strip it before comparing.
  const stripTs = (r) => {
    const { meta, ...rest } = r;
    const { timestamp, ...metaRest } = meta;
    return { ...rest, meta: metaRest };
  };

  assert.deepEqual(stripTs(a), stripTs(b), 'two cache-less runs match');

  // Now run with an explicit cache; output should still match.
  const cache = createAstCache();
  const c = impactAnalyze([tmp], { astCache: cache });
  assert.deepEqual(stripTs(a), stripTs(c), 'cached run matches uncached run');

  // And the cache should have actually been used.
  const stats = cache.stats();
  assert.ok(stats.size >= 2, 'cache stored at least the two source files');
  assert.ok(stats.misses >= 2, 'at least two misses (one per file)');
  // With 7 detectors + import-graph potentially touching each file, we
  // expect plenty of hits on the second+ access. Non-strict bound: >0.
  assert.ok(stats.hits > 0, 'cache was hit by downstream detectors');
});

test('impact analyzeProjects: opts.noCache produces structurally identical output to cached run', () => {
  const tmp = mktmp();
  write(tmp, 'package.json', JSON.stringify({ name: 'no-cache-regress' }));
  write(
    tmp,
    'src/user.js',
    `export function saveUser(u) {
  localStorage.setItem('app.session', JSON.stringify({ v: 1, name: u.name }));
}
export function readUser() {
  return JSON.parse(localStorage.getItem('app.session') ?? '{}');
}
`,
  );
  write(
    tmp,
    'src/events.js',
    `window.dispatchEvent(new CustomEvent('app:update', { detail: { v: 1 } }));
window.addEventListener('app:update', () => {});
`,
  );

  const stripTs = (r) => {
    const { meta, ...rest } = r;
    const { timestamp, ...metaRest } = meta;
    return { ...rest, meta: metaRest };
  };

  const cached = impactAnalyze([tmp], {});
  const uncached = impactAnalyze([tmp], { noCache: true });
  assert.deepEqual(
    stripTs(cached),
    stripTs(uncached),
    'noCache: true produces the same output as the default cached run',
  );
});

test('impact analyzeProjects: opts.noCache ignores an injected astCache', () => {
  const tmp = mktmp();
  write(tmp, 'package.json', JSON.stringify({ name: 'no-cache-wins' }));
  write(tmp, 'src/a.js', `localStorage.setItem('k', '1');\n`);

  const cache = createAstCache();
  impactAnalyze([tmp], { noCache: true, astCache: cache });
  // With noCache: true, the injected cache is never consulted.
  const stats = cache.stats();
  assert.equal(stats.size, 0, 'cache was never touched');
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 0);
});

test('impact analyzeProjects: passing astCache returns the same detector set as a fresh run', () => {
  const tmp = mktmp();
  write(tmp, 'package.json', JSON.stringify({ name: 'cache-determinism' }));
  write(
    tmp,
    'src/a.js',
    `localStorage.setItem('shared.key', '1');\nlocalStorage.getItem('shared.key');\n`,
  );

  const cache = createAstCache();
  const r1 = impactAnalyze([tmp], { astCache: cache });
  const r2 = impactAnalyze([tmp], { astCache: cache }); // reuse cache

  // Fingerprints are the stable identity — they must match across runs
  // regardless of cache state.
  assert.deepEqual(
    r1.findings.map((f) => f.fingerprint).sort(),
    r2.findings.map((f) => f.fingerprint).sort(),
    'fingerprints are stable across reused-cache runs',
  );
});
