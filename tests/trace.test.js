import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseStorageTarget,
  traceStorage,
  traceEvent,
  traceGlobal,
  renderMermaid,
  summarize,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/trace.js';
import { analyzeProjects as impactAnalyze } from '../src/impact.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-trace-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ---------- parseStorageTarget ----------

test('parseStorageTarget: splits on the first colon only', () => {
  assert.deepEqual(parseStorageTarget('localStorage:app.session'),
    { backend: 'localStorage', key: 'app.session' });
  assert.deepEqual(parseStorageTarget('sessionStorage:user:profile:v2'),
    { backend: 'sessionStorage', key: 'user:profile:v2' });
});

test('parseStorageTarget: rejects unknown backend', () => {
  assert.throws(() => parseStorageTarget('cookies:foo'),
    /Unknown storage backend.*'cookies'/);
});

test('parseStorageTarget: rejects missing colon', () => {
  assert.throws(() => parseStorageTarget('localStorage.app'),
    /<backend:key>/);
});

test('parseStorageTarget: rejects empty key', () => {
  assert.throws(() => parseStorageTarget('localStorage:'),
    /non-empty key/);
});

// ---------- traceStorage ----------

test('traceStorage: schema envelope', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);

  const r = traceStorage([a], 'localStorage', 'k');
  assert.equal(r.version, SCHEMA_VERSION);
  assert.equal(r.analyzer, ANALYZER_ID);
  assert.deepEqual(r.target, { kind: 'storage', backend: 'localStorage', name: 'k' });
  assert.equal(r.projects.length, 1);
  // 1 target + 2 occurrences.
  assert.equal(r.nodes.length, 3);
  assert.equal(r.edges.length, 2);
});

test('traceStorage: occurrence nodes carry project, file, line, column, op, snippet', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);

  const r = traceStorage([a], 'localStorage', 'k');
  const occ = r.nodes.find((n) => n.role === 'occurrence');
  assert.ok(occ);
  assert.equal(occ.project, 'app');
  assert.equal(occ.file, 'src/w.ts');
  assert.equal(typeof occ.line, 'number');
  assert.equal(typeof occ.column, 'number');
  assert.equal(occ.op, 'write');
  assert.match(occ.snippet, /localStorage\.setItem/);
});

test('traceStorage: edge kind maps op to relation', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/ops.ts', `
    localStorage.setItem('k', 1);
    localStorage.getItem('k');
    localStorage.removeItem('k');
  `);

  const r = traceStorage([a], 'localStorage', 'k');
  const kinds = new Set(r.edges.map((e) => e.kind));
  assert.ok(kinds.has('writes-to'));
  assert.ok(kinds.has('reads-from'));
  assert.ok(kinds.has('removes-from'));
});

test('traceStorage: non-matching key returns target-only graph (no edges)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('kept', 1);`);

  const r = traceStorage([a], 'localStorage', 'not-a-key');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].role, 'target');
  assert.equal(r.edges.length, 0);
  assert.equal(r.summary.totalOccurrences, 0);
  assert.equal(r.summary.affectedFiles, 0);
});

test('traceStorage: does not cross storage backends', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/ls.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/ss.ts', `sessionStorage.setItem('k', 1);`);

  const ls = traceStorage([a], 'localStorage', 'k');
  const ss = traceStorage([a], 'sessionStorage', 'k');
  // Each backend sees only its own site.
  assert.equal(ls.summary.totalOccurrences, 1);
  assert.equal(ss.summary.totalOccurrences, 1);
  assert.ok(ls.nodes.some((n) => n.role === 'occurrence' && n.file.endsWith('ls.ts')));
  assert.ok(ss.nodes.some((n) => n.role === 'occurrence' && n.file.endsWith('ss.ts')));
});

test('traceStorage: opts.exclude is threaded through to walker', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'examples/fixture.ts', `localStorage.setItem('k', 1);`);

  const full = traceStorage([a], 'localStorage', 'k');
  const scoped = traceStorage([a], 'localStorage', 'k', { exclude: ['examples'] });

  assert.equal(full.summary.totalOccurrences, 2);
  assert.equal(scoped.summary.totalOccurrences, 1);
  assert.ok(scoped.nodes.every(
    (n) => n.role !== 'occurrence' || !n.file.startsWith('examples'),
  ));
});

// ---------- traceEvent ----------

test('traceEvent: matches channel by literal name', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/d.ts', `window.dispatchEvent(new CustomEvent('user:changed'));`);
  write(a, 'src/l.ts', `window.addEventListener('user:changed', fn);`);
  write(a, 'src/other.ts', `window.dispatchEvent(new CustomEvent('unrelated'));`);

  const r = traceEvent([a], 'user:changed');
  assert.equal(r.target.kind, 'event');
  assert.equal(r.target.name, 'user:changed');
  assert.equal(r.summary.totalOccurrences, 2);
  const kinds = new Set(r.edges.map((e) => e.kind));
  assert.ok(kinds.has('dispatches-to'));
  assert.ok(kinds.has('listens-to'));
});

test('traceEvent: channel names containing colons are matched as-is', () => {
  // Regression: --event parsing must not try to split on colons the way
  // --storage does. "user:changed" is a single channel name.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/l.ts', `window.addEventListener('ns:evt', fn);`);

  const r = traceEvent([a], 'ns:evt');
  assert.equal(r.summary.totalOccurrences, 1);
});

// ---------- traceGlobal ----------

test('traceGlobal: surfaces declare sites across projects', () => {
  const a = mktmp();
  const b = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  // Classic scripts (no import/export) with a shared top-level function.
  write(a, 'src/helpers.js', `function sharedHelper() { return 1; }`);
  write(b, 'src/helpers.js', `function sharedHelper() { return 2; }`);

  const r = traceGlobal([a, b], 'sharedHelper');
  assert.equal(r.target.kind, 'global');
  assert.equal(r.summary.totalOccurrences, 2);
  assert.equal(r.summary.affectedProjects, 2);
  assert.ok(r.edges.every((e) => e.kind === 'declares'));
});

// ---------- renderMermaid ----------

test('renderMermaid: emits a flowchart with target hub and one edge per occurrence', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);

  const r = traceStorage([a], 'localStorage', 'k');
  const md = renderMermaid(r);
  assert.match(md, /^flowchart TD/);
  assert.match(md, /target\["localStorage:k"\]/);
  assert.match(md, /-->\|writes-to\| target/);
  assert.match(md, /-->\|reads-from\| target/);
});

// ---------- summarize ----------

test('summarize: reports target label, op counts, and affected counts', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);

  const r = traceStorage([a], 'localStorage', 'k');
  const lines = summarize(r);
  assert.ok(lines.some((l) => l.includes('localStorage:k')));
  assert.ok(lines.some((l) => /write=1/.test(l) && /read=1/.test(l)));
  assert.ok(lines.some((l) => /occurrences:\s+2/.test(l)));
});

// ---------- integration: trace output is faithful to impact / shared-state ----------

test('integration: trace occurrences match the same sites impact sees for the key', () => {
  // The fixture mirrors examples/app-a's app.session key: writer + reader
  // + remover across two files. Running trace and impact on the same tree
  // must produce the same set of (file, line, op) tuples for that key.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/writer.ts', `
    export function login(t) {
      localStorage.setItem('app.session', t);
    }
    export function logout() {
      localStorage.removeItem('app.session');
    }
  `);
  write(a, 'src/reader.ts', `
    export function getToken() {
      return localStorage.getItem('app.session');
    }
  `);
  write(a, 'src/unrelated.ts', `localStorage.setItem('other', 1);`);

  const traced = traceStorage([a], 'localStorage', 'app.session');
  const impactResult = impactAnalyze([a]);
  const impactFinding = impactResult.findings.find(
    (f) => f.kind === 'shared-storage-key'
      && f.detail.storage === 'localStorage'
      && f.detail.key === 'app.session',
  );
  assert.ok(impactFinding, 'impact must surface a finding for app.session');

  const traceTuples = new Set(
    traced.nodes
      .filter((n) => n.role === 'occurrence')
      .map((n) => `${n.file}:${n.line}:${n.op}`),
  );
  // Impact wraps the detector finding under `.detail`; the raw occurrences
  // live there. This pin also guards against a silent impact-envelope
  // refactor that drops occurrences from the unified shape.
  const impactTuples = new Set(
    impactFinding.detail.occurrences.map((o) => `${o.file}:${o.line}:${o.op}`),
  );
  assert.deepEqual(
    [...traceTuples].sort(),
    [...impactTuples].sort(),
    'trace and impact must see the same occurrences for this key',
  );
  // And the unrelated 'other' key must not leak into the trace graph.
  assert.ok(
    [...traceTuples].every((t) => !t.includes('unrelated.ts')),
    'trace must be scoped to the targeted key',
  );
});
