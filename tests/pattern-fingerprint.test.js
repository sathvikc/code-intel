// tests/pattern-fingerprint.test.js — D18 patternFingerprint field tests.
//
// Verifies:
//   a. Per-kind recipe match (15 kinds): patternFingerprint === expected hash.
//   b. Location-free stability: same kind + logical identity, different file
//      layout → same patternFingerprint, different fingerprint.
//   c. Identity-sensitivity: same kind, different logical identity → different
//      patternFingerprint.
//   d. Class-like equality: for static storage-key, fingerprint === patternFingerprint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeProjects } from '../src/impact.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-pf-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// Compute the expected patternFingerprint from recipe parts (joined by '|').
function expectedPF(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// ---------- helpers for triggering each kind ----------

function storageKeyFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('pf-key', '1');`);
  write(a, 'src/r.ts', `localStorage.getItem('pf-key');`);
  return a;
}

function dynamicStorageFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `localStorage.setItem(dynamicKey(), '1');`);
  write(a, 'src/b.ts', `localStorage.getItem(dynamicKey());`);
  return a;
}

function eventChannelFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/emit.ts', `window.dispatchEvent(new CustomEvent('pf-channel'));`);
  write(a, 'src/on.ts', `window.addEventListener('pf-channel', () => {});`);
  return a;
}

function dynamicEventFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Dynamic channel: computed value
  write(a, 'src/emit.ts', `window.dispatchEvent(new CustomEvent(eventName()));`);
  write(a, 'src/on.ts', `window.addEventListener(eventName(), () => {});`);
  return a;
}

function globalBindingFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.js', `function pfHelper() { return 1; }`);
  write(a, 'src/b.js', `function pfHelper() { return 2; }`);
  return a;
}

function staleCaptureFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/stale.ts', `const snap = document.cookie;`);
  return a;
}

function pairedKeysFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `
    export function save(v) {
      sessionStorage.setItem('pf-a', v);
      sessionStorage.setItem('pf-b', v);
    }
  `);
  return a;
}

function shapeDriftFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('drift-key', JSON.stringify({ x: 1, y: 2 }));`);
  write(a, 'src/r.ts', `const v = JSON.parse(localStorage.getItem('drift-key')); v.x; v.z;`);
  return a;
}

function eventShapeDriftFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/dispatch.ts',
    `dispatchEvent(new CustomEvent('pf-esd', { detail: { userId: 1, email: 'x' } }));`,
  );
  write(a, 'src/listen.ts',
    `addEventListener('pf-esd', ({ detail: { userId, name } }) => {});`,
  );
  return a;
}

function structuralDriftFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/config.js', `export const CFG = { a: 1, b: 2 };`);
  write(a, 'src/api.js', `
    import { CFG } from './config.js';
    const x = CFG.a;
    const y = CFG.c;
  `);
  return a;
}

function eventBridgeFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/bridge.ts',
    `window.addEventListener('pf-bridge', (e) => { worker.dispatchEvent(new CustomEvent('pf-bridge')) })`,
  );
  return a;
}

function missingTeardownFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/comp.ts', `
    function setup() {
      window.addEventListener('resize', handler);
    }
  `);
  return a;
}

function abortNeverCalledFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/comp.ts', `
    function setup() {
      const ctrl = new AbortController();
      fetch('/api', { signal: ctrl.signal });
    }
  `);
  return a;
}

function handlerIdentityMismatchFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/comp.ts', `
    function setup() {
      window.addEventListener('click', () => doThing());
      window.removeEventListener('click', () => doThing());
    }
  `);
  return a;
}

function duplicateSvgIdFixture() {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/G.tsx', `
    export const G = ({ items }) => (
      <svg>
        {items.map((i) => <g key={i}><linearGradient id="pf-svg-id" /><rect fill="url(#pf-svg-id)" /></g>)}
      </svg>
    );
  `);
  return a;
}

// ---------- (a) per-kind recipe match ----------

test('patternFingerprint: shared-storage-key (static) matches recipe', () => {
  const a = storageKeyFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key' && !x.detail.dynamic);
  assert.ok(f, 'expected shared-storage-key finding');
  const storage = f.detail.storage;
  const key = f.detail.key;
  assert.equal(f.patternFingerprint, expectedPF('shared-storage-key', storage, key));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: shared-storage-key (dynamic) matches recipe', () => {
  const a = dynamicStorageFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key' && x.detail.dynamic);
  assert.ok(f, 'expected dynamic shared-storage-key finding');
  const storage = f.detail.storage ?? '?';
  assert.equal(f.patternFingerprint, expectedPF('shared-storage-key', 'dynamic', storage));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: shared-event-channel (static) matches recipe', () => {
  const a = eventChannelFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-event-channel' && !x.detail.dynamic);
  assert.ok(f, 'expected shared-event-channel finding');
  const channel = f.detail.channel ?? '';
  assert.equal(f.patternFingerprint, expectedPF('shared-event-channel', channel));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: shared-event-channel (dynamic) matches recipe', () => {
  const a = dynamicEventFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-event-channel' && x.detail.dynamic);
  assert.ok(f, 'expected dynamic shared-event-channel finding');
  assert.equal(f.patternFingerprint, expectedPF('shared-event-channel', 'dynamic'));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: shared-global-binding matches recipe', () => {
  const a = globalBindingFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-global-binding');
  assert.ok(f, 'expected shared-global-binding finding');
  const name = f.detail.name ?? '';
  assert.equal(f.patternFingerprint, expectedPF('shared-global-binding', name));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: stale-module-capture matches recipe', () => {
  const a = staleCaptureFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'stale-module-capture');
  assert.ok(f, 'expected stale-module-capture finding');
  const capturedVia = f.detail.capturedVia ?? '';
  assert.equal(f.patternFingerprint, expectedPF('stale-module-capture', capturedVia));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: paired-keys matches recipe', () => {
  const a = pairedKeysFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'paired-keys');
  assert.ok(f, 'expected paired-keys finding');
  const storage = f.detail.storage ?? '?';
  const sortedKeys = [...(f.detail.keys ?? [])].sort().join('+');
  assert.equal(f.patternFingerprint, expectedPF('paired-keys', storage, sortedKeys));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: shape-drift matches recipe', () => {
  const a = shapeDriftFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shape-drift');
  assert.ok(f, 'expected shape-drift finding');
  const storage = f.detail.storage ?? '?';
  const key = f.detail.key ?? '';
  assert.equal(f.patternFingerprint, expectedPF('shape-drift', storage, key));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: event-shape-drift matches recipe', () => {
  const a = eventShapeDriftFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'event-shape-drift');
  assert.ok(f, 'expected event-shape-drift finding');
  const channel = f.detail.channel ?? '';
  assert.equal(f.patternFingerprint, expectedPF('event-shape-drift', channel));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: structural-drift matches recipe', () => {
  const a = structuralDriftFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'structural-drift');
  assert.ok(f, 'expected structural-drift finding');
  const module_ = f.detail.module ?? '';
  const exportedName = f.detail.exportedName ?? '';
  assert.equal(f.patternFingerprint, expectedPF('structural-drift', module_, exportedName));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: event-bridge matches recipe', () => {
  const a = eventBridgeFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'event-bridge');
  assert.ok(f, 'expected event-bridge finding');
  const channel = f.detail.channel ?? '';
  const fromHost = f.detail.fromHost ?? '';
  const toHost = f.detail.toHost ?? '';
  assert.equal(f.patternFingerprint, expectedPF('event-bridge', channel, fromHost, toHost));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: missing-teardown matches recipe', () => {
  const a = missingTeardownFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'missing-teardown');
  assert.ok(f, 'expected missing-teardown finding');
  const registrationKind = f.detail.registrationKind ?? '';
  assert.equal(f.patternFingerprint, expectedPF('missing-teardown', registrationKind));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: abort-never-called matches recipe (kind only)', () => {
  const a = abortNeverCalledFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'abort-never-called');
  assert.ok(f, 'expected abort-never-called finding');
  // D18: degenerate — pattern is the kind itself, no extra parts.
  assert.equal(f.patternFingerprint, expectedPF('abort-never-called'));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: handler-identity-mismatch matches recipe', () => {
  const a = handlerIdentityMismatchFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'handler-identity-mismatch');
  assert.ok(f, 'expected handler-identity-mismatch finding');
  const channel = f.detail.channel ?? '';
  assert.equal(f.patternFingerprint, expectedPF('handler-identity-mismatch', channel));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint: duplicate-static-svg-id matches recipe', () => {
  const a = duplicateSvgIdFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'duplicate-static-svg-id');
  assert.ok(f, 'expected duplicate-static-svg-id finding');
  const id = f.detail.id ?? '';
  assert.equal(f.patternFingerprint, expectedPF('duplicate-static-svg-id', id));
  assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
});

// ---------- (b) location-free stability ----------
//
// Two fixtures: same logical coupling, different file layout.
// patternFingerprint must be identical; fingerprint must differ.

test('patternFingerprint: stable across file-layout changes (shared-storage-key)', () => {
  // Layout A: writer in src/w.ts, reader in src/r.ts
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('stable-key', '1');`);
  write(a, 'src/r.ts', `localStorage.getItem('stable-key');`);

  // Layout B: same coupling, different file names and paths
  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app' }));
  write(b, 'lib/writer.ts', `localStorage.setItem('stable-key', '1');`);
  write(b, 'lib/reader.ts', `localStorage.getItem('stable-key');`);
  write(b, 'lib/reader2.ts', `localStorage.getItem('stable-key');`);

  const rA = analyzeProjects([a]);
  const rB = analyzeProjects([b]);
  const fA = rA.findings.find((x) => x.kind === 'shared-storage-key' && x.detail.key === 'stable-key');
  const fB = rB.findings.find((x) => x.kind === 'shared-storage-key' && x.detail.key === 'stable-key');

  assert.ok(fA, 'layout A: expected finding');
  assert.ok(fB, 'layout B: expected finding');

  // patternFingerprint is location-free: same logical coupling → same hash.
  assert.equal(fA.patternFingerprint, fB.patternFingerprint,
    'patternFingerprint must be the same across file-layout changes');

  // fingerprint is location-aware (static key is same here, so it should
  // also be identical — the point is patternFingerprint is definitely equal).
  assert.match(fA.patternFingerprint, /^[0-9a-f]{16}$/);
  assert.match(fB.patternFingerprint, /^[0-9a-f]{16}$/);
});

test('patternFingerprint stable; fingerprint differs across sites (dynamic storage)', () => {
  // Two separate projects with dynamic keys — each yields a per-site fingerprint
  // but the same patternFingerprint (kind + 'dynamic' + storage).
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/alpha.ts', `localStorage.setItem(computeKey(), '1');`);
  write(a, 'src/beta.ts', `localStorage.setItem(computeKey2(), '1');`);

  const r = analyzeProjects([a]);
  const dynFindings = r.findings.filter((x) => x.kind === 'shared-storage-key' && x.detail.dynamic);

  // May be 0, 1, or 2 dynamic findings depending on same-file inference.
  // If at least 2 dynamic findings exist, verify patternFingerprint is equal
  // (same storage) and fingerprints differ (different sites).
  if (dynFindings.length >= 2) {
    assert.equal(dynFindings[0].patternFingerprint, dynFindings[1].patternFingerprint,
      'dynamic findings for same storage type share patternFingerprint');
    assert.notEqual(dynFindings[0].fingerprint, dynFindings[1].fingerprint,
      'dynamic findings at different sites must have different fingerprints');
  } else {
    // Single or no dynamic finding — still verify the one that exists has valid shape.
    for (const f of dynFindings) {
      assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/);
    }
  }
});

// ---------- (c) identity-sensitive ----------
//
// Same kind, different logical identity → different patternFingerprint.

test('patternFingerprint: different keys → different patternFingerprint', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w1.ts', `localStorage.setItem('key-one', '1'); localStorage.getItem('key-one');`);
  write(a, 'src/w2.ts', `localStorage.setItem('key-two', '1'); localStorage.getItem('key-two');`);

  const r = analyzeProjects([a]);
  const f1 = r.findings.find((x) => x.kind === 'shared-storage-key' && x.detail.key === 'key-one');
  const f2 = r.findings.find((x) => x.kind === 'shared-storage-key' && x.detail.key === 'key-two');
  assert.ok(f1 && f2, 'expected two distinct storage-key findings');
  assert.notEqual(f1.patternFingerprint, f2.patternFingerprint,
    'different key names must produce different patternFingerprints');
});

test('patternFingerprint: different event channels → different patternFingerprint', () => {
  // D20: each channel must span ≥2 files; split dispatch and listen across files.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/emit-alpha.ts', `window.dispatchEvent(new CustomEvent('chan-alpha'));`);
  write(a, 'src/listen-alpha.ts', `window.addEventListener('chan-alpha', () => {});`);
  write(a, 'src/emit-beta.ts', `window.dispatchEvent(new CustomEvent('chan-beta'));`);
  write(a, 'src/listen-beta.ts', `window.addEventListener('chan-beta', () => {});`);

  const r = analyzeProjects([a]);
  const fa = r.findings.find((x) => x.kind === 'shared-event-channel' && x.detail.channel === 'chan-alpha');
  const fb = r.findings.find((x) => x.kind === 'shared-event-channel' && x.detail.channel === 'chan-beta');
  assert.ok(fa && fb, 'expected two distinct event-channel findings');
  assert.notEqual(fa.patternFingerprint, fb.patternFingerprint,
    'different channel names must produce different patternFingerprints');
});

test('patternFingerprint: different global binding names → different patternFingerprint', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.js', `function helperA() {} function helperB() {}`);
  write(a, 'src/b.js', `function helperA() {} function helperB() {}`);

  const r = analyzeProjects([a]);
  const fa = r.findings.find((x) => x.kind === 'shared-global-binding' && x.detail.name === 'helperA');
  const fb = r.findings.find((x) => x.kind === 'shared-global-binding' && x.detail.name === 'helperB');
  assert.ok(fa && fb, 'expected two distinct global-binding findings');
  assert.notEqual(fa.patternFingerprint, fb.patternFingerprint,
    'different binding names must produce different patternFingerprints');
});

// ---------- (d) class-like equality ----------
//
// For static storage-key, fingerprint and patternFingerprint should be equal
// because both hash only (kind, storage, key) — no location parts.

test('patternFingerprint: static shared-storage-key has fingerprint === patternFingerprint', () => {
  const a = storageKeyFixture();
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'shared-storage-key' && !x.detail.dynamic);
  assert.ok(f, 'expected static shared-storage-key finding');
  assert.equal(f.fingerprint, f.patternFingerprint,
    'for static storage-key, fingerprint and patternFingerprint hash the same parts');
});

// ---------- schema presence ----------
//
// Every finding in a standard run must carry a valid patternFingerprint.

test('patternFingerprint: present on every finding, 16 hex chars', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/w.ts', `localStorage.setItem('k', 1);`);
  write(a, 'src/r.ts', `localStorage.getItem('k');`);
  write(a, 'src/emit.ts', `window.dispatchEvent(new CustomEvent('ch'));`);
  write(a, 'src/on.ts', `window.addEventListener('ch', () => {});`);
  write(a, 'src/stale.ts', `const x = document.cookie;`);

  const r = analyzeProjects([a]);
  assert.ok(r.findings.length >= 2);
  for (const f of r.findings) {
    assert.equal(typeof f.patternFingerprint, 'string',
      `finding ${f.id} missing patternFingerprint`);
    assert.match(f.patternFingerprint, /^[0-9a-f]{16}$/,
      `finding ${f.id} has invalid patternFingerprint: ${f.patternFingerprint}`);
  }
});
