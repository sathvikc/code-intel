// import-graph.js — AST-based reverse import graph + blast-radius.
//
// Given N project roots and a set of changed files, compute the transitive
// set of files that import (directly or indirectly) those changed files.
// This is the "who silently breaks when this file changes?" query.
//
// Design notes:
//   - AST-based import extraction (per D5, syntactic). We parse each source
//     file with the TypeScript compiler and collect:
//       * ES `import ... from 'x'`  (ImportDeclaration)
//       * ES `import('x')`          (CallExpression where expression is ImportKeyword)
//       * ES `export ... from 'x'`  (ExportDeclaration with moduleSpecifier)
//       * CJS `require('x')`        (CallExpression where callee is `require`)
//     This is broader than analyze-impact.js's regex and avoids string-literal
//     false positives (e.g. strings inside comments / template parts).
//   - Path-alias resolution: we read each project's `tsconfig.json` (if
//     present) and build an alias map from `compilerOptions.paths`. Aliases
//     are resolved against the project's `baseUrl` (or the tsconfig dir).
//   - Relative imports resolve via filesystem with a list of candidate
//     extensions (.ts, .tsx, .js, .jsx, .mjs, .cjs) and index files.
//   - Bare imports (`import x from 'lodash'`) are ignored — they resolve to
//     node_modules which we intentionally skip.
//   - BFS from the changed-file set over the reverse graph yields the blast
//     radius with depth. Depth 0 is the changed file itself and is omitted
//     from the result (the caller already knows those).

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles, SOURCE_EXTENSIONS } from './project.js';

export const SCHEMA_VERSION = '0.1';

const EXT_CANDIDATES = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_CANDIDATES = EXT_CANDIDATES.map((e) => `/index${e}`);

// ---------- tsconfig alias loading ----------

function stripJsonComments(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (!inStr && c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (!inStr && c === '/' && n === '*') { i += 2; while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Load path aliases from a project's tsconfig.json, if present.
 * Returns { aliases: Record<string, string>, baseDir: string } or null.
 */
export function loadAliases(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'tsconfig.json'),
    path.join(projectRoot, 'tsconfig.base.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let cfg;
    try { cfg = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))); }
    catch { continue; }
    const co = cfg.compilerOptions ?? {};
    const baseUrl = co.baseUrl ? path.resolve(path.dirname(file), co.baseUrl) : path.dirname(file);
    const aliases = {};
    for (const [alias, targets] of Object.entries(co.paths ?? {})) {
      // paths values are arrays like ["src/foo"], possibly with "*" wildcards.
      const first = Array.isArray(targets) ? targets[0] : targets;
      if (typeof first !== 'string') continue;
      const cleanAlias = alias.replace(/\/\*$/, '');
      const cleanTarget = path.resolve(baseUrl, first.replace(/\/\*$/, ''));
      aliases[cleanAlias] = cleanTarget;
    }
    return { aliases, baseDir: baseUrl };
  }
  return { aliases: {}, baseDir: projectRoot };
}

// ---------- import extraction (AST) ----------

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
 * Extract every import specifier from a source file's AST.
 * Returns the raw strings exactly as written — resolution happens separately.
 */
export function extractImportSpecifiers(code, filePath, preparsed) {
  const sf = preparsed ?? ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const specs = [];

  function visit(node) {
    // import ... from 'x'
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    }
    // export ... from 'x'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    }
    // import('x')
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg)) specs.push(arg.text);
    }
    // require('x')
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return specs;
}

// ---------- resolution ----------

function firstExistingCandidate(base) {
  // Try base itself (with extensions) and base/index.* (index files).
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXT_CANDIDATES) {
    const c = base + ext;
    if (fs.existsSync(c)) return c;
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const ix of INDEX_CANDIDATES) {
      const c = base + ix;
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * Resolve one import specifier from a file. Returns the absolute path of the
 * target source file, or null if the spec is bare (node_modules) or can't
 * be resolved.
 */
export function resolveImport(spec, fromFile, aliasMap) {
  // 1. Alias match (longest prefix wins)
  let aliasTarget = null;
  let bestMatch = '';
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (spec === alias || spec.startsWith(alias + '/')) {
      if (alias.length > bestMatch.length) {
        bestMatch = alias;
        aliasTarget = target + spec.slice(alias.length);
      }
    }
  }
  if (aliasTarget) {
    return firstExistingCandidate(aliasTarget);
  }

  // 2. Relative import
  if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), spec);
    return firstExistingCandidate(base);
  }

  // 3. Bare spec — skip (node_modules or URL)
  return null;
}

// ---------- graph build + blast radius ----------

/**
 * Build the reverse import graph for a set of projects.
 *
 * Returns:
 *   {
 *     graph: Map<absTargetFile, Set<absImporterFile>>,
 *     filesByProject: Map<projectId, Set<absFile>>,
 *     projects: Array<{ id, root }>,
 *   }
 *
 * An edge target -> importer means "importer imports target."
 */
export function buildReverseGraph(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const astCache = opts.astCache;
  const aliasesByProject = new Map(projects.map((p) => [p.id, loadAliases(p.root)]));
  const graph = new Map();
  const filesByProject = new Map(projects.map((p) => [p.id, new Set()]));

  for (const project of projects) {
    const { aliases } = aliasesByProject.get(project.id);
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      filesByProject.get(project.id).add(absFile);
      let src;
      let preparsed;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) continue;
        src = cached.code;
        preparsed = cached.sourceFile;
      } else {
        try { src = fs.readFileSync(absFile, 'utf8'); } catch { continue; }
      }
      let specs;
      try { specs = extractImportSpecifiers(src, absFile, preparsed); } catch { continue; }
      for (const spec of specs) {
        const target = resolveImport(spec, absFile, aliases);
        if (!target) continue;
        if (!graph.has(target)) graph.set(target, new Set());
        graph.get(target).add(absFile);
      }
    }
  }

  return { graph, filesByProject, projects };
}

/**
 * Given the reverse graph and a set of changed files, return a Map of
 * absFile -> depth for every file that transitively imports a changed file.
 * Depth 1 = direct importer. Changed files themselves are not in the result.
 */
export function findDependents(graph, changedFiles, maxDepth = 6) {
  const result = new Map();
  const seen = new Set(changedFiles);
  let frontier = [...changedFiles];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const f of frontier) {
      const importers = graph.get(f);
      if (!importers) continue;
      for (const imp of importers) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        result.set(imp, depth);
        next.push(imp);
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * One-shot convenience: build graph and compute dependents for a change set.
 */
export function analyzeProjects(projectRoots, changedFiles, opts = {}) {
  const { maxDepth = 6, exclude, astCache } = opts;
  const { graph, filesByProject, projects } = buildReverseGraph(projectRoots, { exclude, astCache });
  // Filter changedFiles to absolute paths that actually exist in one of the
  // indexed projects. This tolerates paths outside our scan scope gracefully.
  const knownFiles = new Set();
  for (const set of filesByProject.values()) for (const f of set) knownFiles.add(f);
  const absChanged = new Set();
  for (const f of changedFiles) {
    const abs = path.isAbsolute(f) ? f : path.resolve(f);
    if (knownFiles.has(abs)) absChanged.add(abs);
  }
  const dependents = findDependents(graph, absChanged, maxDepth);

  return {
    version: SCHEMA_VERSION,
    analyzer: 'import-graph',
    projects: projects.map((p) => ({ id: p.id, root: p.root })),
    changedFiles: [...absChanged],
    dependents: [...dependents.entries()].map(([file, depth]) => ({ file, depth })),
    maxDepth,
  };
}

export const _internal = { firstExistingCandidate };
