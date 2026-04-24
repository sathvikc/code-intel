import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSource,
  analyzeProjects,
  summarize,
} from '../src/shape-drift.js';

// ---------- helpers ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-events-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ---------- analyzeSource unit tests ----------

test('eventWrites: inline dispatchEvent(new CustomEvent(ch, {detail:{a,b}})) → shape {a,b}', () => {
  const { eventWrites } = analyzeSource(
    `dispatchEvent(new CustomEvent('profile:changed', { detail: { userId: 1, email: 'x' } }));`,
    'f.ts',
  );
  assert.equal(eventWrites.length, 1);
  assert.equal(eventWrites[0].channel, 'profile:changed');
  assert.equal(eventWrites[0].opaque, false);
  assert.deepEqual(eventWrites[0].keys, ['email', 'userId']);
});

test('eventWrites: window.dispatchEvent(new CustomEvent(...)) is captured', () => {
  const { eventWrites } = analyzeSource(
    `window.dispatchEvent(new CustomEvent('nav:changed', { detail: { path: '/a', params: {} } }));`,
    'f.ts',
  );
  assert.equal(eventWrites.length, 1);
  assert.equal(eventWrites[0].channel, 'nav:changed');
  assert.equal(eventWrites[0].opaque, false);
  assert.deepEqual(eventWrites[0].keys, ['params', 'path']);
});

test('eventWrites: non-literal detail is opaque', () => {
  const { eventWrites } = analyzeSource(
    `dispatchEvent(new CustomEvent('sync', { detail: extObj }));`,
    'f.ts',
  );
  assert.equal(eventWrites.length, 1);
  assert.equal(eventWrites[0].opaque, true);
});

test('eventWrites: no detail arg is opaque', () => {
  const { eventWrites } = analyzeSource(
    `dispatchEvent(new CustomEvent('sync'));`,
    'f.ts',
  );
  assert.equal(eventWrites.length, 1);
  assert.equal(eventWrites[0].opaque, true);
  assert.equal(eventWrites[0].reason, 'no-literal-detail');
});

test('eventWrites: alias-followed write → aliasedFrom field', () => {
  const { eventWrites } = analyzeSource(
    `const ev = new CustomEvent('auth:login', { detail: { token: 't', userId: 1 } });
     dispatchEvent(ev);`,
    'f.ts',
  );
  assert.equal(eventWrites.length, 1);
  assert.equal(eventWrites[0].aliasedFrom, 'ev');
  assert.equal(eventWrites[0].opaque, false);
  assert.deepEqual(eventWrites[0].keys, ['token', 'userId']);
});

test('eventReads: inline arrow handler with destructured detail { detail: { a, b } }', () => {
  const { eventReads } = analyzeSource(
    `addEventListener('profile:changed', ({ detail: { userId, name } }) => {});`,
    'f.ts',
  );
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0].channel, 'profile:changed');
  assert.equal(eventReads[0].opaque, false);
  assert.deepEqual(eventReads[0].keys, ['name', 'userId']);
});

test('eventReads: inline arrow handler with e.detail.field direct access', () => {
  const { eventReads } = analyzeSource(
    `window.addEventListener('cart:update', (e) => { e.detail.count; e.detail.total; });`,
    'f.ts',
  );
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0].channel, 'cart:update');
  assert.equal(eventReads[0].opaque, false);
  assert.deepEqual(eventReads[0].keys, ['count', 'total']);
});

test('eventReads: inline arrow handler with const d = e.detail; d.field', () => {
  const { eventReads } = analyzeSource(
    `addEventListener('nav:changed', (e) => { const d = e.detail; d.path; d.query; });`,
    'f.ts',
  );
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0].channel, 'nav:changed');
  assert.equal(eventReads[0].opaque, false);
  assert.deepEqual(eventReads[0].keys, ['path', 'query']);
});

test('eventReads: handler shorthand { detail } binding → looks for detail.field usage', () => {
  const { eventReads } = analyzeSource(
    `addEventListener('sync', ({ detail }) => { detail.id; detail.ts; });`,
    'f.ts',
  );
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0].opaque, false);
  assert.deepEqual(eventReads[0].keys, ['id', 'ts']);
});

test('eventReads: { detail: d } alias binding → looks for d.field usage', () => {
  const { eventReads } = analyzeSource(
    `addEventListener('sync', ({ detail: d }) => { d.id; d.ts; });`,
    'f.ts',
  );
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0].opaque, false);
  assert.deepEqual(eventReads[0].keys, ['id', 'ts']);
});

test('eventReads: handler is a non-inline reference → opaque', () => {
  const { eventReads } = analyzeSource(
    `addEventListener('sync', handleSync);`,
    'f.ts',
  );
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0].opaque, true);
  assert.equal(eventReads[0].reason, 'handler-not-inline');
});

test('eventReads: { detail: ...rest } → opaque', () => {
  const { eventReads } = analyzeSource(
    `addEventListener('sync', ({ detail: ...rest }) => {});`,
    'f.ts',
  );
  assert.equal(eventReads.length, 1);
  assert.equal(eventReads[0].opaque, true);
});

test('eventReads and eventWrites are both empty when no events', () => {
  const { eventWrites, eventReads } = analyzeSource(
    `localStorage.setItem('k', JSON.stringify({ a: 1 }));`,
    'f.ts',
  );
  assert.equal(eventWrites.length, 0);
  assert.equal(eventReads.length, 0);
});

// ---------- analyzeProjects integration tests ----------

// Test 1: inline literal dispatch + destructure listener disagrees → emits
test('integration: inline dispatch + destructure listener disagrees → emits event-shape-drift', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/dispatch.ts',
    `dispatchEvent(new CustomEvent('profile:changed', { detail: { userId: 1, email: 'x' } }));`,
  );
  write(a, 'src/listen.ts',
    `addEventListener('profile:changed', ({ detail: { userId, name } }) => {});`,
  );
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'event-shape-drift');
  assert.ok(f, 'should emit event-shape-drift finding');
  assert.equal(f.channel, 'profile:changed');
  assert.deepEqual(f.writeOnlyKeys, ['email']);
  assert.deepEqual(f.readOnlyKeys, ['name']);
  assert.equal(r.findings.filter((x) => x.kind === 'event-shape-drift').length, 1);
});

// Test 2: inline literal dispatch + direct-access listener disagrees → emits
test('integration: inline dispatch + direct-access listener disagrees → emits event-shape-drift', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/dispatch.ts',
    `dispatchEvent(new CustomEvent('cart:update', { detail: { items: [], total: 0 } }));`,
  );
  write(a, 'src/listen.ts',
    `window.addEventListener('cart:update', (e) => { e.detail.count; e.detail.total; });`,
  );
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'event-shape-drift');
  assert.ok(f, 'should emit event-shape-drift finding');
  assert.equal(f.channel, 'cart:update');
  assert.deepEqual(f.writeOnlyKeys, ['items']);
  assert.deepEqual(f.readOnlyKeys, ['count']);
});

// Test 3: inline literal dispatch + binding-then-usage listener disagrees → emits
test('integration: inline dispatch + binding-then-usage listener disagrees → emits event-shape-drift', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/dispatch.ts',
    `window.dispatchEvent(new CustomEvent('nav:changed', { detail: { path: '/', params: {} } }));`,
  );
  write(a, 'src/listen.ts',
    `addEventListener('nav:changed', (e) => { const d = e.detail; d.path; d.query; });`,
  );
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'event-shape-drift');
  assert.ok(f, 'should emit event-shape-drift finding');
  assert.equal(f.channel, 'nav:changed');
  assert.deepEqual(f.writeOnlyKeys, ['params']);
  assert.deepEqual(f.readOnlyKeys, ['query']);
});

// Test 4: agreement → does not emit
test('integration: dispatch+listen agree → no event-shape-drift finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/dispatch.ts',
    `dispatchEvent(new CustomEvent('sync', { detail: { id: 1, ts: Date.now() } }));`,
  );
  write(a, 'src/listen.ts',
    `addEventListener('sync', ({ detail: { id, ts } }) => {});`,
  );
  const r = analyzeProjects([a]);
  const eventFindings = r.findings.filter((x) => x.kind === 'event-shape-drift');
  assert.equal(eventFindings.length, 0);
});

// Test 5: one-side opaque → does not emit
test('integration: opaque dispatch + literal listen → no event-shape-drift finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/dispatch.ts',
    `dispatchEvent(new CustomEvent('sync', { detail: extObj }));`,
  );
  write(a, 'src/listen.ts',
    `addEventListener('sync', (e) => { e.detail.id; });`,
  );
  const r = analyzeProjects([a]);
  const eventFindings = r.findings.filter((x) => x.kind === 'event-shape-drift');
  assert.equal(eventFindings.length, 0);
});

// Test 6: alias-followed write → resolves correctly
test('integration: alias-followed dispatch → event-shape-drift with aliasedFrom', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/dispatch.ts',
    `const ev = new CustomEvent('auth:login', { detail: { token: 't', userId: 1 } });
     dispatchEvent(ev);`,
  );
  write(a, 'src/listen.ts',
    `addEventListener('auth:login', (e) => { e.detail.token; e.detail.uid; });`,
  );
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'event-shape-drift');
  assert.ok(f, 'should emit event-shape-drift finding');
  assert.equal(f.channel, 'auth:login');
  assert.deepEqual(f.writeOnlyKeys, ['userId']);
  assert.deepEqual(f.readOnlyKeys, ['uid']);
  const dispatchOcc = f.occurrences.find((o) => o.op === 'dispatch');
  assert.equal(dispatchOcc.aliasedFrom, 'ev');
});

// Test 7: storage findings unaffected
test('integration: storage shape-drift still emits alongside event-shape-drift', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Storage pair with drift
  write(a, 'src/store-write.ts',
    `localStorage.setItem('user', JSON.stringify({ name: 'x', age: 3 }));`,
  );
  write(a, 'src/store-read.ts',
    `const u = JSON.parse(localStorage.getItem('user') || '{}'); u.firstName;`,
  );
  // Event pair with drift
  write(a, 'src/event-dispatch.ts',
    `dispatchEvent(new CustomEvent('msg', { detail: { body: 'hi', sender: 'a' } }));`,
  );
  write(a, 'src/event-listen.ts',
    `addEventListener('msg', (e) => { e.detail.body; e.detail.recipient; });`,
  );
  const r = analyzeProjects([a]);
  const storageFinding = r.findings.find((f) => f.kind === 'shape-drift');
  const eventFinding = r.findings.find((f) => f.kind === 'event-shape-drift');
  assert.ok(storageFinding, 'should still emit storage shape-drift');
  assert.equal(storageFinding.storage, 'localStorage');
  assert.equal(storageFinding.key, 'user');
  assert.ok(eventFinding, 'should emit event-shape-drift');
  assert.equal(eventFinding.channel, 'msg');
  assert.deepEqual(eventFinding.writeOnlyKeys, ['sender']);
  assert.deepEqual(eventFinding.readOnlyKeys, ['recipient']);
});

// Test 8: analyzeProjects integration — op values are 'dispatch' / 'listen'
test('integration: occurrence op values are dispatch and listen', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/d.ts',
    `dispatchEvent(new CustomEvent('x', { detail: { a: 1, b: 2 } }));`,
  );
  write(a, 'src/l.ts',
    `addEventListener('x', (e) => { e.detail.a; e.detail.c; });`,
  );
  const r = analyzeProjects([a]);
  const f = r.findings.find((x) => x.kind === 'event-shape-drift');
  assert.ok(f, 'finding present');
  const ops = new Set(f.occurrences.map((o) => o.op));
  assert.ok(ops.has('dispatch'), 'dispatch op present');
  assert.ok(ops.has('listen'), 'listen op present');
  // Confirm kind
  assert.equal(f.kind, 'event-shape-drift');
});

// Test 9: summarize counts byChannelKind
test('summarize: byChannelKind counts storage and event separately', () => {
  const fakeResult = {
    projects: [{ id: 'a', root: '/a' }],
    findings: [
      {
        kind: 'shape-drift',
        storage: 'localStorage',
        key: 'k',
        writeOnlyKeys: ['a'],
        readOnlyKeys: [],
        occurrences: [],
      },
      {
        kind: 'event-shape-drift',
        channel: 'x',
        writeOnlyKeys: ['b'],
        readOnlyKeys: [],
        occurrences: [],
      },
      {
        kind: 'event-shape-drift',
        channel: 'y',
        writeOnlyKeys: [],
        readOnlyKeys: ['c'],
        occurrences: [],
      },
    ],
  };
  const summary = summarize(fakeResult);
  assert.equal(summary.findingCount, 3);
  assert.equal(summary.byChannelKind.storage, 1);
  assert.equal(summary.byChannelKind.event, 2);
  assert.equal(summary.byStorage.localStorage, 1);
});
