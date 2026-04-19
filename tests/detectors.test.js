import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DETECTORS,
  DETECTOR_IDS,
  getDetector,
  selectDetectors,
} from '../src/detectors/index.js';

// ---------- registry contract ----------

test('registry: every entry has the required shape', () => {
  for (const d of DETECTORS) {
    assert.equal(typeof d.id, 'string', 'id is a string');
    assert.ok(d.id.length > 0, 'id is non-empty');
    assert.equal(typeof d.module, 'object', 'module is an imported namespace');
    assert.equal(
      typeof d.module.analyzeProjects, 'function',
      `${d.id}: module must export analyzeProjects`,
    );
    assert.equal(
      typeof d.module.summarize, 'function',
      `${d.id}: module must export summarize`,
    );
    assert.equal(typeof d.findingKind, 'string', 'findingKind is a string');
    assert.ok(d.findingKind.length > 0, 'findingKind is non-empty');
    assert.equal(typeof d.summarize, 'function', 'CLI summarize is a function');
  }
});

test('registry: ids are unique', () => {
  const seen = new Set();
  for (const d of DETECTORS) {
    assert.ok(!seen.has(d.id), `duplicate id: ${d.id}`);
    seen.add(d.id);
  }
});

test('registry: findingKind values are unique (impact relies on it)', () => {
  // Impact tags each wrapped finding with .kind = detector.findingKind. Two
  // detectors sharing a findingKind would make --summary.byKind counts
  // ambiguous and would collide the `${kind}:${id}` finding identifier.
  const seen = new Set();
  for (const d of DETECTORS) {
    assert.ok(!seen.has(d.findingKind), `duplicate findingKind: ${d.findingKind}`);
    seen.add(d.findingKind);
  }
});

test('registry: DETECTOR_IDS mirrors DETECTORS in order', () => {
  assert.deepEqual(DETECTOR_IDS, DETECTORS.map((d) => d.id));
});

test('registry: every current detector is present (guard against accidental drop)', () => {
  // If a detector disappears from the registry by accident, every orchestrator
  // silently stops calling it. This pins the full set so a drop is a
  // deliberate red test, not a silent regression.
  const expected = [
    'shared-state',
    'shared-events',
    'shared-globals',
    'stale-captures',
    'paired-keys',
    'shape-drift',
    'duplicate-static-svg-id',
  ];
  for (const id of expected) {
    assert.ok(DETECTOR_IDS.includes(id), `registry is missing: ${id}`);
  }
});

// ---------- getDetector ----------

test('getDetector: returns the entry for a known id', () => {
  const d = getDetector('shared-state');
  assert.ok(d);
  assert.equal(d.id, 'shared-state');
  assert.equal(d.findingKind, 'shared-storage-key');
});

test('getDetector: returns undefined for an unknown id', () => {
  assert.equal(getDetector('not-a-detector'), undefined);
});

// ---------- selectDetectors ----------

test('selectDetectors: no opts returns every detector in registry order', () => {
  const picked = selectDetectors();
  assert.deepEqual(picked.map((d) => d.id), DETECTOR_IDS);
});

test('selectDetectors: only narrows to the given ids, preserving registry order', () => {
  // Registry order is: shared-state, shared-events, shared-globals, ...
  // Pass them in reverse to pin that we order by registry, not by input.
  const picked = selectDetectors({ only: ['shared-globals', 'shared-state'] });
  assert.deepEqual(picked.map((d) => d.id), ['shared-state', 'shared-globals']);
});

test('selectDetectors: skip removes the given ids from the full set', () => {
  const picked = selectDetectors({ skip: ['duplicate-static-svg-id'] });
  assert.ok(!picked.some((d) => d.id === 'duplicate-static-svg-id'));
  assert.equal(picked.length, DETECTORS.length - 1);
});

test('selectDetectors: only + skip composes (skip narrows further)', () => {
  const picked = selectDetectors({
    only: ['shared-state', 'shared-events'],
    skip: ['shared-events'],
  });
  assert.deepEqual(picked.map((d) => d.id), ['shared-state']);
});

test('selectDetectors: unknown ids in `only` throw and name the known set', () => {
  assert.throws(
    () => selectDetectors({ only: ['not-real'] }),
    (e) => /not-real/.test(e.message) && /Known ids:/.test(e.message),
  );
});

test('selectDetectors: unknown ids in `skip` throw and name the known set', () => {
  assert.throws(
    () => selectDetectors({ skip: ['not-real'] }),
    (e) => /not-real/.test(e.message) && /Known ids:/.test(e.message),
  );
});

test('selectDetectors: empty only list is a no-op (everything runs)', () => {
  // Distinct from `only: ['a']`, an empty list means "no filter given."
  // This keeps `--only` repeatable + empty safely equivalent to no flag.
  const picked = selectDetectors({ only: [] });
  assert.deepEqual(picked.map((d) => d.id), DETECTOR_IDS);
});

test('selectDetectors: null only/skip is a no-op (same as undefined)', () => {
  const picked = selectDetectors({ only: null, skip: null });
  assert.deepEqual(picked.map((d) => d.id), DETECTOR_IDS);
});
