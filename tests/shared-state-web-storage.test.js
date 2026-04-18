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
} from '../src/shared-state-web-storage.js';

// ---------- analyzeSource (unit) ----------

test('detects localStorage.setItem with string literal', () => {
  const occ = analyzeSource(`localStorage.setItem('app.session', t);`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].storage, 'localStorage');
  assert.equal(occ[0].key, 'app.session');
  assert.equal(occ[0].op, 'write');
  assert.equal(occ[0].dynamic, false);
  assert.equal(occ[0].line, 1);
});

test('detects getItem / removeItem as read / remove', () => {
  const src = `
    const x = sessionStorage.getItem('k');
    sessionStorage.removeItem('k');
  `;
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 2);
  assert.equal(occ[0].op, 'read');
  assert.equal(occ[1].op, 'remove');
  assert.equal(occ[0].storage, 'sessionStorage');
});

test('resolves window.localStorage and globalThis.localStorage', () => {
  const src = `
    window.localStorage.setItem('a', 1);
    globalThis.localStorage.getItem('a');
  `;
  const occ = analyzeSource(src, 'f.js');
  assert.equal(occ.length, 2);
  assert.equal(occ[0].storage, 'localStorage');
  assert.equal(occ[1].storage, 'localStorage');
});

test('flags dynamic keys (non-literal first argument)', () => {
  // Note: `const k = 'app.session'; setItem(k, …)` folds to the literal
  // (see fold-string-literals.js); the still-dynamic case is the
  // substituted template literal.
  const src = `
    localStorage.getItem(\`prefix.\${id}\`);
    localStorage.setItem(lookupKey(), 'v');
  `;
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 2);
  assert.ok(occ.every(o => o.dynamic === true));
  assert.ok(occ.every(o => o.key === null));
  assert.ok(occ.every(o => o.foldedFrom === null));
});

test('folds same-file `const K = "literal"` to a static key', () => {
  const src = `
    const SESSION_KEY = 'app.session';
    localStorage.setItem(SESSION_KEY, 'v');
    localStorage.getItem(SESSION_KEY);
  `;
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 2);
  assert.ok(occ.every(o => o.dynamic === false));
  assert.ok(occ.every(o => o.key === 'app.session'));
  assert.ok(occ.every(o => o.foldedFrom === 'SESSION_KEY'));
});

test('does NOT fold a reassigned `let`', () => {
  const src = `
    let k = 'app.session';
    k = 'other';
    localStorage.setItem(k, 'v');
  `;
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dynamic, true);
  assert.equal(occ[0].key, null);
  assert.equal(occ[0].foldedFrom, null);
});

test('folds through element access as well', () => {
  const src = `
    const K = 'app.session';
    const v = localStorage[K];
  `;
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].key, 'app.session');
  assert.equal(occ[0].dynamic, false);
  assert.equal(occ[0].foldedFrom, 'K');
  assert.equal(occ[0].detectedVia, 'indexed-access');
});

test('ignores unrelated method calls and identifiers', () => {
  const src = `
    myStore.setItem('x', 1);
    const localStorage2 = {};
    localStorage2.setItem('x', 1);
  `;
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 0);
});

test('treats no-substitution template as literal key', () => {
  const src = "localStorage.setItem(`app.session`, v);";
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].key, 'app.session');
  assert.equal(occ[0].dynamic, false);
});

test('parses tsx without crashing', () => {
  const src = `
    export const C = () => {
      localStorage.setItem('ui.theme', 'dark');
      return <div>{localStorage.getItem('ui.theme')}</div>;
    };
  `;
  const occ = analyzeSource(src, 'f.tsx');
  assert.equal(occ.length, 2);
});

// ---------- detectedVia metadata (D4) ----------

test('method-call detections carry detectedVia: "method-call"', () => {
  const occ = analyzeSource(`localStorage.setItem('k', v);`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].detectedVia, 'method-call');
});

// ---------- indexed access (D4 / new pattern) ----------

test('indexed write with string literal', () => {
  const occ = analyzeSource(`localStorage['app.session'] = token;`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'write');
  assert.equal(occ[0].key, 'app.session');
  assert.equal(occ[0].detectedVia, 'indexed-access');
  assert.equal(occ[0].dynamic, false);
});

test('indexed read with string literal', () => {
  const occ = analyzeSource(`const t = localStorage['app.session'];`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'read');
  assert.equal(occ[0].key, 'app.session');
  assert.equal(occ[0].detectedVia, 'indexed-access');
});

test('delete on indexed access → remove with detectedVia "delete"', () => {
  const occ = analyzeSource(`delete localStorage['app.session'];`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'remove');
  assert.equal(occ[0].detectedVia, 'delete');
});

test('window.localStorage[...] resolves through indexed access', () => {
  const occ = analyzeSource(`window.localStorage['k'] = 1;`, 'f.js');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].storage, 'localStorage');
  assert.equal(occ[0].op, 'write');
  assert.equal(occ[0].detectedVia, 'indexed-access');
});

test('dynamic indexed access flags dynamic', () => {
  const occ = analyzeSource(`localStorage[someVar] = 1;`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dynamic, true);
  assert.equal(occ[0].key, null);
  assert.equal(occ[0].detectedVia, 'indexed-access');
});

test('compound assignment emits read and write at same site (D7)', () => {
  const occ = analyzeSource(`localStorage['k'] += '!';`, 'f.ts');
  assert.equal(occ.length, 2);
  const ops = occ.map(o => o.op).sort();
  assert.deepEqual(ops, ['read', 'write']);
  assert.ok(occ.every(o => o.line === 1));
  assert.ok(occ.every(o => o.detectedVia === 'indexed-access'));
});

// ---------- property (dot) access (D6) ----------

test('dot-access write → detectedVia "property-access"', () => {
  const occ = analyzeSource(`localStorage.authToken = token;`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'write');
  assert.equal(occ[0].key, 'authToken');
  assert.equal(occ[0].detectedVia, 'property-access');
  assert.equal(occ[0].dynamic, false);
});

test('dot-access read → detectedVia "property-access"', () => {
  const occ = analyzeSource(`const x = localStorage.authToken;`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'read');
  assert.equal(occ[0].key, 'authToken');
  assert.equal(occ[0].detectedVia, 'property-access');
});

test('method reference (no call) is NOT detected as property access', () => {
  // `localStorage.setItem` used as a value, not a call. D6 whitelist skips it.
  const occ = analyzeSource(`const fn = localStorage.setItem;`, 'f.ts');
  assert.equal(occ.length, 0);
});

test('meta-property reads (length, key) are not detected as user keys', () => {
  const occ = analyzeSource(`const n = localStorage.length;`, 'f.ts');
  assert.equal(occ.length, 0);
});

test('delete on dot access → remove with detectedVia "delete"', () => {
  const occ = analyzeSource(`delete localStorage.authToken;`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'remove');
  assert.equal(occ[0].key, 'authToken');
  assert.equal(occ[0].detectedVia, 'delete');
});

// ---------- cross-style grouping ----------

test('method-call, indexed, and property access merge into one finding per key', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/one.ts', `localStorage.setItem('shared.key', 1);`);
  write(a, 'src/two.ts', `const v = localStorage['shared.key'];`);
  write(a, 'src/three.ts', `const w = localStorage.sharedKeyAlt;`); // different key name
  write(a, 'src/four.ts', `localStorage.sharedKeyAlt = 2;`);

  const result = analyzeProjects([a]);
  const finding1 = result.findings.find(f => f.key === 'shared.key');
  const finding2 = result.findings.find(f => f.key === 'sharedKeyAlt');

  assert.ok(finding1, 'finding for shared.key');
  assert.equal(finding1.occurrences.length, 2);
  const via1 = finding1.occurrences.map(o => o.detectedVia).sort();
  assert.deepEqual(via1, ['indexed-access', 'method-call']);

  assert.ok(finding2, 'finding for sharedKeyAlt');
  assert.equal(finding2.occurrences.length, 2);
  const via2 = finding2.occurrences.map(o => o.detectedVia).sort();
  assert.deepEqual(via2, ['property-access', 'property-access']);
});

// ---------- analyzeProjects (integration, tmp fs) ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('groups the same storage key across files and projects', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/login.ts', `localStorage.setItem('app.session', t);`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/client.ts', `const t = localStorage.getItem('app.session');`);
  write(b, 'src/logout.ts', `localStorage.removeItem('app.session');`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.version, SCHEMA_VERSION);
  assert.equal(result.analyzer, ANALYZER_ID);
  assert.equal(result.projects.length, 2);

  const authFinding = result.findings.find(
    f => f.storage === 'localStorage' && f.key === 'app.session',
  );
  assert.ok(authFinding, 'expected a finding for localStorage.app.session');
  assert.equal(authFinding.dynamic, false);
  const projectsInFinding = new Set(authFinding.occurrences.map(o => o.project));
  assert.deepEqual([...projectsInFinding].sort(), ['app-a', 'app-b']);
  const ops = new Set(authFinding.occurrences.map(o => o.op));
  assert.ok(ops.has('write') && ops.has('read') && ops.has('remove'));
});

test('skips node_modules and other ignored dirs', () => {
  const a = mktmp();
  write(a, 'src/app.ts', `localStorage.setItem('real', 1);`);
  write(a, 'node_modules/pkg/index.js', `localStorage.setItem('should.be.ignored', 1);`);
  write(a, 'dist/bundle.js', `localStorage.setItem('also.ignored', 1);`);

  const result = analyzeProjects([a]);
  const keys = result.findings.filter(f => !f.dynamic).map(f => f.key);
  assert.deepEqual(keys, ['real']);
});

test('dynamic occurrences are not merged across sites', () => {
  const a = mktmp();
  write(a, 'src/one.ts', `localStorage.setItem(dynKey, 1);`);
  write(a, 'src/two.ts', `localStorage.setItem(dynKey, 2);`);

  const result = analyzeProjects([a]);
  const dyn = result.findings.filter(f => f.dynamic);
  assert.equal(dyn.length, 2);
  for (const f of dyn) assert.equal(f.occurrences.length, 1);
});

test('schema shape: findings carry project, file (relative), line, op', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'solo' }));
  write(a, 'src/x.ts', `\nlocalStorage.setItem('k', 1);\n`);

  const result = analyzeProjects([a]);
  const f = result.findings[0];
  assert.equal(f.occurrences[0].project, 'solo');
  assert.equal(f.occurrences[0].file, path.join('src', 'x.ts'));
  assert.equal(f.occurrences[0].line, 2);
  assert.equal(f.occurrences[0].op, 'write');
});
