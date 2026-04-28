import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveProject,
  walkSourceFiles,
  classifyBuildArtifact,
  classifyTestContext,
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
  // includeTestContext: true so that e2e/ is not default-skipped; this test
  // is exercising exclude-glob composition, not the test-context filter.
  const files = [...walkSourceFiles(root, { exclude: ['examples', '**/__tests__'], includeTestContext: true })]
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

// ---------- classifyTestContext ----------

test('classifyTestContext: returns null for ordinary source files', () => {
  assert.equal(classifyTestContext('/root/src/app.ts', '/root'), null);
  assert.equal(classifyTestContext('/root/src/utils/helper.js', '/root'), null);
  assert.equal(classifyTestContext('/root/src/component.tsx', '/root'), null);
});

test('classifyTestContext: matches *.test.* suffixes', () => {
  assert.deepEqual(classifyTestContext('/r/src/app.test.ts', '/r'), { kind: 'test-context', reason: 'filename-test' });
  assert.deepEqual(classifyTestContext('/r/src/app.test.tsx', '/r'), { kind: 'test-context', reason: 'filename-test' });
  assert.deepEqual(classifyTestContext('/r/src/app.test.js', '/r'), { kind: 'test-context', reason: 'filename-test' });
  assert.deepEqual(classifyTestContext('/r/src/app.test.mjs', '/r'), { kind: 'test-context', reason: 'filename-test' });
});

test('classifyTestContext: matches *.spec.* suffixes', () => {
  assert.deepEqual(classifyTestContext('/r/src/app.spec.ts', '/r'), { kind: 'test-context', reason: 'filename-spec' });
  assert.deepEqual(classifyTestContext('/r/src/app.spec.js', '/r'), { kind: 'test-context', reason: 'filename-spec' });
  assert.deepEqual(classifyTestContext('/r/src/app.spec.cjs', '/r'), { kind: 'test-context', reason: 'filename-spec' });
});

test('classifyTestContext: matches setup/config basenames', () => {
  assert.deepEqual(classifyTestContext('/r/jest.setup.ts', '/r'), { kind: 'test-context', reason: 'setup-config' });
  assert.deepEqual(classifyTestContext('/r/vitest.config.ts', '/r'), { kind: 'test-context', reason: 'setup-config' });
  assert.deepEqual(classifyTestContext('/r/jest.config.js', '/r'), { kind: 'test-context', reason: 'setup-config' });
  assert.deepEqual(classifyTestContext('/r/setupTests.ts', '/r'), { kind: 'test-context', reason: 'setup-config' });
  assert.deepEqual(classifyTestContext('/r/setupFiles.ts', '/r'), { kind: 'test-context', reason: 'setup-config' });
  assert.deepEqual(classifyTestContext('/r/setup-jest.js', '/r'), { kind: 'test-context', reason: 'setup-config' });
  assert.deepEqual(classifyTestContext('/r/setup-tests.ts', '/r'), { kind: 'test-context', reason: 'setup-config' });
});

test('classifyTestContext: matches files inside __tests__/ at any depth', () => {
  assert.deepEqual(classifyTestContext('/r/__tests__/foo.ts', '/r'), { kind: 'test-context', reason: '__tests__-dir' });
  assert.deepEqual(classifyTestContext('/r/src/__tests__/bar.ts', '/r'), { kind: 'test-context', reason: '__tests__-dir' });
  assert.deepEqual(classifyTestContext('/r/src/a/b/__tests__/deep.ts', '/r'), { kind: 'test-context', reason: '__tests__-dir' });
});

test('classifyTestContext: matches files inside __mocks__/ at any depth', () => {
  assert.deepEqual(classifyTestContext('/r/__mocks__/foo.ts', '/r'), { kind: 'test-context', reason: '__mocks__-dir' });
  assert.deepEqual(classifyTestContext('/r/src/__mocks__/bar.ts', '/r'), { kind: 'test-context', reason: '__mocks__-dir' });
});

test('classifyTestContext: matches top-level test dirs (first segment only)', () => {
  assert.deepEqual(classifyTestContext('/r/tests/foo.ts', '/r'), { kind: 'test-context', reason: 'top-level-test-dir' });
  assert.deepEqual(classifyTestContext('/r/test/foo.ts', '/r'), { kind: 'test-context', reason: 'top-level-test-dir' });
  assert.deepEqual(classifyTestContext('/r/e2e/foo.ts', '/r'), { kind: 'test-context', reason: 'top-level-test-dir' });
  assert.deepEqual(classifyTestContext('/r/cypress/foo.ts', '/r'), { kind: 'test-context', reason: 'top-level-test-dir' });
  assert.deepEqual(classifyTestContext('/r/playwright/foo.ts', '/r'), { kind: 'test-context', reason: 'top-level-test-dir' });
});

test('classifyTestContext: does NOT match nested test dirs that are not first segment', () => {
  assert.equal(classifyTestContext('/r/src/utils/tests/foo.ts', '/r'), null);
  assert.equal(classifyTestContext('/r/src/test/foo.ts', '/r'), null);
  assert.equal(classifyTestContext('/r/src/e2e/foo.ts', '/r'), null);
});

test('classifyTestContext: does NOT match app.testing.ts (substring, not suffix)', () => {
  assert.equal(classifyTestContext('/r/src/app.testing.ts', '/r'), null);
});

// ---------- walkSourceFiles: test-context skipping ----------

test('walkSourceFiles skips *.test.ts files by default', () => {
  const root = mktmp();
  write(root, 'src/app.ts', 'const x = 1;');
  write(root, 'src/app.test.ts', 'test("x", () => {});');
  const files = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'app.ts')]);
});

test('walkSourceFiles skips files inside __tests__/ by default', () => {
  const root = mktmp();
  write(root, 'src/app.ts', 'const x = 1;');
  write(root, 'src/__tests__/app.ts', 'test("x", () => {});');
  const files = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'app.ts')]);
});

test('walkSourceFiles skips files inside top-level tests/ by default', () => {
  const root = mktmp();
  write(root, 'src/app.ts', 'const x = 1;');
  write(root, 'tests/integration.ts', 'test("x", () => {});');
  const files = [...walkSourceFiles(root)].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [path.join('src', 'app.ts')]);
});

test('walkSourceFiles with includeTestContext: true yields test files too', () => {
  const root = mktmp();
  write(root, 'src/app.ts', 'const x = 1;');
  write(root, 'src/app.test.ts', 'test("x", () => {});');
  write(root, 'src/__tests__/unit.ts', 'test("u", () => {});');
  write(root, 'tests/e2e.ts', 'test("e", () => {});');
  const files = [...walkSourceFiles(root, { includeTestContext: true })].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [
    path.join('src', '__tests__', 'unit.ts'),
    path.join('src', 'app.test.ts'),
    path.join('src', 'app.ts'),
    path.join('tests', 'e2e.ts'),
  ]);
});

test('walkSourceFiles: includeTestContext: true does not un-skip build artifacts (both rules independent)', () => {
  const root = mktmp();
  write(root, 'src/real.js', 'const x = 1;');
  write(root, 'src/lib.min.js', 'const x=1;');
  write(root, 'src/app.test.ts', 'test("x", () => {});');
  // lib.min.js is a build artifact — still skipped even when includeTestContext: true
  // app.test.ts is a test file — included when includeTestContext: true
  const files = [...walkSourceFiles(root, { includeTestContext: true })].map(f => path.relative(root, f)).sort();
  assert.deepEqual(files, [
    path.join('src', 'app.test.ts'),
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
