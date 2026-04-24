// structural-drift detector (P12).
//
// Detects exported const object literals whose declared shape diverges from
// how importers access them. Example:
//
//   // src/config.js
//   export const CFG = { foo_host: 'a', foo_path: '/b' };
//
//   // src/api.js
//   import { CFG } from './config';
//   const url = `${CFG.host}${CFG.path}`;  // typo — foo_host / foo_path
//
// `readOnlyKeys: ['host', 'path']` triggers the finding.
//
// Algorithm:
//   Pass 1 — declarations: collect all object exports across all files.
//   Pass 2 — readers: for each import that maps to an object export, walk
//             the importer's AST for property access / destructure usages.
//   Pass 3 — emit: compare declared shape vs union of reader shapes; emit
//             when readOnlyKeys (accessed-but-not-declared) is non-empty.
//
// Known gaps (v1):
//   - `export { X } from '...'` re-export chains: one-hop only (via
//     resolveObjectExport). Deeper chains are skipped.
//   - `export * from '...'` barrel re-exports are not followed for
//     object exports (string-constant barrels are followed by the
//     cross-file-constants machinery; object exports are not).
//   - Namespace imports `import * as NS from ...` are not tracked.
//   - Dynamic property access `CFG[expr]` marks the reader as partial
//     and contributes no keys; finding is still emitted based on other
//     clear readers.
//   - Nested property drift (e.g. CFG.sub.key) — only top-level keys.
//
// Output schema version: 0.1
// Finding kind: "structural-drift"

import ts from 'typescript';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { readSource, scriptKindFor } from './framework-file.js';
import { buildConstantsIndex, collectImports, resolveObjectExport } from './cross-file-constants.js';
import { extractObjectLiteralKeys, extractReadShapeFromUsages } from './shape-drift.js';
import { loadAliases, resolveImport } from './import-graph.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'structural-drift';

// ---------------------------------------------------------------------------
// Usage walker: extract what keys a reader accesses on a named binding
// ---------------------------------------------------------------------------

/**
 * Walk a source file's AST and collect all property / destructure accesses
 * on a given local binding name.
 *
 * Returns:
 *   {
 *     shape: string[] | null,   // sorted key set, or null if partial-only
 *     partial: boolean,         // true if any dynamic/opaque access found
 *     occurrences: Array<{ line, col, snippet, shape, partial?, reason? }>
 *   }
 *
 * "partial" means there was a dynamic access (CFG[expr], spread {...CFG},
 * or mutation CFG.x = ...) that we can't interpret as a literal key access.
 * When partial=true and no clear keys were found, shape=null.
 */
function collectBindingUsages(localName, sourceFile) {
  const keys = new Set();
  let hasOpaqueAccess = false;
  const occurrences = [];

  function snippetOf(node) {
    return node.getText(sourceFile).split('\n')[0].slice(0, 200);
  }
  function locOf(node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: line + 1, col: character + 1 };
  }

  // Walk for destructuring patterns: `const { a, b } = localName`
  function visitDestructure(bindingPattern, node) {
    const loc = locOf(node);
    const innerKeys = [];
    let innerPartial = false;
    for (const el of bindingPattern.elements) {
      if (el.dotDotDotToken) {
        innerPartial = true;
        continue;
      }
      const keyNode = el.propertyName ?? el.name;
      if (ts.isIdentifier(keyNode)) {
        innerKeys.push(keyNode.text);
      } else if (ts.isStringLiteral(keyNode) || ts.isNoSubstitutionTemplateLiteral(keyNode)) {
        innerKeys.push(keyNode.text);
      } else {
        innerPartial = true;
      }
    }
    for (const k of innerKeys) keys.add(k);
    if (innerPartial) hasOpaqueAccess = true;
    const sortedKeys = [...new Set(innerKeys)].sort();
    occurrences.push({
      ...loc,
      snippet: snippetOf(node),
      shape: sortedKeys.length > 0 ? sortedKeys : null,
      ...(innerPartial ? { partial: true } : {}),
    });
  }

  function visit(node) {
    // Property access: localName.key
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === localName
    ) {
      // Mutation guard: localName.key = ... is a write, mark partial
      const parent = node.parent;
      const isMutation =
        ts.isBinaryExpression(parent)
        && parent.left === node
        && isBinaryAssignment(parent.operatorToken.kind);

      if (isMutation) {
        hasOpaqueAccess = true;
        const loc = locOf(node);
        occurrences.push({
          ...loc,
          snippet: snippetOf(parent),
          partial: true,
          reason: 'mutation',
          shape: null,
        });
      } else if (ts.isIdentifier(node.name)) {
        keys.add(node.name.text);
        const loc = locOf(node);
        occurrences.push({
          ...loc,
          snippet: snippetOf(node),
          shape: [node.name.text],
        });
      } else {
        hasOpaqueAccess = true;
      }
      // Don't recurse into node.expression (already checked) but DO
      // recurse into the rest — let forEachChild handle it; we just
      // don't want to double-count this node. Fall through to forEachChild.
    }

    // Element access: localName['key'] or localName[expr]
    if (
      ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === localName
    ) {
      const arg = node.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        keys.add(arg.text);
        const loc = locOf(node);
        occurrences.push({ ...loc, snippet: snippetOf(node), shape: [arg.text] });
      } else {
        hasOpaqueAccess = true;
        const loc = locOf(node);
        occurrences.push({
          ...loc,
          snippet: snippetOf(node),
          partial: true,
          reason: 'dynamic-element-access',
          shape: null,
        });
      }
    }

    // Spread: { ...localName } — opaque
    if (ts.isSpreadAssignment(node) && ts.isIdentifier(node.expression) && node.expression.text === localName) {
      hasOpaqueAccess = true;
      const loc = locOf(node);
      occurrences.push({
        ...loc,
        snippet: snippetOf(node),
        partial: true,
        reason: 'spread',
        shape: null,
      });
    }

    // Destructuring: const { a, b } = localName
    if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isIdentifier(node.initializer)
      && node.initializer.text === localName
      && ts.isObjectBindingPattern(node.name)
    ) {
      visitDestructure(node.name, node);
      // Don't recurse further into this var decl's children — we handled it.
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const sortedKeys = [...keys].sort();
  return {
    shape: sortedKeys.length > 0 ? sortedKeys : null,
    partial: hasOpaqueAccess,
    occurrences,
  };
}

function isBinaryAssignment(kind) {
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

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

/**
 * Run structural-drift across N project roots.
 *
 * Returns { findings: WrappedFinding[], fileCount, errorCount }
 */
export function analyzeStructuralDriftProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const astCache = opts.astCache;

  // Build a constants index that includes objectExportsByFile.
  const index = buildConstantsIndex(projects, { exclude, astCache });

  let fileCount = 0;
  let errorCount = 0;

  // groupKey → { keys, line, col, snippet, project, file, exportedName, absFile }
  const declarationsByKey = new Map();
  // groupKey → Array<{ file, absFile, line, col, shape, partial, project, importedAs, fromModule, snippet, usageOccurrences }>
  const readersByKey = new Map();

  // ---------- Pass 1 & 2: walk all files ----------
  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      fileCount++;

      // Parse or use cached AST.
      let sourceFile;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) { fileCount--; continue; }
        sourceFile = cached.sourceFile;
      } else {
        let code;
        try { code = readSource(absFile); } catch { errorCount++; continue; }
        try {
          sourceFile = ts.createSourceFile(
            absFile,
            code,
            ts.ScriptTarget.Latest,
            /* setParentNodes */ true,
            scriptKindFor(absFile),
          );
        } catch { errorCount++; continue; }
      }

      const rel = path.relative(project.root, absFile);

      // --- Pass 1: declarations ---
      const objExports = index.objectExportsByFile.get(absFile);
      if (objExports) {
        for (const [exportedName, entry] of objExports) {
          const groupKey = `${absFile}::${exportedName}`;
          declarationsByKey.set(groupKey, {
            ...entry,
            exportedName,
            absFile,
            file: rel,
            project: project.id,
          });
        }
      }

      // --- Pass 2: readers ---
      // For each import in this file, check if it maps to an object export.
      const imports = index.importsByFile.get(absFile);
      if (!imports) continue;

      for (const [localName, binding] of imports) {
        const aliases = index.aliasesByFile.get(absFile) ?? {};
        const targetAbs = resolveImport(binding.module, absFile, aliases);
        if (!targetAbs) continue;

        // Check direct match in objectExportsByFile first.
        let objectEntry = null;
        let resolvedFile = null;
        let resolvedExportedName = null;

        const directExports = index.objectExportsByFile.get(targetAbs);
        if (directExports) {
          const entry = directExports.get(binding.exportedName);
          if (entry) {
            objectEntry = entry;
            resolvedFile = targetAbs;
            resolvedExportedName = binding.exportedName;
          }
        }

        // If no direct match, try one-hop re-export via resolveObjectExport.
        if (!objectEntry) {
          const resolved = resolveObjectExport(absFile, localName, index);
          if (resolved) {
            objectEntry = { keys: resolved.keys, line: resolved.line, col: resolved.col, snippet: resolved.snippet };
            resolvedFile = resolved.file;
            resolvedExportedName = resolved.exportedName;
          }
        }

        if (!objectEntry || !resolvedFile) continue;

        const groupKey = `${resolvedFile}::${resolvedExportedName}`;

        // Walk this file for usages of localName.
        let usages;
        try {
          usages = collectBindingUsages(localName, sourceFile);
        } catch {
          errorCount++;
          continue;
        }

        if (!readersByKey.has(groupKey)) readersByKey.set(groupKey, []);
        readersByKey.get(groupKey).push({
          file: rel,
          absFile,
          project: project.id,
          importedAs: localName,
          fromModule: binding.module,
          shape: usages.shape,
          partial: usages.partial,
          usageOccurrences: usages.occurrences,
          // Pick the first non-opaque occurrence's location, or fallback to import location.
          line: usages.occurrences[0]?.line ?? 1,
          col: usages.occurrences[0]?.col ?? 1,
          snippet: usages.occurrences[0]?.snippet ?? '',
        });
      }
    }
  }

  // ---------- Pass 3: emit ----------
  const findings = [];

  for (const [groupKey, decl] of declarationsByKey) {
    const readers = readersByKey.get(groupKey) ?? [];

    // Aggregate read shape from non-partial readers.
    const readShape = new Set();
    let opaqueReaders = 0;

    for (const r of readers) {
      if (r.partial && (!r.shape || r.shape.length === 0)) {
        opaqueReaders++;
      } else if (r.shape) {
        for (const k of r.shape) readShape.add(k);
        if (r.partial) opaqueReaders++; // partial but also has some clear keys
      } else {
        opaqueReaders++;
      }
    }

    const declaredKeys = new Set(decl.keys);
    const readOnlyKeys = [...readShape].filter((k) => !declaredKeys.has(k)).sort();
    const writeOnlyKeys = [...declaredKeys].filter((k) => !readShape.has(k)).sort();

    // Emit only when readOnlyKeys is non-empty (accessed-but-not-declared).
    if (readOnlyKeys.length === 0) continue;

    // Build occurrences list.
    const occurrences = [];

    // Declaration occurrence.
    const moduleRel = path.relative(
      projects.find((p) => path.resolve(decl.absFile).startsWith(path.resolve(p.root) + path.sep) ||
                           path.resolve(decl.absFile) === path.resolve(p.root))?.root ?? projects[0]?.root ?? '',
      decl.absFile,
    );

    occurrences.push({
      project: decl.project,
      file: decl.file,
      line: decl.line,
      column: decl.col,
      op: 'declare',
      shape: decl.keys,
      snippet: decl.snippet,
    });

    // Reader occurrences.
    for (const r of readers) {
      const baseOcc = {
        project: r.project,
        file: r.file,
        line: r.line,
        column: r.col,
        op: 'read',
        shape: r.shape,
        snippet: r.snippet,
        importedAs: r.importedAs,
        fromModule: r.fromModule,
      };
      if (r.partial) baseOcc.partial = true;
      occurrences.push(baseOcc);
    }

    const moduleRelPath = decl.file;

    findings.push({
      kind: 'structural-drift',
      module: moduleRelPath,
      exportedName: decl.exportedName,
      declaredShape: [...declaredKeys].sort(),
      readShape: [...readShape].sort(),
      readOnlyKeys,
      writeOnlyKeys,
      opaqueReaders,
      occurrences,
    });
  }

  findings.sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    return a.exportedName.localeCompare(b.exportedName);
  });

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map((p) => ({ id: p.id, root: p.root })),
    findings,
    fileCount,
    errorCount,
  };
}

/**
 * Standard registry interface alias for analyzeStructuralDriftProjects.
 */
export const analyzeProjects = analyzeStructuralDriftProjects;

/**
 * Human-facing summary for the CLI.
 */
export function summarize(findings) {
  if (Array.isArray(findings)) {
    return [`structural-drift: ${findings.length} drifted export(s)`];
  }
  // Also handle result envelope for compatibility.
  const list = findings?.findings ?? [];
  return [`structural-drift: ${list.length} drifted export(s)`];
}
