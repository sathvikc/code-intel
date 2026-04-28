import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { analyzeProjects, computeDiff, SCHEMA_VERSION, ANALYZER_ID } from '../src/impact.js';
import { renderMarkdown } from '../src/report-markdown.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-impact-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ---------- analyzeProjects: basic shape (no change set) ----------

test('analyzeProjects: schema envelope', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/y.ts', `localStorage.getItem('k');`);

  const r = analyzeProjects([a]);
  assert.equal(r.version, SCHEMA_VERSION);
  assert.equal(r.analyzer, ANALYZER_ID);
  assert.ok(r.meta);
  assert.ok(r.summary);
  assert.ok(Array.isArray(r.findings));
  assert.ok(r.integrations);
  // No `since` → base should be null, blast radius null, gitInfo null.
  assert.equal(r.meta.base, null);
  assert.equal(r.summary.blastRadius, null);
  assert.equal(r.graph, null);
  assert.equal(r.integrations.git, null);
});

test('analyzeProjects: aggregates findings across all four detectors', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // shared storage key
  write(a, 'src/login.ts', `localStorage.setItem('session', t);`);
  write(a, 'src/api.ts', `const t = localStorage.getItem('session');`);
  // shared event channel
  write(a, 'src/emit.ts', `window.dispatchEvent(new CustomEvent('ping'));`);
  write(a, 'src/on.ts', `window.addEventListener('ping', () => {});`);
  // shared global binding
  write(a, 'src/classic-a.js', `function helper() { return 1; }`);
  write(a, 'src/classic-b.js', `function helper() { return 2; }`);
  // stale capture
  write(a, 'src/stale.ts', `const snapshot = document.cookie;`);

  const r = analyzeProjects([a]);
  const kinds = new Set(r.findings.map((f) => f.kind));
  assert.ok(kinds.has('shared-storage-key'));
  assert.ok(kinds.has('shared-event-channel'));
  assert.ok(kinds.has('shared-global-binding'));
  assert.ok(kinds.has('stale-module-capture'));
});

// ---------- severity heuristic ----------

test('severity: shared-global-binding is always critical', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.js', `function helper() {}`);
  write(a, 'src/b.js', `function helper() {}`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-global-binding');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
});

test('severity: shared-storage-key is critical when cross-project', () => {
  const a = mktmp();
  const b = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(b, 'src/r.ts', `localStorage.getItem('k');`);
  const r = analyzeProjects([a, b]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
});

test('severity: shared-storage-key is warning within a single project', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

test('severity: stale-module-capture is warning', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `const v = document.cookie;`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'stale-module-capture');
  assert.ok(f);
  assert.equal(f.severity, 'warning');
});

// ---------- change set via explicit changedFiles ----------

test('changedFiles: findings touching change are sorted first and marked', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Two separate storage keys, only one touches the changed file.
  write(a, 'src/changed.ts', `localStorage.setItem('changed-key', 1);`);
  write(a, 'src/changed-other.ts', `localStorage.getItem('changed-key');`);
  write(a, 'src/unchanged-1.ts', `localStorage.setItem('other-key', 1);`);
  write(a, 'src/unchanged-2.ts', `localStorage.getItem('other-key');`);

  const changedAbs = path.join(a, 'src/changed.ts');
  const r = analyzeProjects([a], { changedFiles: [changedAbs] });

  assert.equal(r.meta.changedFileCount, 1);
  const touching = r.findings.filter((f) => f.touchesChange);
  assert.equal(touching.length, 1);
  assert.equal(touching[0].id, 'shared-storage-key:changed-key');
  // touching should be first in the list.
  assert.equal(r.findings[0].id, 'shared-storage-key:changed-key');
});

test('changedFiles: blast radius computed via import graph', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/target.ts', `export const x = 1;`);
  write(a, 'src/mid.ts', `import { x } from './target'; export const y = x;`);
  write(a, 'src/top.ts', `import { y } from './mid'; export const z = y;`);

  const changedAbs = path.join(a, 'src/target.ts');
  const r = analyzeProjects([a], { changedFiles: [changedAbs] });

  assert.ok(r.summary.blastRadius);
  assert.equal(r.summary.blastRadius.total, 2);
  assert.ok(r.graph.blastRadius.find((b) => b.file.endsWith('mid.ts')));
  assert.ok(r.graph.blastRadius.find((b) => b.file.endsWith('top.ts')));
});

test('changedFiles: summary.findingsTouchingChange counted correctly', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.setItem('k1', 1);`);
  write(a, 'src/b.ts', `localStorage.getItem('k1');`);
  write(a, 'src/c.ts', `localStorage.setItem('k2', 1);`);
  write(a, 'src/d.ts', `localStorage.getItem('k2');`);

  const r = analyzeProjects([a], { changedFiles: [path.join(a, 'src/a.ts')] });
  assert.equal(r.summary.totalFindings, 2);
  assert.equal(r.summary.findingsTouchingChange, 1);
});

// ---------- git integration (optional, graceful) ----------

test('since: returns available:false when not a git repo', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', 1);`);
  const r = analyzeProjects([a], { since: 'HEAD~1', cwd: a });
  assert.equal(r.integrations.git.available, false);
  // Without a valid change set, findingsTouchingChange stays null.
  assert.equal(r.summary.findingsTouchingChange, null);
  assert.equal(r.summary.blastRadius, null);
});

test('since: integrates with a real git repo', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/y.ts', `localStorage.getItem('k');`);

  execSync('git init -q', { cwd: a });
  execSync('git config user.email "t@t" && git config user.name "t"', { cwd: a, shell: '/bin/bash' });
  execSync('git add . && git commit -qm "init"', { cwd: a, shell: '/bin/bash' });
  // Modify y.ts to create a diff.
  write(a, 'src/y.ts', `localStorage.getItem('k'); // edited`);
  // HEAD still points to the initial commit; the working tree diff is what we want.
  const r = analyzeProjects([a], { since: 'HEAD', cwd: a });

  assert.equal(r.integrations.git.available, true);
  assert.ok(r.meta.changedFileCount >= 1);
  assert.ok(r.summary.findingsTouchingChange >= 1);
});

// ---------- message rendering for dynamic keys/channels (regression: dogfood §2.5) ----------

test('message: static storage key renders with literal name', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('app.session', t);`);
  write(a, 'src/r.ts', `localStorage.getItem('app.session');`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.id === 'shared-storage-key:app.session');
  assert.ok(f);
  assert.ok(f.message.includes(`'app.session'`), `message was: ${f.message}`);
  assert.ok(!f.message.includes(`'null'`));
});

test('message: dynamic storage key renders as (dynamic: <expr>), not null', () => {
  // Regression: before the fix, messageFor template-literal-stringified a JS
  // null into the string `'null'`, producing output like
  //   `localStorage key 'null' is touched by 1 files`
  // which looks like the literal key "null". Now it says `(dynamic: cacheKey(id))`.
  //
  // Note: a same-file `const K = 'literal'` would fold (see
  // fold-string-literals.js), so this uses a function-call key to stay
  // genuinely dynamic.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem(cacheKey(id), 1);`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key');
  assert.ok(f, 'expected a shared-storage-key finding');
  assert.equal(f.detail.dynamic, true);
  assert.ok(!f.message.includes(`'null'`), `message should not contain 'null': ${f.message}`);
  assert.ok(f.message.includes('(dynamic'), `message should mark dynamic: ${f.message}`);
  assert.ok(f.message.includes('cacheKey'), `message should surface the expression text: ${f.message}`);
});

test('message: dynamic event channel renders as (dynamic: <expr>), not null', () => {
  // Genuinely-dynamic channel: the name is a function call, which is
  // opaque to the fold helper.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `window.dispatchEvent(new CustomEvent(eventName(id)));`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-event-channel');
  assert.ok(f);
  assert.equal(f.detail.dynamic, true);
  assert.ok(!f.message.includes(`'null'`));
  assert.ok(f.message.includes('(dynamic'));
  assert.ok(f.message.includes('eventName'));
});

test('message: dynamic with no key and no expression still renders (dynamic)', () => {
  // Defense-in-depth: `dispatchEvent(e)` where `e` is a function parameter
  // produces dynamic=true because the alias-follow can't resolve parameters.
  // The message must not leak `'null'` even if the expression were empty.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `function fwd(e) { window.dispatchEvent(e); }`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-event-channel' && x.detail.dynamic);
  assert.ok(f);
  assert.ok(!f.message.includes(`'null'`), `message was: ${f.message}`);
  assert.ok(f.message.includes('(dynamic'), `message was: ${f.message}`);
});

// ---------- confidence ----------

test('confidence: every finding carries high | medium | low + a reason', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  write(a, 'src/stale.ts', `const x = document.cookie;`);
  const r = analyzeProjects([a]);
  assert.ok(r.findings.length >= 2);
  for (const f of r.findings) {
    assert.match(f.confidence, /^(high|medium|low)$/);
    assert.equal(typeof f.confidenceReason, 'string');
    assert.ok(f.confidenceReason.length > 20, `reason too short for ${f.id}`);
  }
});

test('confidence: summary.byConfidence aggregates counts', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  const r = analyzeProjects([a]);
  assert.ok(r.summary.byConfidence);
  const total = (r.summary.byConfidence.high ?? 0)
    + (r.summary.byConfidence.medium ?? 0)
    + (r.summary.byConfidence.low ?? 0);
  assert.equal(total, r.findings.length);
});

test('confidence: cross-file write+read literal storage key is high', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('app.session', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('app.session');`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.id === 'shared-storage-key:app.session');
  assert.ok(f);
  assert.equal(f.confidence, 'high');
  assert.match(f.confidenceReason, /canonical shared-state shape|cross-project/i);
});

test('confidence: cross-project literal storage key is high and reason mentions projects', () => {
  const a = mktmp();
  const b = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(a, 'src/w.ts', `localStorage.setItem('shared.k', 1);`);
  write(b, 'src/r.ts', `localStorage.getItem('shared.k');`);
  const r = analyzeProjects([a, b]);
  const f = r.findings.find((x) => x.id === 'shared-storage-key:shared.k');
  assert.ok(f);
  assert.equal(f.confidence, 'high');
  assert.match(f.confidenceReason, /2 projects|cross-project/i);
});

test('confidence: dynamic storage key is low', () => {
  // Same-file `const K = 'literal'` folds, so use a truly opaque key
  // (function call) to keep the finding dynamic.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem(computeKey(), 1);`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key' && x.detail.dynamic);
  assert.ok(f);
  assert.equal(f.confidence, 'low');
  assert.match(f.confidenceReason, /computed at runtime|heuristic/i);
});

test('confidence: shared-global-binding is high with "whichever loads last wins" framing', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Classic script (no import/export) with a top-level function declaration.
  write(a, 'src/one.js', `function parseCookie() { return 1; }`);
  write(a, 'src/two.js', `function parseCookie() { return 2; }`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-global-binding');
  assert.ok(f);
  assert.equal(f.confidence, 'high');
  assert.match(f.confidenceReason, /loads last|silently overwrites/i);
});

test('confidence: stale-module-capture is medium and reason names SPA/MPA context', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `const tier = document.cookie;`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'stale-module-capture');
  assert.ok(f);
  assert.equal(f.confidence, 'medium');
  assert.match(f.confidenceReason, /single-page|SPA|multi-page|MPA|worker/i);
});

test('confidence: paired-keys is medium and reason calls out v2 cross-file correlation', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `
    export function cache(v) {
      sessionStorage.setItem('k1', v);
      sessionStorage.setItem('k2', v);
    }
  `);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'paired-keys');
  assert.ok(f);
  assert.equal(f.confidence, 'medium');
  assert.match(f.confidenceReason, /cluster|v2|correlate|travel together/i);
});

// ---------- fingerprint ----------

test('fingerprint: present on every finding, 16 hex chars', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  write(a, 'src/stale.ts', `const x = document.cookie;`);
  const r = analyzeProjects([a]);
  assert.ok(r.findings.length >= 2);
  for (const f of r.findings) {
    assert.equal(typeof f.fingerprint, 'string');
    assert.match(f.fingerprint, /^[0-9a-f]{16}$/, `bad fingerprint: ${f.fingerprint}`);
  }
});

test('fingerprint: deterministic across runs with unchanged inputs', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  write(a, 'src/emit.ts', `window.dispatchEvent(new CustomEvent('ping'));`);
  write(a, 'src/on.ts', `window.addEventListener('ping', () => {});`);
  write(a, 'src/stale.ts', `const x = document.cookie;`);

  const r1 = analyzeProjects([a]);
  const r2 = analyzeProjects([a]);
  const map1 = new Map(r1.findings.map((f) => [f.id, f.fingerprint]));
  const map2 = new Map(r2.findings.map((f) => [f.id, f.fingerprint]));
  assert.deepEqual([...map1.entries()].sort(), [...map2.entries()].sort());
});

test('fingerprint: static storage-key finding is stable when a new reader file is added', () => {
  // Adding another file that touches the same key should NOT change the
  // fingerprint — it's the same logical coupling, just with one more site.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('app.session', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('app.session');`);
  const before = analyzeProjects([a]).findings.find((f) => f.id === 'shared-storage-key:app.session');
  assert.ok(before);

  write(a, 'src/r2.ts', `localStorage.getItem('app.session');`);
  const after = analyzeProjects([a]).findings.find((f) => f.id === 'shared-storage-key:app.session');
  assert.ok(after);
  assert.equal(before.fingerprint, after.fingerprint);
});

test('fingerprint: different storage keys get different fingerprints', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k1', 1); localStorage.getItem('k1');`);
  write(a, 'src/x.ts', `localStorage.setItem('k2', 1); localStorage.getItem('k2');`);
  const r = analyzeProjects([a]);
  const f1 = r.findings.find((f) => f.id === 'shared-storage-key:k1');
  const f2 = r.findings.find((f) => f.id === 'shared-storage-key:k2');
  assert.ok(f1 && f2);
  assert.notEqual(f1.fingerprint, f2.fingerprint);
});

test('fingerprint: localStorage vs sessionStorage with same key are distinct', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w1.ts', `localStorage.setItem('k', 1); localStorage.getItem('k');`);
  write(a, 'src/w2.ts', `sessionStorage.setItem('k', 1); sessionStorage.getItem('k');`);
  const r = analyzeProjects([a]);
  const ls = r.findings.find((f) => f.kind === 'shared-storage-key' && f.detail.storage === 'localStorage');
  const ss = r.findings.find((f) => f.kind === 'shared-storage-key' && f.detail.storage === 'sessionStorage');
  assert.ok(ls && ss);
  assert.notEqual(ls.fingerprint, ss.fingerprint);
});

test('fingerprint: dynamic findings are per-site (distinct fingerprints)', () => {
  // Need genuinely-dynamic keys on both sides (same-file const folds).
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.setItem(keyFor('a'), 1);`);
  write(a, 'src/b.ts', `localStorage.setItem(keyFor('b'), 1);`);
  const r = analyzeProjects([a]);
  const dyn = r.findings.filter((f) => f.kind === 'shared-storage-key' && f.detail.dynamic);
  assert.equal(dyn.length, 2);
  assert.notEqual(dyn[0].fingerprint, dyn[1].fingerprint);
});

test('fingerprint: paired-keys cluster differs by location', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/one.ts', `
    export function a() {
      sessionStorage.setItem('flags', '1');
      sessionStorage.setItem('flags.ts', '1');
    }
    export function b() {
      sessionStorage.setItem('flags', '2');
      sessionStorage.setItem('flags.ts', '2');
    }
  `);
  const r = analyzeProjects([a]);
  const pairs = r.findings.filter((f) => f.kind === 'paired-keys');
  assert.equal(pairs.length, 2);
  assert.notEqual(pairs[0].fingerprint, pairs[1].fingerprint);
});

// ---------- renderMarkdown ----------

test('renderMarkdown: produces sectioned output', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/b.ts', `localStorage.getItem('k');`);
  write(a, 'src/c.ts', `const x = document.cookie;`);

  const r = analyzeProjects([a]);
  const md = renderMarkdown(r);
  assert.ok(md.includes('# code-intel — Impact Report'));
  assert.ok(md.includes('## Summary'));
  assert.ok(md.includes('## Findings'));
  assert.ok(md.includes('Warning'));
  assert.ok(md.includes('Shared storage key'));
});

test('renderMarkdown: no findings renders "No findings"', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/pure.ts', `export const X = 1 + 2;`);
  const r = analyzeProjects([a]);
  const md = renderMarkdown(r);
  assert.ok(md.includes('## No findings'));
});

test('renderMarkdown: includes blast radius section when present', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/target.ts', `export const x = 1;`);
  write(a, 'src/consumer.ts', `import { x } from './target'; export const y = x;`);

  const r = analyzeProjects([a], { changedFiles: [path.join(a, 'src/target.ts')] });
  const md = renderMarkdown(r);
  assert.ok(md.includes('## Blast Radius'));
  assert.ok(md.includes('consumer.ts'));
});

// ---------- opts.exclude (Q14 / D11) ----------

test('exclude: orchestrator passes opts.exclude through to every detector', () => {
  // Two sibling trees with overlapping shared-storage-key findings. If the
  // orchestrator forwards the exclude correctly, one tree drops out and the
  // cross-file finding collapses.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Real source (scanned)
  write(a, 'src/writer.ts', `localStorage.setItem('shared.key', 1);`);
  write(a, 'src/reader.ts', `localStorage.getItem('shared.key');`);
  // Fixture tree (excluded in one of the two runs below)
  write(a, 'examples/broken.ts', `
    localStorage.setItem('fixture.key', 1);
    document.cookie;
    window.CUSTOM_GLOBAL = 1;
  `);

  const baseline = analyzeProjects([a]);
  const excluded = analyzeProjects([a], { exclude: ['examples'] });

  // Baseline must surface findings from examples/; the exclude run must not.
  assert.ok(baseline.findings.some((f) => f.id.includes('fixture.key')),
    'baseline should see the fixture key');
  assert.ok(
    !excluded.findings.some((f) => f.id.includes('fixture.key')),
    'excluded run must NOT see fixture.key',
  );
  // The real shared.key finding should survive the exclude.
  assert.ok(
    excluded.findings.some((f) => f.id.includes('shared.key')),
    'excluded run should still see shared.key (src/ is not excluded)',
  );
});

// ---------- opts.only / opts.skip (D13) ----------

test('only: narrows detector set; other kinds are absent from findings', () => {
  // A fixture that trips several detectors at once: storage key coupling,
  // classic-script global collision, and a stale module capture. With
  // --only shared-state the report must contain the storage finding and
  // nothing else.
  const a = mktmp();
  const b = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  // Shared storage key across both projects.
  write(a, 'src/w.ts', `localStorage.setItem('shared.k', 1);`);
  write(b, 'src/r.ts', `localStorage.getItem('shared.k');`);
  // Classic-script global collision across both projects.
  write(a, 'src/helper.js', `function doThing() {}`);
  write(b, 'src/helper.js', `function doThing() {}`);
  // Stale module capture in one project.
  write(a, 'src/cap.ts', `const tier = document.cookie;`);

  const baseline = analyzeProjects([a, b]);
  const only = analyzeProjects([a, b], { only: ['shared-state'] });

  const baselineKinds = new Set(baseline.findings.map((f) => f.kind));
  const onlyKinds = new Set(only.findings.map((f) => f.kind));

  // Baseline has multiple kinds; only-run has just shared-storage-key.
  assert.ok(baselineKinds.size >= 3, `baseline should surface multiple kinds, got ${[...baselineKinds]}`);
  assert.deepEqual([...onlyKinds], ['shared-storage-key']);
});

test('skip: removes exactly the named detector; other kinds untouched', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  write(a, 'src/cap.ts', `const tier = document.cookie;`);

  const baseline = analyzeProjects([a]);
  const skipped = analyzeProjects([a], { skip: ['shared-state'] });

  assert.ok(baseline.findings.some((f) => f.kind === 'shared-storage-key'));
  assert.ok(!skipped.findings.some((f) => f.kind === 'shared-storage-key'),
    'shared-storage-key must be absent after --skip shared-state');
  // A non-skipped kind that was in the baseline must still be in the skipped run.
  const baselineOther = baseline.findings.find((f) => f.kind !== 'shared-storage-key');
  if (baselineOther) {
    assert.ok(skipped.findings.some((f) => f.kind === baselineOther.kind),
      `kind ${baselineOther.kind} must survive --skip shared-state`);
  }
});

test('only: unknown detector id throws with the known-ids list', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  assert.throws(
    () => analyzeProjects([a], { only: ['not-a-detector'] }),
    /not-a-detector/,
  );
});

test('only + skip: compose — skip applies after only', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/cap.ts', `const tier = document.cookie;`);
  write(a, 'src/helper.js', `function helper() {}`);

  const r = analyzeProjects([a], {
    only: ['shared-state', 'stale-captures'],
    skip: ['stale-captures'],
  });
  const kinds = new Set(r.findings.map((f) => f.kind));
  // Registry id stale-captures maps to findingKind stale-module-capture.
  assert.ok(!kinds.has('stale-module-capture'));
  assert.ok(!kinds.has('shared-global-binding'),
    'shared-globals was not in --only, so its findings must be absent');
});

test('only: no-op full run equals baseline with no only/skip (regression)', () => {
  // Pinning that routing findings through the registry produces byte-
  // identical output to the baseline when no filters are applied. If a
  // future registry refactor drops a detector silently, this fails.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  write(a, 'src/cap.ts', `const tier = document.cookie;`);
  write(a, 'src/helper.js', `function helper() {}`);

  const baseline = analyzeProjects([a]);
  const noop = analyzeProjects([a]);
  assert.deepEqual(
    baseline.findings.map((f) => f.id).sort(),
    noop.findings.map((f) => f.id).sort(),
  );
  assert.deepEqual(baseline.summary.byKind, noop.summary.byKind);
});

test('exclude: blast radius respects opts.exclude', () => {
  // A file inside an excluded tree that transitively imports a changed
  // file must NOT appear in the blast radius, because it was never
  // indexed by the graph builder.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/target.ts', `export const x = 1;`);
  write(a, 'src/consumer.ts', `import { x } from './target'; export const y = x;`);
  write(a, 'examples/also-consumer.ts', `import { x } from '../src/target'; export const z = x;`);

  const baseline = analyzeProjects([a], { changedFiles: [path.join(a, 'src/target.ts')] });
  const excluded = analyzeProjects([a], {
    changedFiles: [path.join(a, 'src/target.ts')],
    exclude: ['examples'],
  });

  assert.ok(
    baseline.graph.blastRadius.some((b) => b.file.endsWith('also-consumer.ts')),
    'baseline should include examples/also-consumer.ts',
  );
  assert.ok(
    !excluded.graph.blastRadius.some((b) => b.file.endsWith('also-consumer.ts')),
    'exclude must drop examples/also-consumer.ts from blast radius',
  );
  // src/consumer.ts must still be found in both runs.
  assert.ok(excluded.graph.blastRadius.some((b) => b.file.endsWith('consumer.ts')));
});

// ---------- --baseline diff integration ----------

test('baseline diff: computeDiff(findings, []) — all are new', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);

  const result = analyzeProjects([a]);
  assert.ok(result.findings.length >= 1);

  const diff = computeDiff(result.findings, []);
  assert.equal(diff.new.length, result.findings.length, 'all findings are new against empty baseline');
  assert.equal(diff.resolved.length, 0);
  assert.equal(diff.unchanged.length, 0);
});

test('baseline diff: computeDiff(findings, findings) — all are unchanged', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);

  const result = analyzeProjects([a]);
  assert.ok(result.findings.length >= 1);

  const diff = computeDiff(result.findings, result.findings);
  assert.equal(diff.new.length, 0);
  assert.equal(diff.resolved.length, 0);
  assert.equal(diff.unchanged.length, result.findings.length, 'all findings are unchanged when baseline === current');
});

test('baseline diff: computeDiff([], findings) — all are resolved', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);

  const result = analyzeProjects([a]);
  assert.ok(result.findings.length >= 1);

  const diff = computeDiff([], result.findings);
  assert.equal(diff.new.length, 0);
  assert.equal(diff.resolved.length, result.findings.length, 'all baseline findings are resolved when current is empty');
  assert.equal(diff.unchanged.length, 0);
});

// ---------- proxied-platform-global decoration ----------

test('impact: proxied-platform-global finding is decorated with correct severity/confidence/fingerprint/id', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/nav.ts', `window.history = new Proxy(window.history, {});`);

  const result = analyzeProjects([a]);
  const f = result.findings.find((x) => x.kind === 'proxied-platform-global');
  assert.ok(f, 'expected a proxied-platform-global finding');

  assert.equal(f.severity, 'warning');
  assert.equal(f.confidence, 'medium');
  assert.ok(typeof f.confidenceReason === 'string' && f.confidenceReason.includes('Reflect'),
    'confidenceReason should mention Reflect');
  assert.ok(typeof f.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(f.fingerprint),
    'fingerprint should be 16-char hex');
  assert.ok(typeof f.patternFingerprint === 'string' && /^[0-9a-f]{16}$/.test(f.patternFingerprint),
    'patternFingerprint should be 16-char hex');
  assert.equal(f.fingerprint, f.patternFingerprint,
    'fingerprint and patternFingerprint should be equal for proxied-platform-global (static coupling kind)');
  assert.equal(f.id, 'proxied-platform-global:window.history');
});
