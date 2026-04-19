// paired-keys analyzer: co-located storage-setItem clusters (P10).
//
// Detects the "write-these-keys-together-or-break-the-cache" pattern.
// Canonical shape:
//
//   function cacheFlags(v) {
//     sessionStorage.setItem('flags', JSON.stringify(v));
//     sessionStorage.setItem('flags-ts', String(Date.now()));
//   }
//
// The two keys are a pair by convention — readers decide freshness by
// comparing `flags-ts` to a TTL. Any writer elsewhere that touches `flags`
// without also touching `flags-ts` silently breaks the invariant: readers
// see the old timestamp, assume the cache is fresh, and serve stale data.
// The language has no way to express "these keys travel together"; the
// intent lives in the function body where both `setItem` calls appear
// back-to-back. Detecting that cluster makes the invariant visible.
//
// v1 definition — emit one `paired-keys` finding per cluster, where a
// cluster is:
//
//   - inside a single function-like body (FunctionDeclaration,
//     FunctionExpression, ArrowFunction, MethodDeclaration, accessors,
//     constructors);
//   - ≥2 literal-key `setItem` calls on the same storage (localStorage
//     or sessionStorage) — dynamic/computed keys are skipped;
//   - with distinct keys (same key twice is a reassignment, not a pair);
//   - co-located: consecutive literal-key setItems within ≤5 statements
//     of each other join the same cluster (greedy).
//
// Out of v1 (recall gaps logged in OPEN_QUESTIONS as part of the general
// static-analysis constraint — we ship the slice per D2 and iterate):
//
//   - Top-level (module-scope) paired writes — clustering is function-
//     body only for now. Most real cases we've seen live inside a cache /
//     setter / persist function, so the v1 catches the paired-key cache shape.
//   - "Other writer touches only one key of a known pair" (the cross-
//     cluster lead mentioned in P10). Requires a second pass over all
//     files after clusters are collected. Worth adding once we have real
//     dogfood feedback on the intra-cluster finding.
//   - Wrapper modules (`storage.set('k', v)` where `set` is a helper)
//     — same Q2 constraint as every other storage analyzer.
//   - Cookie / URL param / CustomEvent detail shapes — paired-keys is
//     storage-specific in v1. `shape-drift` (P9) will address the more
//     general shape-contract case.
//
// Output schema version: 0.1
// Finding kind: "paired-keys"

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { buildFoldMap, resolveStringArg } from './fold-string-literals.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'paired-keys';

const STORAGE_NAMES = new Set(['localStorage', 'sessionStorage']);

// Maximum statement-gap within which two literal-key setItems still count
// as co-located. Chosen to be generous enough to absorb an intervening
// `const ts = Date.now()` or a guard `if (!v) return;`, yet tight enough
// to reject "this function also writes another key 40 lines down in an
// unrelated branch."
const WINDOW_STATEMENTS = 5;

/**
 * Is `node` a function-like construct whose body defines a fresh
 * clustering scope? Top-level statements belong to the module scope,
 * which v1 does not cluster (see module-header notes).
 */
function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
  );
}

/**
 * Resolve `storage` in `storage.setItem(...)` to a known storage name,
 * handling the `window.localStorage` / `globalThis.sessionStorage` forms.
 */
function storageNameOf(node) {
  if (ts.isIdentifier(node) && STORAGE_NAMES.has(node.text)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const host = node.expression;
    const name = node.name;
    if (!ts.isIdentifier(name) || !STORAGE_NAMES.has(name.text)) return null;
    if (ts.isIdentifier(host) && (host.text === 'window' || host.text === 'globalThis')) {
      return name.text;
    }
  }
  return null;
}

/**
 * Scan a statement (or any node) for `storage.setItem(literal, …)` call
 * sites. Does NOT descend into function-like bodies — their calls
 * execute when the function is invoked, not as part of the outer scope,
 * so they must never merge into the outer cluster. This applies at ALL
 * levels including the root: if the caller passes a nested function
 * declaration (e.g. as a statement of the outer function's body), the
 * walker returns zero hits for it.
 */
function findLiteralSetItems(rootNode, sourceFile, foldMap) {
  const results = [];
  function visit(node) {
    if (isFunctionLike(node)) return;

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propAccess = node.expression;
      if (ts.isIdentifier(propAccess.name) && propAccess.name.text === 'setItem') {
        const storage = storageNameOf(propAccess.expression);
        if (storage) {
          // Accept inline string literals AND same-file folded constants.
          // A paired-key cluster is about the KEY contract, not about
          // whether the author typed the literal at the call site.
          const resolved = resolveStringArg(node.arguments[0], sourceFile, foldMap);
          if (!resolved.dynamic && resolved.value !== null) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const snippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);
            results.push({
              storage,
              key: resolved.value,
              foldedFrom: resolved.foldedFrom,
              line: line + 1,
              column: character + 1,
              snippet,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(rootNode);
  return results;
}

/**
 * Apply the clustering rule to a list of per-statement setItem hits, in
 * statement order. Returns zero or more clusters, each a list of hits
 * with ≥2 distinct keys on the same storage, gaps ≤ WINDOW_STATEMENTS.
 */
function clusterize(perStatementHits) {
  const clusters = [];
  let current = null;

  function maybeEmit() {
    if (!current) return;
    if (current.length >= 2) {
      const distinct = new Set(current.map((h) => h.key));
      if (distinct.size >= 2) clusters.push(current);
    }
    current = null;
  }

  for (const { stmtIdx, hits } of perStatementHits) {
    for (const hit of hits) {
      if (!current) {
        current = [{ ...hit, stmtIdx }];
        continue;
      }
      const prev = current[current.length - 1];
      const sameStorage = prev.storage === hit.storage;
      const withinWindow = stmtIdx - prev.stmtIdx <= WINDOW_STATEMENTS;
      if (sameStorage && withinWindow) {
        current.push({ ...hit, stmtIdx });
      } else {
        maybeEmit();
        current = [{ ...hit, stmtIdx }];
      }
    }
  }
  maybeEmit();
  return clusters;
}

/**
 * Collect all clusters found inside a single source file. Each cluster
 * is returned in the shape emitted by analyzeProjects (minus project /
 * file fields, which are attached by the caller).
 */
export function analyzeSource(code, filePath, preparsed) {
  const sf = preparsed ?? ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const foldMap = buildFoldMap(sf);
  const clusters = [];

  function processBody(block) {
    if (!block || !ts.isBlock(block)) return;
    const perStatement = block.statements.map((stmt, stmtIdx) => ({
      stmtIdx,
      hits: findLiteralSetItems(stmt, sf, foldMap),
    }));
    for (const cluster of clusterize(perStatement)) {
      // De-dupe keys preserving first-seen order.
      const seen = new Set();
      const keys = [];
      for (const h of cluster) {
        if (!seen.has(h.key)) {
          seen.add(h.key);
          keys.push(h.key);
        }
      }
      clusters.push({
        storage: cluster[0].storage,
        keys,
        occurrences: cluster.map((h) => {
          const occ = {
            key: h.key,
            line: h.line,
            column: h.column,
            snippet: h.snippet,
          };
          if (h.foldedFrom) occ.foldedFrom = h.foldedFrom;
          return occ;
        }),
      });
    }
  }

  function visit(node) {
    if (isFunctionLike(node) && node.body) {
      processBody(node.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return clusters;
}

function scriptKindFor(filePath) {
  switch (path.extname(filePath)) {
    case '.ts': return ts.ScriptKind.TS;
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.mjs':
    case '.cjs':
    case '.js': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.Unknown;
  }
}

/**
 * Run the analyzer across N project roots.
 *
 * A cluster is intra-function by construction, so each finding's
 * occurrences all share the same project and file. Unlike `shared-state`,
 * paired-keys findings are NOT grouped across files — two different
 * functions that happen to write the same pair of keys produce two
 * findings, because the invariant lives per-function.
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const astCache = opts.astCache;
  const findings = [];

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      let code;
      let preparsed;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) continue;
        code = cached.code;
        preparsed = cached.sourceFile;
      } else {
        try {
          code = fs.readFileSync(absFile, 'utf8');
        } catch {
          continue;
        }
      }
      let clusters;
      try {
        clusters = analyzeSource(code, absFile, preparsed);
      } catch {
        continue; // graceful parse-failure skip
      }
      const rel = path.relative(project.root, absFile);
      for (const cluster of clusters) {
        findings.push({
          kind: 'paired-keys',
          storage: cluster.storage,
          keys: cluster.keys,
          occurrences: cluster.occurrences.map((o) => ({
            project: project.id,
            file: rel,
            line: o.line,
            column: o.column,
            key: o.key,
            op: 'write',
            detectedVia: 'paired-setItem-cluster',
            snippet: o.snippet,
          })),
        });
      }
    }
  }

  // Deterministic order: storage, then comma-joined keys, then first line.
  findings.sort((a, b) => {
    if (a.storage !== b.storage) return a.storage < b.storage ? -1 : 1;
    const ka = a.keys.join(',');
    const kb = b.keys.join(',');
    if (ka !== kb) return ka < kb ? -1 : 1;
    const la = a.occurrences[0]?.line ?? 0;
    const lb = b.occurrences[0]?.line ?? 0;
    return la - lb;
  });

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map((p) => ({ id: p.id, root: p.root })),
    findings,
  };
}

/**
 * Summarize a result for human display (stderr).
 */
export function summarize(result) {
  const byStorage = { localStorage: 0, sessionStorage: 0 };
  let totalKeys = 0;
  let maxKeys = 0;
  for (const f of result.findings) {
    byStorage[f.storage] = (byStorage[f.storage] ?? 0) + 1;
    totalKeys += f.keys.length;
    if (f.keys.length > maxKeys) maxKeys = f.keys.length;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byStorage,
    totalKeys,
    maxKeys,
  };
}
