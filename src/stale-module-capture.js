// Analyzer for stale captures of dynamic sources at module scope.
//
// Bug pattern (real, seen in production):
//
//   const accountTier = getAccountTier();  // module scope
//   export function render() {
//     // accountTier is frozen at module load — cookie flips mid-session
//     // don't update it. Silent staleness.
//   }
//
// Detection strategy (two-pass, heuristic, D2 recall-first):
//
//   Pass 1 — auto-detect "reader" functions:
//     Walk every source file's top-level function and arrow-function
//     declarations. If the body references a known dynamic base API
//     (document.cookie, sessionStorage.getItem, navigator.*, fetch(), …),
//     the function's name is registered as a reader. This works
//     cross-file: a reader defined in detect.ts is known when we scan
//     render.ts.
//
//   Pass 2 — find captures:
//     For every top-level VariableStatement, if the initializer expression
//     tree contains either:
//       (a) a direct dynamic base API, or
//       (b) a call to a known reader by name,
//     flag as a stale-module-capture finding.
//
// What we skip (logged, not silently):
//   - Destructuring bindings still flagged, bound name is recorded as
//     "<destructured>" — reviewer can see the snippet.
//   - Initializers that are themselves function literals (arrow / function
//     expressions): they're NOT evaluated at module load, they ARE the
//     reader definitions. Skipped.
//   - Cross-file reader detection by name only (no scope analysis).
//     Means if two unrelated files both define a function named `X`,
//     where one is a reader and the other is not, a capture call to `X`
//     anywhere is flagged. Per D2, acceptable — reviewer dismisses.
//   - `await` captures at top level (top-level-await pattern). Worth
//     revisiting when we see a real case.
//
// Output schema version: 0.1
// Finding kind: "stale-module-capture"

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { readSource, scriptKindFor } from './framework-file.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'stale-module-capture';

// Direct dynamic call patterns: `host.method(...)` strings.
const DYNAMIC_CALL_METHODS = new Set([
  'document.getElementById',
  'document.querySelector',
  'document.querySelectorAll',
  'document.getElementsByClassName',
  'document.getElementsByTagName',
  'document.getElementsByName',
  'document.createElement',
  'sessionStorage.getItem',
  'localStorage.getItem',
  'window.getComputedStyle',
  'window.matchMedia',
]);

// Direct dynamic bare-function calls: identifiers that are call-shaped.
const DYNAMIC_CALL_NAMES = new Set(['fetch']);

// Direct dynamic property reads: `host.prop` strings.
const DYNAMIC_PROPERTY_READS = new Set([
  'document.cookie',
  'document.referrer',
  'document.URL',
  'document.title',
  'document.body',
  'document.head',
  'document.activeElement',
  'window.location',
  'window.innerWidth',
  'window.innerHeight',
  'window.outerWidth',
  'window.outerHeight',
  'window.scrollX',
  'window.scrollY',
  'window.pageXOffset',
  'window.pageYOffset',
]);

// Hosts whose ANY property read is dynamic.
const DYNAMIC_HOST_READS = new Set(['navigator']);

/**
 * Is the given node itself a dynamic source expression?
 * - Call to a known dynamic API
 * - Property read of a known dynamic identifier
 */
function isDynamicSource(node) {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && DYNAMIC_CALL_NAMES.has(callee.text)) return true;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
      const full = `${callee.expression.text}.${callee.name.text}`;
      if (DYNAMIC_CALL_METHODS.has(full)) return true;
    }
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isIdentifier(node.name)) {
    const full = `${node.expression.text}.${node.name.text}`;
    if (DYNAMIC_PROPERTY_READS.has(full)) return true;
    if (DYNAMIC_HOST_READS.has(node.expression.text)) return true;
  }
  return false;
}

/** Return a short human-readable label for a dynamic source node. */
function summarizeSource(node) {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return `${callee.text}()`;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
      return `${callee.expression.text}.${callee.name.text}()`;
    }
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isIdentifier(node.name)) {
    return `${node.expression.text}.${node.name.text}`;
  }
  return '<dynamic>';
}

/**
 * Walk a function/arrow body (or any subtree) and return true if any
 * descendant expression is a dynamic source.
 */
function subtreeTouchesDynamicSource(root) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (isDynamicSource(node)) { found = true; return; }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

/**
 * Pass 1: return the set of top-level function names in this file whose
 * body touches a dynamic source. These are the "readers".
 */
export function extractReaders(sourceFile) {
  const readers = new Set();
  for (const stmt of sourceFile.statements) {
    // function X() { ... } or export function X() { ... }
    if (ts.isFunctionDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name) && stmt.body) {
      if (subtreeTouchesDynamicSource(stmt.body)) readers.add(stmt.name.text);
      continue;
    }
    // const/let/var X = () => ... | function() {...}
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) {
          if (subtreeTouchesDynamicSource(init.body)) readers.add(decl.name.text);
        }
      }
    }
  }
  return readers;
}

/**
 * Pass 2: return the list of stale-capture sites in this file, given the
 * reader name set collected from pass 1 (across all files).
 */
export function findCaptures(sourceFile, readerNames) {
  const captures = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      const init = decl.initializer;
      // Skip function literals — they ARE the reader definitions, not captures.
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) continue;

      const reason = captureReason(init, readerNames);
      if (!reason) continue;

      const bindingName = ts.isIdentifier(decl.name) ? decl.name.text : '<destructured>';
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile));
      captures.push({
        name: bindingName,
        capturedVia: reason.via,
        capturedKind: reason.kind,
        line: line + 1,
        column: character + 1,
        snippet: stmt.getText(sourceFile).split('\n')[0].slice(0, 200),
      });
    }
  }
  return captures;
}

function captureReason(init, readerNames) {
  let reason = null;
  function visit(node) {
    if (reason) return;
    if (isDynamicSource(node)) {
      reason = { kind: 'direct-api', via: summarizeSource(node) };
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && readerNames.has(node.expression.text)) {
      reason = { kind: 'indirect-wrapper', via: node.expression.text };
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(init);
  return reason;
}

/**
 * Parse a single file. Returns the source file plus raw readers/captures
 * for testing. Note: captures found here only know about readers from
 * THIS file; the full reader set is computed cross-file in analyzeProjects.
 */
export function analyzeSource(code, filePath, preparsed) {
  const sf = preparsed ?? ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const readers = extractReaders(sf);
  const captures = findCaptures(sf, readers);
  return { readers: [...readers], captures };
}

/**
 * Run the analyzer across N project roots. Two-pass: collect all readers
 * across all files first, then scan for captures with the full reader set.
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const astCache = opts.astCache;

  const readerNames = new Set();
  const parsed = [];

  // Pass 1: parse every file, collect reader names.
  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      let sf;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) continue;
        sf = cached.sourceFile;
      } else {
        let code;
        try { code = readSource(absFile); } catch { continue; }
        try {
          sf = ts.createSourceFile(absFile, code, ts.ScriptTarget.Latest, true, scriptKindFor(absFile));
        } catch { continue; }
      }
      parsed.push({ project, absFile, sf });
      for (const name of extractReaders(sf)) readerNames.add(name);
    }
  }

  // Pass 2: find captures using the full reader set.
  const findings = [];
  for (const { project, absFile, sf } of parsed) {
    const captures = findCaptures(sf, readerNames);
    for (const c of captures) {
      const rel = path.relative(project.root, absFile);
      findings.push({
        kind: 'stale-module-capture',
        name: c.name,
        capturedVia: c.capturedVia,
        capturedKind: c.capturedKind,
        occurrences: [{
          project: project.id,
          file: rel,
          line: c.line,
          column: c.column,
          snippet: c.snippet,
        }],
      });
    }
  }

  // Stable sort by project / file / line for deterministic output.
  findings.sort((a, b) => {
    const ao = a.occurrences[0], bo = b.occurrences[0];
    if (ao.project !== bo.project) return ao.project < bo.project ? -1 : 1;
    if (ao.file !== bo.file) return ao.file < bo.file ? -1 : 1;
    return ao.line - bo.line;
  });

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map(p => ({ id: p.id, root: p.root })),
    findings,
    meta: {
      detectedReaders: [...readerNames].sort(),
    },
  };
}

/**
 * Summarize a result for human display (stderr).
 */
export function summarize(result) {
  const byKind = { 'direct-api': 0, 'indirect-wrapper': 0 };
  for (const f of result.findings) {
    byKind[f.capturedKind] = (byKind[f.capturedKind] ?? 0) + 1;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byCapturedKind: byKind,
    detectedReaders: result.meta?.detectedReaders?.length ?? 0,
  };
}
