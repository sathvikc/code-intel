// Same-file string-literal constant folding.
//
// Shared helper used by the detectors that extract a string key or event
// channel from a call argument. Without folding, a pattern as ordinary as
//
//   const APP_SESSION_KEY = 'app.session';
//   localStorage.setItem(APP_SESSION_KEY, v);
//
// shows up as `dynamic: true` with expression text `APP_SESSION_KEY`,
// which is technically correct but practically useless — the key is
// right there in the file. Folding resolves the identifier to its
// literal so the coupling / shape-drift / paired-keys / event-channel
// detectors can see through the constant.
//
// v1 scope (deliberately narrow; the gaps are logged in OPEN_QUESTIONS):
//
//   - SAME FILE ONLY. Imported / re-exported / barrel-indirected
//     constants are not followed. The fold map is built per source file.
//   - `const X = "literal"` or never-reassigned `let X = "literal"`.
//     `var` is excluded (hoisting semantics make the analysis
//     noisier than the win is worth for v1).
//   - Initializer must be a bare StringLiteral or a
//     NoSubstitutionTemplateLiteral. No concatenation, no substituted
//     templates, no property accesses, no function calls.
//   - Binding name must be a plain Identifier. Destructuring patterns
//     (`const { X } = obj`, `const [X] = arr`) are skipped.
//   - If the binding's name is ever written to anywhere in the file
//     (assignment, compound assignment, `++`/`--`, destructuring
//     assignment target), no binding of that name folds — even
//     unrelated ones in sibling scopes. This is conservative on
//     purpose.
//   - Temporal dead zone is respected in the cheap form: a use site
//     must appear strictly AFTER its declaration's start position.
//     Hoisting-style use-before-decl is not folded.
//   - Nearest-declaration-wins resolution. When two foldable bindings
//     share a name in nested scopes, the use site sees the one whose
//     containing scope is innermost.
//
// Output-schema impact: when folding fires, the consuming detector
// records a `foldedFrom: <identifier-name>` field on the occurrence.
// Inline literals keep `foldedFrom` absent/null. No other field
// changes. This is additive and safe under the stable-schema decision.

import ts from 'typescript';
import { isAssignmentOperator } from './ast-helpers.js';

/**
 * Per-file fold map. Opaque to callers; consume via `resolveFoldedIdentifier`
 * or `resolveStringArg`.
 *
 * Internally: a map from identifier name to all foldable declarations of
 * that name in the file, each carrying its enclosing scope node so that
 * the resolver can do nearest-scope lookup in O(#candidates) without
 * re-walking the AST.
 */
export function buildFoldMap(sourceFile) {
  const reassignedNames = collectReassignedNames(sourceFile);
  /** @type {Map<string, Array<{ decl: ts.VariableDeclaration, value: string, scope: ts.Node }>>} */
  const declarationsByName = new Map();
  /**
   * A strictly larger map than `declarationsByName`: every non-reassigned
   * `const` / `let` binding, keyed by name, regardless of initializer
   * shape. Consumed by `resolveSameScopeBinding` for single-hop alias
   * follow (e.g. `const raw = storage.getItem(K); JSON.parse(raw)` or
   * `const fwd = new CustomEvent('X'); dispatchEvent(fwd)`). Kept
   * separate so the string-literal fold path stays untouched.
   *
   * @type {Map<string, Array<{ decl: ts.VariableDeclaration, init: ts.Expression, scope: ts.Node }>>}
   */
  const bindingsByName = new Map();
  collectCandidateDeclarations(sourceFile, declarationsByName, bindingsByName, reassignedNames);
  return { declarationsByName, bindingsByName, reassignedNames };
}

/**
 * Resolve an Identifier use site to its nearest-scope foldable binding.
 * Returns `{ value, name }` on success, `null` otherwise.
 *
 * This is a cheap, purely-syntactic resolver. It does not consult the
 * TypeScript checker. Correctness relies on the reassignment pre-pass
 * excluding any name that is written to in the file.
 */
export function resolveFoldedIdentifier(useNode, foldMap) {
  if (!useNode || !ts.isIdentifier(useNode)) return null;
  const name = useNode.text;
  const candidates = foldMap.declarationsByName.get(name);
  if (!candidates || candidates.length === 0) return null;

  const usePos = useNode.getStart();
  let best = null;
  let bestScopeStart = -1;

  for (const cand of candidates) {
    const scopeStart = cand.scope.getStart();
    const scopeEnd = cand.scope.getEnd();
    if (usePos < scopeStart || usePos > scopeEnd) continue;
    if (cand.decl.getStart() >= usePos) continue; // use-before-decl guard
    if (scopeStart > bestScopeStart) {
      best = cand;
      bestScopeStart = scopeStart;
    }
  }

  return best ? { value: best.value, name } : null;
}

/**
 * Resolve an Identifier use-site to the initializer expression of its
 * nearest-scope non-reassigned `const` / `let` binding. Single-hop only:
 * the returned `init` is exactly whatever the declaration wrote, not
 * recursively resolved.
 *
 * This is the generalised cousin of `resolveFoldedIdentifier` — same
 * reassignment / scope / use-before-decl discipline, but returns the
 * raw initializer node instead of filtering to string literals. Used
 * by detectors that want to look through one level of aliasing:
 *
 *   const raw = localStorage.getItem(K);  // ← init is a CallExpression
 *   JSON.parse(raw).field                  // ← alias-follow: init reveals K
 *
 *   const fwd = new CustomEvent('X');      // ← init is a NewExpression
 *   window.dispatchEvent(fwd);             // ← alias-follow: init reveals 'X'
 *
 * @returns {{ init: import('typescript').Expression, name: string, decl: import('typescript').VariableDeclaration } | null}
 */
export function resolveSameScopeBinding(useNode, foldMap) {
  if (!useNode || !ts.isIdentifier(useNode)) return null;
  const name = useNode.text;
  const candidates = foldMap.bindingsByName.get(name);
  if (!candidates || candidates.length === 0) return null;

  const usePos = useNode.getStart();
  let best = null;
  let bestScopeStart = -1;

  for (const cand of candidates) {
    const scopeStart = cand.scope.getStart();
    const scopeEnd = cand.scope.getEnd();
    if (usePos < scopeStart || usePos > scopeEnd) continue;
    if (cand.decl.getStart() >= usePos) continue; // use-before-decl guard
    if (scopeStart > bestScopeStart) {
      best = cand;
      bestScopeStart = scopeStart;
    }
  }

  return best ? { init: best.init, name, decl: best.decl } : null;
}

/**
 * Resolve a call argument node to a uniform shape used by the detectors
 * that extract keys/channels from string args.
 *
 *   { value, dynamic, expressionText, foldedFrom, foldedFromModule? }
 *
 * - Inline StringLiteral / NoSubstitutionTemplateLiteral:
 *     value = text, dynamic = false, foldedFrom = null
 * - Identifier that folds to a literal via same-file declaration:
 *     value = literal, dynamic = false, foldedFrom = identifier name
 * - Identifier that folds to a literal via cross-file import
 *   (only when `crossFileResolver` is provided):
 *     value = literal, dynamic = false,
 *     foldedFrom = identifier name, foldedFromModule = module specifier
 * - Anything else:
 *     value = null, dynamic = true, foldedFrom = null
 *
 * `expressionText` is the original source text of the argument node,
 * preserved so downstream consumers still see the raw expression
 * (useful for reporting and for disambiguating distinct dynamic sites).
 *
 * `crossFileResolver`, when passed, has the signature
 *   (identifierName: string, fromFile: string) =>
 *     { value: string, moduleSource: string, importedAs: string } | null
 * and is consulted only after same-file folding fails. Same-file
 * declarations always win — if a file shadows an imported constant
 * with a local binding of the same name, the local binding is used.
 */
export function resolveStringArg(argNode, sourceFile, foldMap, crossFileResolver) {
  if (!argNode) {
    return { value: null, dynamic: true, expressionText: '', foldedFrom: null };
  }
  if (ts.isStringLiteral(argNode) || ts.isNoSubstitutionTemplateLiteral(argNode)) {
    return {
      value: argNode.text,
      dynamic: false,
      expressionText: argNode.text,
      foldedFrom: null,
    };
  }
  const folded = resolveFoldedIdentifier(argNode, foldMap);
  if (folded) {
    return {
      value: folded.value,
      dynamic: false,
      expressionText: argNode.getText(sourceFile),
      foldedFrom: folded.name,
    };
  }
  if (crossFileResolver && ts.isIdentifier(argNode)) {
    const xfile = crossFileResolver(argNode.text, sourceFile.fileName);
    if (xfile) {
      return {
        value: xfile.value,
        dynamic: false,
        expressionText: argNode.getText(sourceFile),
        foldedFrom: argNode.text,
        foldedFromModule: xfile.moduleSource,
      };
    }
  }
  return {
    value: null,
    dynamic: true,
    expressionText: argNode.getText(sourceFile),
    foldedFrom: null,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Every identifier name that is the target of an assignment or mutation
 * anywhere in the file. Used to conservatively exclude non-constant
 * bindings from folding.
 */
function collectReassignedNames(sourceFile) {
  /** @type {Set<string>} */
  const reassigned = new Set();

  function addIfIdent(node) {
    if (node && ts.isIdentifier(node)) reassigned.add(node.text);
  }

  /**
   * Destructuring assignment targets look like `({a} = obj)` or
   * `[a] = arr` — walk the pattern and mark each identifier leaf.
   * (Not to be confused with destructuring DECLARATIONS, which are
   * already excluded at candidate-collection time.)
   */
  function markPatternTargets(node) {
    if (!node) return;
    if (ts.isIdentifier(node)) {
      reassigned.add(node.text);
      return;
    }
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
      else if (
        ts.isObjectLiteralExpression(lhs)
        || ts.isArrayLiteralExpression(lhs)
      ) {
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
 * Walk every VariableDeclaration once and populate both the
 * string-literal fold map (`byName`) and the broader same-scope binding
 * map (`bindingsByName`). Both maps share the same reassignment pre-pass
 * and the same nearest-scope resolution semantics.
 */
function collectCandidateDeclarations(sourceFile, byName, bindingsByName, reassignedNames) {
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      if (list && ts.isVariableDeclarationList(list)) {
        const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
        const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
        // `var` deliberately excluded in v1 — its hoisting semantics
        // interact poorly with the cheap use-before-decl check.
        const name = node.name.text;
        if ((isConst || isLet) && !reassignedNames.has(name)) {
          const init = node.initializer;
          if (init) {
            const scope = enclosingScope(node);
            if (scope) {
              // Always register in the broader binding map.
              if (!bindingsByName.has(name)) bindingsByName.set(name, []);
              bindingsByName.get(name).push({ decl: node, init, scope });
              // Register in the string-literal fold map only if the
              // initializer is a bare string literal.
              if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
                if (!byName.has(name)) byName.set(name, []);
                byName.get(name).push({ decl: node, value: init.text, scope });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

/**
 * Innermost function-like ancestor, or the SourceFile itself for a
 * module-scope declaration. Used to bound where a binding is visible.
 */
function enclosingScope(node) {
  let p = node.parent;
  while (p) {
    if (isFunctionLike(p) || p.kind === ts.SyntaxKind.SourceFile) return p;
    p = p.parent;
  }
  return null;
}

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

