import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveProject,
  walkSourceFiles,
  classifyBuildArtifact,
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

// ---------- walkSourceFiles: opts.exclude (Q14 / D11) ----------

test('walkSourceFiles honors opts.exclude for a top-level directory', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'examples/b.ts', '');
  write(root, 'docs/c.ts', '');
  const files = [...walkSourceFiles(root, { exclude: ['examples'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('docs', 'c.ts'), path.join('src', 'a.ts')]);
});

test('walkSourceFiles honors opts.exclude for a nested directory', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'src/examples/b.ts', '');
  write(root, 'examples/c.ts', '');
  // Exclude only the nested one, not the top-level.
  const files = [...walkSourceFiles(root, { exclude: ['src/examples'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('examples', 'c.ts'), path.join('src', 'a.ts')]);
});

test('walkSourceFiles honors multiple opts.exclude entries (and-ed)', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'examples/b.ts', '');
  write(root, 'docs/c.ts', '');
  write(root, 'e2e/d.ts', '');
  const files = [...walkSourceFiles(root, { exclude: ['examples', 'docs', 'e2e'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'a.ts')]);
});

test('walkSourceFiles: opts.exclude does NOT let the user re-include IGNORED_DIRS', () => {
  // node_modules stays hardcoded-excluded even if the user somehow tries to
  // interact with it via --exclude (which would be a nonsensical invocation,
  // but worth a regression guard).
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'node_modules/pkg/b.ts', '');
  // Passing node_modules in exclude is a no-op because IGNORED_DIRS already
  // excludes it; the test pins that the user can't accidentally *enable*
  // scanning of it by any means of this flag.
  const files = [...walkSourceFiles(root, { exclude: ['node_modules'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'a.ts')]);
});

test('walkSourceFiles: empty or missing opts.exclude is a no-op', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'examples/b.ts', '');
  const baseline = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  const emptyOpts = [...walkSourceFiles(root, {})].map(f => path.relative(root, f)).sort();
  const emptyExclude = [...walkSourceFiles(root, { exclude: [] })].map(f => path.relative(root, f)).sort();
  assert.deepEqual(emptyOpts, baseline);
  assert.deepEqual(emptyExclude, baseline);
});

// ---------- walkSourceFiles: glob-aware opts.exclude ----------

test('walkSourceFiles: **/__tests__ prunes test dirs at every depth', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, '__tests__/root-test.ts', '');
  write(root, 'src/__tests__/nested-test.ts', '');
  write(root, 'src/a/b/__tests__/deep-test.ts', '');
  const files = [...walkSourceFiles(root, { exclude: ['**/__tests__'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'a.ts')]);
});

test('walkSourceFiles: **/*.spec.* prunes spec files at every depth', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'src/a.spec.ts', '');
  write(root, 'src/nested/b.spec.tsx', '');
  write(root, 'src/nested/c.ts', '');
  const files = [...walkSourceFiles(root, { exclude: ['**/*.spec.*'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [
    path.join('src', 'a.ts'),
    path.join('src', 'nested', 'c.ts'),
  ]);
});

test('walkSourceFiles: src/** prunes everything under src/', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'src/nested/b.ts', '');
  write(root, 'docs/c.ts', '');
  const files = [...walkSourceFiles(root, { exclude: ['src/**'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('docs', 'c.ts')]);
});

test('walkSourceFiles: mixing literal + glob patterns composes cleanly', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'src/__tests__/nested.ts', '');
  write(root, 'examples/b.ts', '');
  write(root, 'e2e/c.ts', '');
  const files = [...walkSourceFiles(root, { exclude: ['examples', '**/__tests__'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('e2e', 'c.ts'), path.join('src', 'a.ts')]);
});

test('walkSourceFiles: a glob that matches nothing is a no-op', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'docs/b.ts', '');
  const baseline = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  const excluded = [...walkSourceFiles(root, { exclude: ['**/nothing-here/**'] })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(excluded, baseline);
});

// ---------- walkSourceFiles: build-artifact skipping ----------

test('walkSourceFiles skips a *.min.js file by default', () => {
  const root = mktmp();
  write(root, 'src/real.js', 'const x = 1;');
  write(root, 'src/foo.min.js', 'const x=1;');
  const files = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'real.js')]);
});

test('walkSourceFiles skips files under a vendor/ directory by default', () => {
  const root = mktmp();
  write(root, 'src/real.js', 'const x = 1;');
  write(root, 'public/vendor/lib.js', 'const x = 1;');
  const files = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'real.js')]);
});

test('walkSourceFiles skips a file whose first line exceeds the long-line threshold', () => {
  const root = mktmp();
  write(root, 'src/real.js', 'const x = 1;');
  write(root, 'public/bundle.js', ';'.repeat(2000));
  const files = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'real.js')]);
});

test('walkSourceFiles with includeBuildArtifacts: true yields all files', () => {
  const root = mktmp();
  write(root, 'src/real.js', 'const x = 1;');
  write(root, 'src/foo.min.js', 'const x=1;');
  write(root, 'public/vendor/lib.js', 'const x = 1;');
  write(root, 'public/bundle.js', ';'.repeat(2000));
  const files = [...walkSourceFiles(root, { includeBuildArtifacts: true })]
    .map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [
    path.join('public', 'bundle.js'),
    path.join('public', 'vendor', 'lib.js'),
    path.join('src', 'foo.min.js'),
    path.join('src', 'real.js'),
  ]);
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
