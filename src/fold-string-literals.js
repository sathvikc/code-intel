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
  collectCandidateDeclarations(sourceFile, declarationsByName, reassignedNames);
  return { declarationsByName, reassignedNames };
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
 * Resolve a call argument node to a uniform shape used by the detectors
 * that extract keys/channels from string args.
 *
 *   { value, dynamic, expressionText, foldedFrom }
 *
 * - Inline StringLiteral / NoSubstitutionTemplateLiteral:
 *     value = text, dynamic = false, foldedFrom = null
 * - Identifier that folds to a literal:
 *     value = literal, dynamic = false, foldedFrom = identifier name
 * - Anything else:
 *     value = null, dynamic = true, foldedFrom = null
 *
 * `expressionText` is the original source text of the argument node,
 * preserved so downstream consumers still see the raw expression
 * (useful for reporting and for disambiguating distinct dynamic sites).
 */
export function resolveStringArg(argNode, sourceFile, foldMap) {
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
 * Walk every VariableDeclaration and keep the ones that qualify as
 * foldable string-literal constants.
 */
function collectCandidateDeclarations(sourceFile, byName, reassignedNames) {
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
          if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
            const scope = enclosingScope(node);
            if (scope) {
              if (!byName.has(name)) byName.set(name, []);
              byName.get(name).push({ decl: node, value: init.text, scope });
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
