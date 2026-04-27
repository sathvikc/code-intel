// Analyzer: lifecycle-cleanup-drift (P13)
//
// Detects registration calls that have no matching teardown reachable in the
// same function body. Three finding kinds:
//
//   missing-teardown         — a registration with no reachable matching
//                              teardown anywhere in the same function body
//   abort-never-called       — new AbortController() whose .signal is passed
//                              to ≥1 API, but no .abort() call in the same body
//   handler-identity-mismatch — addEventListener(type, fn1) paired with
//                              removeEventListener(type, fn2) where fn1 and fn2
//                              are provably different references
//
// Scope: intra-function only. The cleanup-return pattern is handled: a
// function body that returns an arrow/function has its returned body treated
// as reachable teardown scope (React useEffect style).
//
// Syntactic only. No cross-file analysis (v1).
//
// Output schema version: 0.1
// Finding kind: "lifecycle-cleanup-drift" (wrapper); individual kinds above.

import ts from 'typescript';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { readSource, scriptKindFor } from './framework-file.js';
import { buildFoldMap, resolveStringArg } from './fold-string-literals.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'lifecycle-cleanup-drift';

// Observer kinds that use .disconnect() for teardown
const OBSERVER_KINDS = new Set(['IntersectionObserver', 'MutationObserver', 'ResizeObserver']);

// Closeable resource kinds that use .close() for teardown
const CLOSEABLE_KINDS = new Set(['WebSocket', 'EventSource']);

/**
 * Analyse a single function body node and return findings.
 * `fnNode` should be a FunctionDeclaration, FunctionExpression, ArrowFunction,
 * MethodDeclaration, or Constructor node whose body we will walk.
 *
 * Returns an array of finding objects (missing-teardown, abort-never-called,
 * handler-identity-mismatch).
 */
function analyzeFunctionBody(fnNode, sourceFile, project, filePath, foldMap, crossFileResolver) {
  const registrations = [];  // { kind, eventType?, varBinding?, line, col, snippet, handlerNode? }
  const teardowns = [];      // { kind, eventType?, varBinding?, line, col, snippet, handlerNode? }
  const abortControllers = new Map(); // varName → { varName, signalUsedAt:[], abortCalled:bool, line, col, snippet }

  // Resolve a string argument using the same fold-aware machinery every other
  // string-key detector uses (see D8 / D15). This lets addEventListener('foo')
  // pair with removeEventListener('foo') AND addEventListener(EVENT_TYPE) pair
  // with removeEventListener(EVENT_TYPE) when EVENT_TYPE is a same-file const
  // or an imported const — the dominant pattern in real codebases.
  function resolveEventType(node) {
    if (!node) return null;
    const r = resolveStringArg(node, sourceFile, foldMap, crossFileResolver);
    return r.dynamic ? null : r.value;
  }

  // Collect the set of known observer/closeable variable names so we can
  // recognise .disconnect() / .close() calls on them.
  const observerBindings = new Map(); // varName → kind
  const closeableBindings = new Map(); // varName → kind
  const timerBindings = new Map(); // varName → kind (setInterval/setTimeout)

  function getSnippet(node) {
    return node.getText(sourceFile).split('\n')[0].slice(0, 200);
  }

  function getPos(node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: line + 1, column: character + 1 };
  }

  // Extract the variable name from the left-hand side of a VariableDeclaration
  // that contains `node` as its initializer.
  function varBindingOf(node) {
    const decl = node.parent;
    if (!decl || !ts.isVariableDeclaration(decl)) return null;
    if (ts.isIdentifier(decl.name)) return decl.name.text;
    return null;
  }

  // Get the receiver identifier text from <expr>.method()
  function receiverIdentifier(callNode) {
    const callee = callNode.expression;
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const expr = callee.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    return null;
  }

  // Check if `node` is a call like `<ident>.method()`
  function isMethodCall(node, methodName) {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    return callee.name.text === methodName;
  }

  // Walk only the immediate body scope — do NOT recurse into nested function
  // declarations or arrow functions EXCEPT:
  //   (a) the body of a directly-returned arrow/function (cleanup-return pattern)
  //   (b) any block-like containers that are not function bodies themselves
  //       (IfStatement, Block, SwitchStatement, etc.)
  //
  // We do this by collecting all nodes with a single shallow walk, stopping
  // recursion when we hit a function/arrow boundary that is NOT the return value.

  // First pass: walk body to collect all nodes, respecting function boundaries.
  // `isInsideReturnedFn` is set to true when we recurse into a directly-returned
  // cleanup function.
  function collectNodes(node, nodes) {
    nodes.push(node);
    ts.forEachChild(node, (child) => {
      // Stop recursion into nested function bodies (they have their own scope)
      // EXCEPT if this child is being returned from the outermost body.
      if (
        ts.isFunctionDeclaration(child) ||
        ts.isFunctionExpression(child) ||
        ts.isArrowFunction(child) ||
        ts.isMethodDeclaration(child) ||
        ts.isConstructorDeclaration(child) ||
        ts.isGetAccessorDeclaration(child) ||
        ts.isSetAccessorDeclaration(child)
      ) {
        // Don't recurse into nested functions — they are their own analysis unit
        return;
      }
      collectNodes(child, nodes);
    });
  }

  // Find directly-returned function/arrow in the function body and collect
  // its nodes too (cleanup-return pattern).
  function findReturnedCleanupBody(bodyNode) {
    // Only look at top-level return statements in the function body.
    // bodyNode is a Block node.
    if (!bodyNode || !ts.isBlock(bodyNode)) return null;
    for (const stmt of bodyNode.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        const expr = stmt.expression;
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
          return expr.body;
        }
      }
    }
    return null;
  }

  // Get the function body node
  let bodyNode = null;
  if (ts.isArrowFunction(fnNode) && !ts.isBlock(fnNode.body)) {
    // Concise arrow: body is a single expression, no block
    bodyNode = null;
  } else if (fnNode.body && ts.isBlock(fnNode.body)) {
    bodyNode = fnNode.body;
  } else if (fnNode.body) {
    bodyNode = fnNode.body;
  }

  if (!bodyNode) return [];

  // Collect all nodes from the main body and from the cleanup-return body.
  const allNodes = [];
  collectNodes(bodyNode, allNodes);

  const cleanupBody = findReturnedCleanupBody(bodyNode);
  if (cleanupBody) {
    collectNodes(cleanupBody, allNodes);
  }

  // First sub-pass: collect all constructor bindings (observers, closeables,
  // abort controllers) so we know what variables to watch for .disconnect()
  // / .close() / .abort() calls.
  for (const node of allNodes) {
    if (ts.isNewExpression(node)) {
      const ctorName = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (!ctorName) continue;
      const varName = varBindingOf(node);
      if (OBSERVER_KINDS.has(ctorName)) {
        if (varName) observerBindings.set(varName, ctorName);
      } else if (CLOSEABLE_KINDS.has(ctorName)) {
        if (varName) closeableBindings.set(varName, ctorName);
      } else if (ctorName === 'AbortController') {
        const pos = getPos(node);
        abortControllers.set(varName ?? `__anon_${pos.line}_${pos.column}`, {
          varName,
          signalUsedAt: [],
          abortCalled: false,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      }
    }
    // Also collect setInterval/setTimeout bindings
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && (callee.text === 'setInterval' || callee.text === 'setTimeout')) {
        const varName = varBindingOf(node);
        if (varName) timerBindings.set(varName, callee.text);
      }
    }
  }

  // Second sub-pass: collect registrations, teardowns, and signal usages.
  for (const node of allNodes) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const args = node.arguments ?? [];

      // --- addEventListener(type, handler) ---
      if (ts.isIdentifier(callee) && callee.text === 'addEventListener') {
        const eventType = resolveEventType(args[0]);
        const handlerNode = args[1] ?? null;
        const pos = getPos(node);
        registrations.push({
          kind: 'addEventListener',
          eventType,
          handlerNode,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
          abortSignalCtrl: detectAbortSignalInArgs(args, abortControllers),
        });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'addEventListener'
      ) {
        const eventType = resolveEventType(args[0]);
        const handlerNode = args[1] ?? null;
        const pos = getPos(node);
        registrations.push({
          kind: 'addEventListener',
          eventType,
          handlerNode,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
          abortSignalCtrl: detectAbortSignalInArgs(args, abortControllers),
        });
      }

      // --- removeEventListener(type, handler) ---
      if (ts.isIdentifier(callee) && callee.text === 'removeEventListener') {
        const eventType = resolveEventType(args[0]);
        const handlerNode = args[1] ?? null;
        const pos = getPos(node);
        teardowns.push({
          kind: 'addEventListener',
          eventType,
          handlerNode,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'removeEventListener'
      ) {
        const eventType = resolveEventType(args[0]);
        const handlerNode = args[1] ?? null;
        const pos = getPos(node);
        teardowns.push({
          kind: 'addEventListener',
          eventType,
          handlerNode,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      }

      // --- setInterval(fn, ms) / setTimeout(fn, ms) ---
      if (ts.isIdentifier(callee) && (callee.text === 'setInterval' || callee.text === 'setTimeout')) {
        const varName = varBindingOf(node);
        const pos = getPos(node);
        registrations.push({
          kind: callee.text,
          varBinding: varName,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      }

      // --- clearInterval(id) / clearTimeout(id) ---
      if (ts.isIdentifier(callee) && (callee.text === 'clearInterval' || callee.text === 'clearTimeout')) {
        const idArg = args[0];
        const varName = idArg && ts.isIdentifier(idArg) ? idArg.text : null;
        const teardownKind = callee.text === 'clearInterval' ? 'setInterval' : 'setTimeout';
        const pos = getPos(node);
        teardowns.push({
          kind: teardownKind,
          varBinding: varName,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      }

      // --- <obs>.disconnect() ---
      if (isMethodCall(node, 'disconnect')) {
        const recv = receiverIdentifier(node);
        if (recv && observerBindings.has(recv)) {
          const pos = getPos(node);
          teardowns.push({
            kind: observerBindings.get(recv),
            varBinding: recv,
            line: pos.line,
            column: pos.column,
            snippet: getSnippet(node),
          });
        }
      }

      // --- <ws/es>.close() ---
      if (isMethodCall(node, 'close')) {
        const recv = receiverIdentifier(node);
        if (recv && closeableBindings.has(recv)) {
          const pos = getPos(node);
          teardowns.push({
            kind: closeableBindings.get(recv),
            varBinding: recv,
            line: pos.line,
            column: pos.column,
            snippet: getSnippet(node),
          });
        }
      }

      // --- <ctrl>.abort() ---
      if (isMethodCall(node, 'abort')) {
        const recv = receiverIdentifier(node);
        if (recv && abortControllers.has(recv)) {
          abortControllers.get(recv).abortCalled = true;
        }
      }

      // --- MediaQueryList.addListener(fn) ---
      if (isMethodCall(node, 'addListener')) {
        const handlerNode = args[0] ?? null;
        const pos = getPos(node);
        registrations.push({
          kind: 'MediaQueryList.addListener',
          handlerNode,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      }

      // --- MediaQueryList.removeListener(fn) ---
      if (isMethodCall(node, 'removeListener')) {
        const handlerNode = args[0] ?? null;
        const pos = getPos(node);
        teardowns.push({
          kind: 'MediaQueryList.addListener',
          handlerNode,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      }

      // --- AbortSignal usage: any call with { signal: <ctrl>.signal } arg ---
      detectSignalUsage(node, args, abortControllers, sourceFile, filePath, project);
    }

    // --- new Observer / new WebSocket / new EventSource / new AbortController ---
    if (ts.isNewExpression(node)) {
      const ctorName = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (!ctorName) continue;
      const varName = varBindingOf(node);
      const pos = getPos(node);

      if (OBSERVER_KINDS.has(ctorName)) {
        registrations.push({
          kind: ctorName,
          varBinding: varName,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      } else if (CLOSEABLE_KINDS.has(ctorName)) {
        registrations.push({
          kind: ctorName,
          varBinding: varName,
          line: pos.line,
          column: pos.column,
          snippet: getSnippet(node),
        });
      }
    }
  }

  // Emit findings
  const findings = [];

  // --- missing-teardown ---
  for (const reg of registrations) {
    if (reg.kind === 'addEventListener') {
      // Check if there is a matching removeEventListener for this event type
      const matching = teardowns.find(
        (t) => t.kind === 'addEventListener' && t.eventType === reg.eventType,
      );
      if (!matching) {
        // AbortSignal happy path: if this registration had a { signal: ctrl.signal }
        // argument AND ctrl.abort() was called, treat it as cleaned up.
        if (reg.abortSignalCtrl) {
          const ctrl = abortControllers.get(reg.abortSignalCtrl);
          if (ctrl && ctrl.abortCalled) continue;
        }
        findings.push({
          kind: 'missing-teardown',
          registrationKind: 'addEventListener',
          occurrences: [{
            project,
            file: filePath,
            line: reg.line,
            column: reg.column,
            op: 'register',
            snippet: reg.snippet,
            registrationKind: 'addEventListener',
            ...(reg.eventType != null ? { channel: reg.eventType } : {}),
          }],
        });
      }
    } else if (reg.kind === 'setInterval' || reg.kind === 'setTimeout') {
      const matching = reg.varBinding
        ? teardowns.find((t) => t.kind === reg.kind && t.varBinding === reg.varBinding)
        : null;
      if (!matching) {
        findings.push({
          kind: 'missing-teardown',
          registrationKind: reg.kind,
          occurrences: [{
            project,
            file: filePath,
            line: reg.line,
            column: reg.column,
            op: 'register',
            snippet: reg.snippet,
            registrationKind: reg.kind,
          }],
        });
      }
    } else if (OBSERVER_KINDS.has(reg.kind) || CLOSEABLE_KINDS.has(reg.kind)) {
      const matching = teardowns.find(
        (t) => t.kind === reg.kind && t.varBinding === reg.varBinding,
      );
      if (!matching) {
        findings.push({
          kind: 'missing-teardown',
          registrationKind: reg.kind,
          occurrences: [{
            project,
            file: filePath,
            line: reg.line,
            column: reg.column,
            op: 'register',
            snippet: reg.snippet,
            registrationKind: reg.kind,
          }],
        });
      }
    } else if (reg.kind === 'MediaQueryList.addListener') {
      const matching = teardowns.find((t) => t.kind === 'MediaQueryList.addListener');
      if (!matching) {
        findings.push({
          kind: 'missing-teardown',
          registrationKind: 'MediaQueryList.addListener',
          occurrences: [{
            project,
            file: filePath,
            line: reg.line,
            column: reg.column,
            op: 'register',
            snippet: reg.snippet,
            registrationKind: 'MediaQueryList.addListener',
          }],
        });
      }
    }
  }

  // --- abort-never-called ---
  for (const [, ctrl] of abortControllers) {
    if (ctrl.signalUsedAt.length > 0 && !ctrl.abortCalled) {
      findings.push({
        kind: 'abort-never-called',
        occurrences: [{
          project,
          file: filePath,
          line: ctrl.line,
          column: ctrl.column,
          op: 'construct',
          snippet: ctrl.snippet,
          usedAt: ctrl.signalUsedAt,
        }],
      });
    }
  }

  // --- handler-identity-mismatch ---
  for (const reg of registrations) {
    if (reg.kind !== 'addEventListener') continue;
    const matching = teardowns.find(
      (t) => t.kind === 'addEventListener' && t.eventType === reg.eventType,
    );
    if (!matching) continue;
    if (!handlerIdentityMismatch(reg.handlerNode, matching.handlerNode)) continue;
    findings.push({
      kind: 'handler-identity-mismatch',
      channel: reg.eventType,
      occurrences: [
        {
          project,
          file: filePath,
          line: reg.line,
          column: reg.column,
          op: 'add',
          snippet: reg.snippet,
          handlerKind: handlerKindOf(reg.handlerNode),
        },
        {
          project,
          file: filePath,
          line: matching.line,
          column: matching.column,
          op: 'remove',
          snippet: matching.snippet,
          handlerKind: handlerKindOf(matching.handlerNode),
        },
      ],
    });
  }

  return findings;
}

/**
 * Check if any argument (or nested argument object property) passes
 * `<ctrl>.signal` where `<ctrl>` is a known AbortController binding.
 * Returns the controller's key name if found, null otherwise.
 */
function detectAbortSignalInArgs(args, abortControllers) {
  for (const arg of args) {
    const ctrl = findSignalInExpression(arg, abortControllers);
    if (ctrl) return ctrl;
  }
  return null;
}

/**
 * Recursively search `node` for `<ctrl>.signal` property access where
 * `ctrl` is a known AbortController. Returns the ctrl key, or null.
 */
function findSignalInExpression(node, abortControllers) {
  if (!node) return null;
  // Direct property access: ctrl.signal
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'signal') {
    if (ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (abortControllers.has(name)) return name;
    }
  }
  // Object literal: { signal: ctrl.signal, ... }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const result = findSignalInExpression(prop.initializer, abortControllers);
        if (result) return result;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        // { signal } shorthand — signal would be the ctrl itself, not common
        // but handle gracefully
      }
    }
  }
  // Spread, array, etc. — not common but be safe
  return null;
}

/**
 * Walk all call-expression nodes in a call's args to record .signal usages
 * for abort-controller tracking.
 */
function detectSignalUsage(callNode, args, abortControllers, sourceFile, filePath, project) {
  for (const arg of args) {
    scanForSignal(arg, abortControllers, callNode, sourceFile, filePath, project);
  }
}

function scanForSignal(node, abortControllers, callNode, sourceFile, filePath, project) {
  if (!node) return;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'signal') {
    if (ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (abortControllers.has(name)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(callNode.getStart(sourceFile));
        abortControllers.get(name).signalUsedAt.push({
          file: filePath,
          line: line + 1,
          column: character + 1,
          snippet: callNode.getText(sourceFile).split('\n')[0].slice(0, 200),
        });
      }
    }
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        scanForSignal(prop.initializer, abortControllers, callNode, sourceFile, filePath, project);
      }
    }
  }
}

/**
 * Determine the handler kind label for a handler AST node.
 */
function handlerKindOf(node) {
  if (!node) return 'identifier';
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'arrow';
  if (ts.isIdentifier(node)) return 'identifier';
  if (ts.isFunctionDeclaration(node)) return 'function';
  return 'identifier';
}

/**
 * Returns true if the two handler nodes are provably different references.
 */
function handlerIdentityMismatch(addNode, removeNode) {
  if (!addNode || !removeNode) return false;
  const addInline = ts.isArrowFunction(addNode) || ts.isFunctionExpression(addNode);
  const removeInline = ts.isArrowFunction(removeNode) || ts.isFunctionExpression(removeNode);
  // Both inline arrows/functions → always mismatch (different objects)
  if (addInline && removeInline) return true;
  // Both identifiers → mismatch if different names
  if (ts.isIdentifier(addNode) && ts.isIdentifier(removeNode)) {
    return addNode.text !== removeNode.text;
  }
  // One inline, one identifier → always mismatch
  if ((addInline && ts.isIdentifier(removeNode)) || (ts.isIdentifier(addNode) && removeInline)) {
    return true;
  }
  return false;
}

/**
 * Collect all top-level function bodies in a source file.
 * Returns array of function AST nodes.
 */
function collectFunctionBodies(sourceFile) {
  const functions = [];

  function visit(node, depth) {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);

    if (isFn) {
      functions.push(node);
      // Recurse into function body for nested functions (each is its own analysis unit)
      if (node.body) {
        ts.forEachChild(node.body, (child) => visit(child, depth + 1));
      }
      // For concise arrows (body is an expression), recurse into the expression
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        ts.forEachChild(node.body, (child) => visit(child, depth + 1));
      }
    } else {
      ts.forEachChild(node, (child) => visit(child, depth + 1));
    }
  }

  ts.forEachChild(sourceFile, (child) => visit(child, 0));
  return functions;
}

/**
 * Parse a single source string and return findings.
 *
 * @param {string} code - source code
 * @param {string} filePath - file path (for snippets and occurrence records)
 * @param {ts.SourceFile} [preparsed] - optional pre-parsed AST
 * @param {string} [project] - project id (defaults to basename)
 * @returns {object[]} findings
 */
export function analyzeSource(code, filePath, preparsed, project, crossFileResolver) {
  const sourceFile = preparsed ?? ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const proj = project ?? path.basename(path.dirname(filePath));
  const foldMap = buildFoldMap(sourceFile);
  const functions = collectFunctionBodies(sourceFile);
  const findings = [];
  for (const fn of functions) {
    const fnFindings = analyzeFunctionBody(fn, sourceFile, proj, filePath, foldMap, crossFileResolver);
    findings.push(...fnFindings);
  }
  return findings;
}

/**
 * Run the analyzer across N project roots and return the schema-shaped result.
 *
 * @param {string[]} projectRoots
 * @param {object} [opts]
 * @returns {{ version, analyzer, projects, findings }}
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const includeBuildArtifacts = opts.includeBuildArtifacts;
  const astCache = opts.astCache;
  const crossFileResolver = opts.crossFileResolver;
  const findings = [];

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude, includeBuildArtifacts })) {
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
      let filefindings;
      try {
        filefindings = analyzeSource(code, path.relative(project.root, absFile), preparsed, project.id, crossFileResolver);
      } catch {
        continue;
      }
      findings.push(...filefindings);
    }
  }

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map((p) => ({ id: p.id, root: p.root })),
    findings,
  };
}

/**
 * Summarize a result for human display.
 */
export function summarize(result) {
  const byKind = {};
  for (const f of result.findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byKind,
  };
}
