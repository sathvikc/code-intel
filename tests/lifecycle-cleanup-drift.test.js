import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { analyzeSource } from '../src/lifecycle-cleanup-drift.js';

// Helper: run analyzeSource with a known project/file and return findings
function run(code, file = 'test.js', project = 'proj') {
  return analyzeSource(code, file, undefined, project);
}

// ---------- Test 1: addEventListener with no teardown → missing-teardown ----------

test('addEventListener with no teardown emits missing-teardown', () => {
  const findings = run(`
    function setup() {
      window.addEventListener('resize', handler);
    }
  `);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.kind, 'missing-teardown');
  assert.equal(f.registrationKind, 'addEventListener');
  assert.equal(f.occurrences[0].op, 'register');
  assert.equal(f.occurrences[0].registrationKind, 'addEventListener');
  assert.equal(f.occurrences[0].channel, 'resize');
});

// ---------- Test 2: addEventListener with matching removeEventListener same identifier → no finding ----------

test('addEventListener with matching removeEventListener same identifier → no finding', () => {
  const findings = run(`
    function setup() {
      window.addEventListener('resize', onResize);
      window.removeEventListener('resize', onResize);
    }
  `);
  assert.equal(findings.length, 0);
});

// ---------- Test 3: setInterval result discarded, no clearInterval → missing-teardown ----------

test('setInterval result discarded emits missing-teardown', () => {
  const findings = run(`
    function setup() {
      setInterval(() => {}, 1000);
    }
  `);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.kind, 'missing-teardown');
  assert.equal(f.registrationKind, 'setInterval');
});

// ---------- Test 4: setInterval result captured, clearInterval(id) present → no finding ----------

test('setInterval result captured, clearInterval present → no finding', () => {
  const findings = run(`
    function setup() {
      const timerId = setInterval(() => {}, 1000);
      clearInterval(timerId);
    }
  `);
  assert.equal(findings.length, 0);
});

// ---------- Test 5: new IntersectionObserver no disconnect → missing-teardown ----------

test('new IntersectionObserver with no disconnect emits missing-teardown', () => {
  const findings = run(`
    function setup() {
      const obs = new IntersectionObserver(cb);
    }
  `);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.kind, 'missing-teardown');
  assert.equal(f.registrationKind, 'IntersectionObserver');
});

// ---------- Test 6: new IntersectionObserver with .disconnect() → no finding ----------

test('new IntersectionObserver with disconnect → no finding', () => {
  const findings = run(`
    function setup() {
      const obs = new IntersectionObserver(cb);
      obs.disconnect();
    }
  `);
  assert.equal(findings.length, 0);
});

// ---------- Test 7: AbortController signal used, no .abort() → abort-never-called ----------

test('AbortController signal used, no abort emits abort-never-called', () => {
  const findings = run(`
    function setup() {
      const ctrl = new AbortController();
      fetch('/api', { signal: ctrl.signal });
    }
  `);
  const abortFindings = findings.filter((f) => f.kind === 'abort-never-called');
  assert.equal(abortFindings.length, 1);
  const f = abortFindings[0];
  assert.equal(f.occurrences[0].op, 'construct');
  assert.ok(f.occurrences[0].usedAt.length >= 1);
});

// ---------- Test 8: AbortController signal used, .abort() present → no finding ----------

test('AbortController signal used, abort present → no finding', () => {
  const findings = run(`
    function setup() {
      const ctrl = new AbortController();
      fetch('/api', { signal: ctrl.signal });
      ctrl.abort();
    }
  `);
  const abortFindings = findings.filter((f) => f.kind === 'abort-never-called');
  assert.equal(abortFindings.length, 0);
});

// ---------- Test 9: addEventListener with { signal: ctrl.signal }, ctrl.abort() present → no missing-teardown ----------

test('addEventListener with abort signal happy path → no missing-teardown', () => {
  const findings = run(`
    function setup() {
      const ctrl = new AbortController();
      window.addEventListener('click', handler, { signal: ctrl.signal });
      ctrl.abort();
    }
  `);
  const missingTeardown = findings.filter((f) => f.kind === 'missing-teardown');
  assert.equal(missingTeardown.length, 0);
});

// ---------- Test 10: handler-identity-mismatch — both inline arrows ----------

test('handler-identity-mismatch — both inline arrows', () => {
  const findings = run(`
    function setup() {
      window.addEventListener('click', () => doA());
      window.removeEventListener('click', () => doA());
    }
  `);
  const mismatches = findings.filter((f) => f.kind === 'handler-identity-mismatch');
  assert.equal(mismatches.length, 1);
  const f = mismatches[0];
  assert.equal(f.channel, 'click');
  assert.equal(f.occurrences[0].op, 'add');
  assert.equal(f.occurrences[1].op, 'remove');
  assert.equal(f.occurrences[0].handlerKind, 'arrow');
  assert.equal(f.occurrences[1].handlerKind, 'arrow');
});

// ---------- Test 11: handler-identity-mismatch — different named bindings ----------

test('handler-identity-mismatch — different named bindings', () => {
  const findings = run(`
    function setup() {
      window.addEventListener('scroll', handlerA);
      window.removeEventListener('scroll', handlerB);
    }
  `);
  const mismatches = findings.filter((f) => f.kind === 'handler-identity-mismatch');
  assert.equal(mismatches.length, 1);
  const f = mismatches[0];
  assert.equal(f.channel, 'scroll');
  assert.equal(f.occurrences[0].handlerKind, 'identifier');
  assert.equal(f.occurrences[1].handlerKind, 'identifier');
});

// ---------- Test 12: handler same binding name → no handler-identity-mismatch ----------

test('handler same binding name → no handler-identity-mismatch', () => {
  const findings = run(`
    function setup() {
      window.addEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
    }
  `);
  const mismatches = findings.filter((f) => f.kind === 'handler-identity-mismatch');
  assert.equal(mismatches.length, 0);
});

// ---------- Test 13: cleanup-return pattern (useEffect-style) → no finding ----------

test('cleanup-return pattern → no missing-teardown', () => {
  const findings = run(`
    function setup() {
      useEffect(() => {
        window.addEventListener('resize', onResize);
        return () => {
          window.removeEventListener('resize', onResize);
        };
      }, []);
    }
  `);
  // The inner arrow function passed to useEffect is its own function body.
  // The addEventListener is in that inner body, and the returned arrow's body
  // contains the removeEventListener — so no missing-teardown should fire.
  const missingTeardown = findings.filter((f) => f.kind === 'missing-teardown');
  assert.equal(missingTeardown.length, 0);
});

// ---------- Test 14: new WebSocket no .close() → missing-teardown ----------

test('new WebSocket with no close emits missing-teardown', () => {
  const findings = run(`
    function setup() {
      const ws = new WebSocket('wss://example.com');
    }
  `);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.kind, 'missing-teardown');
  assert.equal(f.registrationKind, 'WebSocket');
});

// ---------- Test 15: fingerprint stability ----------

test('fingerprint stability — same finding hashes identically twice', () => {
  // We compute the fingerprint the same way impact.js does:
  // hash kind + registrationKind + file + line
  function fingerprintFor(kind, detail) {
    const parts = [kind];
    if (kind === 'missing-teardown') {
      parts.push(detail.registrationKind ?? '', detail.occurrences?.[0]?.file ?? '',
                 String(detail.occurrences?.[0]?.line ?? ''));
    } else if (kind === 'abort-never-called') {
      parts.push(detail.occurrences?.[0]?.file ?? '',
                 String(detail.occurrences?.[0]?.line ?? ''));
    } else if (kind === 'handler-identity-mismatch') {
      parts.push(detail.channel ?? '', detail.occurrences?.[0]?.file ?? '',
                 String(detail.occurrences?.[0]?.line ?? ''));
    }
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  }

  const findings1 = run(`
    function setup() {
      window.addEventListener('resize', handler);
    }
  `, 'comp.js', 'myapp');

  const findings2 = run(`
    function setup() {
      window.addEventListener('resize', handler);
    }
  `, 'comp.js', 'myapp');

  assert.equal(findings1.length, 1);
  assert.equal(findings2.length, 1);

  const fp1 = fingerprintFor(findings1[0].kind, findings1[0]);
  const fp2 = fingerprintFor(findings2[0].kind, findings2[0]);

  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 16);
});

// ---------- Additional edge cases ----------

test('new ResizeObserver with disconnect → no finding', () => {
  const findings = run(`
    function init() {
      const obs = new ResizeObserver(cb);
      obs.disconnect();
    }
  `);
  assert.equal(findings.length, 0);
});

test('new MutationObserver with no disconnect → missing-teardown', () => {
  const findings = run(`
    function init() {
      const obs = new MutationObserver(cb);
      obs.observe(document.body, { childList: true });
    }
  `);
  const f = findings.find((x) => x.kind === 'missing-teardown');
  assert.ok(f);
  assert.equal(f.registrationKind, 'MutationObserver');
});

test('new EventSource with close → no finding', () => {
  const findings = run(`
    function init() {
      const es = new EventSource('/stream');
      es.close();
    }
  `);
  assert.equal(findings.length, 0);
});

test('setTimeout captured and cleared → no finding', () => {
  const findings = run(`
    function init() {
      const tid = setTimeout(() => {}, 500);
      clearTimeout(tid);
    }
  `);
  assert.equal(findings.length, 0);
});

test('nested function body is not reported for outer scope', () => {
  // The addEventListener inside the nested function should NOT be reported
  // as a finding for the outer function — it belongs to the nested scope.
  const findings = run(`
    function outer() {
      // outer does nothing with event listeners
    }
    function inner() {
      window.addEventListener('resize', onResize);
    }
  `);
  // Only the inner function's registration is missing teardown
  const f = findings.filter((x) => x.kind === 'missing-teardown');
  assert.equal(f.length, 1);
  assert.equal(f[0].registrationKind, 'addEventListener');
});
