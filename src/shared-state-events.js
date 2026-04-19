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
// Native DOM event suppression: if a channel name is a known native browser
// event (`resize`, `scroll`, `click`, `popstate`, `message`, …) AND every
// occurrence on it is a listener (no `dispatch`), the finding is dropped
// as noise — it's just browser event wire-up, not cross-file coupling.
// A dispatch on a native-named channel is kept (synthesizing a native
// event IS a coupling signal: file A triggers, file B listens).
//
// Output schema version: 0.1
// Finding kind: "shared-event-channel"

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { buildFoldMap, resolveStringArg } from './fold-string-literals.js';

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

// Known native DOM events. A channel whose name matches one of these AND
// has no `dispatch` occurrence in scan is suppressed — two files listening
// to `'resize'` is not coupling, it's two independent window-event
// handlers. Kept conservative: if a name is ambiguous, it's left off the
// list so the finding surfaces (recall-first, D2).
export const NATIVE_DOM_EVENTS = new Set([
  // Lifecycle / navigation
  'load', 'DOMContentLoaded', 'beforeunload', 'unload',
  'pageshow', 'pagehide', 'visibilitychange',
  'popstate', 'hashchange',
  // Network / storage / postMessage
  'online', 'offline', 'message', 'storage',
  // Viewport / layout
  'resize', 'scroll',
  // Focus
  'focus', 'blur',
  // Pointer / mouse
  'click', 'dblclick', 'contextmenu',
  'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'wheel',
  // Keyboard
  'keydown', 'keyup', 'keypress',
  // Touch
  'touchstart', 'touchend', 'touchmove', 'touchcancel',
  // Form
  'submit', 'change', 'input', 'reset', 'invalid',
  // Clipboard / drag
  'copy', 'cut', 'paste',
  'dragstart', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
  // Media
  'play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'canplay', 'seeked',
  // Animation / transition
  'animationstart', 'animationend', 'animationiteration',
  'transitionstart', 'transitionend', 'transitionrun', 'transitioncancel',
]);

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
 * Returns { name, dynamic, expressionText, foldedFrom }.
 *
 * Goes through the same-file fold helper so `const CH = 'profile:changed';
 * window.addEventListener(CH, …)` resolves to the literal. `foldedFrom`
 * carries the identifier name when folding fired, null otherwise.
 */
function extractChannelFromListenerArg(argNode, sourceFile, foldMap) {
  if (!argNode) return { name: null, dynamic: true, expressionText: '', foldedFrom: null };
  return extractStringOrDynamic(argNode, sourceFile, foldMap);
}

function extractChannelFromDispatchArg(argNode, sourceFile, foldMap) {
  if (!argNode) return { name: null, dynamic: true, expressionText: '', foldedFrom: null };
  // `new CustomEvent('foo', …)` or `new Event('foo', …)`
  if (ts.isNewExpression(argNode)) {
    const ctor = argNode.expression;
    const ctorName =
      ts.isIdentifier(ctor) ? ctor.text :
      (ts.isPropertyAccessExpression(ctor) && ts.isIdentifier(ctor.name)) ? ctor.name.text :
      null;
    if (ctorName === 'CustomEvent' || ctorName === 'Event') {
      const nameArg = argNode.arguments?.[0];
      if (nameArg) return extractStringOrDynamic(nameArg, sourceFile, foldMap);
      return { name: null, dynamic: true, expressionText: argNode.getText(sourceFile), foldedFrom: null };
    }
  }
  // Fallback: unknown dispatch argument (variable, already-constructed event, etc.)
  return { name: null, dynamic: true, expressionText: argNode.getText(sourceFile), foldedFrom: null };
}

function extractStringOrDynamic(node, sourceFile, foldMap) {
  const { value, dynamic, expressionText, foldedFrom } = resolveStringArg(
    node,
    sourceFile,
    foldMap,
  );
  return { name: value, dynamic, expressionText, foldedFrom };
}

/**
 * Parse a single file and return raw occurrences. Pure — no filesystem.
 */
export function analyzeSource(code, filePath, preparsed) {
  const sourceFile = preparsed ?? ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const foldMap = buildFoldMap(sourceFile);
  const occurrences = [];

  function record(node, host, name, dynamic, expressionText, op, detectedVia, foldedFrom) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);
    occurrences.push({
      host,
      name,
      dynamic,
      expressionText,
      op,
      detectedVia,
      foldedFrom: foldedFrom ?? null,
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
            const { name, dynamic, expressionText, foldedFrom } =
              op === 'dispatch'
                ? extractChannelFromDispatchArg(node.arguments[0], sourceFile, foldMap)
                : extractChannelFromListenerArg(node.arguments[0], sourceFile, foldMap);
            record(node, host, name, dynamic, expressionText, op, detectedVia, foldedFrom);
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
          const { name, dynamic, expressionText, foldedFrom } =
            op === 'dispatch'
              ? extractChannelFromDispatchArg(node.arguments[0], sourceFile, foldMap)
              : extractChannelFromListenerArg(node.arguments[0], sourceFile, foldMap);
          record(node, 'window', name, dynamic, expressionText, op, detectedVia, foldedFrom);
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
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const astCache = opts.astCache;
  const groups = new Map();

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
      let occurrences;
      try {
        occurrences = analyzeSource(code, absFile, preparsed);
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
        const pushed = {
          project: project.id,
          file: rel,
          line: occ.line,
          column: occ.column,
          op: occ.op,
          host: occ.host,
          detectedVia: occ.detectedVia,
          snippet: occ.snippet,
        };
        if (occ.foldedFrom) pushed.foldedFrom = occ.foldedFrom;
        groups.get(groupKey).occurrences.push(pushed);
      }
    }
  }

  // Drop listen-only native-DOM-event findings — browser wire-up, not
  // coupling. See the module-header comment for rationale.
  const findings = [...groups.values()]
    .filter((f) => {
      if (f.dynamic) return true;
      if (!NATIVE_DOM_EVENTS.has(f.channel)) return true;
      const hasDispatch = f.occurrences.some((o) => o.op === 'dispatch');
      return hasDispatch;
    })
    .sort((a, b) => {
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
