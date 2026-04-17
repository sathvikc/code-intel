import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSource,
  analyzeProjects,
  resolveProject,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/shared-state-web-storage.js';

// ---------- analyzeSource (unit) ----------

test('detects localStorage.setItem with string literal', () => {
  const occ = analyzeSource(`localStorage.setItem('auth.token', t);`, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].storage, 'localStorage');
  assert.equal(occ[0].key, 'auth.token');
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
  const src = `
    const k = 'auth.token';
    localStorage.setItem(k, 'v');
    localStorage.getItem(\`prefix.\${id}\`);
  `;
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 2);
  assert.ok(occ.every(o => o.dynamic === true));
  assert.equal(occ[0].key, null);
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
  const src = "localStorage.setItem(`auth.token`, v);";
  const occ = analyzeSource(src, 'f.ts');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].key, 'auth.token');
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

// ---------- analyzeProjects (integration, tmp fs) ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('resolveProject uses package.json name, falls back to basename', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: '@org/app-a' }));
  const pa = resolveProject(a);
  assert.equal(pa.id, '@org/app-a');

  const b = mktmp();
  const pb = resolveProject(b);
  assert.equal(pb.id, path.basename(b));
});

test('groups the same storage key across files and projects', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/login.ts', `localStorage.setItem('auth.token', t);`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/client.ts', `const t = localStorage.getItem('auth.token');`);
  write(b, 'src/logout.ts', `localStorage.removeItem('auth.token');`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.version, SCHEMA_VERSION);
  assert.equal(result.analyzer, ANALYZER_ID);
  assert.equal(result.projects.length, 2);

  const authFinding = result.findings.find(
    f => f.storage === 'localStorage' && f.key === 'auth.token',
  );
  assert.ok(authFinding, 'expected a finding for localStorage.auth.token');
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
