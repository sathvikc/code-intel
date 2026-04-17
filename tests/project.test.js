import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveProject,
  walkSourceFiles,
  SOURCE_EXTENSIONS,
  IGNORED_DIRS,
} from '../src/project.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-proj-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ---------- resolveProject ----------

test('resolveProject uses package.json name, falls back to basename', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: '@org/app-a' }));
  const pa = resolveProject(a);
  assert.equal(pa.id, '@org/app-a');

  const b = mktmp();
  const pb = resolveProject(b);
  assert.equal(pb.id, path.basename(b));
});

test('resolveProject tolerates a malformed package.json', () => {
  const root = mktmp();
  write(root, 'package.json', '{ not valid json');
  const p = resolveProject(root);
  assert.equal(p.id, path.basename(root));
});

test('resolveProject throws when root is not a directory', () => {
  const root = mktmp();
  const notADir = path.join(root, 'nope');
  assert.throws(() => resolveProject(notADir));
});

// ---------- walkSourceFiles ----------

test('walkSourceFiles yields only source-extension files', () => {
  const root = mktmp();
  write(root, 'a.ts', '');
  write(root, 'b.tsx', '');
  write(root, 'c.js', '');
  write(root, 'd.mjs', '');
  write(root, 'e.cjs', '');
  write(root, 'readme.md', '');
  write(root, 'pic.png', '');
  const files = [...walkSourceFiles(root)].map(f => path.basename(f)).sort();
  assert.deepEqual(files, ['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.cjs']);
});

test('walkSourceFiles skips IGNORED_DIRS', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'node_modules/pkg/b.ts', '');
  write(root, 'dist/c.ts', '');
  write(root, '.git/hooks/d.ts', '');
  const files = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'a.ts')]);
});

// ---------- exported constants ----------

test('SOURCE_EXTENSIONS and IGNORED_DIRS are Sets with expected members', () => {
  assert.ok(SOURCE_EXTENSIONS instanceof Set);
  for (const ext of ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']) {
    assert.ok(SOURCE_EXTENSIONS.has(ext), `expected ${ext} in SOURCE_EXTENSIONS`);
  }
  assert.ok(IGNORED_DIRS instanceof Set);
  for (const d of ['node_modules', 'dist', '.git']) {
    assert.ok(IGNORED_DIRS.has(d), `expected ${d} in IGNORED_DIRS`);
  }
});
