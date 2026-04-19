// duplicate-static-svg-id analyzer (P6, v2 per D10).
//
// Detects the "every render emits the same DOM id" class of bug — and only
// emits when we can demonstrate that the duplication actually happens in
// the code today. We do NOT emit based on the latent-bug theory that "if
// this component is ever rendered twice, it will collide" — that was the
// v1 framing (D9) and it produced noise on lone-use components. The new
// rule (D10) is: describe facts about what the code has, not predictions
// about what it might do.
//
// Canonical bug shape:
//
//   function IconFx() {
//     return (
//       <svg>
//         <defs>
//           <linearGradient id="icon-fx-gradient">...</linearGradient>
//         </defs>
//         <rect fill="url(#icon-fx-gradient)" />
//       </svg>
//     );
//   }
//
// On its own this is NOT a finding. It becomes one when we can point to
// evidence that IconFx is (or will be, by construction) rendered more
// than once — evidence the analyzer observes in the current codebase.
//
// Evidence types we emit on (v1):
//
//   E1  in-file-loop
//       The declaration's JSX subtree sits inside a .map / .forEach /
//       .flatMap / .reduce / .reduceRight callback, or an Array.from(…, cb)
//       callback, in the same file. Every iteration emits the same id.
//       confidence: high.
//
//   E2  caller-loop
//       The declaration's enclosing component is rendered inside such an
//       iteration construct by an importer (one hop via the reverse import
//       graph). Same effect, one file removed.
//       confidence: high.
//
//   E3  same-component-duplicate
//       The same id literal is declared ≥2 times inside the same component.
//       Every render of the component puts ≥2 elements into the DOM with
//       the same id — guaranteed collision per render.
//       confidence: high.
//
//   E4  cross-component-duplicate
//       The same id literal is declared by ≥2 distinct components anywhere
//       in the scanned set. The analyzer cannot prove the two components
//       ever mount on the same page, so this is an observed textual fact
//       whose impact is uncertain. Emit as low, let the reviewer decide.
//       confidence: low.
//
// A candidate that matches the static-id + same-file-anchor shape but has
// none of E1-E4 is SKIPPED. That is the key behaviour change from v1: no
// more latent-bug emissions.
//
// Gaps (intentional v1 simplifications; add when real cases demand it):
//
//   - Only direct importers are walked for E2; two-hop re-exports or
//     wrapper components that forward into an iterator are missed.
//   - Iteration-method detection is a small allowlist. Custom iteration
//     wrappers (a util that internally maps) are missed.
//   - Named-callback loops — `items.map(renderIcon); function renderIcon()
//     { return <X /> }` — are missed because the JSX and the iteration
//     site cross a non-iteration function boundary.
//   - Namespace imports (`import * as icons from './icons'`) are not
//     tracked for JSX usage.
//   - Inline `style={{ fill: 'url(#foo)' }}` object literals are not
//     scanned (only string-valued attributes).
//   - SVG embedded in a template literal or dangerouslySetInnerHTML is
//     out of scope (deferred to the built-output scanning slice).
//
// Output schema version: 0.2 (bumped — finding shape adds `component`
// and `evidence`; new occurrence op types: `iteration-site` and
// `duplicate-declaration`).

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { buildFoldMap, resolveStringArg } from './fold-string-literals.js';
import { buildReverseGraph, loadAliases, resolveImport } from './import-graph.js';

export const SCHEMA_VERSION = '0.2';
export const ANALYZER_ID = 'duplicate-static-svg-id';

const HREF_ATTRS = new Set(['href', 'xlinkHref', 'xlink:href']);
const URL_REF_PATTERN = /url\(\s*#([^\s)"']+)\s*\)/g;
const ITER_METHODS = new Set(['map', 'flatMap', 'forEach', 'reduce', 'reduceRight']);

// ---------- public: per-file observation ----------

/**
 * Walk a single file and produce an observation record. This function
 * does NOT emit findings on its own — emission is driven by the cross-
 * file stitching in `analyzeProjects`, because every evidence type
 * (even E1 in-file loop) is cheaper to express with the full set of
 * candidates in hand.
 *
 * @returns {{
 *   staticIdSites: Array<{
 *     id: string, element: string, component: string | null,
 *     line: number, column: number, snippet: string, foldedFrom?: string,
 *     inIteration: boolean, iterationMethod: string | null,
 *     iterationSiteLine: number | null,
 *   }>,
 *   anchoredIds: Set<string>,
 *   anchorRefs: Array<{
 *     id: string, via: 'url' | 'href', attribute: string, element: string,
 *     line: number, column: number, snippet: string, foldedFrom?: string,
 *   }>,
 *   jsxUsages: Array<{
 *     component: string, line: number, column: number,
 *     inIteration: boolean, iterationMethod: string | null,
 *     iterationSiteLine: number | null,
 *   }>,
 *   importedAs: Map<string, { fromSpec: string, exportName: string }>,
 *   componentExports: Map<string, { exportedAs: string }>,
 * }}
 */
export function analyzeSource(code, filePath, preparsed) {
  const sf = preparsed ?? ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );
  const foldMap = buildFoldMap(sf);

  const staticIdSites = [];
  const anchoredIds = new Set();
  const anchorRefs = [];
  const jsxUsages = [];
  const importedAs = new Map();
  const componentExports = new Map();

  collectImports(sf, importedAs);
  collectExports(sf, componentExports);
  collectJsx(sf, foldMap, {
    staticIdSites,
    anchoredIds,
    anchorRefs,
    jsxUsages,
  });

  return { staticIdSites, anchoredIds, anchorRefs, jsxUsages, importedAs, componentExports };
}

// ---------- public: cross-project emission ----------

/**
 * Analyze N project roots, stitch cross-file evidence, and emit findings.
 *
 * Each finding is shaped around a (project, file, component, id) candidate
 * — a component that declares a static id for which an anchor (url(#id)
 * or href="#id") exists in the same file. A candidate only emits when
 * at least one evidence entry (E1-E4) applies.
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const projects = projectRoots.map(resolveProject);
  const exclude = opts.exclude;
  const astCache = opts.astCache;
  const rootById = new Map(projects.map((p) => [p.id, p.root]));
  const aliasesByProject = new Map(projects.map((p) => [p.id, loadAliases(p.root)]));

  // Per-file observations, keyed by absolute path.
  /** @type {Map<string, ReturnType<typeof analyzeSource> & { project: string, rel: string }>} */
  const observationsByFile = new Map();

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root, { exclude })) {
      let code;
      let preparsed;
      if (astCache) {
        const cached = astCache.get(absFile);
        if (!cached) continue;
        code = cached.code;
        preparsed = cached.sourceFile;
      } else {
        try { code = fs.readFileSync(absFile, 'utf8'); } catch { continue; }
      }
      let obs;
      try { obs = analyzeSource(code, absFile, preparsed); } catch { continue; }
      observationsByFile.set(absFile, {
        ...obs,
        project: project.id,
        rel: path.relative(project.root, absFile),
      });
    }
  }

  // Reverse import graph (who imports what).
  const { graph: reverseGraph } = buildReverseGraph(projectRoots, { exclude, astCache });

  // Collect candidates. A candidate is a (file, component, id) combo that
  // has at least one static-id declaration AND the file has an anchor for
  // the same id.
  const candidates = collectCandidates(observationsByFile);

  // Cross-component index: id -> list of candidates declaring it.
  const candidatesById = new Map();
  for (const c of candidates.values()) {
    if (!candidatesById.has(c.id)) candidatesById.set(c.id, []);
    candidatesById.get(c.id).push(c);
  }

  // Attach evidence to each candidate.
  for (const candidate of candidates.values()) {
    attachEvidence(candidate, {
      observationsByFile,
      reverseGraph,
      candidatesById,
      aliasesByProject,
    });
  }

  // Emit findings for candidates with at least one evidence entry.
  const findings = [];
  for (const candidate of candidates.values()) {
    if (candidate.evidence.length === 0) continue;
    findings.push(buildFinding(candidate));
  }

  findings.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    const la = a.occurrences[0], lb = b.occurrences[0];
    const fa = `${la?.project ?? ''}:${la?.file ?? ''}`;
    const fb = `${lb?.project ?? ''}:${lb?.file ?? ''}`;
    if (fa !== fb) return fa < fb ? -1 : 1;
    return (la?.line ?? 0) - (lb?.line ?? 0);
  });

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    projects: projects.map((p) => ({ id: p.id, root: p.root })),
    findings,
  };
}

/**
 * Summarize a result for human display (stderr). Backwards-compatible
 * field names with v1 so the CLI summarizer keeps working.
 */
export function summarize(result) {
  let totalDeclarations = 0;
  let totalReferences = 0;
  const affectedFiles = new Set();
  const byEvidence = { 'in-file-loop': 0, 'caller-loop': 0, 'same-component-duplicate': 0, 'cross-component-duplicate': 0 };
  for (const f of result.findings) {
    for (const o of f.occurrences) {
      if (o.op === 'reference') totalReferences++;
      else if (o.op === 'declare') totalDeclarations++;
      affectedFiles.add(`${o.project}:${o.file}`);
    }
    for (const e of f.evidence) {
      byEvidence[e.type] = (byEvidence[e.type] ?? 0) + 1;
    }
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    totalDeclarations,
    totalReferences,
    affectedFiles: affectedFiles.size,
    byEvidence,
  };
}

// ---------- per-file walks ----------

function collectImports(sf, importedAs) {
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const fromSpec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause) {
        // default import: `import Foo from 'x'`
        if (clause.name) {
          importedAs.set(clause.name.text, { fromSpec, exportName: 'default' });
        }
        // named: `import { Foo, Bar as Baz } from 'x'`
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const local = el.name.text;
            const ext = el.propertyName?.text ?? el.name.text;
            importedAs.set(local, { fromSpec, exportName: ext });
          }
        }
        // namespace `import * as Foo from 'x'` — not tracked in v1.
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function collectExports(sf, componentExports) {
  function visit(node) {
    // export default <identifier|expression>
    if (ts.isExportAssignment(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        componentExports.set(expr.text, { exportedAs: 'default' });
      } else {
        componentExports.set('<default>', { exportedAs: 'default' });
      }
      return;
    }
    // export [default] function X() {}
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
      const name = node.name?.text;
      const isDefault = hasDefaultModifier(node);
      if (name) {
        componentExports.set(name, { exportedAs: isDefault ? 'default' : name });
      } else if (isDefault) {
        componentExports.set('<default>', { exportedAs: 'default' });
      }
      return;
    }
    // export [default] class X {}
    if (ts.isClassDeclaration(node) && hasExportModifier(node)) {
      const name = node.name?.text;
      const isDefault = hasDefaultModifier(node);
      if (name) {
        componentExports.set(name, { exportedAs: isDefault ? 'default' : name });
      } else if (isDefault) {
        componentExports.set('<default>', { exportedAs: 'default' });
      }
      return;
    }
    // export const X = ...
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name && ts.isIdentifier(decl.name)) {
          componentExports.set(decl.name.text, { exportedAs: decl.name.text });
        }
      }
      return;
    }
    // export { X, Y as Z }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const local = el.propertyName?.text ?? el.name.text;
        const ext = el.name.text;
        componentExports.set(local, { exportedAs: ext });
      }
      return;
    }
    // Recurse into children so a `const X = ...` at module-top inside a
    // statement list gets reached; ts.forEachChild handles the top-level
    // statements directly. We intentionally don't recurse into function
    // bodies.
    if (ts.isSourceFile(node)) ts.forEachChild(node, visit);
  }
  visit(sf);
}

function collectJsx(sf, foldMap, out) {
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const element = jsxTagName(node);
      let declaredId = null;
      let declaredFoldedFrom = null;
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = jsxAttrName(attr);
        const resolved = resolveJsxAttrString(attr, sf, foldMap);
        if (resolved.value === null) continue;
        if (name === 'id') {
          declaredId = resolved.value;
          declaredFoldedFrom = resolved.foldedFrom ?? null;
          continue;
        }
        const refs = extractReferencedIds(name, resolved.value);
        if (refs.length === 0) continue;
        const { line, column } = locOf(node, sf);
        for (const ref of refs) {
          out.anchoredIds.add(ref.id);
          const entry = {
            id: ref.id,
            via: ref.via,
            attribute: name,
            element,
            line,
            column,
            snippet: snippetOf(node, sf),
          };
          if (resolved.foldedFrom) entry.foldedFrom = resolved.foldedFrom;
          out.anchorRefs.push(entry);
        }
      }

      if (declaredId !== null) {
        const { line, column } = locOf(node, sf);
        const iter = findIterationAncestor(node);
        const site = {
          id: declaredId,
          element,
          component: nearestComponentName(node),
          line,
          column,
          snippet: snippetOf(node, sf),
          inIteration: !!iter,
          iterationMethod: iter?.method ?? null,
          iterationSiteLine: iter ? sf.getLineAndCharacterOfPosition(iter.call.getStart(sf)).line + 1 : null,
        };
        if (declaredFoldedFrom) site.foldedFrom = declaredFoldedFrom;
        out.staticIdSites.push(site);
      }

      // JSX usage: user-component name (PascalCase) — used for caller-loop
      // evidence. HTML / SVG lowercase tags are skipped.
      const tagText = element;
      if (tagText && /^[A-Z]/.test(tagText)) {
        const { line, column } = locOf(node, sf);
        const iter = findIterationAncestor(node);
        out.jsxUsages.push({
          component: tagText,
          line,
          column,
          inIteration: !!iter,
          iterationMethod: iter?.method ?? null,
          iterationSiteLine: iter ? sf.getLineAndCharacterOfPosition(iter.call.getStart(sf)).line + 1 : null,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

// ---------- candidate assembly + evidence ----------

function collectCandidates(observationsByFile) {
  // key = project|file|component|id
  const candidates = new Map();
  for (const [absFile, obs] of observationsByFile) {
    for (const site of obs.staticIdSites) {
      // Anchor gate: an id with no matching url(#) / href="#" anchor in the
      // same file is probably a test selector or a11y target, not an SVG
      // graphics reference. Skip — preserves v1's recall discipline.
      if (!obs.anchoredIds.has(site.id)) continue;
      const componentKey = site.component ?? '<anon>';
      const key = `${obs.project}|${obs.rel}|${componentKey}|${site.id}`;
      let c = candidates.get(key);
      if (!c) {
        c = {
          project: obs.project,
          file: obs.rel,
          absFile,
          component: site.component,
          id: site.id,
          element: site.element,
          declarations: [],
          anchorRefs: [],
          evidence: [],
        };
        candidates.set(key, c);
      }
      c.declarations.push({
        line: site.line,
        column: site.column,
        snippet: site.snippet,
        foldedFrom: site.foldedFrom,
        inIteration: site.inIteration,
        iterationMethod: site.iterationMethod,
        iterationSiteLine: site.iterationSiteLine,
      });
    }
  }
  // Attach the relevant anchor refs per-candidate.
  for (const c of candidates.values()) {
    const obs = observationsByFile.get(c.absFile);
    for (const ref of obs.anchorRefs) {
      if (ref.id === c.id) {
        c.anchorRefs.push(ref);
      }
    }
  }
  return candidates;
}

function attachEvidence(candidate, ctx) {
  // E1: any declaration of this id in this component sits inside an
  // in-file iteration construct.
  for (const decl of candidate.declarations) {
    if (decl.inIteration) {
      candidate.evidence.push({
        type: 'in-file-loop',
        method: decl.iterationMethod,
        at: { project: candidate.project, file: candidate.file, line: decl.iterationSiteLine },
      });
      break; // one is enough
    }
  }

  // E3: same component declares the same id ≥2 times.
  if (candidate.declarations.length >= 2) {
    candidate.evidence.push({
      type: 'same-component-duplicate',
      count: candidate.declarations.length,
      at: {
        project: candidate.project,
        file: candidate.file,
        line: candidate.declarations[0].line,
      },
    });
  }

  // E4: another component anywhere declares the same id literal.
  const siblings = ctx.candidatesById.get(candidate.id) ?? [];
  for (const other of siblings) {
    if (other === candidate) continue;
    // same-component-duplicate (E3) case: skip here — they are the same
    // (project, file, component, id) bucket, so they'd have been merged
    // into one candidate.
    if (other.component === candidate.component
        && other.file === candidate.file
        && other.project === candidate.project) continue;
    candidate.evidence.push({
      type: 'cross-component-duplicate',
      other: {
        project: other.project,
        file: other.file,
        component: other.component,
        line: other.declarations[0]?.line ?? null,
      },
    });
  }

  // E2: an importer of this file renders this component inside a loop.
  if (candidate.component) {
    const callerLoopSites = findCallerLoopSites(candidate, ctx);
    for (const site of callerLoopSites) {
      candidate.evidence.push({
        type: 'caller-loop',
        method: site.method,
        at: { project: site.project, file: site.file, line: site.iterationSiteLine },
      });
    }
  }
}

/**
 * Walk the direct importers of the candidate's file. For each importer,
 * resolve its import specifier back to the candidate's file, figure out
 * which local name the importer uses for the candidate's component, and
 * check whether any JSX usage of that local name sits inside a loop.
 */
function findCallerLoopSites(candidate, ctx) {
  const importers = ctx.reverseGraph.get(candidate.absFile);
  if (!importers || importers.size === 0) return [];
  const sites = [];

  // What external name does the candidate's file expose this component as?
  const srcObs = ctx.observationsByFile.get(candidate.absFile);
  const exported = srcObs?.componentExports.get(candidate.component);
  if (!exported) return []; // component not exported — no external callers

  for (const importerAbs of importers) {
    const importerObs = ctx.observationsByFile.get(importerAbs);
    if (!importerObs) continue;

    // Which local name(s) does the importer use for this export?
    const localNames = [];
    for (const [localName, spec] of importerObs.importedAs) {
      if (spec.exportName !== exported.exportedAs) continue;
      const aliases = ctx.aliasesByProject.get(importerObs.project)?.aliases ?? {};
      const resolved = resolveImport(spec.fromSpec, importerAbs, aliases);
      if (resolved === candidate.absFile) {
        localNames.push(localName);
      }
    }
    if (localNames.length === 0) continue;

    // Check each local name for iteration usage.
    for (const local of localNames) {
      for (const usage of importerObs.jsxUsages) {
        if (usage.component !== local) continue;
        if (!usage.inIteration) continue;
        sites.push({
          project: importerObs.project,
          file: importerObs.rel,
          line: usage.line,
          column: usage.column,
          method: usage.iterationMethod,
          iterationSiteLine: usage.iterationSiteLine,
        });
      }
    }
  }
  return sites;
}

// ---------- finding assembly ----------

function buildFinding(candidate) {
  const occurrences = [];
  for (const decl of candidate.declarations) {
    const o = {
      project: candidate.project,
      file: candidate.file,
      line: decl.line,
      column: decl.column,
      op: 'declare',
      element: candidate.element,
      snippet: decl.snippet,
      component: candidate.component,
    };
    if (decl.foldedFrom) o.foldedFrom = decl.foldedFrom;
    occurrences.push(o);
  }
  for (const ref of candidate.anchorRefs) {
    const o = {
      project: candidate.project,
      file: candidate.file,
      line: ref.line,
      column: ref.column,
      op: 'reference',
      element: ref.element,
      attribute: ref.attribute,
      via: ref.via,
      snippet: ref.snippet,
    };
    if (ref.foldedFrom) o.foldedFrom = ref.foldedFrom;
    occurrences.push(o);
  }
  // Add iteration-site occurrences for loop evidence.
  for (const ev of candidate.evidence) {
    if ((ev.type === 'in-file-loop' || ev.type === 'caller-loop') && ev.at && ev.at.line != null) {
      occurrences.push({
        project: ev.at.project,
        file: ev.at.file,
        line: ev.at.line,
        column: 1,
        op: 'iteration-site',
        method: ev.method,
        evidenceKind: ev.type,
      });
    }
  }
  // Add duplicate-declaration occurrences for E4.
  for (const ev of candidate.evidence) {
    if (ev.type === 'cross-component-duplicate') {
      occurrences.push({
        project: ev.other.project,
        file: ev.other.file,
        line: ev.other.line,
        column: 1,
        op: 'duplicate-declaration',
        component: ev.other.component,
        evidenceKind: 'cross-component-duplicate',
      });
    }
  }
  occurrences.sort((a, b) => {
    const fa = `${a.project}:${a.file}`;
    const fb = `${b.project}:${b.file}`;
    if (fa !== fb) return fa < fb ? -1 : 1;
    if (a.line !== b.line) return (a.line ?? 0) - (b.line ?? 0);
    return (a.column ?? 0) - (b.column ?? 0);
  });
  return {
    kind: 'duplicate-static-svg-id',
    id: candidate.id,
    element: candidate.element,
    component: candidate.component,
    evidence: candidate.evidence,
    occurrences,
  };
}

// ---------- AST helpers ----------

function jsxTagName(node) {
  const tag = node.tagName;
  if (!tag) return '';
  if (ts.isIdentifier(tag)) return tag.text;
  try { return tag.getText(); } catch { return ''; }
}

function jsxAttrName(attr) {
  const name = attr.name;
  if (!name) return '';
  if (ts.isIdentifier(name)) return name.text;
  if (typeof ts.isJsxNamespacedName === 'function' && ts.isJsxNamespacedName(name)) {
    return `${name.namespace.text}:${name.name.text}`;
  }
  try { return name.getText(); } catch { return ''; }
}

function resolveJsxAttrString(attr, sourceFile, foldMap) {
  const init = attr.initializer;
  if (!init) return { value: null, foldedFrom: null };
  if (ts.isStringLiteral(init)) {
    return { value: init.text, foldedFrom: null };
  }
  if (ts.isJsxExpression(init) && init.expression) {
    const r = resolveStringArg(init.expression, sourceFile, foldMap);
    return { value: r.value, foldedFrom: r.foldedFrom };
  }
  return { value: null, foldedFrom: null };
}

function extractReferencedIds(attrName, value) {
  if (attrName === 'id' || typeof value !== 'string' || value.length === 0) return [];
  const out = [];
  const pattern = new RegExp(URL_REF_PATTERN.source, 'g');
  let m;
  while ((m = pattern.exec(value)) !== null) {
    out.push({ id: m[1], via: 'url' });
  }
  if (HREF_ATTRS.has(attrName) && value.length > 1 && value.startsWith('#')) {
    const id = value.slice(1);
    if (id.length > 0 && !/\s/.test(id)) {
      out.push({ id, via: 'href' });
    }
  }
  return out;
}

/**
 * Walk up from a JSX node to find the enclosing component-ish name.
 * Returns the component name or null if anonymous / top-level.
 */
function nearestComponentName(node) {
  let n = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isClassDeclaration(n) && n.name) return n.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n))
        && n.parent && ts.isVariableDeclaration(n.parent)
        && n.parent.name && ts.isIdentifier(n.parent.name)) {
      return n.parent.name.text;
    }
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n))
        && n.parent && ts.isExportAssignment(n.parent)) {
      return '<default>';
    }
    if (ts.isSourceFile(n)) break;
    n = n.parent;
  }
  return null;
}

/**
 * Walk up from a JSX node looking for an iteration ancestor: a function
 * that is passed as the callback argument of a CallExpression whose
 * callee is one of the recognized iteration methods. Returns { method,
 * call } or null.
 *
 * Stops at the first function-like ancestor: if the JSX is inside a
 * named helper, we conservatively do NOT walk past that helper to find
 * a grandparent loop, because we don't know the helper is only ever
 * called from a loop.
 */
function findIterationAncestor(node) {
  let n = node.parent;
  while (n) {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) {
      if (n.parent && ts.isCallExpression(n.parent)) {
        const call = n.parent;
        if (call.arguments.includes(n)) {
          const callee = call.expression;
          if (ts.isPropertyAccessExpression(callee) && callee.name) {
            const method = callee.name.text;
            if (ITER_METHODS.has(method)) return { method, call };
            if (method === 'from' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Array') {
              return { method: 'Array.from', call };
            }
          }
        }
      }
      return null;
    }
    if (ts.isSourceFile(n)) break;
    n = n.parent;
  }
  return null;
}

function hasExportModifier(node) {
  return !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(node) {
  return !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function locOf(node, sf) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}
function snippetOf(node, sf) {
  return node.getText(sf).split('\n')[0].slice(0, 200);
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
