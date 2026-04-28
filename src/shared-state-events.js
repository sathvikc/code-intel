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
import { readSource, scriptKindFor } from './framework-file.js';
import { buildFoldMap, resolveStringArg, resolveSameScopeBinding } from './fold-string-literals.js';

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
 * Returns { name, dynamic, expressionText, foldedFrom, foldedFromModule? }.
 *
 * Goes through the shared fold helper so `const CH = 'profile:changed';
 * window.addEventListener(CH, …)` resolves to the literal. When
 * `crossFileResolver` is provided, imported constants also resolve and
 * carry `foldedFromModule`. `foldedFrom` is the identifier name when
 * folding fired, null otherwise.
 */
function extractChannelFromListenerArg(argNode, sourceFile, foldMap, crossFileResolver) {
  if (!argNode) return { name: null, dynamic: true, expressionText: '', foldedFrom: null };
  return extractStringOrDynamic(argNode, sourceFile, foldMap, crossFileResolver);
}

/**
 * Extract the channel(s) from the first argument of a dispatch call.
 *
 * Returns an array because one call can legitimately dispatch on more
 * than one channel when the argument is an aliased event whose init is
 * a ternary (`const fwd = cond ? new CustomEvent('A') : new Event('B');
 * dispatch(fwd)` → channels `['A', 'B']`). Most calls return a single-
 * element array. The multi-channel path is opt-in: it only fires when
 * the argument is a same-scope non-reassigned alias.
 *
 * Recognised shapes:
 *   - `dispatch(new CustomEvent('X', ...))`            inline (existing)
 *   - `dispatch(new Event('X', ...))`                  inline (existing)
 *   - `const fwd = new CustomEvent('X'); dispatch(fwd)` alias     (P22)
 *   - `const fwd = cond ? new CustomEvent('A') :       alias + ternary
 *      new Event('B'); dispatch(fwd)`                              (P22)
 *
 * Each element carries `aliasedFrom` when alias-follow fired; absent
 * on inline dispatches. `foldedFrom` / `foldedFromModule` continue to
 * flag string-identifier-vs-literal folding on the channel name.
 */
function extractDispatchChannels(argNode, sourceFile, foldMap, crossFileResolver) {
  if (!argNode) {
    return [{ name: null, dynamic: true, expressionText: '', foldedFrom: null }];
  }
  // Inline: `new CustomEvent('foo', …)` or `new Event('foo', …)`
  const inline = channelFromConstructor(argNode, sourceFile, foldMap, crossFileResolver);
  if (inline) return [inline];
  // Alias follow: `dispatch(x)` where `x` is a same-scope const/let.
  if (ts.isIdentifier(argNode)) {
    const aliased = resolveSameScopeBinding(argNode, foldMap);
    if (aliased) {
      const channels = channelsFromAliasInit(aliased.init, sourceFile, foldMap, crossFileResolver);
      if (channels && channels.length > 0) {
        return channels.map((c) => ({ ...c, aliasedFrom: aliased.name }));
      }
    }
  }
  // Fallback: dynamic — unknown event, cross-function construction, etc.
  return [{
    name: null,
    dynamic: true,
    expressionText: argNode.getText(sourceFile),
    foldedFrom: null,
  }];
}

/**
 * If `argNode` is `new CustomEvent(lit, …)` or `new Event(lit, …)`,
 * return the channel descriptor; else null. Shared between the inline
 * dispatch path and the alias-follow path so both see the same
 * recognised constructor set.
 */
function channelFromConstructor(argNode, sourceFile, foldMap, crossFileResolver) {
  if (!ts.isNewExpression(argNode)) return null;
  const ctor = argNode.expression;
  const ctorName =
    ts.isIdentifier(ctor) ? ctor.text :
    (ts.isPropertyAccessExpression(ctor) && ts.isIdentifier(ctor.name)) ? ctor.name.text :
    null;
  if (ctorName !== 'CustomEvent' && ctorName !== 'Event') return null;
  const nameArg = argNode.arguments?.[0];
  if (!nameArg) {
    return { name: null, dynamic: true, expressionText: argNode.getText(sourceFile), foldedFrom: null };
  }
  return extractStringOrDynamic(nameArg, sourceFile, foldMap, crossFileResolver);
}

/**
 * Recursively flatten an alias's initializer into one or more channel
 * descriptors. Handles the v1 alias-follow shapes: direct constructor,
 * a ternary of two constructors, and parens wrapping either of the
 * above. Returns null (not an empty array) when nothing is
 * extractable, so the caller can distinguish "no alias-recognised
 * channels" from "alias recognised but gave zero channels".
 */
function channelsFromAliasInit(initNode, sourceFile, foldMap, crossFileResolver) {
  if (ts.isParenthesizedExpression(initNode)) {
    return channelsFromAliasInit(initNode.expression, sourceFile, foldMap, crossFileResolver);
  }
  if (ts.isConditionalExpression(initNode)) {
    const whenTrue = channelsFromAliasInit(initNode.whenTrue, sourceFile, foldMap, crossFileResolver) ?? [];
    const whenFalse = channelsFromAliasInit(initNode.whenFalse, sourceFile, foldMap, crossFileResolver) ?? [];
    const combined = [...whenTrue, ...whenFalse];
    return combined.length > 0 ? combined : null;
  }
  const direct = channelFromConstructor(initNode, sourceFile, foldMap, crossFileResolver);
  return direct ? [direct] : null;
}

function extractStringOrDynamic(node, sourceFile, foldMap, crossFileResolver) {
  const { value, dynamic, expressionText, foldedFrom, foldedFromModule } = resolveStringArg(
    node,
    sourceFile,
    foldMap,
    crossFileResolver,
  );
  return { name: value, dynamic, expressionText, foldedFrom, foldedFromModule };
}

/**
 * Parse a single file and return raw occurrences. Pure — no filesystem.
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

  function record(node, host, ch, op, detectedVia) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);
    const occ = {
      host,
      name: ch.name,
      dynamic: ch.dynamic,
      expressionText: ch.expressionText,
      op,
      detectedVia,
      foldedFrom: ch.foldedFrom ?? null,
      line: line + 1,
      column: character + 1,
      snippet,
    };
    if (ch.foldedFromModule) occ.foldedFromModule = ch.foldedFromModule;
    if (ch.aliasedFrom) occ.aliasedFrom = ch.aliasedFrom;
    occurrences.push(occ);
  }

  function emitChannels(node, host, op, detectedVia, channels) {
    for (const ch of channels) {
      record(node, host, ch, op, detectedVia);
    }
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
            const channels = op === 'dispatch'
              ? extractDispatchChannels(node.arguments[0], sourceFile, foldMap, crossFileResolver)
              : [extractChannelFromListenerArg(node.arguments[0], sourceFile, foldMap, crossFileResolver)];
            emitChannels(node, host, op, detectedVia, channels);
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
          const channels = op === 'dispatch'
            ? extractDispatchChannels(node.arguments[0], sourceFile, foldMap, crossFileResolver)
            : [extractChannelFromListenerArg(node.arguments[0], sourceFile, foldMap, crossFileResolver)];
          emitChannels(node, 'window', op, detectedVia, channels);
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
 * Grouping: static channel names merge across all projects and files;
 * dynamic occurrences stay per-site so they don't all collapse into one.
 * `host` does NOT split groups — `window.dispatchEvent('x')` in one file and
 * `globalThis.addEventListener('x')` in another refer to the same channel.
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const includeBuildArtifacts = opts.includeBuildArtifacts;
  const includeTestContext = opts.includeTestContext;
  const astCache = opts.astCache;
  const crossFileResolver = opts.crossFileResolver;
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
        if (occ.foldedFromModule) pushed.foldedFromModule = occ.foldedFromModule;
        if (occ.aliasedFrom) pushed.aliasedFrom = occ.aliasedFrom;
        groups.get(groupKey).occurrences.push(pushed);
      }
    }
  }

  // Drop listen-only native-DOM-event findings — browser wire-up, not
  // coupling. See the module-header comment for rationale.
  const findings = [...groups.values()]
    .filter((f) => {
      if (f.dynamic) return true;
      // D20: static channels must span ≥2 distinct files
      const distinctFiles = new Set(
        f.occurrences.map((o) => `${o.project}::${o.file}`),
      );
      if (distinctFiles.size < 2) return false;
      // Existing native-event filter (unchanged)
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
 * Parse a single file and return raw bridge records — one per
 * (listen-site, inner-dispatch-site) pair where the dispatched channel
 * matches the listened channel and the target host is different.
 *
 * v1 constraints (per spec):
 *   - Handler must be inline (ArrowFunction or FunctionExpression).
 *   - Channel name must be statically resolvable.
 *   - Only same-channel bridges (no rename-bridges).
 *   - Self-bridge suppressed: both hosts in GLOBAL_HOSTS → skip.
 */
export function analyzeBridgeSource(code, filePath, preparsed, foldMap, crossFileResolver) {
  const sourceFile = preparsed ?? ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const fm = foldMap ?? buildFoldMap(sourceFile);
  const bridges = [];

  /**
   * Walk a handler body to find all inner dispatchEvent(...) calls and
   * return them with their host, channel info, and source location.
   */
  function collectInnerDispatches(handlerNode) {
    const result = [];
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let innerHost = null;
        let isDispatch = false;

        // `<expr>.dispatchEvent(...)`
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'dispatchEvent') {
          isDispatch = true;
          const receiver = callee.expression;
          const gHost = globalHostOf(receiver);
          if (gHost) {
            innerHost = 'window'; // canonical
          } else {
            // Walk the receiver expression to find the leftmost identifier.
            innerHost = leftmostIdentifier(receiver);
          }
        }

        // bare `dispatchEvent(...)`
        if (ts.isIdentifier(callee) && callee.text === 'dispatchEvent') {
          isDispatch = true;
          innerHost = 'window';
        }

        if (isDispatch && innerHost !== null) {
          const channels = extractDispatchChannels(node.arguments[0], sourceFile, fm, crossFileResolver);
          const { line: ln, character: col } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const snippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);
          // Build toHostExpression for non-global receivers
          let toHostExpression;
          if (ts.isPropertyAccessExpression(callee)) {
            const gHost = globalHostOf(callee.expression);
            if (!gHost) {
              toHostExpression = callee.expression.getText(sourceFile);
            }
          }
          for (const ch of channels) {
            result.push({ channel: ch, innerHost, line: ln + 1, column: col + 1, snippet, toHostExpression });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(handlerNode);
    return result;
  }

  /**
   * Return the leftmost identifier text in a (possibly nested) property
   * access expression, e.g. `iframe.contentWindow` → `"iframe"`.
   */
  function leftmostIdentifier(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return leftmostIdentifier(node.expression);
    if (ts.isElementAccessExpression(node)) return leftmostIdentifier(node.expression);
    return null;
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let fromHost = null;

      // `<host>.addEventListener(...)`
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'addEventListener') {
        const host = globalHostOf(callee.expression);
        if (host) fromHost = 'window'; // canonical
      }
      // bare `addEventListener(...)`
      if (ts.isIdentifier(callee) && callee.text === 'addEventListener') {
        fromHost = 'window';
      }

      if (fromHost !== null && node.arguments.length >= 2) {
        // Extract listen channel
        const channelResult = extractChannelFromListenerArg(node.arguments[0], sourceFile, fm, crossFileResolver);
        if (!channelResult.dynamic && channelResult.name !== null) {
          const channelName = channelResult.name;
          const handler = node.arguments[1];
          const isInline = ts.isArrowFunction(handler) || ts.isFunctionExpression(handler);
          if (isInline) {
            const { line: listenLn, character: listenCol } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const listenSnippet = node.getText(sourceFile).split('\n')[0].slice(0, 200);

            const innerDispatches = collectInnerDispatches(handler);
            for (const d of innerDispatches) {
              if (d.channel.dynamic || d.channel.name === null) continue;
              if (d.channel.name !== channelName) continue; // v1: no rename-bridges

              const toHost = d.innerHost;
              // Self-bridge suppression: both in GLOBAL_HOSTS equivalence → skip
              // fromHost is always 'window' (canonical for window/globalThis/self)
              // toHost is 'window' if the inner dispatch was to a global host
              if (toHost === 'window') continue; // fromHost is always 'window', so same → skip
              // Also skip if toHost === fromHost (same non-global)
              if (toHost === fromHost) continue;

              const bridge = {
                channel: channelName,
                fromHost,
                toHost,
                listenLine: listenLn + 1,
                listenCol: listenCol + 1,
                listenSnippet,
                dispatchLine: d.line,
                dispatchCol: d.column,
                dispatchSnippet: d.snippet,
              };
              if (d.toHostExpression) bridge.toHostExpression = d.toHostExpression;
              if (channelResult.foldedFrom) bridge.foldedFrom = channelResult.foldedFrom;
              if (channelResult.foldedFromModule) bridge.foldedFromModule = channelResult.foldedFromModule;
              if (d.channel.aliasedFrom) bridge.aliasedFrom = d.channel.aliasedFrom;
              bridges.push(bridge);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bridges;
}

/**
 * Run the bridge detector across N project roots and return findings.
 * Mirrors the shape of analyzeProjects but returns kind: 'event-bridge'.
 */
export function analyzeBridgeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const includeBuildArtifacts = opts.includeBuildArtifacts;
  const includeTestContext = opts.includeTestContext;
  const astCache = opts.astCache;
  const crossFileResolver = opts.crossFileResolver;

  // Group by (channel, fromHost, toHost)
  const groups = new Map();
  let fileCount = 0;
  let errorCount = 0;

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude, includeBuildArtifacts, includeTestContext })) {
      fileCount++;
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
          errorCount++;
          continue;
        }
      }
      let bridges;
      try {
        bridges = analyzeBridgeSource(code, absFile, preparsed, null, crossFileResolver);
      } catch {
        errorCount++;
        continue;
      }
      for (const b of bridges) {
        const rel = path.relative(project.root, absFile);
        const groupKey = `${b.channel}::${b.fromHost}->${b.toHost}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            kind: 'event-bridge',
            channel: b.channel,
            fromHost: b.fromHost,
            toHost: b.toHost,
            occurrences: [],
          });
        }
        const g = groups.get(groupKey);
        // Listen occurrence
        const listenOcc = {
          project: project.id,
          file: rel,
          line: b.listenLine,
          column: b.listenCol,
          op: 'listen',
          host: b.fromHost,
          snippet: b.listenSnippet,
        };
        if (b.foldedFrom) listenOcc.foldedFrom = b.foldedFrom;
        if (b.foldedFromModule) listenOcc.foldedFromModule = b.foldedFromModule;
        if (b.aliasedFrom) listenOcc.aliasedFrom = b.aliasedFrom;
        // Dispatch occurrence
        const dispatchOcc = {
          project: project.id,
          file: rel,
          line: b.dispatchLine,
          column: b.dispatchCol,
          op: 'dispatch',
          host: b.toHost,
          snippet: b.dispatchSnippet,
          bridgedFrom: { file: rel, line: b.listenLine, column: b.listenCol },
        };
        if (b.toHostExpression) dispatchOcc.toHostExpression = b.toHostExpression;
        if (b.foldedFrom) dispatchOcc.foldedFrom = b.foldedFrom;
        if (b.foldedFromModule) dispatchOcc.foldedFromModule = b.foldedFromModule;
        if (b.aliasedFrom) dispatchOcc.aliasedFrom = b.aliasedFrom;
        g.occurrences.push(listenOcc, dispatchOcc);
      }
    }
  }

  const findings = [...groups.values()].sort((a, b) => {
    if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
    if (a.fromHost !== b.fromHost) return a.fromHost < b.fromHost ? -1 : 1;
    return a.toHost < b.toHost ? -1 : 1;
  });

  return { findings, fileCount, errorCount };
}

/**
 * Summarize bridge results for human display.
 * Accepts either the raw findings array or the full result envelope
 * { findings, fileCount, errorCount } returned by analyzeBridgeProjects.
 */
export function bridgeSummarize(resultOrFindings) {
  const findings = Array.isArray(resultOrFindings) ? resultOrFindings : (resultOrFindings?.findings ?? []);
  return [
    `event-bridge: ${findings.length} bridge(s) across ${new Set(findings.map(f => f.channel)).size} channel(s)`,
  ];
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
