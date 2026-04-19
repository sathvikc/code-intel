// shape-drift analyzer: write-shape vs read-shape on a shared channel (P9).
//
// This is the detector no existing tool catches. TypeScript does not see
// across a `JSON.stringify` / `JSON.parse` / storage boundary — `getItem`
// returns `string | null`, and whatever shape comes back is whatever the
// writer serialised, which lives in *code*, not in types. When one file
// writes `{ name }` and another file reads `.firstName`, the refactor
// that renamed the field has type-checked fine and broken silently in
// prod. shape-drift makes that invisible contract visible.
//
// v1 is deliberately narrow, per D2 (ship the slice, log the gaps):
//
//   channel          — storage (localStorage + sessionStorage, incl.
//                      window./globalThis. hosts). Cookies, CustomEvent
//                      detail, URL params come in later slices.
//   write signal     — setItem(literalKey, JSON.stringify(<objLiteral>))
//                      Extract the top-level key set from the literal.
//   read signals     — JSON.parse(storage.getItem(literalKey)), consumed
//                      in one of three forms:
//                        a) direct property access — JSON.parse(...).x
//                        b) destructuring — const { x, y } = JSON.parse(...)
//                        c) variable binding — const o = JSON.parse(...);
//                           then o.x / o['x'] accesses in the same scope
//                      Tolerant of `… || '{}'` / `… ?? '{}'` fallbacks and
//                      non-null assertions `…!` around the getItem call.
//   emission rule    — emit only when BOTH sides have at least one literal
//                      shape observation AND the aggregated shapes
//                      disagree. Opaque-only channels do not emit;
//                      literal-only channels do not emit. This keeps v1
//                      high-signal; opaque-partial cases can be revisited
//                      once v1 has dogfood data.
//
// Known recall gaps (logged here honestly; future slices):
//
//   - Cookies, CustomEvent detail, URL params (other channels).
//   - Spread writes `JSON.stringify({ ...prev, x })` where `prev` is
//     cross-file.
//   - Helper-wrapped writes / reads — `storage.set('k', obj)` through a
//     helper module (Q2).
//   - Dynamic keys on either side — we only pair literal keys.
//   - Dynamic property reads `o[key]` where `key` is non-literal.
//   - Nested-field drift — v1 is top-level keys only. `user.address.
//     street` → `user.addressLine1` is a v2 problem.
//   - Cross-function propagation of the parsed value — v1 tracks usage
//     only inside the enclosing function / module scope.
//
// What this does NOT catch is why `shared-state` still has to exist — it
// flags coupling on the key itself, even when shapes are opaque. The two
// detectors are additive: `shared-state` says "these files share this
// key", `shape-drift` says "and the shape contract is broken."
//
// Output schema version: 0.1
// Finding kind: "shape-drift"

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { buildFoldMap, resolveStringArg } from './fold-string-literals.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'shape-drift';

const STORAGE_NAMES = new Set(['localStorage', 'sessionStorage']);

/** `localStorage` / `window.localStorage` / `globalThis.sessionStorage` → name. */
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

/** Unwrap surface-level fallbacks around a JSON.parse argument. */
function unwrapParseArg(node) {
  // `expr || '{}'`, `expr ?? '{}'` → expr
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.BarBarToken
      || kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return unwrapParseArg(node.left);
    }
  }
  // `expr!` non-null assertion
  if (ts.isNonNullExpression(node)) return unwrapParseArg(node.expression);
  // `(expr)` parens
  if (ts.isParenthesizedExpression(node)) return unwrapParseArg(node.expression);
  return node;
}

/**
 * True if the call is `JSON.stringify(<something>)`.
 */
function isJsonStringifyCall(node) {
  return (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'JSON'
    && ts.isIdentifier(node.expression.name)
    && node.expression.name.text === 'stringify'
  );
}

/**
 * True if the call is `JSON.parse(<something>)`.
 */
function isJsonParseCall(node) {
  return (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'JSON'
    && ts.isIdentifier(node.expression.name)
    && node.expression.name.text === 'parse'
  );
}

/**
 * True if the call is `<storage>.getItem(literalKey)` and returns the key;
 * null otherwise. Accepts same-file folded identifier keys so that
 * `const K = 'user.profile'; JSON.parse(localStorage.getItem(K) || '{}')`
 * resolves to `K`'s literal value. `foldedFrom` carries the identifier
 * name when folding fired, null otherwise.
 */
function storageGetItemKey(node, sourceFile, foldMap) {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const pa = node.expression;
  if (!ts.isIdentifier(pa.name) || pa.name.text !== 'getItem') return null;
  const storage = storageNameOf(pa.expression);
  if (!storage) return null;
  const resolved = resolveStringArg(node.arguments[0], sourceFile, foldMap);
  if (resolved.dynamic || resolved.value === null) return null;
  return { storage, key: resolved.value, foldedFrom: resolved.foldedFrom };
}

/**
 * Top-level key set of an object literal, or null if the literal contains
 * anything that would make the shape opaque (spread, computed name,
 * method, etc.). Returns a sorted, de-duped string array.
 */
function extractObjectLiteralKeys(expr) {
  if (!expr || !ts.isObjectLiteralExpression(expr)) return null;
  const keys = [];
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) return null;
    if (
      ts.isPropertyAssignment(prop)
      || ts.isShorthandPropertyAssignment(prop)
      || ts.isMethodDeclaration(prop)
      || ts.isGetAccessorDeclaration(prop)
      || ts.isSetAccessorDeclaration(prop)
    ) {
      const name = prop.name;
      if (!name) return null;
      if (ts.isIdentifier(name)) {
        keys.push(name.text);
      } else if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
        keys.push(name.text);
      } else {
        // ComputedPropertyName, NumericLiteral, PrivateIdentifier — opaque.
        return null;
      }
    } else {
      return null;
    }
  }
  return [...new Set(keys)].sort();
}

/**
 * Given a `storage.setItem(key, <value>)` call, return the write shape.
 * Returns { opaque: false, keys } when we can see an object literal;
 * { opaque: true, reason } otherwise.
 */
function extractWriteShape(setItemCall) {
  const valueArg = setItemCall.arguments[1];
  if (!valueArg) return { opaque: true, reason: 'no-value-arg' };
  if (!isJsonStringifyCall(valueArg)) {
    // setItem value is a bare string / identifier / fetch result — shape
    // is not observable syntactically.
    return { opaque: true, reason: 'value-not-json-stringify' };
  }
  const payload = valueArg.arguments[0];
  const keys = extractObjectLiteralKeys(payload);
  if (keys) return { opaque: false, keys };
  return { opaque: true, reason: 'stringify-arg-not-object-literal' };
}

/**
 * Function-like predicate for scope resolution during read-shape
 * extraction — we only walk within the enclosing function (or the source
 * file if the read is at module scope).
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
 * Given the parent of a `JSON.parse(getItem(...))` call (after unwrapping
 * fallbacks), work out what shape the reader expects. Handles the three
 * v1 forms: direct access, destructuring, variable binding.
 *
 * Returns { opaque, keys?, reason? }.
 */
function extractReadShape(parseCall, sourceFile) {
  // The parseCall we're given is the *actual* JSON.parse call node. Its
  // parent may be a property access / element access / variable
  // declaration, each of which is a different consumption form.
  const parent = parseCall.parent;
  if (!parent) return { opaque: true, reason: 'no-parent' };

  // Form a: JSON.parse(...).field   →   shape = { field }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === parseCall) {
    if (ts.isIdentifier(parent.name)) return { opaque: false, keys: [parent.name.text] };
    return { opaque: true, reason: 'non-identifier-property-name' };
  }
  // Form a': JSON.parse(...)[ 'field' ]   →   shape = { field }
  if (ts.isElementAccessExpression(parent) && parent.expression === parseCall) {
    const arg = parent.argumentExpression;
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      return { opaque: false, keys: [arg.text] };
    }
    return { opaque: true, reason: 'dynamic-element-access' };
  }
  // Form b: const { a, b } = JSON.parse(...)   →   shape = { a, b }
  // Form c: const o = JSON.parse(...); … o.a, o.b …   →   walk usages
  if (ts.isVariableDeclaration(parent) && parent.initializer === parseCall) {
    const binding = parent.name;
    if (ts.isObjectBindingPattern(binding)) {
      const keys = [];
      for (const el of binding.elements) {
        if (el.dotDotDotToken) return { opaque: true, reason: 'rest-destructure' };
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key)) {
          keys.push(key.text);
        } else if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
          keys.push(key.text);
        } else {
          return { opaque: true, reason: 'non-identifier-destructure-key' };
        }
      }
      if (keys.length === 0) return { opaque: true, reason: 'empty-destructure' };
      return { opaque: false, keys: [...new Set(keys)].sort() };
    }
    if (ts.isIdentifier(binding)) {
      return extractReadShapeFromUsages(binding.text, parent, sourceFile);
    }
    return { opaque: true, reason: 'complex-binding-pattern' };
  }
  // Any other parent context (inside an expression, return value, etc.)
  // — for v1 we don't track the result. This deliberately misses things
  // like `return JSON.parse(...)` / `callee(JSON.parse(...))`, which is
  // fine for the slice; the reader's consumer is where the shape would
  // actually be observed, and that consumer's call site is outside our
  // scope for v1.
  return { opaque: true, reason: 'parsed-value-not-directly-accessed' };
}

/**
 * For `const <varName> = JSON.parse(...)`, scan the enclosing function /
 * module scope for property and element accesses on `<varName>`, collect
 * literal top-level keys. Returns the same { opaque, keys?, reason? }
 * shape as extractReadShape.
 */
function extractReadShapeFromUsages(varName, bindingDecl, sourceFile) {
  // Enclosing scope is the innermost function-like ancestor, or the
  // SourceFile if the binding is at module scope.
  let scope = bindingDecl.parent;
  while (scope && !isFunctionLike(scope) && scope.kind !== ts.SyntaxKind.SourceFile) {
    scope = scope.parent;
  }
  if (!scope) return { opaque: true, reason: 'no-enclosing-scope' };

  const keys = new Set();
  let hasOpaqueAccess = false;

  function visit(node) {
    // o.<ident>
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === varName
    ) {
      if (ts.isIdentifier(node.name)) keys.add(node.name.text);
      else hasOpaqueAccess = true;
    }
    // o['<literal>'] or o[dynamic]
    if (
      ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === varName
    ) {
      const arg = node.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        keys.add(arg.text);
      } else {
        hasOpaqueAccess = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);

  if (keys.size === 0) {
    return {
      opaque: true,
      reason: hasOpaqueAccess ? 'only-dynamic-accesses-on-binding' : 'binding-not-accessed',
    };
  }
  return {
    opaque: false,
    keys: [...keys].sort(),
    partial: hasOpaqueAccess || undefined,
  };
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
 * Analyse a single source file. Returns { writes: [...], reads: [...] }
 * where each entry has { storage, key, line, column, opaque, keys?,
 * reason?, snippet }.
 */
export function analyzeSource(code, filePath) {
  const sf = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const foldMap = buildFoldMap(sf);
  const writes = [];
  const reads = [];

  function snippetOf(node) {
    return node.getText(sf).split('\n')[0].slice(0, 200);
  }
  function locOf(node) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, column: character + 1 };
  }

  function visit(node) {
    // ----- write side: storage.setItem(literalKey, JSON.stringify({...})) -----
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const pa = node.expression;
      if (ts.isIdentifier(pa.name) && pa.name.text === 'setItem') {
        const storage = storageNameOf(pa.expression);
        if (storage) {
          const resolvedKey = resolveStringArg(node.arguments[0], sf, foldMap);
          if (!resolvedKey.dynamic && resolvedKey.value !== null) {
            const shape = extractWriteShape(node);
            const { line, column } = locOf(node);
            writes.push({
              storage,
              key: resolvedKey.value,
              foldedFrom: resolvedKey.foldedFrom,
              line,
              column,
              snippet: snippetOf(node),
              ...shape,
            });
          }
        }
      }
    }

    // ----- read side: JSON.parse(<something that wraps storage.getItem(literalKey)>) -----
    if (isJsonParseCall(node)) {
      const rawArg = node.arguments[0];
      if (rawArg) {
        const inner = unwrapParseArg(rawArg);
        const hit = storageGetItemKey(inner, sf, foldMap);
        if (hit) {
          const shape = extractReadShape(node, sf);
          const { line, column } = locOf(node);
          reads.push({
            storage: hit.storage,
            key: hit.key,
            foldedFrom: hit.foldedFrom,
            line,
            column,
            snippet: snippetOf(node),
            ...shape,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { writes, reads };
}

/**
 * Run shape-drift across N project roots. Groups all write and read
 * sites by (storage, key), then emits a finding per channel where both
 * sides have ≥1 literal-shape observation AND the union shapes disagree.
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  /** @type {Map<string, { storage, key, writes: any[], reads: any[] }>} */
  const channels = new Map();

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      let code;
      try {
        code = fs.readFileSync(absFile, 'utf8');
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = analyzeSource(code, absFile);
      } catch {
        continue;
      }
      const rel = path.relative(project.root, absFile);
      for (const w of parsed.writes) {
        const id = `${w.storage}:${w.key}`;
        if (!channels.has(id)) channels.set(id, { storage: w.storage, key: w.key, writes: [], reads: [] });
        channels.get(id).writes.push({ ...w, project: project.id, file: rel });
      }
      for (const r of parsed.reads) {
        const id = `${r.storage}:${r.key}`;
        if (!channels.has(id)) channels.set(id, { storage: r.storage, key: r.key, writes: [], reads: [] });
        channels.get(id).reads.push({ ...r, project: project.id, file: rel });
      }
    }
  }

  const findings = [];
  for (const { storage, key, writes, reads } of channels.values()) {
    const literalWrites = writes.filter((w) => !w.opaque);
    const literalReads = reads.filter((r) => !r.opaque);

    // v1 emission rule: need at least one literal shape on BOTH sides to
    // have any basis for comparison.
    if (literalWrites.length === 0 || literalReads.length === 0) continue;

    const writeShape = new Set();
    for (const w of literalWrites) for (const k of w.keys) writeShape.add(k);
    const readShape = new Set();
    for (const r of literalReads) for (const k of r.keys) readShape.add(k);

    const writeOnlyKeys = [...writeShape].filter((k) => !readShape.has(k)).sort();
    const readOnlyKeys = [...readShape].filter((k) => !writeShape.has(k)).sort();

    if (writeOnlyKeys.length === 0 && readOnlyKeys.length === 0) continue;

    const occurrences = [
      ...writes.map((w) => {
        const occ = {
          project: w.project,
          file: w.file,
          line: w.line,
          column: w.column,
          op: 'write',
          shape: w.opaque ? null : w.keys,
          opaque: w.opaque,
          reason: w.reason ?? null,
          snippet: w.snippet,
        };
        if (w.foldedFrom) occ.foldedFrom = w.foldedFrom;
        return occ;
      }),
      ...reads.map((r) => {
        const occ = {
          project: r.project,
          file: r.file,
          line: r.line,
          column: r.column,
          op: 'read',
          shape: r.opaque ? null : r.keys,
          opaque: r.opaque,
          reason: r.reason ?? null,
          partial: r.partial ?? undefined,
          snippet: r.snippet,
        };
        if (r.foldedFrom) occ.foldedFrom = r.foldedFrom;
        return occ;
      }),
    ];

    findings.push({
      kind: 'shape-drift',
      storage,
      key,
      writeShape: [...writeShape].sort(),
      readShape: [...readShape].sort(),
      writeOnlyKeys,
      readOnlyKeys,
      opaqueWrites: writes.length - literalWrites.length,
      opaqueReads: reads.length - literalReads.length,
      occurrences,
    });
  }

  findings.sort((a, b) => {
    if (a.storage !== b.storage) return a.storage < b.storage ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map((p) => ({ id: p.id, root: p.root })),
    findings,
  };
}

/**
 * Human-facing summary for the CLI.
 */
export function summarize(result) {
  const byStorage = { localStorage: 0, sessionStorage: 0 };
  let withReadOnlyDrift = 0;
  let withWriteOnlyDrift = 0;
  let withBothDrift = 0;
  for (const f of result.findings) {
    byStorage[f.storage] = (byStorage[f.storage] ?? 0) + 1;
    const r = f.readOnlyKeys.length > 0;
    const w = f.writeOnlyKeys.length > 0;
    if (r && w) withBothDrift++;
    else if (r) withReadOnlyDrift++;
    else if (w) withWriteOnlyDrift++;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byStorage,
    withReadOnlyDrift,
    withWriteOnlyDrift,
    withBothDrift,
  };
}
