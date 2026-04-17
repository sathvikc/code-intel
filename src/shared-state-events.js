// shared-state analyzer: event channels (window / globalThis CustomEvent)
//
// Detects cross-file (and cross-project) coupling through browser event APIs.
// File A dispatches `new CustomEvent('profile:changed')`; file B listens
// with `addEventListener('profile:changed', handler)`. No import links
// them; the channel name is the coupling key.
//
// Syntactic only (D5). Multi-project first-class (D1). Recall over precision
// (D2). Every occurrence carries `detectedVia` (D4).
//
// Output schema version: 0.1
// Finding kind: "shared-event-channel"

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'shared-state.events';

// Global hosts we recognize as the event target when methods are called on
// them directly. `window` and `globalThis` are the canonical cases; a bare
// method call like `dispatchEvent(...)` at top level is also global in a
// browser context, so we treat that as an implicit window dispatch.
const GLOBAL_HOSTS = new Set(['window', 'globalThis', 'self']);

// Event-target methods and their semantic ops.
const METHOD_OPS = {
  dispatchEvent: 'dispatch',
  addEventListener: 'listen',
  removeEventListener: 'unlisten',
};

/**
 * Determine if an expression refers to a global event target — either
 * `window` / `globalThis` / `self` as an identifier, or a bare implicit
 * global (e.g. `dispatchEvent(...)` at module scope). Returns the target
 * name or null. For bare implicit calls returns `"window"` as the
 * canonical host.
 */
function globalHostOf(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) && GLOBAL_HOSTS.has(node.text)) return node.text;
  return null;
}

/**
 * Extract the channel name from the first argument of an event method.
 * For `dispatchEvent(new CustomEvent('foo', {...}))` the first arg is a
 * NewExpression whose own first arg is the channel name.
 * For `addEventListener('foo', handler)` the first arg is the name directly.
 * Returns { name, dynamic, expressionText }.
 */
function extractChannelFromListenerArg(argNode, sourceFile) {
  if (!argNode) return { name: null, dynamic: true, expressionText: '' };
  return extractStringOrDynamic(argNode, sourceFile);
}

function extractChannelFromDispatchArg(argNode, sourceFile) {
  if (!argNode) return { name: null, dynamic: true, expressionText: '' };
  // `new CustomEvent('foo', …)` or `new Event('foo', …)`
  if (ts.isNewExpression(argNode)) {
    const ctor = argNode.expression;
    const ctorName =
      ts.isIdentifier(ctor) ? ctor.text :
      (ts.isPropertyAccessExpression(ctor) && ts.isIdentifier(ctor.name)) ? ctor.name.text :
      null;
    if (ctorName === 'CustomEvent' || ctorName === 'Event') {
      const nameArg = argNode.arguments?.[0];
      if (nameArg) return extractStringOrDynamic(nameArg, sourceFile);
      return { name: null, dynamic: true, expressionText: argNode.getText(sourceFile) };
    }
  }
  // Fallback: unknown dispatch argument (variable, already-constructed event, etc.)
  return { name: null, dynamic: true, expressionText: argNode.getText(sourceFile) };
}

function extractStringOrDynamic(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { name: node.text, dynamic: false, expressionText: node.text };
  }
  return { name: null, dynamic: true, expressionText: node.getText(sourceFile) };
}

/**
 * Parse a single file and return raw occurrences. Pure — no filesystem.
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

  function record(node, host, name, dynamic, expressionText, op, detectedVia) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);
    occurrences.push({
      host,
      name,
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
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // Case A: host.method(...) where host is window / globalThis / self
      if (ts.isPropertyAccessExpression(callee)) {
        const methodName = callee.name.text;
        const op = METHOD_OPS[methodName];
        if (op) {
          const host = globalHostOf(callee.expression);
          if (host) {
            const detectedVia = op === 'dispatch' ? 'custom-event' : 'event-listener';
            const { name, dynamic, expressionText } =
              op === 'dispatch'
                ? extractChannelFromDispatchArg(node.arguments[0], sourceFile)
                : extractChannelFromListenerArg(node.arguments[0], sourceFile);
            record(node, host, name, dynamic, expressionText, op, detectedVia);
          }
        }
      }

      // Case B: bare method call dispatchEvent(...) / addEventListener(...)
      // treated as implicit `window.*` per browser semantics. Only when the
      // callee is a plain Identifier with a known method name (not a property
      // access on some other object).
      if (ts.isIdentifier(callee)) {
        const op = METHOD_OPS[callee.text];
        if (op) {
          const detectedVia = op === 'dispatch' ? 'custom-event' : 'event-listener';
          const { name, dynamic, expressionText } =
            op === 'dispatch'
              ? extractChannelFromDispatchArg(node.arguments[0], sourceFile)
              : extractChannelFromListenerArg(node.arguments[0], sourceFile);
          record(node, 'window', name, dynamic, expressionText, op, detectedVia);
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
 * Grouping: static channel names merge across all projects and files;
 * dynamic occurrences stay per-site so they don't all collapse into one.
 * `host` does NOT split groups — `window.dispatchEvent('x')` in one file and
 * `globalThis.addEventListener('x')` in another refer to the same channel.
 */
export function analyzeProjects(projectRoots) {
  const projects = projectRoots.map(resolveProject);
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
        continue;
      }
      for (const occ of occurrences) {
        const rel = path.relative(project.root, absFile);
        const groupKey = occ.dynamic
          ? `__dynamic__::${project.id}::${rel}::${occ.line}::${occ.column}`
          : `channel::${occ.name}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            kind: 'shared-event-channel',
            channel: occ.name,
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
          host: occ.host,
          detectedVia: occ.detectedVia,
          snippet: occ.snippet,
        });
      }
    }
  }

  const findings = [...groups.values()].sort((a, b) => {
    if (a.channel === null && b.channel !== null) return 1;
    if (a.channel !== null && b.channel === null) return -1;
    if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
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
  const byOp = { dispatch: 0, listen: 0, unlisten: 0 };
  let crossProject = 0;
  let crossFile = 0;
  let dynamicCount = 0;
  for (const f of result.findings) {
    if (f.dynamic) { dynamicCount++; continue; }
    for (const o of f.occurrences) byOp[o.op] = (byOp[o.op] ?? 0) + 1;
    const projects = new Set(f.occurrences.map(o => o.project));
    const files = new Set(f.occurrences.map(o => `${o.project}::${o.file}`));
    if (projects.size > 1) crossProject++;
    else if (files.size > 1) crossFile++;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byOp,
    crossProject,
    crossFile,
    dynamic: dynamicCount,
  };
}
