import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

import { isAssignmentOperator } from '../src/ast-helpers.js';

// ---------- positive: all 16 ECMAScript compound-assignment operators ----------

test('isAssignmentOperator: returns true for all 16 compound-assignment operators', () => {
  const yes = [
    ['EqualsToken (=)', ts.SyntaxKind.EqualsToken],
    ['PlusEqualsToken (+=)', ts.SyntaxKind.PlusEqualsToken],
    ['MinusEqualsToken (-=)', ts.SyntaxKind.MinusEqualsToken],
    ['AsteriskEqualsToken (*=)', ts.SyntaxKind.AsteriskEqualsToken],
    ['AsteriskAsteriskEqualsToken (**=)', ts.SyntaxKind.AsteriskAsteriskEqualsToken],
    ['SlashEqualsToken (/=)', ts.SyntaxKind.SlashEqualsToken],
    ['PercentEqualsToken (%=)', ts.SyntaxKind.PercentEqualsToken],
    ['LessThanLessThanEqualsToken (<<=)', ts.SyntaxKind.LessThanLessThanEqualsToken],
    ['GreaterThanGreaterThanEqualsToken (>>=)', ts.SyntaxKind.GreaterThanGreaterThanEqualsToken],
    ['GreaterThanGreaterThanGreaterThanEqualsToken (>>>=)', ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken],
    ['AmpersandEqualsToken (&=)', ts.SyntaxKind.AmpersandEqualsToken],
    ['BarEqualsToken (|=)', ts.SyntaxKind.BarEqualsToken],
    ['CaretEqualsToken (^=)', ts.SyntaxKind.CaretEqualsToken],
    ['AmpersandAmpersandEqualsToken (&&=)', ts.SyntaxKind.AmpersandAmpersandEqualsToken],
    ['BarBarEqualsToken (||=)', ts.SyntaxKind.BarBarEqualsToken],
    ['QuestionQuestionEqualsToken (??=)', ts.SyntaxKind.QuestionQuestionEqualsToken],
  ];
  for (const [label, kind] of yes) {
    assert.equal(isAssignmentOperator(kind), true, `expected true for ${label}`);
  }
});

// ---------- negative: non-assignment binary operators ----------

test('isAssignmentOperator: returns false for non-assignment binary operators', () => {
  const no = [
    ['PlusToken (+)', ts.SyntaxKind.PlusToken],
    ['MinusToken (-)', ts.SyntaxKind.MinusToken],
    ['AsteriskToken (*)', ts.SyntaxKind.AsteriskToken],
    ['SlashToken (/)', ts.SyntaxKind.SlashToken],
    ['EqualsEqualsToken (==)', ts.SyntaxKind.EqualsEqualsToken],
    ['EqualsEqualsEqualsToken (===)', ts.SyntaxKind.EqualsEqualsEqualsToken],
    ['LessThanToken (<)', ts.SyntaxKind.LessThanToken],
    ['GreaterThanToken (>)', ts.SyntaxKind.GreaterThanToken],
    ['AmpersandAmpersandToken (&&)', ts.SyntaxKind.AmpersandAmpersandToken],
    ['BarBarToken (||)', ts.SyntaxKind.BarBarToken],
    ['QuestionQuestionToken (??)', ts.SyntaxKind.QuestionQuestionToken],
  ];
  for (const [label, kind] of no) {
    assert.equal(isAssignmentOperator(kind), false, `expected false for ${label}`);
  }
});

// ---------- defensive: non-token inputs ----------

test('isAssignmentOperator: returns false for undefined/null/garbage', () => {
  assert.equal(isAssignmentOperator(undefined), false);
  assert.equal(isAssignmentOperator(null), false);
  assert.equal(isAssignmentOperator(0), false);
  assert.equal(isAssignmentOperator(99999), false);
  assert.equal(isAssignmentOperator('not a kind'), false);
});

// ---------- structural: real AST tokens parsed via TS ----------

test('isAssignmentOperator: matches real BinaryExpression operator tokens for all 16 forms', () => {
  // Use TypeScript itself to parse each operator form, walk to the
  // BinaryExpression, and feed its operatorToken.kind back in. This
  // catches drift between our hardcoded SyntaxKind values and the
  // installed typescript version's actual enum.
  const sources = [
    'a = 1', 'a += 1', 'a -= 1', 'a *= 1', 'a **= 1',
    'a /= 1', 'a %= 1', 'a <<= 1', 'a >>= 1', 'a >>>= 1',
    'a &= 1', 'a |= 1', 'a ^= 1', 'a &&= 1', 'a ||= 1', 'a ??= 1',
  ];
  for (const src of sources) {
    const sf = ts.createSourceFile('t.ts', `${src};`, ts.ScriptTarget.Latest, true);
    let found = null;
    function visit(node) {
      if (ts.isBinaryExpression(node) && !found) found = node;
      ts.forEachChild(node, visit);
    }
    visit(sf);
    assert.ok(found, `failed to parse: ${src}`);
    assert.equal(
      isAssignmentOperator(found.operatorToken.kind),
      true,
      `expected isAssignmentOperator() === true for parsed: ${src}`,
    );
  }
});
