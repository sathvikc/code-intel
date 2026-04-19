// shared-state analyzer: global-binding collisions.
//
// Detects two or more files defining the same name on the global object.
// The canonical production bug: two teams ship classic <script> files,
// each with an identically-named top-level helper function. Whichever
// loads later silently overwrites the earlier, breaking callers that
// expected the earlier behavior. No import graph, bundler, or linter
// sees this because it's cross-script coupling on `window`.
//
// Detection cases (syntactic, D5):
//   A. Explicit:   window.X = …, globalThis.X = …, self.X = …
//   B. Indexed:    window['X'] = …
//   C. Delete:     delete window.X
//   D. Classic-script top-level `function X()`     (only when file is NOT an ES module / CommonJS)
//   E. Classic-script top-level `var/const/let X`  (same condition)
//
// "Classic script" is detected syntactically: a file is treated as a classic
// script when it contains no ES import/export/export= and no CommonJS
// require/module.exports/exports.X assignment. This is an approximation
// (the real answer depends on how the file is loaded in HTML / tsconfig),
// but it's the best we can do purely from file contents. Per D2 we prefer
// recall: flag broadly, let the reviewer dismiss obvious false positives.
//
// Grouping: by binding name. A finding is emitted when ≥2 DISTINCT files
// share a name (that's the collision). Multiple occurrences in a single
// file — re-assignments, redeclarations, self-shadowing — are not a
// cross-bundle collision; they're just intra-file code. A name is only
// coupling once another file also touches it.
//
// Reads are not detected in v1. Telling "bare identifier read of a global"
// from "read of a local" requires scope analysis we don't do. Writes
// (declarations + assignments + deletes) are where the collision shows
// up; reads can be added later if needed.
//
// Output schema version: 0.1
// Finding kind: "shared-global-binding"

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'shared-state.globals';

const GLOBAL_HOSTS = new Set(['window', 'globalThis', 'self']);

// Known browser-API names we should NOT flag when assigned on
// window/globalThis. Users rarely reassign these; when they do, it's
// almost always polyfilling, which is its own category. Keep this list
// conservative: if in doubt, leave a name out (D2: prefer recall).
const BUILTIN_GLOBAL_PROPS = new Set([
  'location', 'document', 'navigator', 'history', 'screen', 'console',
  'localStorage', 'sessionStorage', 'indexedDB', 'cookieStore', 'caches',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight',
  'scrollTo', 'scrollBy', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset',
  'scroll', 'getComputedStyle', 'matchMedia',
  'alert', 'confirm', 'prompt',
  'crypto', 'performance',
  'top', 'parent', 'opener', 'frames', 'self', 'window', 'globalThis',
  'onerror', 'onload', 'onunload', 'onbeforeunload', 'onmessage',
]);

/**
 * Is the given source file module-scoped (ES module or CommonJS)? If yes,
 * top-level declarations are local; we only flag explicit window.X writes.
 * If no, it's a classic script and every top-level declaration is a global.
 */
export function fileIsModuleLike(sourceFile) {
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) return true;
    if (ts.isImportEqualsDeclaration(stmt)) return true;
    if (ts.isExportDeclaration(stmt)) return true;
    if (ts.isExportAssignment(stmt)) return true;
    const mods = (ts.getModifiers?.(stmt) ?? stmt.modifiers) || [];
    for (const m of mods) {
      if (m.kind === ts.SyntaxKind.ExportKeyword) return true;
    }
  }
  let hasCjs = false;
  function visit(node) {
    if (hasCjs) return;
    // require(...)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      hasCjs = true;
      return;
    }
    // module.exports = ... or exports.X = ...
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)) {
        if (left.expression.text === 'module' && ts.isIdentifier(left.name) && left.name.text === 'exports') {
          hasCjs = true;
          return;
        }
        if (left.expression.text === 'exports') {
          hasCjs = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return hasCjs;
}

/**
 * For `host.X` or `host['X']` where host is window/globalThis/self, return
 * the property name; otherwise null. Skips builtins on the host.
 */
function userGlobalName(accessExpr) {
  if (ts.isPropertyAccessExpression(accessExpr)) {
    if (!ts.isIdentifier(accessExpr.expression) || !GLOBAL_HOSTS.has(accessExpr.expression.text)) return null;
    if (!ts.isIdentifier(accessExpr.name)) return null;
    const name = accessExpr.name.text;
    if (BUILTIN_GLOBAL_PROPS.has(name)) return null;
    return { host: accessExpr.expression.text, name };
  }
  if (ts.isElementAccessExpression(accessExpr)) {
    if (!ts.isIdentifier(accessExpr.expression) || !GLOBAL_HOSTS.has(accessExpr.expression.text)) return null;
    const arg = accessExpr.argumentExpression;
    if (!arg) return null;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const name = arg.text;
      if (BUILTIN_GLOBAL_PROPS.has(name)) return null;
      return { host: accessExpr.expression.text, name };
    }
  }
  return null;
}

/**
 * Parse a single file and return its occurrences. Pure — no filesystem.
 */
export function analyzeSource(code, filePath) {
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const isModule = fileIsModuleLike(sf);
  const occurrences = [];

  function record(node, name, host, op, detectedVia) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const snippet = node.getText(sf).split('\n')[0].slice(0, 200);
    occurrences.push({
      name,
      host,
      op,
      detectedVia,
      isModuleLike: isModule,
      line: line + 1,
      column: character + 1,
      snippet,
    });
  }

  // Case D + E: classic-script top-level declarations (only if NOT module).
  if (!isModule) {
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) {
        record(stmt, stmt.name.text, 'global', 'declare', 'classic-script-function');
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            record(decl, decl.name.text, 'global', 'declare', 'classic-script-variable');
          }
        }
      } else if (ts.isClassDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) {
        record(stmt, stmt.name.text, 'global', 'declare', 'classic-script-class');
      }
    }
  }

  // Cases A/B/C: explicit window.X / globalThis.X / self.X writes and deletes,
  // anywhere in the file (module or not).
  function visit(node) {
    // Case C: delete host.X / host['X']
    if (ts.isDeleteExpression(node)) {
      const target = node.expression;
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const info = userGlobalName(target);
        if (info) {
          record(node, info.name, info.host, 'remove', 'delete');
        }
      }
    }
    // Case A/B: host.X = … or host['X'] = …
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const info = userGlobalName(left);
        if (info) {
          const detectedVia = ts.isPropertyAccessExpression(left) ? 'explicit-global' : 'explicit-global-indexed';
          record(node, info.name, info.host, 'assign', detectedVia);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return { isModule, occurrences };
}

function isAssignmentOperator(kind) {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
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
 * Run the analyzer across N project roots. Group occurrences by binding
 * name; emit findings for names with ≥2 occurrences (the collision case).
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const groups = new Map();

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      let code;
      try {
        code = fs.readFileSync(absFile, 'utf8');
      } catch {
        continue;
      }
      let result;
      try {
        result = analyzeSource(code, absFile);
      } catch {
        continue;
      }
      for (const occ of result.occurrences) {
        const rel = path.relative(project.root, absFile);
        if (!groups.has(occ.name)) {
          groups.set(occ.name, {
            kind: 'shared-global-binding',
            name: occ.name,
            occurrences: [],
          });
        }
        groups.get(occ.name).occurrences.push({
          project: project.id,
          file: rel,
          line: occ.line,
          column: occ.column,
          op: occ.op,
          host: occ.host,
          detectedVia: occ.detectedVia,
          isModuleLike: occ.isModuleLike,
          snippet: occ.snippet,
        });
      }
    }
  }

  // Only emit findings for names that cross ≥2 DISTINCT files — the
  // cross-bundle collision case. Multiple writes/declarations inside one
  // file are intra-file code, not coupling.
  const findings = [...groups.values()]
    .filter(f => {
      const files = new Set(f.occurrences.map(o => `${o.project}::${o.file}`));
      return files.size >= 2;
    })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

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
  const byOp = { declare: 0, assign: 0, remove: 0 };
  let crossProject = 0;
  let crossFile = 0;
  for (const f of result.findings) {
    for (const o of f.occurrences) byOp[o.op] = (byOp[o.op] ?? 0) + 1;
    const projectsSet = new Set(f.occurrences.map(o => o.project));
    const filesSet = new Set(f.occurrences.map(o => `${o.project}::${o.file}`));
    if (projectsSet.size > 1) crossProject++;
    else if (filesSet.size > 1) crossFile++;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byOp,
    crossProject,
    crossFile,
    dynamic: 0, // this analyzer has no dynamic case in v1
  };
}
