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

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.turbo', '.cache',
]);

/**
 * Resolve a project descriptor from a root path.
 * Project id = package.json `name` if present, else directory basename.
 */
export function resolveProject(root) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Project root is not a directory: ${abs}`);
  }
  const pkgPath = path.join(abs, 'package.json');
  let id = path.basename(abs);
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0) id = pkg.name;
    } catch {
      // graceful degradation: bad package.json → fall back to basename
    }
  }
  return { id, root: abs };
}

/**
 * Walk a directory and yield absolute paths to source files we should parse.
 */
export function* walkSourceFiles(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // graceful: unreadable dir → skip
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        // allow hidden source roots only if explicitly listed; default skip
        if (IGNORED_DIRS.has(e.name)) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (SOURCE_EXTENSIONS.has(path.extname(e.name))) yield full;
      }
    }
  }
}

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
 * argumentExpression). Returns { key, dynamic, expressionText }.
 */
function extractKey(argNode, sourceFile) {
  if (!argNode) return { key: null, dynamic: true, expressionText: '' };
  if (ts.isStringLiteral(argNode) || ts.isNoSubstitutionTemplateLiteral(argNode)) {
    return { key: argNode.text, dynamic: false, expressionText: argNode.text };
  }
  const text = argNode.getText(sourceFile);
  return { key: null, dynamic: true, expressionText: text };
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
export function analyzeSource(code, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const occurrences = [];

  function record(node, storage, key, dynamic, expressionText, op, detectedVia) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);
    occurrences.push({
      storage,
      key,
      dynamic,
      expressionText,
      op,
      detectedVia,
      line: line + 1,
      column: character + 1,
      snippet,
    });
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
          const { key, dynamic, expressionText } = extractKey(node.arguments[0], sourceFile);
          record(node, storage, key, dynamic, expressionText, op, 'method-call');
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
        const { key, dynamic, expressionText } = extractKey(node.argumentExpression, sourceFile);
        const ops = classifyAccessOps(node);
        for (const op of ops) {
          record(node, storage, key, dynamic, expressionText, op, op === 'remove' ? 'delete' : 'indexed-access');
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
            record(node, storage, keyName, false, keyName, op, op === 'remove' ? 'delete' : 'property-access');
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return occurrences;
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
 * Run the analyzer across N project roots and return the schema-shaped result.
 */
export function analyzeProjects(projectRoots) {
  const projects = projectRoots.map(resolveProject);
  // group key: storage + '::' + (key ?? `__dynamic__::${project}::${file}::${line}`)
  // static keys are grouped across projects; dynamic occurrences stay per-site.
  const groups = new Map();

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root)) {
      let code;
      try {
        code = fs.readFileSync(absFile, 'utf8');
      } catch {
        continue;
      }
      let occurrences;
      try {
        occurrences = analyzeSource(code, absFile);
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
        groups.get(groupKey).occurrences.push({
          project: project.id,
          file: rel,
          line: occ.line,
          column: occ.column,
          op: occ.op,
          detectedVia: occ.detectedVia,
          snippet: occ.snippet,
        });
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
