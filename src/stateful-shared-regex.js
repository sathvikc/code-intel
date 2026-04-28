// stateful-shared-regex analyzer.
//
// Detects module-scope `const` bindings initialized to a regex with the
// `g` or `y` flag (regex literal or `new RegExp(pattern, flags)` with
// string-literal arguments), where the same binding is later invoked with
// `.test(...)` or `.exec(...)` in the same file.
//
// Canonical P17 bug: a /g or /y regex at module scope carries `lastIndex`
// across every .test()/.exec() call. After a successful match the next call
// against the same input returns false. If the binding is invoked more than
// once over the module's lifetime results silently flip.
//
// Detection rule:
//   Pass 1 — collect top-level `const` declarations with a qualifying init.
//   Pass 2 — walk the whole AST for .test(...) / .exec(...) calls on that name.
//   Emit only when ≥1 use-site exists. One finding per (project, file, name).
//
// Output schema version: 0.1
// Finding kind: "stateful-shared-regex"

import ts from 'typescript';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { readSource, scriptKindFor } from './framework-file.js';

export const ANALYZER_ID = 'stateful-shared-regex';
export const SCHEMA_VERSION = '0.1';

function flagsContainGorY(flags) {
  return /[gy]/.test(flags);
}

function parseRegexLiteralText(text) {
  // text like '/\\S+@\\S+/gi' — split on last forward slash
  const lastSlash = text.lastIndexOf('/');
  const pattern = text.slice(1, lastSlash);
  const flags = text.slice(lastSlash + 1);
  return { pattern, flags };
}

function matchQualifyingInitializer(init) {
  if (ts.isRegularExpressionLiteral(init)) {
    const { pattern, flags } = parseRegexLiteralText(init.text);
    if (!flagsContainGorY(flags)) return null;
    return { pattern, flags };
  }
  if (
    ts.isNewExpression(init)
    && ts.isIdentifier(init.expression)
    && init.expression.text === 'RegExp'
    && init.arguments?.length === 2
  ) {
    const [a, b] = init.arguments;
    const isLiteralStr = (n) =>
      ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
    if (!isLiteralStr(a) || !isLiteralStr(b)) return null;
    if (!flagsContainGorY(b.text)) return null;
    return { pattern: a.text, flags: b.text };
  }
  return null;
}

function collectDeclarations(sourceFile) {
  const decls = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (!ts.isIdentifier(decl.name)) continue;
      const m = matchQualifyingInitializer(decl.initializer);
      if (!m) continue;
      decls.push({
        name: decl.name.text,
        pattern: m.pattern,
        flags: m.flags,
        declareNode: stmt,
      });
    }
  }
  return decls;
}

function collectUseSites(sourceFile, names) {
  const uses = [];
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && names.has(node.expression.expression.text)
      && ts.isIdentifier(node.expression.name)
      && (node.expression.name.text === 'test' || node.expression.name.text === 'exec')
    ) {
      uses.push({
        name: node.expression.expression.text,
        op: node.expression.name.text,
        node,
      });
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return uses;
}

function detectInFile(absFile, sourceFile, projectId, projectRoot) {
  const decls = collectDeclarations(sourceFile);
  if (decls.length === 0) return [];
  const names = new Set(decls.map((d) => d.name));
  const uses = collectUseSites(sourceFile, names);
  const usesByName = new Map();
  for (const u of uses) {
    if (!usesByName.has(u.name)) usesByName.set(u.name, []);
    usesByName.get(u.name).push(u);
  }
  const findings = [];
  const relFile = path.relative(projectRoot, absFile);
  for (const d of decls) {
    const useSites = usesByName.get(d.name);
    if (!useSites || useSites.length === 0) continue;
    const occurrences = [];
    const pushOcc = (node, op) => {
      const start = node.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const text = node.getText(sourceFile);
      occurrences.push({
        project: projectId,
        file: relFile,
        line: line + 1,
        column: character + 1,
        op,
        snippet: text.length > 200 ? text.slice(0, 200) + '…' : text,
      });
    };
    pushOcc(d.declareNode, 'declare');
    for (const use of useSites) pushOcc(use.node, use.op);
    occurrences.sort((a, b) => a.line - b.line || a.column - b.column);
    findings.push({
      kind: ANALYZER_ID,
      name: d.name,
      pattern: d.pattern,
      flags: d.flags,
      occurrences,
    });
  }
  return findings;
}

/**
 * Run the analyzer across N project roots.
 * Emit one finding per (project, file, name) — no cross-file grouping.
 *
 * @param {string[]} projectRoots
 * @param {object}   [opts]
 * @param {string[]} [opts.exclude]
 * @param {boolean}  [opts.includeBuildArtifacts]
 * @param {boolean}  [opts.includeTestContext]
 * @param {object}   [opts.astCache]          when present, astCache.get(absFile)
 *                                            returns { code, sourceFile } | null
 * @param {*}        [opts.crossFileResolver] accepted and ignored in v1 (D23)
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const includeBuildArtifacts = opts.includeBuildArtifacts;
  const includeTestContext = opts.includeTestContext;
  const astCache = opts.astCache;
  // opts.crossFileResolver accepted and ignored per D23

  const allFindings = [];
  let fileCount = 0;
  let errorCount = 0;

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, {
      exclude,
      includeBuildArtifacts,
      includeTestContext,
    })) {
      fileCount++;
      let sourceFile;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) continue;
        sourceFile = cached.sourceFile;
      } else {
        let code;
        try {
          code = readSource(absFile);
        } catch {
          errorCount++;
          continue;
        }
        try {
          sourceFile = ts.createSourceFile(
            absFile,
            code,
            ts.ScriptTarget.Latest,
            true,
            scriptKindFor(absFile),
          );
        } catch {
          errorCount++;
          continue;
        }
      }
      try {
        allFindings.push(...detectInFile(absFile, sourceFile, project.id, project.root));
      } catch {
        errorCount++;
      }
    }
  }

  const findings = allFindings.sort((a, b) => {
    const ao = a.occurrences[0];
    const bo = b.occurrences[0];
    return (
      (ao?.project ?? '').localeCompare(bo?.project ?? '')
      || (ao?.file ?? '').localeCompare(bo?.file ?? '')
      || a.name.localeCompare(b.name)
    );
  });

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map((p) => p.id),
    findings,
    meta: { fileCount, errorCount, projectCount: projects.length },
  };
}

/**
 * Summarize a result for human display (stderr).
 */
export function summarize(result) {
  const byFlag = {};
  const byPattern = {};
  for (const f of result.findings) {
    byFlag[f.flags] = (byFlag[f.flags] ?? 0) + 1;
    byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    byFlag,
    byPattern,
  };
}
