import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeDiff, analyzeProjects } from '../src/impact.js';

// Minimal wrapped-finding fixture
const mkFinding = (fp, kind = 'shared-storage-key') => ({
  fingerprint: fp, kind, id: `${kind}:${fp}`, detail: {}
});

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-baseline-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('computeDiff', () => {
  it('all new — baseline empty, current has 2', () => {
    const current = [mkFinding('aaa'), mkFinding('bbb')];
    const diff = computeDiff(current, []);
    assert.equal(diff.new.length, 2);
    assert.equal(diff.resolved.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });

  it('all resolved — current empty, baseline has 2', () => {
    const baseline = [mkFinding('aaa'), mkFinding('bbb')];
    const diff = computeDiff([], baseline);
    assert.equal(diff.new.length, 0);
    assert.equal(diff.resolved.length, 2);
    assert.equal(diff.unchanged.length, 0);
  });

  it('all unchanged — same 2 fingerprints in both', () => {
    const current = [mkFinding('aaa'), mkFinding('bbb')];
    const baseline = [mkFinding('aaa'), mkFinding('bbb')];
    const diff = computeDiff(current, baseline);
    assert.equal(diff.new.length, 0);
    assert.equal(diff.resolved.length, 0);
    assert.equal(diff.unchanged.length, 2);
  });

  it('mixed — baseline has [A, B], current has [B, C]', () => {
    const fA = mkFinding('aaaa');
    const fB = mkFinding('bbbb');
    const fC = mkFinding('cccc');
    const diff = computeDiff([fB, fC], [fA, fB]);
    assert.equal(diff.new.length, 1);
    assert.equal(diff.new[0].fingerprint, 'cccc');
    assert.equal(diff.resolved.length, 1);
    assert.equal(diff.resolved[0].fingerprint, 'aaaa');
    assert.equal(diff.unchanged.length, 1);
    assert.equal(diff.unchanged[0].fingerprint, 'bbbb');
  });

  it('null baseline findings — all current are new, nothing resolved', () => {
    const current = [mkFinding('aaa'), mkFinding('bbb')];
    const diff = computeDiff(current, null);
    assert.equal(diff.new.length, 2);
    assert.equal(diff.resolved.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });

  it('fingerprint collision — two current findings with the same fp: both counted in unchanged, baseline entry not resolved', () => {
    // currentByFp Map overwrites duplicates (last wins), so the resolved-check
    // sees only one entry for that fp — baseline finding is not flagged resolved.
    // The unchanged loop iterates currentFindings directly (not the Map), so
    // both current items that match the baseline fp appear in unchanged.
    const current = [mkFinding('dupe'), mkFinding('dupe')];
    const baseline = [mkFinding('dupe')];
    const diff = computeDiff(current, baseline);
    assert.equal(diff.resolved.length, 0, 'baseline entry must not appear in resolved');
    assert.equal(diff.new.length, 0, 'no new findings expected');
    // Both current items matched baseline by fp, so unchanged has 2 entries.
    assert.equal(diff.unchanged.length, 2);
  });

  it('fingerprint collision warning — duplicate fingerprints in current run emit a stderr warning', () => {
    // Capture stderr writes during the call.
    const captured = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      computeDiff([mkFinding('dupe'), mkFinding('dupe')], []);
    } finally {
      process.stderr.write = origWrite;
    }
    const warnings = captured.filter((s) => s.includes('duplicate fingerprint'));
    assert.equal(warnings.length, 1, 'one warning expected per duplicate fingerprint');
    assert.match(warnings[0], /current run/);
    assert.match(warnings[0], /dupe/);
  });

  it('fingerprint collision warning — duplicate fingerprints in baseline emit a stderr warning', () => {
    const captured = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      computeDiff([], [mkFinding('dupe'), mkFinding('dupe')]);
    } finally {
      process.stderr.write = origWrite;
    }
    const warnings = captured.filter((s) => s.includes('duplicate fingerprint'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /baseline/);
  });

  it('event-shape-drift fingerprint stability — two identical detail objects produce the same fingerprint', () => {
    // Test indirectly: run analyzeProjects twice on the same fixture and
    // verify that event-shape-drift findings (if any) have stable fingerprints.
    // Since event-shape-drift is a specific detector, we use a storage-based
    // proxy: the fingerprintFor function is not exported, so we test stability
    // via two analyzeProjects runs on the same inputs.
    const a = mktmp();
    write(a, 'package.json', JSON.stringify({ name: 'app' }));
    write(a, 'src/w.ts', `localStorage.setItem('stable.key', 1);`);
    write(a, 'src/r.ts', `localStorage.getItem('stable.key');`);

    const r1 = analyzeProjects([a]);
    const r2 = analyzeProjects([a]);

    const fps1 = r1.findings.map((f) => f.fingerprint).sort();
    const fps2 = r2.findings.map((f) => f.fingerprint).sort();
    assert.deepEqual(fps1, fps2, 'fingerprints must be stable across identical runs');
  });
});
