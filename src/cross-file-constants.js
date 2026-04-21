// Cross-file string-literal constant folding.
//
// The v1 fold helper (`fold-string-literals.js`) only resolves an identifier
// to its value when the declaration lives in the same file. In real
// codebases, teams almost always extract shared string keys into a
// `constants.ts` / `keys.ts` / `events.ts` module:
//
//   // src/storage/keys.ts
//   export const K_SESSION = 'app.session';
//
//   // src/session/save.ts
//   import { K_SESSION } from '../storage/keys';
//   localStorage.setItem(K_SESSION, JSON.stringify({ ... }));
//
// v1 sees `K_SESSION` as dynamic and drops the coupling signal. This
// module closes that gap by building a per-run index of every
// string-literal export across the project set, plus a resolver the
// detectors call when same-file folding fails.
//
// v2 scope (deliberately narrow; the gaps are logged in OPEN_QUESTIONS
// as follow-ups, and on `BACKLOG.md` as "Cross-file constant folding
// v2.5"):
//
//   - NAMED AND DEFAULT IMPORTS of string literals only. Namespace
//     imports (`import * as NS from ...; NS.K_SESSION`) are not
//     followed — the property-access layer is a separate story.
//   - EXPORT DECLARATIONS handled: `export const X = 'lit'`, `const X
//     = 'lit'; export { X }`, `export { X as Y }`, `export { X } from
//     './mod'`, `export { X as Y } from './mod'`, `export * from
//     './mod'`, `export default 'lit'`, `export default X` (when X is
//     a local literal).
//   - RE-EXPORT CHAINS are followed transitively with a visited set
//     to break cycles. Barrel files (`export * from ...`) are
//     expanded at lookup time.
//   - MODULE SPECIFIER RESOLUTION reuses `resolveImport` from
//     `import-graph.js`: tsconfig path aliases, relative imports,
//     extension candidates, and index files. Bare (node_modules)
//     specifiers skip cleanly.
//   - TEMPORAL DEAD ZONE is not a concern here: by construction, an
//     ES-module `import` sees the final bindings of the target
//     module, so use-order within the importing file doesn't matter.
//   - REASSIGNMENT GUARD at the export side: we skip an export if its
//     declared name is ever the target of an assignment or mutation
//     in its own file, matching the conservative rule v1 applies to
//     same-file folding.
//
// Out of scope for v2 (intentional; keeps the surface small):
//
//   - `import * as NS` namespace imports.
//   - Object-literal exports read by property (`import { KEYS };
//     KEYS.SESSION`) — this is an object-member extension, not a
//     constant-fold extension.
//   - CommonJS `require('./keys').X`.
//   - Computed values (`export const K = getKey()`), template
//     literals with substitutions, concatenations.
//   - Dynamic imports (`await import('./keys')`).
//   - JSON imports.
//
// Output-schema impact (additive, same spirit as v1's `foldedFrom`):
// when a cross-file fold fires, the consumer records an additional
// `foldedFromModule: <module-specifier>` on the occurrence. Old
// consumers keep seeing `foldedFrom` as the identifier name; new
// consumers get the import path too.

import ts from 'typescript';
import fs from 'node:fs';
import { walkSourceFiles } from './project.js';
import { readSource, scriptKindFor } from './framework-file.js';
import { loadAliases, resolveImport } from './import-graph.js';

// ---------------------------------------------------------------------------
// Per-file collectors
// ---------------------------------------------------------------------------

/**
 * Collect every string-literal export from a single file's top level.
 *
 * Returns:
 *   {
 *     namedExports: Map<exportedName, Entry>,
 *     starReexports: string[],      // module specifiers (`export * from '...'`)
 *   }
 *
 * Entry variants:
 *   { kind: 'literal', value: string }
 *   { kind: 'reexport', module: string, originalName: string }
 *
 * A local `const X = 'lit'` is only registered under `namedExports` if
 * X is actually exported (via `export const` or a later `export { X }`).
 * A local X that is ever the target of assignment/mutation is excluded
 * (matches the reassignment guard in same-file folding).
 */
export function collectExports(sourceFile) {
  const namedExports = new Map();
  const starReexports = [];

  const reassigned = collectReassignedNames(sourceFile);
  const localLiterals = collectLocalLiteralBindings(sourceFile, reassigned);

  // Walk top-level statements only. Exports at inner scopes are not
  // real ES module exports.
  for (const stmt of sourceFile.statements) {
    // `export const X = 'lit', Y = 'lit2'` / `export let Z = 'lit'`
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      const hasDefault = hasDefaultModifier(stmt);
      const list = stmt.declarationList;
      const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
      const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
      // `var` excluded, matching same-file folder.
      if (!(isConst || isLet)) continue;
      for (const decl of list.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name)) continue;
        if (reassigned.has(decl.name.text)) continue;
        const value = literalStringFrom(decl.initializer);
        if (value === null) continue;
        const exportedName = hasDefault ? 'default' : decl.name.text;
        namedExports.set(exportedName, { kind: 'literal', value });
      }
      continue;
    }

    // `export { X }`, `export { X as Y }`, `export { X } from './mod'`,
    // `export { X as Y } from './mod'`, `export * from './mod'`
    if (ts.isExportDeclaration(stmt)) {
      const moduleSpec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : null;

      // `export * from '...'`
      if (!stmt.exportClause && moduleSpec) {
        starReexports.push(moduleSpec);
        continue;
      }

      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const exportedName = el.name.text;
          const originalName = el.propertyName?.text ?? el.name.text;

          if (moduleSpec) {
            // `export { X [as Y] } from './mod'`
            namedExports.set(exportedName, {
              kind: 'reexport',
              module: moduleSpec,
              originalName,
            });
          } else {
            // `export { X [as Y] }` — originalName refers to a local binding.
            const value = localLiterals.get(originalName);
            if (value !== null && value !== undefined) {
              namedExports.set(exportedName, { kind: 'literal', value });
            }
            // If the local isn't a foldable literal (function, class,
            // object, etc.), we silently drop the export — nothing
            // useful for our purposes.
          }
        }
        continue;
      }
      // `export * as NS from '...'` — namespace re-export; skip in v2
      // (matches the "no namespace imports" rule on the consumer side).
      continue;
    }

    // `export default <expression>`
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const expr = stmt.expression;
      const directLiteral = literalStringFrom(expr);
      if (directLiteral !== null) {
        namedExports.set('default', { kind: 'literal', value: directLiteral });
        continue;
      }
      if (ts.isIdentifier(expr)) {
        const local = localLiterals.get(expr.text);
        if (local !== null && local !== undefined) {
          namedExports.set('default', { kind: 'literal', value: local });
        }
      }
      continue;
    }
  }

  return { namedExports, starReexports };
}

/**
 * Collect every top-level `import` from a file, keyed by the local
 * binding name the importing file will USE. Values record where the
 * binding came from on the exporting module's side.
 *
 * Returns Map<localName, { module: string, exportedName: string }>
 *
 *   import { A } from 'x'           → A   → { module: 'x', exportedName: 'A' }
 *   import { A as B } from 'x'      → B   → { module: 'x', exportedName: 'A' }
 *   import Def from 'x'             → Def → { module: 'x', exportedName: 'default' }
 *   import Def, { A } from 'x'      → Def → { module: 'x', exportedName: 'default' }
 *                                     A   → { module: 'x', exportedName: 'A' }
 *   import * as NS from 'x'         → (skipped in v2)
 */
export function collectImports(sourceFile) {
  const imports = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const moduleSpec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    // `import type { ... }` — no runtime binding, skip.
    if (clause.isTypeOnly) continue;

    // Default binding.
    if (clause.name) {
      imports.set(clause.name.text, { module: moduleSpec, exportedName: 'default' });
    }
    // Named bindings.
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (el.isTypeOnly) continue;
        const local = el.name.text;
        const exportedName = el.propertyName?.text ?? el.name.text;
        imports.set(local, { module: moduleSpec, exportedName });
      }
    }
    // Namespace bindings intentionally skipped; see v2 scope notes.
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Index build + resolver
// ---------------------------------------------------------------------------

/**
 * Build a cross-project constants index using the per-run AST cache.
 *
 * Returns:
 *   {
 *     exportsByFile:  Map<absPath, { namedExports, starReexports }>,
 *     importsByFile:  Map<absPath, Map<localName, { module, exportedName }>>,
 *     aliasesByFile:  Map<absPath, Record<alias, targetPath>>,
 *   }
 *
 * `aliasesByFile` lets the resolver call `resolveImport` with the
 * right tsconfig aliases regardless of which project a file came from.
 * It's computed at build time rather than at query time so repeated
 * lookups don't re-read tsconfig.
 */
export function buildConstantsIndex(projects, opts = {}) {
  const exclude = opts.exclude;
  const astCache = opts.astCache;

  const exportsByFile = new Map();
  const importsByFile = new Map();
  const aliasesByFile = new Map();

  for (const project of projects) {
    const projectAliases = loadAliases(project.root)?.aliases ?? {};
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      let sourceFile;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) continue;
        sourceFile = cached.sourceFile;
      } else {
        let code;
        try { code = readSource(absFile); } catch { continue; }
        try {
          sourceFile = ts.createSourceFile(
            absFile,
            code,
            ts.ScriptTarget.Latest,
            /* setParentNodes */ true,
            scriptKindFor(absFile),
          );
        } catch { continue; }
      }

      try { exportsByFile.set(absFile, collectExports(sourceFile)); } catch { /* tolerant */ }
      try { importsByFile.set(absFile, collectImports(sourceFile)); } catch { /* tolerant */ }
      aliasesByFile.set(absFile, projectAliases);
    }
  }

  return { exportsByFile, importsByFile, aliasesByFile };
}

/**
 * Build a cross-file resolver closure from a constants index.
 *
 * The returned function has signature:
 *   (identifierName: string, fromFile: string) =>
 *     { value: string, moduleSource: string, importedAs: string } | null
 *
 * Detectors call this from inside `resolveStringArg` when same-file
 * folding misses. The closure captures the index so every detector
 * and every file reuses the same import-map / alias resolution.
 */
export function makeCrossFileResolver({ exportsByFile, importsByFile, aliasesByFile }) {
  return function resolve(identifierName, fromFile) {
    const imports = importsByFile.get(fromFile);
    if (!imports) return null;
    const binding = imports.get(identifierName);
    if (!binding) return null;

    const aliases = aliasesByFile.get(fromFile) ?? {};
    const targetAbs = resolveImport(binding.module, fromFile, aliases);
    if (!targetAbs) return null;

    const value = lookupExportValue(
      targetAbs,
      binding.exportedName,
      { exportsByFile, aliasesByFile },
      new Set(),
    );
    if (value === null) return null;

    return {
      value,
      moduleSource: binding.module,
      importedAs: identifierName,
    };
  };
}

/**
 * Recursively resolve an export name in a target file, following
 * re-export chains and star re-exports. Cycle-safe via `visited`.
 */
function lookupExportValue(absFile, exportName, ctx, visited) {
  const key = absFile + '\0' + exportName;
  if (visited.has(key)) return null;
  visited.add(key);

  const entry = ctx.exportsByFile.get(absFile);
  if (!entry) return null;

  const direct = entry.namedExports.get(exportName);
  if (direct) {
    if (direct.kind === 'literal') return direct.value;
    if (direct.kind === 'reexport') {
      const aliases = ctx.aliasesByFile.get(absFile) ?? {};
      const nextAbs = resolveImport(direct.module, absFile, aliases);
      if (!nextAbs) return null;
      return lookupExportValue(nextAbs, direct.originalName, ctx, visited);
    }
  }

  // Star re-exports: try each in order, first hit wins. This matches
  // JS semantics in the common case (conflicting star re-exports are
  // a module-resolution error we don't try to replicate here).
  for (const starModule of entry.starReexports) {
    const aliases = ctx.aliasesByFile.get(absFile) ?? {};
    const starAbs = resolveImport(starModule, absFile, aliases);
    if (!starAbs) continue;
    const value = lookupExportValue(starAbs, exportName, ctx, visited);
    if (value !== null) return value;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasExportModifier(stmt) {
  return !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(stmt) {
  return !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function literalStringFrom(expr) {
  if (!expr) return null;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

/**
 * Mirror of the same-file reassignment collector. Kept local so this
 * module has no runtime dependency on `fold-string-literals.js` (which
 * would create an import cycle when that file wires the resolver in).
 */
function collectReassignedNames(sourceFile) {
  const reassigned = new Set();
  function addIfIdent(node) {
    if (node && ts.isIdentifier(node)) reassigned.add(node.text);
  }
  function markPatternTargets(node) {
    if (!node) return;
    if (ts.isIdentifier(node)) { reassigned.add(node.text); return; }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) addIfIdent(prop.name);
        else if (ts.isPropertyAssignment(prop)) markPatternTargets(prop.initializer);
        else if (ts.isSpreadAssignment(prop)) markPatternTargets(prop.expression);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isSpreadElement(el)) markPatternTargets(el.expression);
        else if (!ts.isOmittedExpression(el)) markPatternTargets(el);
      }
    }
  }
  function visit(node) {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const lhs = node.left;
      if (ts.isIdentifier(lhs)) reassigned.add(lhs.text);
      else if (ts.isObjectLiteralExpression(lhs) || ts.isArrayLiteralExpression(lhs)) {
        markPatternTargets(lhs);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken
        || node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        addIfIdent(node.operand);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return reassigned;
}

/**
 * Local `const / let NAME = 'literal'` declarations at any scope.
 * Used to resolve `export { NAME }` back to a value. Skips any name
 * listed in `reassigned`.
 */
function collectLocalLiteralBindings(sourceFile, reassigned) {
  const byName = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      if (list && ts.isVariableDeclarationList(list)) {
        const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
        const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
        const name = node.name.text;
        if ((isConst || isLet) && !reassigned.has(name) && !byName.has(name)) {
          const value = literalStringFrom(node.initializer);
          if (value !== null) byName.set(name, value);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return byName;
}

function isAssignmentOperator(kind) {
  switch (kind) {
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return true;
    default:
      return false;
  }
}
