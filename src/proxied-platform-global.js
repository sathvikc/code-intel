// proxied-platform-global analyzer.
//
// Detects assignments of the shape `<host>.<platformProp> = new Proxy(...)`
// where <host> is a browser-environment root (window, globalThis, self) and
// <platformProp> names a built-in browser global from the v1 catalogue.
//
// The canonical production bug (P8): a third-party library that later attaches
// a property to a proxied platform global can silently lose its write if the
// Proxy's `set` trap does not forward via Reflect.set. The static fact is
// unambiguous; the runtime implication (does the handler swallow third-party
// writes?) is D5-rejected for static analysis. Emit the fact; the reviewer
// judges transparency.
//
// Detection rule:
//   - BinaryExpression with EqualsToken operator.
//   - Left: PropertyAccessExpression where expression is an Identifier in
//     HOSTS and name is an Identifier in PLATFORM_PROPS.
//   - Right: NewExpression whose callee is the bare identifier 'Proxy'.
//
// No cross-file threshold — a single install IS the bug surface. Per D2,
// recall-first: flag every install; let the reviewer dismiss transparent ones.
//
// Output schema version: 0.1
// Finding kind: "proxied-platform-global"

import ts from 'typescript';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { readSource, scriptKindFor } from './framework-file.js';

export const ANALYZER_ID = 'proxied-platform-global';
export const SCHEMA_VERSION = '0.1';

// Hosts: identifiers that name the browser-environment root.
const HOSTS = new Set(['window', 'globalThis', 'self']);

// Platform properties: built-in browser globals that third-party
// libraries plausibly decorate. Adding a name here is purely additive
// (one-line edit + one regression test). See D22 for the rationale.
const PLATFORM_PROPS = new Set([
  // History / navigation
  'history',
  'location',
  // Network
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  // Storage
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  // Document / DOM
  'document',
  // Logging / observability
  'console',
  // Crypto / perf / capability
  'crypto',
  'performance',
  'navigator',
  // Notifications
  'Notification',
]);

export { PLATFORM_PROPS, HOSTS };

function isProxyNew(node) {
  return (
    ts.isNewExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'Proxy'
  );
}

/**
 * If node is a Proxy-install assignment on a catalogued (host, property),
 * return { host, property }; otherwise return null.
 */
function matchProxyInstall(node) {
  if (!ts.isBinaryExpression(node)) return null;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const lhs = node.left;
  if (!ts.isPropertyAccessExpression(lhs)) return null;
  if (!ts.isIdentifier(lhs.expression)) return null;
  if (!HOSTS.has(lhs.expression.text)) return null;
  if (!ts.isIdentifier(lhs.name)) return null;
  if (!PLATFORM_PROPS.has(lhs.name.text)) return null;
  if (!isProxyNew(node.right)) return null;
  return { host: lhs.expression.text, property: lhs.name.text };
}

/**
 * Walk a source file and return all Proxy-install occurrences found.
 * Pure — no filesystem access.
 */
function detectInFile(absFile, sourceFile, projectId, projectRoot) {
  const occurrences = [];
  function visit(node) {
    const m = matchProxyInstall(node);
    if (m) {
      const start = node.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const text = node.getText(sourceFile);
      const snippet = text.length > 200 ? text.slice(0, 200) + '…' : text;
      occurrences.push({
        host: m.host,
        property: m.property,
        project: projectId,
        file: path.relative(projectRoot, absFile),
        line: line + 1,
        column: character + 1,
        op: 'install',
        snippet,
      });
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return occurrences;
}

/**
 * Run the analyzer across N project roots. Group occurrences by (host, property)
 * across all projects. Emit one finding per group — no cross-file threshold.
 *
 * @param {string[]} projectRoots
 * @param {object}   [opts]
 * @param {string[]} [opts.exclude]
 * @param {boolean}  [opts.includeBuildArtifacts]
 * @param {boolean}  [opts.includeTestContext]
 * @param {object}   [opts.astCache]          when present, astCache.get(absFile)
 *                                            returns { code, sourceFile } | null
 * @param {*}        [opts.crossFileResolver] accepted and ignored in v1
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const includeBuildArtifacts = opts.includeBuildArtifacts;
  const includeTestContext = opts.includeTestContext;
  const astCache = opts.astCache;

  const allOccurrences = [];
  let fileCount = 0;
  let errorCount = 0;

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, {
      exclude,
      includeBuildArtifacts,
      includeTestContext,
    })) {
      fileCount++;
      let sourceFile;
      if (astCache) {
        // astCache.get returns { code, sourceFile } or null.
        // Lift verbatim from src/shared-state-globals.js lines ~241–252.
        const cached = astCache.get(absFile);
        if (!cached) continue;
        sourceFile = cached.sourceFile;
      } else {
        let code;
        try {
          code = readSource(absFile);
        } catch {
          errorCount++;
          continue;
        }
        try {
          sourceFile = ts.createSourceFile(
            absFile,
            code,
            ts.ScriptTarget.Latest,
            true,
            scriptKindFor(absFile),
          );
        } catch {
          errorCount++;
          continue;
        }
      }
      try {
        allOccurrences.push(...detectInFile(absFile, sourceFile, project.id, project.root));
      } catch {
        errorCount++;
      }
    }
  }

  // Group across projects by (host, property). One finding per group.
  // Per-occurrence project field carries the project identity (mirrors
  // src/shared-state-globals.js lines ~261–278 grouping by name across projects).
  const groups = new Map();
  for (const occ of allOccurrences) {
    const key = `${occ.host}.${occ.property}`;
    if (!groups.has(key)) {
      groups.set(key, { host: occ.host, property: occ.property, occurrences: [] });
    }
    groups.get(key).occurrences.push({
      project: occ.project,
      file: occ.file,
      line: occ.line,
      column: occ.column,
      op: occ.op,
      snippet: occ.snippet,
    });
  }

  const findings = [...groups.values()]
    .map((g) => ({
      kind: ANALYZER_ID,
      host: g.host,
      property: g.property,
      occurrences: g.occurrences.sort(
        (a, b) =>
          a.project.localeCompare(b.project)
          || a.file.localeCompare(b.file)
          || a.line - b.line
          || a.column - b.column,
      ),
    }))
    .sort(
      (a, b) =>
        a.host.localeCompare(b.host) || a.property.localeCompare(b.property),
    );

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map((p) => p.id),
    findings,
    meta: { fileCount, errorCount, projectCount: projects.length },
  };
}

/**
 * Summarize a result for human display (stderr).
 */
export function summarize(result) {
  const byProperty = {};
  const byHost = {};
  for (const f of result.findings) {
    byProperty[f.property] = (byProperty[f.property] ?? 0) + 1;
    byHost[f.host] = (byHost[f.host] ?? 0) + 1;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byProperty,
    byHost,
  };
}
