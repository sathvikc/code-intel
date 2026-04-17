import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSource,
  analyzeProjects,
  extractReaders,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/stale-module-capture.js';

import ts from 'typescript';

function parse(code, filePath = 'f.ts') {
  return ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
}

// ---------- extractReaders ----------

test('detects function that reads document.cookie as a reader', () => {
  const readers = extractReaders(parse(`
    function parseCookie(name) {
      return document.cookie.match(name);
    }
  `));
  assert.ok(readers.has('parseCookie'));
});

test('detects arrow function reader: const readUserId = () => ...', () => {
  const readers = extractReaders(parse(`
    const readUserId = () => document.cookie;
  `));
  assert.ok(readers.has('readUserId'));
});

test('detects reader using sessionStorage.getItem', () => {
  const readers = extractReaders(parse(`
    function getFlag(k) { return sessionStorage.getItem(k); }
  `));
  assert.ok(readers.has('getFlag'));
});

test('detects reader using navigator.*', () => {
  const readers = extractReaders(parse(`
    function getLang() { return navigator.language; }
  `));
  assert.ok(readers.has('getLang'));
});

test('detects reader using fetch()', () => {
  const readers = extractReaders(parse(`
    function load() { return fetch('/api'); }
  `));
  assert.ok(readers.has('load'));
});

test('does NOT flag pure functions as readers', () => {
  const readers = extractReaders(parse(`
    function add(a, b) { return a + b; }
    const multiply = (a, b) => a * b;
  `));
  assert.equal(readers.size, 0);
});

test('detects exported function readers', () => {
  const readers = extractReaders(parse(`
    export function parseCookieValue(name) {
      return document.cookie;
    }
  `));
  assert.ok(readers.has('parseCookieValue'));
});

// ---------- analyzeSource: direct-api captures ----------

test('flags const X = document.cookie at module scope', () => {
  const { captures } = analyzeSource(
    `const currentToken = document.cookie;`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capturedKind, 'direct-api');
  assert.equal(captures[0].capturedVia, 'document.cookie');
  assert.equal(captures[0].name, 'currentToken');
});

test('flags const X = sessionStorage.getItem(...)', () => {
  const { captures } = analyzeSource(
    `const flag = sessionStorage.getItem('x');`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capturedKind, 'direct-api');
  assert.equal(captures[0].capturedVia, 'sessionStorage.getItem()');
});

test('flags const X = fetch(...)', () => {
  const { captures } = analyzeSource(
    `const promise = fetch('/api');`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capturedVia, 'fetch()');
});

test('flags const X = navigator.userAgent', () => {
  const { captures } = analyzeSource(
    `const ua = navigator.userAgent;`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capturedKind, 'direct-api');
});

test('flags const X = document.getElementById(...)', () => {
  const { captures } = analyzeSource(
    `const el = document.getElementById('root');`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
});

test('flags within a chained expression: const X = navigator.userAgent.includes("foo")', () => {
  const { captures } = analyzeSource(
    `const isChrome = navigator.userAgent.includes('Chrome');`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
});

// ---------- analyzeSource: indirect-wrapper captures ----------

test('flags const X = wrapperReader() where wrapper is in same file', () => {
  const { captures } = analyzeSource(
    `function parseCookie(n) { return document.cookie; }
     const currentToken = parseCookie('auth');`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].capturedKind, 'indirect-wrapper');
  assert.equal(captures[0].capturedVia, 'parseCookie');
});

// ---------- analyzeSource: negative cases ----------

test('does NOT flag module-scope arrow function literal', () => {
  const { captures } = analyzeSource(
    `const parseCookie = () => document.cookie;`,
    'f.ts',
  );
  // The arrow IS a reader (extractReaders picks it up), but `const x = () =>
  // …` itself is NOT a capture — it's a function definition.
  assert.equal(captures.length, 0);
});

test('does NOT flag inside a function body', () => {
  const { captures } = analyzeSource(
    `export function thing() {
       const x = document.cookie;
       return x;
     }`,
    'f.ts',
  );
  assert.equal(captures.length, 0);
});

test('does NOT flag pure literal initializers', () => {
  const { captures } = analyzeSource(
    `const TIMEOUT = 5000;
     const MESSAGE = 'hello';
     const CONFIG = { a: 1 };`,
    'f.ts',
  );
  assert.equal(captures.length, 0);
});

test('does NOT flag imports or exported constants that are pure', () => {
  const { captures } = analyzeSource(
    `import { X } from 'y';
     export const DOUBLED = 2 * 2;`,
    'f.ts',
  );
  assert.equal(captures.length, 0);
});

test('flags export const with dynamic initializer', () => {
  const { captures } = analyzeSource(
    `export const nowUA = navigator.userAgent;`,
    'f.ts',
  );
  assert.equal(captures.length, 1);
});

test('destructured binding also flagged, name as "<destructured>"', () => {
  const { captures } = analyzeSource(
    `function getInfo() { return { cookie: document.cookie }; }
     const { cookie } = getInfo();`,
    'f.ts',
  );
  // (this test intentionally retains `cookie` since it's the destructured property name)
  assert.equal(captures.length, 1);
  assert.equal(captures[0].name, '<destructured>');
  assert.equal(captures[0].capturedKind, 'indirect-wrapper');
});

// ---------- analyzeProjects (integration, cross-file reader detection) ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-stale-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('integration: cross-file reader detection', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/detect.ts', `
    export function getAccountTier() {
      const m = document.cookie.match(/tier=([^;]+)/);
      return m ? m[1] : 'unknown';
    }
  `);
  write(a, 'src/render.ts', `
    import { getAccountTier } from './detect';
    const accountTier = getAccountTier();
    export function render() { return accountTier; }
  `);

  const result = analyzeProjects([a]);
  assert.equal(result.version, SCHEMA_VERSION);
  assert.equal(result.analyzer, ANALYZER_ID);
  assert.ok(result.meta.detectedReaders.includes('getAccountTier'));
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.kind, 'stale-module-capture');
  assert.equal(f.name, 'accountTier');
  assert.equal(f.capturedKind, 'indirect-wrapper');
  assert.equal(f.capturedVia, 'getAccountTier');
  assert.equal(f.occurrences[0].file, 'src/render.ts');
});

test('integration: multiple captures across multiple files', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/a.ts', `const cookie1 = document.cookie;`);
  write(a, 'src/b.ts', `const cookie2 = document.cookie;`);
  write(a, 'src/c.ts', `export function pure() { return 42; }
                        export const safe = 'literal';`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map(f => f.name).sort(),
    ['cookie1', 'cookie2'],
  );
});

test('integration: multi-project works', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/x.ts', `const ua = navigator.userAgent;`);

  const b = mktmp();
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/y.ts', `const cookie = document.cookie;`);

  const result = analyzeProjects([a, b]);
  assert.equal(result.findings.length, 2);
  const projects = result.findings.map(f => f.occurrences[0].project).sort();
  assert.deepEqual(projects, ['app-a', 'app-b']);
});

test('integration: skips node_modules and dist', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/real.ts', `const real = document.cookie;`);
  write(a, 'node_modules/pkg/dist/x.ts', `const noise = document.cookie;`);
  write(a, 'dist/bundle.ts', `const noise = document.cookie;`);

  const result = analyzeProjects([a]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].name, 'real');
});

test('integration: schema shape for a finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/x.ts', `const c = document.cookie;`);

  const result = analyzeProjects([a]);
  const f = result.findings[0];
  assert.equal(f.kind, 'stale-module-capture');
  assert.ok(typeof f.capturedVia === 'string');
  assert.ok(['direct-api', 'indirect-wrapper'].includes(f.capturedKind));
  const o = f.occurrences[0];
  assert.equal(o.project, 'app');
  assert.equal(typeof o.file, 'string');
  assert.ok(typeof o.line === 'number' && o.line > 0);
  assert.ok(typeof o.column === 'number' && o.column > 0);
  assert.ok(typeof o.snippet === 'string');
});
