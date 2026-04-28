// Tests for D19: --world closed|open closure axis.
//
// Coverage:
//   1. Default open behaviour preserved (same confidence as today)
//   2. Hedge fragments dropped under closed
//   3. Confidence tiers raised under closed
//   4. meta.worldClosure present in report envelope
//   5. CLI flag wiring (impact + per-detector subcommand)
//   6. CLI rejects invalid values

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { analyzeProjects } from '../src/impact.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-world-closure-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ---------- helpers ----------

function findingOf(result, kind) {
  return result.findings.find((f) => f.kind === kind);
}

// ---------- 1. Default (open) behaviour preserved ----------

test('worldClosure default: storage key cross-file same-op is medium', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.getItem('token');`);
  write(a, 'src/b.ts', `localStorage.getItem('token');`);
  const r = analyzeProjects([a]); // no closure opt
  const f = findingOf(r, 'shared-storage-key');
  assert.ok(f, 'finding expected');
  assert.equal(f.confidence, 'medium');
  assert.ok(f.confidenceReason.includes('wrapper or a worker file'));
});

test('worldClosure open explicit: same as default', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.getItem('token');`);
  write(a, 'src/b.ts', `localStorage.getItem('token');`);
  const r = analyzeProjects([a], { closure: 'open' });
  const f = findingOf(r, 'shared-storage-key');
  assert.ok(f);
  assert.equal(f.confidence, 'medium');
});

test('worldClosure default: event channel one-sided is medium', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `window.addEventListener('ping', () => {});`);
  const r = analyzeProjects([a]);
  const f = findingOf(r, 'shared-event-channel');
  assert.ok(f);
  assert.equal(f.confidence, 'medium');
  assert.ok(f.confidenceReason.includes('or the event is fired by a library'));
});

// ---------- 2. Hedge fragments dropped under closed ----------

test('closed: confidenceStorageKey drops "wrapper or a worker file" hedge', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.getItem('token');`);
  write(a, 'src/b.ts', `localStorage.getItem('token');`);
  const r = analyzeProjects([a], { closure: 'closed' });
  const f = findingOf(r, 'shared-storage-key');
  assert.ok(f);
  assert.ok(!f.confidenceReason.includes('wrapper or a worker file'), 'hedge should be absent');
});

test('closed: confidenceStorageKey single-file drops "wrapper module" hedge', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Single file uses the same key for both write and read.
  write(a, 'src/a.ts', `localStorage.setItem('only', '1'); const v = localStorage.getItem('only');`);
  const open = analyzeProjects([a], { closure: 'open' });
  const closed = analyzeProjects([a], { closure: 'closed' });
  const fo = findingOf(open, 'shared-storage-key');
  const fc = findingOf(closed, 'shared-storage-key');
  assert.ok(fo && fc, 'finding expected in both modes');
  assert.ok(fo.confidenceReason.includes("wrapper module this analyzer can't see"), 'open keeps hedge');
  assert.ok(!fc.confidenceReason.includes('wrapper module'), 'closed drops hedge');
  assert.equal(fc.confidence, 'medium', 'single-file confidence stays medium under closed (intra-file scope)');
});

test('closed: confidenceEventChannel drops "fired by a library" hedge', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `window.addEventListener('ping', () => {});`);
  const r = analyzeProjects([a], { closure: 'closed' });
  const f = findingOf(r, 'shared-event-channel');
  assert.ok(f);
  assert.ok(!f.confidenceReason.includes('fired by a library'), 'hedge should be absent');
});

test('closed: confidenceEventShapeDrift drops "a wrapper, a different repo" hedge', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Dispatcher emits 'extra' + 'name'; listener only reads 'name' → 'extra' is writeOnly
  write(a, 'src/dispatch.ts', `window.dispatchEvent(new CustomEvent('ch', { detail: { extra: 1, name: 'foo' } }));`);
  write(a, 'src/listen.ts', `window.addEventListener('ch', (e) => { console.log(e.detail.name); });`);
  const open = analyzeProjects([a], { closure: 'open' });
  const closed = analyzeProjects([a], { closure: 'closed' });
  const fo = open.findings.find((f) => f.kind === 'event-shape-drift');
  const fc = closed.findings.find((f) => f.kind === 'event-shape-drift');
  assert.ok(fo, 'open finding expected');
  assert.ok(fc, 'closed finding expected');
  assert.ok(fo.confidenceReason.includes('a wrapper, a different repo'), 'open should have wrapper hedge');
  assert.ok(!fc.confidenceReason.includes('a wrapper, a different repo'), 'closed should not have wrapper hedge');
  assert.ok(fc.confidenceReason.includes('an inline-script handler'), 'closed keeps inline-script caveat');
});

test('closed: confidenceShapeDrift drops "a wrapper module, a different repo" hedge', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Writer writes {hidden, name}; reader reads .name only → 'hidden' is writeOnly
  write(a, 'src/w.ts', `localStorage.setItem('kk', JSON.stringify({ hidden: 1, name: 'foo' }));`);
  write(a, 'src/r.ts', `const d = JSON.parse(localStorage.getItem('kk')); console.log(d.name);`);
  const open = analyzeProjects([a], { closure: 'open' });
  const closed = analyzeProjects([a], { closure: 'closed' });
  const fo = open.findings.find((f) => f.kind === 'shape-drift');
  const fc = closed.findings.find((f) => f.kind === 'shape-drift');
  assert.ok(fo, 'open finding expected');
  assert.ok(fc, 'closed finding expected');
  assert.ok(fo.confidenceReason.includes('a wrapper module, a different repo'), 'open has wrapper hedge');
  assert.ok(!fc.confidenceReason.includes('a wrapper module, a different repo'), 'closed drops wrapper hedge');
  assert.ok(fc.confidenceReason.includes('a worker'), 'closed keeps worker caveat');
});

// ---------- 3. Tier shifts under closed ----------

test('closed raises: storage cross-file same-op medium → high', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.getItem('token');`);
  write(a, 'src/b.ts', `localStorage.getItem('token');`);
  const open = analyzeProjects([a], { closure: 'open' });
  const closed = analyzeProjects([a], { closure: 'closed' });
  const fo = findingOf(open, 'shared-storage-key');
  const fc = findingOf(closed, 'shared-storage-key');
  assert.ok(fo && fc);
  assert.equal(fo.confidence, 'medium', 'open is medium');
  assert.equal(fc.confidence, 'high', 'closed is high');
});

test('closed raises: event channel one-sided medium → high', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `window.addEventListener('ping', () => {});`);
  const open = analyzeProjects([a], { closure: 'open' });
  const closed = analyzeProjects([a], { closure: 'closed' });
  const fo = findingOf(open, 'shared-event-channel');
  const fc = findingOf(closed, 'shared-event-channel');
  assert.ok(fo && fc);
  assert.equal(fo.confidence, 'medium');
  assert.equal(fc.confidence, 'high');
});

test('closed does NOT raise: storage cross-file write+read stays high', () => {
  // write+read across files is already high; closed should not break anything
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('token', '1');`);
  write(a, 'src/r.ts', `localStorage.getItem('token');`);
  const open = analyzeProjects([a], { closure: 'open' });
  const closed = analyzeProjects([a], { closure: 'closed' });
  const fo = findingOf(open, 'shared-storage-key');
  const fc = findingOf(closed, 'shared-storage-key');
  assert.ok(fo && fc);
  assert.equal(fo.confidence, 'high');
  assert.equal(fc.confidence, 'high');
});

// ---------- 4. meta.worldClosure in report envelope ----------

test('meta.worldClosure is "open" when no closure option given', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = analyzeProjects([a]);
  assert.equal(r.meta.worldClosure, 'open');
});

test('meta.worldClosure is "open" when closure: "open" given', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = analyzeProjects([a], { closure: 'open' });
  assert.equal(r.meta.worldClosure, 'open');
});

test('meta.worldClosure is "closed" when closure: "closed" given', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = analyzeProjects([a], { closure: 'closed' });
  assert.equal(r.meta.worldClosure, 'closed');
});

// ---------- 5. CLI flag wiring ----------

test('CLI --world closed: impact emits meta.worldClosure === "closed"', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = spawnSync(process.execPath, [CLI, 'impact', a, '--json', '--world', 'closed'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.meta.worldClosure, 'closed');
});

test('CLI (no --world flag): impact emits meta.worldClosure === "open"', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = spawnSync(process.execPath, [CLI, 'impact', a, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.meta.worldClosure, 'open');
});

test('CLI --world open: impact emits meta.worldClosure === "open"', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = spawnSync(process.execPath, [CLI, 'impact', a, '--json', '--world', 'open'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.meta.worldClosure, 'open');
});

// ---------- 6. CLI rejects invalid values ----------

test('CLI --world banana: impact exits non-zero with clear message', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = spawnSync(process.execPath, [CLI, 'impact', a, '--world', 'banana'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'should exit non-zero');
  assert.ok(
    r.stderr.includes("--world must be 'closed' or 'open'"),
    `stderr should contain the error message; got: ${r.stderr}`,
  );
});

test('CLI --world banana: shared-state exits non-zero with clear message', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `localStorage.setItem('k', '1');`);
  const r = spawnSync(process.execPath, [CLI, 'shared-state', a, '--world', 'banana'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'should exit non-zero');
  assert.ok(
    r.stderr.includes("--world must be 'closed' or 'open'"),
    `stderr should contain the error message; got: ${r.stderr}`,
  );
});

test('CLI --world (missing value): impact exits non-zero', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  const r = spawnSync(process.execPath, [CLI, 'impact', a, '--world'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'should exit non-zero');
  assert.ok(
    r.stderr.includes("--world must be 'closed' or 'open'"),
    `stderr should mention --world; got: ${r.stderr}`,
  );
});
