// shared-state analyzer: web-storage (localStorage / sessionStorage)
//
// Detects cross-file (and cross-project) coupling through Web Storage keys.
// Syntactic only — uses ts.createSourceFile, no type checker. Fast, zero-config.
//
// Multi-project is first-class: callers pass N project roots; findings are
// keyed by {project, file, line}. Grouping is by (storage, key) across all
// projects, so a key written in project A and read in project B surfaces as
// one finding with occurrences from both.
//
// Output schema version: 0.1

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { readSource, scriptKindFor } from './framework-file.js';
import { buildFoldMap, resolveStringArg } from './fold-string-literals.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'shared-state.web-storage';

const STORAGE_NAMES = new Set(['localStorage', 'sessionStorage']);
const METHOD_OPS = {
  setItem: 'write',
  getItem: 'read',
  removeItem: 'remove',
};

// Storage API members. Dot-access on these names is a method reference or a
// meta-property read (e.g. `localStorage.length`), not a user-defined key.
// See D6 in DESIGN_DECISIONS.md.
const STORAGE_API_MEMBERS = new Set([
  'setItem', 'getItem', 'removeItem', 'clear', 'key', 'length',
]);

// Framework-owned or language-internal storage keys that are not
// user-actionable couplings — the user did not choose them and cannot
// rename them. Findings on these keys are pure noise.
// Start small; grow incrementally per dogfood observation.
// Exported so a future config layer can extend or replace.
export const FRAMEWORK_STORAGE_KEYS = new Set([
  '__next',       // Next.js router hydration marker (sessionStorage)
  'NEXT_LOCALE',  // Next.js i18n locale persistence
  '__proto__',    // JS prototype slot — not a real storage key
]);

// SyntaxKinds of compound-assignment operators. Per D7, a compound assignment
// on a storage element access emits both a read and a write occurrence.
const COMPOUND_ASSIGNMENT_KINDS = new Set([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Determine if a node is `localStorage` / `sessionStorage`, possibly accessed
 * via `window.` or `globalThis.`. Returns the storage name or null.
 */
function storageNameOf(node) {
  if (ts.isIdentifier(node) && STORAGE_NAMES.has(node.text)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = node.expression;
    const right = node.name;
    if (!ts.isIdentifier(right) || !STORAGE_NAMES.has(right.text)) return null;
    if (ts.isIdentifier(left) && (left.text === 'window' || left.text === 'globalThis')) {
      return right.text;
    }
  }
  return null;
}

/**
 * Extract a key from a key-bearing node (method call arg or element-access
 * argumentExpression). Returns { key, dynamic, expressionText, foldedFrom,
 * foldedFromModule? }.
 *
 * Goes through the shared fold helper so that
 * `const K = 'app.session'; localStorage.setItem(K, …)` resolves to the
 * literal. When `crossFileResolver` is provided, imported constants
 * (`import { K } from './keys'; localStorage.setItem(K, …)`) also
 * resolve and carry `foldedFromModule` so consumers can see where the
 * binding came from. `foldedFrom` is null for inline literals.
 */
function extractKey(argNode, sourceFile, foldMap, crossFileResolver) {
  const { value, dynamic, expressionText, foldedFrom, foldedFromModule } = resolveStringArg(
    argNode,
    sourceFile,
    foldMap,
    crossFileResolver,
  );
  return { key: value, dynamic, expressionText, foldedFrom, foldedFromModule };
}

/**
 * Classify the operation(s) performed by a parent expression on a storage
 * element access or property access node. Returns an array of op strings
 * (typically one; two for compound assignments per D7).
 */
function classifyAccessOps(node) {
  const parent = node.parent;
  if (!parent) return ['read'];
  // `delete storage['k']` or `delete storage.k` → remove
  if (ts.isDeleteExpression(parent) && parent.expression === node) {
    return ['remove'];
  }
  // `storage['k'] = v` or `storage['k'] += v`; same for dot access
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const kind = parent.operatorToken.kind;
    if (kind === ts.SyntaxKind.EqualsToken) return ['write'];
    if (COMPOUND_ASSIGNMENT_KINDS.has(kind)) return ['read', 'write'];
  }
  return ['read'];
}

/**
 * Parse a single file and return raw occurrences.
 */
export function analyzeSource(code, filePath, preparsed, crossFileResolver) {
  const sourceFile = preparsed ?? ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const foldMap = buildFoldMap(sourceFile);
  const occurrences = [];

  function record(node, storage, key, dynamic, expressionText, op, detectedVia, foldedFrom, foldedFromModule) {
    // Skip framework-owned / language-internal keys (not user-actionable)
    if (!dynamic && key != null && FRAMEWORK_STORAGE_KEYS.has(key)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);
    const occ = {
      storage,
      key,
      dynamic,
      expressionText,
      op,
      detectedVia,
      foldedFrom: foldedFrom ?? null,
      line: line + 1,
      column: character + 1,
      snippet,
    };
    if (foldedFromModule) occ.foldedFromModule = foldedFromModule;
    occurrences.push(occ);
  }

  function visit(node) {
    // Pattern 1: method call — storage.setItem('k', v) / getItem / removeItem
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propAccess = node.expression;
      const methodName = propAccess.name.text;
      const op = METHOD_OPS[methodName];
      if (op) {
        const storage = storageNameOf(propAccess.expression);
        if (storage) {
          const { key, dynamic, expressionText, foldedFrom, foldedFromModule } = extractKey(node.arguments[0], sourceFile, foldMap, crossFileResolver);
          record(node, storage, key, dynamic, expressionText, op, 'method-call', foldedFrom, foldedFromModule);
          // Fall through and let the walker recurse. Pattern 3 will skip the
          // method name (it's in STORAGE_API_MEMBERS), so there's no double
          // counting, and argument-nested storage accesses are still visited.
        }
      }
    }

    // Pattern 2: element access — storage['k'] (any op via parent classification)
    if (ts.isElementAccessExpression(node)) {
      const storage = storageNameOf(node.expression);
      if (storage) {
        const { key, dynamic, expressionText, foldedFrom, foldedFromModule } = extractKey(node.argumentExpression, sourceFile, foldMap, crossFileResolver);
        const ops = classifyAccessOps(node);
        for (const op of ops) {
          record(node, storage, key, dynamic, expressionText, op, op === 'remove' ? 'delete' : 'indexed-access', foldedFrom, foldedFromModule);
        }
      }
    }

    // Pattern 3: property (dot) access — storage.customKey
    // Only when the name is NOT a Storage API member; otherwise it's a method
    // reference or meta-property read, not a user-defined key. Also skip when
    // this PropertyAccess is the callee of a CallExpression (already handled
    // by pattern 1) or is itself referring to a storage global (e.g.
    // `window.localStorage` — that's resolved by storageNameOf elsewhere).
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const keyName = node.name.text;
      const parent = node.parent;
      const isCalleeOfCall = parent && ts.isCallExpression(parent) && parent.expression === node;
      if (!isCalleeOfCall && !STORAGE_API_MEMBERS.has(keyName)) {
        const storage = storageNameOf(node.expression);
        if (storage) {
          const ops = classifyAccessOps(node);
          for (const op of ops) {
            record(node, storage, keyName, false, keyName, op, op === 'remove' ? 'delete' : 'property-access', null, null);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return occurrences;
}

/**
 * Run the analyzer across N project roots and return the schema-shaped result.
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const includeBuildArtifacts = opts.includeBuildArtifacts;
  const includeTestContext = opts.includeTestContext;
  const astCache = opts.astCache;
  const crossFileResolver = opts.crossFileResolver;
  // group key: storage + '::' + (key ?? `__dynamic__::${project}::${file}::${line}`)
  // static keys are grouped across projects; dynamic occurrences stay per-site.
  const groups = new Map();

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude, includeBuildArtifacts, includeTestContext })) {
      let code;
      let preparsed;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) continue;
        code = cached.code;
        preparsed = cached.sourceFile;
      } else {
        try {
          code = readSource(absFile);
        } catch {
          continue;
        }
      }
      let occurrences;
      try {
        occurrences = analyzeSource(code, absFile, preparsed, crossFileResolver);
      } catch {
        continue; // graceful: parse failure → skip file
      }
      for (const occ of occurrences) {
        const rel = path.relative(project.root, absFile);
        const groupKey = occ.dynamic
          ? `${occ.storage}::__dynamic__::${project.id}::${rel}::${occ.line}::${occ.column}`
          : `${occ.storage}::${occ.key}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            kind: 'shared-storage-key',
            storage: occ.storage,
            key: occ.key,
            dynamic: occ.dynamic,
            expression: occ.dynamic ? occ.expressionText : undefined,
            occurrences: [],
          });
        }
        const pushed = {
          project: project.id,
          file: rel,
          line: occ.line,
          column: occ.column,
          op: occ.op,
          detectedVia: occ.detectedVia,
          snippet: occ.snippet,
        };
        if (occ.foldedFrom) pushed.foldedFrom = occ.foldedFrom;
        if (occ.foldedFromModule) pushed.foldedFromModule = occ.foldedFromModule;
        groups.get(groupKey).occurrences.push(pushed);
      }
    }
  }

  const findings = [...groups.values()]
    // deterministic order: storage, then key (nulls last), then first occurrence location
    .sort((a, b) => {
      if (a.storage !== b.storage) return a.storage < b.storage ? -1 : 1;
      if (a.key === null && b.key !== null) return 1;
      if (a.key !== null && b.key === null) return -1;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return 0;
    });

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map(p => ({ id: p.id, root: p.root })),
    findings,
  };
}

/**
 * Summarize a result for human display (stderr).
 */
export function summarize(result) {
  const byStorage = { localStorage: 0, sessionStorage: 0 };
  let crossProject = 0;
  let crossFile = 0;
  let dynamicCount = 0;
  for (const f of result.findings) {
    byStorage[f.storage] = (byStorage[f.storage] ?? 0) + 1;
    if (f.dynamic) { dynamicCount++; continue; }
    const projects = new Set(f.occurrences.map(o => o.project));
    const files = new Set(f.occurrences.map(o => `${o.project}::${o.file}`));
    if (projects.size > 1) crossProject++;
    else if (files.size > 1) crossFile++;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byStorage,
    crossProject,
    crossFile,
    dynamic: dynamicCount,
  };
}
