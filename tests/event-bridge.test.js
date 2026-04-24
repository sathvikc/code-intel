import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeBridgeProjects, analyzeBridgeSource } from '../src/shared-state-events.js';
import { analyzeProjects as impactAnalyzeProjects } from '../src/impact.js';

// ---------- helpers ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-bridge-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ---------- unit: analyzeBridgeSource ----------

test('bridge: positive — window→iframe inline arrow handler', () => {
  const bridges = analyzeBridgeSource(
    `window.addEventListener('resize-notify', (e) => { iframe.contentWindow.dispatchEvent(new CustomEvent('resize-notify')) })`,
    'f.ts',
  );
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].channel, 'resize-notify');
  assert.equal(bridges[0].fromHost, 'window');
  assert.equal(bridges[0].toHost, 'iframe');
});

test('bridge: negative — same host self-dispatch (window→window suppressed)', () => {
  const bridges = analyzeBridgeSource(
    `window.addEventListener('x', () => { window.dispatchEvent(new CustomEvent('x')) })`,
    'f.ts',
  );
  assert.equal(bridges.length, 0);
});

test('bridge: negative — globalThis→window equivalence (self-bridge suppressed)', () => {
  const bridges = analyzeBridgeSource(
    `window.addEventListener('x', () => { globalThis.dispatchEvent(new CustomEvent('x')) })`,
    'f.ts',
  );
  assert.equal(bridges.length, 0);
});

test('bridge: negative — different channel name (rename-bridge not v1)', () => {
  const bridges = analyzeBridgeSource(
    `window.addEventListener('a', () => { iframe.dispatchEvent(new CustomEvent('b')) })`,
    'f.ts',
  );
  assert.equal(bridges.length, 0);
});

test('bridge: negative — named function handler (not inline, skipped in v1)', () => {
  const bridges = analyzeBridgeSource(
    `window.addEventListener('x', onX)`,
    'f.ts',
  );
  assert.equal(bridges.length, 0);
});

test('bridge: positive — alias-follow on inner dispatch (P22)', () => {
  // Inner dispatch uses an aliased event variable — alias-follow should resolve it.
  const bridges = analyzeBridgeSource(
    `const ev = new CustomEvent('ping');
     window.addEventListener('ping', () => { iframe.dispatchEvent(ev) })`,
    'f.ts',
  );
  assert.equal(bridges.length, 1, 'expected one bridge finding');
  assert.equal(bridges[0].channel, 'ping');
  assert.equal(bridges[0].fromHost, 'window');
  assert.equal(bridges[0].toHost, 'iframe');
  assert.equal(bridges[0].aliasedFrom, 'ev');
});

test('bridge: toHostExpression field for nested property access', () => {
  const bridges = analyzeBridgeSource(
    `window.addEventListener('resize', () => { iframe.contentWindow.dispatchEvent(new CustomEvent('resize')) })`,
    'f.ts',
  );
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].toHostExpression, 'iframe.contentWindow');
  assert.equal(bridges[0].toHost, 'iframe');
});

// ---------- integration: analyzeBridgeProjects ----------

test('bridge: analyzeProjects result shape — two files', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/bridge.ts',
    `window.addEventListener('update', (e) => { worker.dispatchEvent(new CustomEvent('update')) })`
  );
  write(a, 'src/other.ts', `// no bridge here`);

  const result = analyzeBridgeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.kind, 'event-bridge');
  assert.equal(f.channel, 'update');
  assert.equal(f.fromHost, 'window');
  assert.equal(f.toHost, 'worker');
  assert.ok(Array.isArray(f.occurrences));
  const listenOcc = f.occurrences.find(o => o.op === 'listen');
  const dispatchOcc = f.occurrences.find(o => o.op === 'dispatch');
  assert.ok(listenOcc, 'expected listen occurrence');
  assert.ok(dispatchOcc, 'expected dispatch occurrence');
  assert.equal(listenOcc.host, 'window');
  assert.equal(dispatchOcc.host, 'worker');
});

test('bridge: no finding for bare same-global-host dispatch', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts',
    `window.addEventListener('x', () => { dispatchEvent(new CustomEvent('x')) })`
  );

  const result = analyzeBridgeProjects([a]);
  assert.equal(result.findings.length, 0);
});

// ---------- fingerprint stability (via impact.analyzeProjects) ----------

test('bridge: fingerprint is stable across re-runs', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/bridge.ts',
    `window.addEventListener('nav', (e) => { iframe.contentWindow.dispatchEvent(new CustomEvent('nav')) })`
  );

  const r1 = impactAnalyzeProjects([a]);
  const r2 = impactAnalyzeProjects([a]);

  const b1 = r1.findings.find(f => f.kind === 'event-bridge');
  const b2 = r2.findings.find(f => f.kind === 'event-bridge');

  assert.ok(b1, 'expected event-bridge finding in run 1');
  assert.ok(b2, 'expected event-bridge finding in run 2');
  assert.equal(b1.fingerprint, b2.fingerprint, 'fingerprint must be stable');
  assert.match(b1.fingerprint, /^[0-9a-f]{16}$/, 'fingerprint must be 16 hex chars');
});
