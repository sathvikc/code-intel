import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { analyzeProjects, SCHEMA_VERSION, ANALYZER_ID } from '../src/impact.js';
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

// ---------- message rendering for dynamic keys/channels (regression: meganav §2.5) ----------

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
  // which looks like the literal key "null". Now it says `(dynamic: cacheKey)`.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `const cacheKey = 'foo'; localStorage.setItem(cacheKey, 1);`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key');
  assert.ok(f, 'expected a shared-storage-key finding');
  assert.equal(f.detail.dynamic, true);
  assert.ok(!f.message.includes(`'null'`), `message should not contain 'null': ${f.message}`);
  assert.ok(f.message.includes('(dynamic'), `message should mark dynamic: ${f.message}`);
  assert.ok(f.message.includes('cacheKey'), `message should surface the expression text: ${f.message}`);
});

test('message: dynamic event channel renders as (dynamic: <expr>), not null', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `const eventName = 'boom'; window.dispatchEvent(new CustomEvent(eventName));`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-event-channel');
  assert.ok(f);
  assert.equal(f.detail.dynamic, true);
  assert.ok(!f.message.includes(`'null'`));
  assert.ok(f.message.includes('(dynamic'));
  assert.ok(f.message.includes('eventName'));
});

test('message: dynamic with no key and no expression still renders (dynamic)', () => {
  // Defense-in-depth: `dispatchEvent(e)` where `e` is a bound variable
  // produces dynamic=true but the analyzer's expression text is the
  // variable name. Even if we had an edge case where expression were
  // empty, the message must not leak `'null'`.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `const e = new CustomEvent('x'); window.dispatchEvent(e);`);
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-event-channel' && x.detail.dynamic);
  assert.ok(f);
  assert.ok(!f.message.includes(`'null'`), `message was: ${f.message}`);
  assert.ok(f.message.includes('(dynamic'), `message was: ${f.message}`);
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
