import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSource,
  analyzeProjects,
  NATIVE_DOM_EVENTS,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/shared-state-events.js';
import { createAstCache } from '../src/ast-cache.js';
import { buildConstantsIndex, makeCrossFileResolver } from '../src/cross-file-constants.js';
import { resolveProject } from '../src/project.js';

// ---------- analyzeSource (unit) ----------

test('detects window.dispatchEvent(new CustomEvent("name"))', () => {
  const occ = analyzeSource(
    `window.dispatchEvent(new CustomEvent('profile:changed', { detail: u }));`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'dispatch');
  assert.equal(occ[0].name, 'profile:changed');
  assert.equal(occ[0].detectedVia, 'custom-event');
  assert.equal(occ[0].host, 'window');
  assert.equal(occ[0].dynamic, false);
});

test('detects window.dispatchEvent(new Event("name"))', () => {
  const occ = analyzeSource(
    `window.dispatchEvent(new Event('ping'));`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].name, 'ping');
  assert.equal(occ[0].detectedVia, 'custom-event');
});

test('detects window.addEventListener with string literal', () => {
  const occ = analyzeSource(
    `window.addEventListener('profile:changed', (e) => console.log(e));`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'listen');
  assert.equal(occ[0].name, 'profile:changed');
  assert.equal(occ[0].detectedVia, 'event-listener');
});

test('detects window.removeEventListener as unlisten', () => {
  const occ = analyzeSource(
    `window.removeEventListener('profile:changed', h);`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].op, 'unlisten');
  assert.equal(occ[0].detectedVia, 'event-listener');
});

test('resolves globalThis and self as hosts', () => {
  const occ = analyzeSource(
    `globalThis.dispatchEvent(new CustomEvent('a'));
     self.addEventListener('b', h);`,
    'f.ts',
  );
  assert.equal(occ.length, 2);
  assert.equal(occ[0].host, 'globalThis');
  assert.equal(occ[1].host, 'self');
});

test('bare dispatchEvent(...) is treated as implicit window.*', () => {
  const occ = analyzeSource(
    `dispatchEvent(new CustomEvent('bare'));
     addEventListener('bare', h);`,
    'f.ts',
  );
  assert.equal(occ.length, 2);
  assert.ok(occ.every(o => o.host === 'window'));
  assert.equal(occ[0].name, 'bare');
  assert.equal(occ[1].name, 'bare');
});

test('flags dynamic channel names (non-literal first arg)', () => {
  // `eventName` has no visible declaration in the file, and `lookupName()`
  // is a function call — both stay dynamic. The `const k = …` + fold case
  // is covered by the next test.
  const occ = analyzeSource(
    `window.dispatchEvent(new CustomEvent(lookupName()));
     window.addEventListener(eventName, h);`,
    'f.ts',
  );
  assert.equal(occ.length, 2);
  assert.ok(occ.every(o => o.dynamic === true));
  assert.ok(occ.every(o => o.name === null));
  assert.ok(occ.every(o => o.foldedFrom === null));
  assert.ok(occ[0].expressionText.length > 0);
});

test('folds same-file `const CH = "literal"` on dispatch and listener', () => {
  const occ = analyzeSource(
    `const CHANNEL = 'profile:changed';
     window.dispatchEvent(new CustomEvent(CHANNEL));
     window.addEventListener(CHANNEL, h);`,
    'f.ts',
  );
  assert.equal(occ.length, 2);
  assert.ok(occ.every(o => o.dynamic === false));
  assert.ok(occ.every(o => o.name === 'profile:changed'));
  assert.ok(occ.every(o => o.foldedFrom === 'CHANNEL'));
});

test('does NOT fold a reassigned channel binding', () => {
  const occ = analyzeSource(
    `let k = 'profile:changed';
     k = 'other';
     window.addEventListener(k, h);`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dynamic, true);
  assert.equal(occ[0].name, null);
  assert.equal(occ[0].foldedFrom, null);
});

test('dispatch with pre-constructed event: alias-follow resolves the channel (P22)', () => {
  // `const e = new CustomEvent('x'); dispatchEvent(e)` — the alias is a
  // same-scope non-reassigned const, so we see through it and record
  // the dispatch on channel 'x' with aliasedFrom tag.
  const occ = analyzeSource(
    `const e = new CustomEvent('x');
     window.dispatchEvent(e);`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dynamic, false);
  assert.equal(occ[0].name, 'x');
  assert.equal(occ[0].aliasedFrom, 'e');
});

test('dispatch with reassigned alias is still dynamic', () => {
  // `let e = new CustomEvent('x'); e = other; dispatchEvent(e)` — the
  // binding is reassigned, so the alias is not foldable and the dispatch
  // stays dynamic. This is the regression guard for the P22 scope.
  const occ = analyzeSource(
    `let e = new CustomEvent('x');
     e = somethingElse;
     window.dispatchEvent(e);`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dynamic, true);
});

test('dispatch with unknown constructor is dynamic', () => {
  const occ = analyzeSource(
    `window.dispatchEvent(new MyCustomEvt('x'));`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dynamic, true);
});

test('ignores unrelated method calls and non-global hosts', () => {
  const occ = analyzeSource(
    `document.addEventListener('click', h);
     bus.emit('x');
     el.dispatchEvent(new CustomEvent('x'));
     foo.removeEventListener('x', h);`,
    'f.ts',
  );
  assert.equal(occ.length, 0);
});

test('template literal (no substitution) counts as literal name', () => {
  const occ = analyzeSource(
    `window.dispatchEvent(new CustomEvent(\`ping\`));
     window.addEventListener(\`ping\`, h);`,
    'f.ts',
  );
  assert.equal(occ.length, 2);
  assert.ok(occ.every(o => o.dynamic === false));
  assert.ok(occ.every(o => o.name === 'ping'));
});

test('parses tsx without crashing', () => {
  const src = `
    export const C = () => {
      window.addEventListener('m', h);
      return <div onClick={() => window.dispatchEvent(new CustomEvent('m'))} />;
    };
  `;
  const occ = analyzeSource(src, 'f.tsx');
  assert.equal(occ.length, 2);
});

// ---------- analyzeProjects (integration, tmp fs) ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-events-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('groups same channel across files and projects', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/emit.ts', `window.dispatchEvent(new CustomEvent('profile:changed', { detail: u }));`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/listen.ts', `globalThis.addEventListener('profile:changed', handler);`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.version, '0.1');
  assert.equal(result.analyzer, ANALYZER_ID);
  assert.equal(result.projects.length, 2);

  const f = result.findings.find(x => x.channel === 'profile:changed');
  assert.ok(f, 'expected finding for profile:changed');
  assert.equal(f.kind, 'shared-event-channel');
  assert.equal(f.occurrences.length, 2);
  const projects = new Set(f.occurrences.map(o => o.project));
  assert.deepEqual([...projects].sort(), ['app-a', 'app-b']);
  const ops = f.occurrences.map(o => o.op).sort();
  assert.deepEqual(ops, ['dispatch', 'listen']);
});

test('dynamic channel occurrences are not merged across sites', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `window.dispatchEvent(new CustomEvent(k));`);
  write(a, 'src/b.ts', `window.addEventListener(otherName, h);`);

  const result = analyzeProjects([a]);
  const dynamics = result.findings.filter(f => f.dynamic);
  assert.equal(dynamics.length, 2);
  for (const d of dynamics) {
    assert.equal(d.channel, null);
    assert.ok(d.expression);
  }
});

test('skips node_modules and other ignored dirs', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/real.ts', `window.dispatchEvent(new CustomEvent('real'));`);
  write(a, 'node_modules/pkg/dist/index.js', `window.dispatchEvent(new CustomEvent('noise'));`);
  write(a, 'dist/bundle.js', `window.dispatchEvent(new CustomEvent('noise'));`);

  const result = analyzeProjects([a]);
  const channels = result.findings.map(f => f.channel).filter(Boolean).sort();
  assert.deepEqual(channels, ['real']);
});

test('schema shape: top-level + finding + occurrence fields', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/one.ts', `window.addEventListener('x', h);`);

  const result = analyzeProjects([a]);
  assert.equal(result.version, SCHEMA_VERSION);
  assert.equal(result.analyzer, 'shared-state.events');
  assert.ok(Array.isArray(result.projects));
  assert.ok(Array.isArray(result.findings));

  const f = result.findings[0];
  assert.equal(f.kind, 'shared-event-channel');
  assert.equal(f.channel, 'x');
  assert.equal(f.dynamic, false);

  const o = f.occurrences[0];
  assert.equal(o.project, 'app');
  assert.equal(o.file, path.join('src', 'one.ts'));
  assert.equal(o.op, 'listen');
  assert.equal(o.detectedVia, 'event-listener');
  assert.equal(o.host, 'window');
  assert.equal(typeof o.line, 'number');
  assert.equal(typeof o.column, 'number');
  assert.equal(typeof o.snippet, 'string');
});

// ---------- native-DOM-event suppression (regression: dogfood §2.7) ----------

test('NATIVE_DOM_EVENTS includes canonical names', () => {
  for (const name of ['resize', 'scroll', 'click', 'popstate', 'message', 'load']) {
    assert.ok(NATIVE_DOM_EVENTS.has(name), `expected '${name}' in NATIVE_DOM_EVENTS`);
  }
});

test('drops listen-only native-event findings in ONE file', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(
    a,
    'src/one.ts',
    `window.addEventListener('resize', () => {});
     window.addEventListener('scroll', () => {});
     window.addEventListener('popstate', () => {});`,
  );
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('drops listen-only native-event findings across multiple files', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `window.addEventListener('resize', h);`);
  write(a, 'src/b.ts', `window.addEventListener('resize', h);`);
  write(a, 'src/c.ts', `globalThis.addEventListener('scroll', h);`);
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('KEEPS native-named channel if at least one occurrence is dispatch', () => {
  // Synthesising a native-named event IS a coupling signal — file A
  // programmatically fires a native event, file B's listener runs.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/emit.ts', `window.dispatchEvent(new CustomEvent('resize'));`);
  write(a, 'src/listen.ts', `window.addEventListener('resize', h);`);
  const result = analyzeProjects([a]);
  const f = result.findings.find((x) => x.channel === 'resize');
  assert.ok(f, 'expected finding for synthesized resize dispatch');
  assert.equal(f.occurrences.length, 2);
});

test('KEEPS custom-named channels even when listen-only (no dispatch)', () => {
  // `profile:changed` is not a native event — a single-site listener
  // is still a weak coupling signal (the dispatcher may be out of scope).
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/listen.ts', `window.addEventListener('profile:changed', h);`);
  const result = analyzeProjects([a]);
  assert.ok(result.findings.some((f) => f.channel === 'profile:changed'));
});

test('dynamic findings are NOT filtered by native-event rule', () => {
  // Dynamic channel names are per-site findings and can't be matched
  // against the native whitelist. Always pass through.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `window.addEventListener(eventName, h);`);
  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].dynamic, true);
});

// ---------- P22: dispatch alias-follow (ternary + integration) ----------

test('P22: ternary alias emits two dispatch occurrences (one per branch)', () => {
  const occ = analyzeSource(
    `function forward(evt) {
       const fwd = evt instanceof CustomEvent
         ? new CustomEvent('A', { bubbles: true, detail: evt.detail })
         : new Event('B', { bubbles: true });
       window.dispatchEvent(fwd);
     }`,
    'f.ts',
  );
  const names = occ.filter((o) => o.op === 'dispatch').map((o) => o.name).sort();
  assert.deepEqual(names, ['A', 'B'], 'both ternary branches emit');
  for (const o of occ) {
    if (o.op === 'dispatch') assert.equal(o.aliasedFrom, 'fwd');
  }
});

test('P22: alias-follow only triggers for same-scope const/let, not cross-function', () => {
  // The alias `fwd` is declared inside makeForwarder; the dispatch uses
  // a parameter. Can't be resolved via our same-scope resolver — the
  // parameter binding has no initializer the resolver understands.
  const occ = analyzeSource(
    `function makeForwarder() {
       return new CustomEvent('A');
     }
     function dispatcher(fwd) {
       window.dispatchEvent(fwd);
     }`,
    'f.ts',
  );
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dynamic, true, 'parameter-bound dispatch stays dynamic (out of v1 scope)');
});

test('P22: integration — aliased dispatch collapses with a listener on the same channel', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'p22-int' }));
  write(a, 'src/pub.ts', `
    function forward() {
      const fwd = new CustomEvent('profile:changed', { detail: {} });
      window.dispatchEvent(fwd);
    }
  `);
  write(a, 'src/sub.ts', `window.addEventListener('profile:changed', () => {});`);
  const result = analyzeProjects([a]);
  const finding = result.findings.find((f) => f.channel === 'profile:changed');
  assert.ok(finding, 'aliased dispatch + listen collapse into one finding');
  assert.equal(finding.dynamic, false);
  const ops = new Set(finding.occurrences.map((o) => o.op));
  assert.ok(ops.has('dispatch') && ops.has('listen'));
  const dispatchOcc = finding.occurrences.find((o) => o.op === 'dispatch');
  assert.equal(dispatchOcc.aliasedFrom, 'fwd');
});

test('D15: folds cross-file `import { CH } from "./events"` for dispatch + listen', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'xfile-ev' }));
  write(a, 'src/events.ts', `export const CH_PROFILE = 'profile:changed';`);
  write(a, 'src/pub.ts', `
    import { CH_PROFILE } from './events';
    window.dispatchEvent(new CustomEvent(CH_PROFILE, { detail: u }));
  `);
  write(a, 'src/sub.ts', `
    import { CH_PROFILE } from './events';
    window.addEventListener(CH_PROFILE, h);
  `);

  const astCache = createAstCache();
  const index = buildConstantsIndex([resolveProject(a)], { astCache });
  const crossFileResolver = makeCrossFileResolver(index);
  const result = analyzeProjects([a], { astCache, crossFileResolver });

  const finding = result.findings.find((f) => f.channel === 'profile:changed');
  assert.ok(finding, 'dispatch + listen collapse into one channel finding');
  assert.equal(finding.dynamic, false);
  assert.equal(finding.occurrences.length, 2);
  const ops = new Set(finding.occurrences.map((o) => o.op));
  assert.ok(ops.has('dispatch') && ops.has('listen'), 'both sides resolved');
  for (const o of finding.occurrences) {
    assert.equal(o.foldedFrom, 'CH_PROFILE');
    assert.equal(o.foldedFromModule, './events');
  }
});
