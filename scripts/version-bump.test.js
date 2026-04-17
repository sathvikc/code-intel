import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineBump, applyBump, VALID_TYPES } from './version-bump.js';

test('feat → minor', () => {
  assert.deepEqual(determineBump('feat: add shared-state analyzer'), {
    bump: 'minor',
    type: 'feat',
    breaking: false,
  });
});

test('feat with scope → minor', () => {
  assert.equal(determineBump('feat(engine): add call graph').bump, 'minor');
});

test('fix → patch', () => {
  assert.equal(determineBump('fix: handle empty files').bump, 'patch');
});

test('perf → patch', () => {
  assert.equal(determineBump('perf: cache AST parse results').bump, 'patch');
});

test('refactor → patch', () => {
  assert.equal(determineBump('refactor: extract walker').bump, 'patch');
});

test('docs → patch', () => {
  assert.equal(determineBump('docs: clarify non-goals').bump, 'patch');
});

test('chore → patch', () => {
  assert.equal(determineBump('chore: bump deps').bump, 'patch');
});

test('feat! bang → major', () => {
  const r = determineBump('feat!: remove legacy API');
  assert.equal(r.bump, 'major');
  assert.equal(r.breaking, true);
});

test('fix(scope)! bang → major', () => {
  assert.equal(determineBump('fix(cli)!: drop --old flag').bump, 'major');
});

test('BREAKING CHANGE footer → major', () => {
  const msg = 'feat: new schema\n\nBREAKING CHANGE: old schema removed';
  assert.equal(determineBump(msg).bump, 'major');
});

test('invalid type rejected', () => {
  const r = determineBump('foo: something');
  assert.ok(r.error);
});

test('missing colon rejected', () => {
  assert.ok(determineBump('feat add thing').error);
});

test('empty message rejected', () => {
  assert.ok(determineBump('').error);
});

test('non-string rejected', () => {
  assert.ok(determineBump(undefined).error);
  assert.ok(determineBump(null).error);
});

test('all declared types parse', () => {
  for (const type of VALID_TYPES) {
    const r = determineBump(`${type}: something`);
    assert.equal(r.error, undefined, `type ${type} should parse`);
    assert.equal(r.type, type);
  }
});

test('applyBump major resets minor+patch', () => {
  assert.equal(applyBump('1.2.3', 'major'), '2.0.0');
});

test('applyBump minor resets patch', () => {
  assert.equal(applyBump('1.2.3', 'minor'), '1.3.0');
});

test('applyBump patch increments patch', () => {
  assert.equal(applyBump('1.2.3', 'patch'), '1.2.4');
});

test('applyBump from 0.0.0 → minor', () => {
  assert.equal(applyBump('0.0.0', 'minor'), '0.1.0');
});

test('applyBump invalid semver throws', () => {
  assert.throws(() => applyBump('1.2', 'patch'));
  assert.throws(() => applyBump('abc', 'patch'));
});

test('applyBump unknown bump throws', () => {
  assert.throws(() => applyBump('1.2.3', 'bogus'));
});
