import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeProjects,
  summarize,
  ANALYZER_ID,
  SCHEMA_VERSION,
} from '../src/stateful-shared-regex.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-stateful-regex-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ---------- positive — canonical cases ----------

test('detects /g regex with .test() use-site — one finding, two occurrences', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/email.ts', `const RE = /\\S+@\\S+/g;\nexport function check(s) { return RE.test(s); }`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.kind, 'stateful-shared-regex');
  assert.equal(f.name, 'RE');
  assert.equal(f.flags, 'g');
  assert.equal(f.occurrences.length, 2);
  const ops = f.occurrences.map((o) => o.op);
  assert.ok(ops.includes('declare'));
  assert.ok(ops.includes('test'));
});

test('detects /y regex with .exec() use-site — flags y, op exec', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/y;\nRE.exec(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.flags, 'y');
  const execOcc = f.occurrences.find((o) => o.op === 'exec');
  assert.ok(execOcc, 'should have exec occurrence');
});

test('detects /gi regex with both .test() and .exec() — three occurrences', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/gi;\nRE.test(s);\nRE.exec(s2);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].occurrences.length, 3);
  const ops = result.findings[0].occurrences.map((o) => o.op).sort();
  assert.deepEqual(ops, ['declare', 'exec', 'test']);
});

test('detects new RegExp(string, "g") constructor with .test()', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = new RegExp('\\\\S+', 'g');\nRE.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.flags, 'g');
  assert.equal(f.pattern, '\\S+');
});

test('detects new RegExp(template-literal, template-literal "g") constructor', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  // Use NoSubstitutionTemplateLiteral (backtick strings without expressions)
  write(a, 'src/t.ts', 'const RE = new RegExp(`pat`, `g`);\nRE.test(s);');

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.flags, 'g');
  assert.equal(f.pattern, 'pat');
});

// ---------- flags catalogue ----------

for (const flags of ['g', 'y', 'gi', 'gy', 'gimsu', 'gimuy']) {
  test(`flags catalogue: /${flags}/ emits a finding`, () => {
    const a = mktmp();
    write(a, 'package.json', JSON.stringify({ name: 'app' }));
    write(a, 'src/t.ts', `const RE = /pat/${flags};\nRE.test(s);`);

    const result = analyzeProjects([a]);
    assert.equal(result.findings.length, 1, `expected finding for flags '${flags}'`);
    assert.equal(result.findings[0].flags, flags);
  });
}

// ---------- negative — must NOT detect ----------

test('no g/y flag: NOT detected', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/i;\nRE.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('no use-site: NOT detected (declaration alone is silent)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/g;`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('.replace() is NOT flagged — only test/exec triggers detection', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/g;\nRE.replace(other, fn);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('local-scope const inside function: NOT detected (v1 module-scope only)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `function f() { const RE = /pat/g; return RE.test(s); }`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('const inside class method: NOT detected (v1 recall gap — method-local scope)', () => {
  // class Foo { method() { const RE = /pat/g; RE.test(s); } }
  // v1 only scans VariableStatements whose parent is SourceFile.
  // Method-local bindings are not a bug (each call gets a fresh regex).
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `class Foo { method() { const RE = /pat/g; RE.test(s); } }`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'method-local const is a known v1 miss (not a bug)');
});

test('class static field: NOT detected (v1 recall gap — D23 out of scope)', () => {
  // class Foo { static RE = /pat/g; check() { return Foo.RE.test(s); } }
  // v1 only detects VariableStatements at module top-level.
  // Class static fields are out of scope per D23.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `class Foo { static RE = /pat/g; check() { return Foo.RE.test(s); } }`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'class static field is a known v1 miss (D23)');
});

test('let binding: NOT detected (v1 recall gap — D23 requires const)', () => {
  // let RE = /pat/g; RE.test(s); — v1 only detects const.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `let RE = /pat/g;\nRE.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'let is a known v1 miss (D23)');
});

test('var binding: NOT detected (v1 recall gap — D23 requires const)', () => {
  // var RE = /pat/g; RE.test(s); — v1 only detects const.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `var RE = /pat/g;\nRE.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'var is a known v1 miss (D23)');
});

test('alias: NOT detected (v1 recall gap — D23 does not follow aliases)', () => {
  // const RE = /pat/g; const r = RE; r.test(s); — v1 only sees RE directly.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/g;\nconst r = RE;\nr.test(s);`);

  const result = analyzeProjects([a]);
  // RE has no direct .test()/.exec() use-sites so no finding is emitted.
  assert.equal(result.findings.length, 0, 'aliased usage is a known v1 miss (D23)');
});

test('dotted access: NOT detected (cfg.re.test — out of scope per D23)', () => {
  // const cfg = { re: /pat/g }; cfg.re.test(s); — dotted receiver is out of scope.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const cfg = { re: /pat/g };\ncfg.re.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'dotted access is out of scope (D23)');
});

test('inline regex literal: NOT detected (/pat/g.test(s) — different bug class per D23)', () => {
  // /pat/g.test(s) — inline literal doesn't share state; different bug class.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `/pat/g.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'inline literal is a different bug class (D23)');
});

test('dynamic first arg to new RegExp: NOT detected (v1 requires literal args per D23)', () => {
  // const RE = new RegExp(userInput, 'g'); RE.test(s); — non-literal first arg.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = new RegExp(userInput, 'g');\nRE.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'dynamic arg is a known v1 miss (D23)');
});

test('destructured regex: NOT detected (destructured name is not a plain Identifier per D23)', () => {
  // const { test } = /pat/g; test('s'); — destructured binding, not a qualifying decl.
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const { test } = /pat/g;\ntest('s');`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0, 'destructured binding is not detected (D23)');
});

// ---------- module-scope filter ----------

test('module-scope top-level const: emits finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/g;\nRE.test(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
});

test('const inside IIFE: NOT detected (v1 module-scope only)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `(function() { const RE = /pat/g; RE.test(s); })();`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

test('const inside if-block: NOT detected (v1 module-scope only)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `if (cond) { const RE = /pat/g; RE.test(s); }`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 0);
});

// ---------- multi-binding ----------

test('two qualifying bindings in one statement: two findings', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const A = /a/g, B = /b/y;\nA.test(s);\nB.exec(s);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 2);
  const names = result.findings.map((f) => f.name).sort();
  assert.deepEqual(names, ['A', 'B']);
  const aFinding = result.findings.find((f) => f.name === 'A');
  const bFinding = result.findings.find((f) => f.name === 'B');
  assert.equal(aFinding.flags, 'g');
  assert.equal(bFinding.flags, 'y');
  const bOps = bFinding.occurrences.map((o) => o.op);
  assert.ok(bOps.includes('exec'));
});

// ---------- multi use-site ----------

test('one binding with multiple use-sites: one finding, four occurrences', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/g;\nRE.test(s1);\nRE.test(s2);\nRE.exec(s3);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].occurrences.length, 4);
  const ops = result.findings[0].occurrences.map((o) => o.op);
  assert.equal(ops.filter((o) => o === 'test').length, 2);
  assert.equal(ops.filter((o) => o === 'exec').length, 1);
  assert.equal(ops.filter((o) => o === 'declare').length, 1);
});

// ---------- schema ----------

test('raw output schema: finding has kind, name, pattern, flags, occurrences; no fingerprint/severity/confidence in raw output', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const EMAIL_RE = /\\S+@\\S+/g;\nif (EMAIL_RE.test(s)) { console.log('ok'); }`);

  const result = analyzeProjects([a]);
  assert.equal(result.version, SCHEMA_VERSION);
  assert.equal(result.analyzer, ANALYZER_ID);
  assert.ok(Array.isArray(result.findings));
  assert.ok(Array.isArray(result.projects));

  const f = result.findings[0];
  assert.equal(f.kind, 'stateful-shared-regex');
  assert.equal(f.name, 'EMAIL_RE');
  assert.ok(typeof f.pattern === 'string');
  assert.ok(typeof f.flags === 'string');
  assert.ok(Array.isArray(f.occurrences));

  const declOcc = f.occurrences.find((o) => o.op === 'declare');
  assert.ok(declOcc, 'should have declare occurrence');
  assert.ok(typeof declOcc.project === 'string');
  assert.ok(typeof declOcc.file === 'string');
  assert.ok(typeof declOcc.line === 'number' && declOcc.line > 0);
  assert.ok(typeof declOcc.column === 'number' && declOcc.column > 0);
  assert.ok(typeof declOcc.snippet === 'string' && declOcc.snippet.length > 0);

  const testOcc = f.occurrences.find((o) => o.op === 'test');
  assert.ok(testOcc, 'should have test occurrence');
  assert.ok(['test', 'exec'].includes(testOcc.op));

  // Verify all valid op values
  for (const occ of f.occurrences) {
    assert.ok(['declare', 'test', 'exec'].includes(occ.op), `op must be declare/test/exec, got: ${occ.op}`);
  }

  // Raw output should NOT carry impact-decoration fields
  assert.equal(f.fingerprint, undefined, 'raw output should not have fingerprint');
  assert.equal(f.severity, undefined, 'raw output should not have severity');
  assert.equal(f.confidence, undefined, 'raw output should not have confidence');
  assert.equal(f.confidenceReason, undefined, 'raw output should not have confidenceReason');
  assert.equal(f.patternFingerprint, undefined, 'raw output should not have patternFingerprint');
});

// ---------- option threading regression smokes ----------

test('includeTestContext: finding emitted when regex is in .test.ts with includeTestContext: true', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/util.test.ts', `const RE = /pat/g;\nRE.test(s);`);

  const result = analyzeProjects([a], { includeTestContext: true });
  assert.equal(result.findings.length, 1, 'should detect when includeTestContext is true');
});

test('default: finding NOT emitted when regex is in .test.ts file', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/util.test.ts', `const RE = /pat/g;\nRE.test(s);`);

  const result = analyzeProjects([a]); // default: skip test-context
  assert.equal(result.findings.length, 0, 'should skip test-context files by default');
});

test('exclude option: matching files are excluded', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/util.ts', `const RE = /pat/g;\nRE.test(s);`);
  write(a, 'some-dir/util.ts', `const RE = /pat/g;\nRE.test(s);`);

  const result = analyzeProjects([a], { exclude: ['some-dir'] });
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].occurrences[0].file.startsWith('src/'));
});

// ---------- occurrence ordering ----------

test('occurrences are sorted by line asc (declare first, use-sites after)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/g;\nRE.test(s1);\nRE.exec(s2);`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  const occs = result.findings[0].occurrences;
  assert.equal(occs[0].op, 'declare', 'first occurrence should be declare');
  for (let i = 1; i < occs.length; i++) {
    assert.ok(occs[i].line >= occs[i - 1].line, 'occurrences should be sorted by line');
  }
});

// ---------- meta envelope ----------

test('meta envelope: fileCount and errorCount are present', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const RE = /pat/g;\nRE.test(s);`);

  const result = analyzeProjects([a]);
  assert.ok(typeof result.meta.fileCount === 'number' && result.meta.fileCount >= 1);
  assert.ok(typeof result.meta.errorCount === 'number');
  assert.ok(typeof result.meta.projectCount === 'number');
});

// ---------- summarize ----------

test('summarize: produces byFlag and byPattern aggregates', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/t.ts', `const A = /pat/g;\nA.test(s);\nconst B = /other/gi;\nB.exec(s);`);

  const result = analyzeProjects([a]);
  const s = summarize(result);
  assert.equal(s.projectCount, 1);
  assert.equal(s.findingCount, 2);
  assert.ok(typeof s.byFlag === 'object');
  assert.ok(typeof s.byPattern === 'object');
  assert.equal(s.byFlag['g'], 1);
  assert.equal(s.byFlag['gi'], 1);
});
