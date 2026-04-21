import test from 'node:test';
import assert from 'node:assert/strict';

import { compileGlob, compileGlobs, matchesAnyGlob } from '../src/glob.js';

// ---------- compileGlob: literal patterns ----------

test('compileGlob: literal pattern matches only the exact rel path', () => {
  const re = compileGlob('examples');
  assert.equal(re.test('examples'), true);
  assert.equal(re.test('src/examples'), false);
  assert.equal(re.test('examples/foo'), false);
});

test('compileGlob: nested literal pattern matches only the exact nested path', () => {
  const re = compileGlob('src/examples');
  assert.equal(re.test('src/examples'), true);
  assert.equal(re.test('examples'), false);
  assert.equal(re.test('src/examples/foo'), false);
  assert.equal(re.test('a/src/examples'), false);
});

test('compileGlob: trailing slash is normalised', () => {
  const a = compileGlob('examples/');
  const b = compileGlob('examples');
  assert.equal(a.source, b.source, 'trailing slash compiles identically');
});

test('compileGlob: backslashes in pattern are normalised to forward slashes', () => {
  const re = compileGlob('src\\examples');
  assert.equal(re.test('src/examples'), true);
});

test('compileGlob: regex metacharacters in literal patterns are escaped', () => {
  // A pattern containing `.` should match the literal dot, not any char.
  const re = compileGlob('app.config');
  assert.equal(re.test('app.config'), true);
  assert.equal(re.test('appXconfig'), false);
});

// ---------- compileGlob: `*` (single-segment wildcard) ----------

test('compileGlob: single * matches within a segment but not across /', () => {
  const re = compileGlob('src/*.ts');
  assert.equal(re.test('src/foo.ts'), true);
  assert.equal(re.test('src/bar.ts'), true);
  assert.equal(re.test('src/foo/bar.ts'), false, 'does NOT cross path separator');
  assert.equal(re.test('foo.ts'), false);
});

test('compileGlob: * anywhere in a segment', () => {
  const re = compileGlob('src/*.spec.ts');
  assert.equal(re.test('src/a.spec.ts'), true);
  assert.equal(re.test('src/nested.deep.spec.ts'), true);
  assert.equal(re.test('src/a.ts'), false);
});

// ---------- compileGlob: `?` (single-char wildcard) ----------

test('compileGlob: ? matches exactly one non-/ character', () => {
  const re = compileGlob('src/a?.ts');
  assert.equal(re.test('src/aa.ts'), true);
  assert.equal(re.test('src/ab.ts'), true);
  assert.equal(re.test('src/a.ts'), false, 'requires one char');
  assert.equal(re.test('src/abc.ts'), false, 'requires exactly one');
  assert.equal(re.test('src/a/.ts'), false, 'does not cross /');
});

// ---------- compileGlob: `**` (cross-segment wildcard) ----------

test('compileGlob: **/X matches X at any depth, including zero', () => {
  const re = compileGlob('**/__tests__');
  assert.equal(re.test('__tests__'), true, 'top-level');
  assert.equal(re.test('src/__tests__'), true);
  assert.equal(re.test('src/a/b/__tests__'), true);
  assert.equal(re.test('__tests__/foo'), false, 'must end in __tests__');
  assert.equal(re.test('src/my__tests__'), false, 'must be a standalone segment');
});

test('compileGlob: **/*.spec.* matches spec files at any depth', () => {
  const re = compileGlob('**/*.spec.*');
  assert.equal(re.test('a.spec.ts'), true);
  assert.equal(re.test('a.spec.js'), true);
  assert.equal(re.test('src/a.spec.tsx'), true);
  assert.equal(re.test('src/a/b/c.spec.ts'), true);
  assert.equal(re.test('src/a.ts'), false, 'no .spec. anywhere');
  assert.equal(re.test('src/spec.ts'), false, 'needs a prefix before .spec.');
});

test('compileGlob: X/** matches everything under X (but not X itself)', () => {
  const re = compileGlob('src/**');
  assert.equal(re.test('src'), false, 'bare directory not matched (X/** has a prefix + /)');
  assert.equal(re.test('src/a.ts'), true);
  assert.equal(re.test('src/a/b/c.ts'), true);
  assert.equal(re.test('docs/a.ts'), false);
});

// ---------- compileGlobs + matchesAnyGlob ----------

test('matchesAnyGlob: empty array is always false', () => {
  assert.equal(matchesAnyGlob('anything/here.ts', []), false);
  assert.equal(matchesAnyGlob('anything', compileGlobs([])), false);
  assert.equal(matchesAnyGlob('anything', compileGlobs(undefined)), false);
});

test('matchesAnyGlob: OR-combines multiple patterns', () => {
  const globs = compileGlobs(['**/__tests__', '**/*.spec.*', 'dist']);
  assert.equal(matchesAnyGlob('src/__tests__', globs), true, 'first pattern');
  assert.equal(matchesAnyGlob('src/a.spec.ts', globs), true, 'second pattern');
  assert.equal(matchesAnyGlob('dist', globs), true, 'third pattern (literal)');
  assert.equal(matchesAnyGlob('src/a.ts', globs), false, 'none match');
});

test('matchesAnyGlob: normalises backslashes in the input path', () => {
  const globs = compileGlobs(['src/**']);
  assert.equal(matchesAnyGlob('src\\a\\b.ts', globs), true);
});

test('compileGlobs: preserves the original pattern string alongside regex', () => {
  const globs = compileGlobs(['**/__tests__']);
  assert.equal(globs.length, 1);
  assert.equal(globs[0].pattern, '**/__tests__');
  assert.ok(globs[0].re instanceof RegExp);
});
