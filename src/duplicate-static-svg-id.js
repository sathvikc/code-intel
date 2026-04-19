// duplicate-static-svg-id analyzer (P6).
//
// Detects the "every render emits the same DOM id" class of bug. Canonical
// shape:
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
// If this component is ever rendered more than once on a page — a list of
// 50 rows, a pre-rendered navigation whose sub-nav was previously built on
// click — every rendered copy puts an element with `id="icon-fx-gradient"`
// into the DOM. Browsers resolve `url(#icon-fx-gradient)` via a DOM-global
// lookup that returns whichever element it found first, so every copy
// except one paints with the wrong (or missing) gradient. The bug is
// silent in development when the component renders once, then surfaces
// the day a product change renders it twice.
//
// Why this slot, why now:
//
// This is not a coupling bug. The invariant is intra-component (the
// render-time guarantee that each instance should own a unique id), not
// cross-file. That makes the detector simpler than every other one
// shipped so far — no cross-file grouping, no project-wide walk of
// occurrences, no dynamic-key heuristics. The analyzer looks at one file
// at a time.
//
// What counts as "static" for the id:
//
//   - `id="foo"` — string-literal JSX attribute.
//   - `id={"foo"}` — JSX expression wrapping a string literal.
//   - `id={FOO}` where `const FOO = 'foo'` is a same-file binding
//     foldable under the rules in `fold-string-literals.js` (D8).
//
// Everything else is dynamic and skipped: `useId()` / `React.useId()`,
// `nanoid()`, `uuid.v4()`, template literals with substitutions, prop
// references, state references, anything that does not resolve to a bare
// literal in this file. The fold helper is shared with the other
// detectors so "static" has a single, consistent meaning across the
// codebase.
//
// The anchor rule — why we don't flag every `<div id="foo">`:
//
// A standalone `<circle id="testAnchor" />` could be a test selector, an
// a11y target, a scroll anchor — not an SVG graphics reference. The bug
// pattern only fires when the id is actually consumed as a graphics
// reference in the same file. So we require at least one matching
// reference in the same file, via:
//
//   - `url(#<id>)` inside any JSX attribute string value. Matches
//     `fill="url(#foo)"`, `stroke="url(#foo)"`, `clip-path="url(#foo)"`,
//     `mask="url(#foo)"`, `filter="url(#foo)"`, etc. — we scan every
//     attribute's string value and look for the pattern, rather than
//     hard-coding the set of attributes that legally take url() refs.
//   - `#<id>` as the value of an `xlinkHref`, `xlink:href`, or `href`
//     attribute. These feed `<use xlinkHref="#sym">` / SVG2 `<use
//     href="#sym">`, which reference `<symbol>` / `<g>` / `<path>`
//     definitions by id.
//
// No matching reference in the file → no finding, even if there is a
// static id on a defs-like element. That is intentional: with no in-file
// consumer, the id might be something else entirely (test hook, a11y,
// DOM query). False-positive cost is higher than the recall we'd gain
// by flagging it.
//
// What we do NOT attempt in v1 (logged as known gaps; revisit per D2):
//
//   - **Render multiplicity.** Whether a component actually renders more
//     than once on a page is not statically decidable in general. A
//     static-id SVG component is a latent bug regardless — if any caller
//     ever renders it twice, it breaks. So we flag the pattern and let
//     `confidence` in the impact layer carry the nuance.
//   - **Cross-file id references.** A library component in `Icon.tsx`
//     consumed by a page that renders `<Icon />` many times is still
//     detected, because the declaration AND the url(#) reference live
//     in `Icon.tsx` together. The bug would only hide if the reference
//     were in a different file, which is vanishingly rare in real SVG
//     code.
//   - **Template literals with substitutions** (`` `url(#${ID})` ``).
//     If `ID` folds to a literal, we'd be able to resolve it, but the
//     detector's current url() extractor is a string regex over the
//     resolved attribute value — it does not attempt to compose
//     partially-folded template fragments. Matches the D8 scope limit.
//   - **Inline style objects.** `<rect style={{ fill: 'url(#foo)' }}>`
//     is not scanned — we only look at JSX attributes whose resolved
//     value is a plain string.
//   - **SVG inside template literals or `dangerouslySetInnerHTML`.**
//     Out of v1 (no JSX to walk); belongs to the build-output scanning
//     mode planned as the next slice.
//   - **Shadow-DOM-scoped components.** `<template shadowrootmode>`
//     isolates ids, so technically the bug doesn't apply inside it.
//     We do not detect or skip shadow-rooted subtrees; if we start
//     seeing false positives from them, we'll add the filter.
//
// Output schema version: 0.1
// Finding kind: "duplicate-static-svg-id"

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, walkSourceFiles } from './project.js';
import { buildFoldMap, resolveStringArg } from './fold-string-literals.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'duplicate-static-svg-id';

// Attributes whose value, if it starts with `#`, references a fragment id
// on another element (for `<use>` / `<a>` etc.).
const HREF_ATTRS = new Set(['href', 'xlinkHref', 'xlink:href']);

const URL_REF_PATTERN = /url\(\s*#([^\s)"']+)\s*\)/g;

/**
 * Analyze a single file. Returns an array of findings; each finding
 * represents one static SVG id that is declared on a JSX element AND
 * referenced inside the same file.
 *
 * @returns {Array<{
 *   kind: 'duplicate-static-svg-id',
 *   id: string,
 *   element: string,
 *   occurrences: Array<
 *     | { line: number, column: number, op: 'declare', element: string,
 *         snippet: string, foldedFrom?: string }
 *     | { line: number, column: number, op: 'reference', via: 'url' | 'href',
 *         attribute: string, element: string, snippet: string,
 *         foldedFrom?: string }
 *   >,
 * }>}
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

  /** @type {Map<string, Array>} */
  const declarations = new Map();
  /** @type {Map<string, Array>} */
  const references = new Map();

  function snippetOf(node) {
    return node.getText(sf).split('\n')[0].slice(0, 200);
  }
  function locOf(node) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, column: character + 1 };
  }

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const element = jsxTagName(node);
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue; // skip spread attrs
        const name = jsxAttrName(attr);
        const resolved = resolveJsxAttrString(attr, sf, foldMap);
        if (resolved.value === null) continue;

        if (name === 'id') {
          // Declaration site. Record against the owning element.
          const { line, column } = locOf(node);
          const entry = {
            line,
            column,
            op: 'declare',
            element,
            snippet: snippetOf(node),
          };
          if (resolved.foldedFrom) entry.foldedFrom = resolved.foldedFrom;
          pushTo(declarations, resolved.value, entry);
          continue;
        }

        // Reference scan. We walk every attribute's resolved string value
        // for `url(#...)` anywhere inside it, and separately check the
        // href-family attributes for a leading `#<id>`.
        const refs = extractReferencedIds(name, resolved.value);
        if (refs.length === 0) continue;

        const { line, column } = locOf(node);
        for (const ref of refs) {
          const entry = {
            line,
            column,
            op: 'reference',
            via: ref.via,
            attribute: name,
            element,
            snippet: snippetOf(node),
          };
          if (resolved.foldedFrom) entry.foldedFrom = resolved.foldedFrom;
          pushTo(references, ref.id, entry);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  const findings = [];
  // Deterministic order: sort ids lexicographically.
  const ids = [...declarations.keys()].sort();
  for (const id of ids) {
    const decls = declarations.get(id);
    const refs = references.get(id);
    if (!refs || refs.length === 0) continue; // no in-file anchor

    const occurrences = [...decls, ...refs].sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });
    findings.push({
      kind: 'duplicate-static-svg-id',
      id,
      element: decls[0].element,
      occurrences,
    });
  }
  return findings;
}

/**
 * Pull the tag name off a JSX opening / self-closing element.
 * Handles `<lineargradient>` (built-in), `<LinearGradient>` (component),
 * and `<svg.LinearGradient>` (namespaced) uniformly — we return whatever
 * source text the tag carries, because the detector doesn't gate on tag
 * kind (the url(#) anchor is what constrains us to graphics context).
 */
function jsxTagName(node) {
  const tag = node.tagName;
  if (!tag) return '';
  if (ts.isIdentifier(tag)) return tag.text;
  try {
    return tag.getText();
  } catch {
    return '';
  }
}

/**
 * Pull an attribute's name. JSX attribute names can be `Identifier`
 * (`id`, `fill`) or `JsxNamespacedName` (`xlink:href`).
 */
function jsxAttrName(attr) {
  const name = attr.name;
  if (!name) return '';
  if (ts.isIdentifier(name)) return name.text;
  // ts.isJsxNamespacedName is available in recent TypeScript versions;
  // fall through to getText() for older versions.
  if (typeof ts.isJsxNamespacedName === 'function' && ts.isJsxNamespacedName(name)) {
    return `${name.namespace.text}:${name.name.text}`;
  }
  try {
    return name.getText();
  } catch {
    return '';
  }
}

/**
 * Resolve a JSX attribute's value to a string if possible.
 *
 *   id="foo"           → { value: 'foo', foldedFrom: null }
 *   id={"foo"}         → { value: 'foo', foldedFrom: null }
 *   id={FOO}           → { value: 'foo', foldedFrom: 'FOO' }  (if FOO folds)
 *   id={useId()}       → { value: null,  foldedFrom: null }
 *   id                 → { value: null,  foldedFrom: null }   (boolean attr)
 */
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

/**
 * Pull every id reference out of a resolved attribute (name, value) pair.
 *
 *   ('fill',  'url(#foo)')              → [{ id: 'foo',   via: 'url'  }]
 *   ('style', 'color: red; fill:url(#a) stroke:url(#b)') → two refs
 *   ('xlinkHref', '#sym')               → [{ id: 'sym',   via: 'href' }]
 *   ('href',  'https://…')              → []
 *   ('id',    'foo')                    → []  (caller handles declarations)
 */
function extractReferencedIds(attrName, value) {
  if (attrName === 'id' || typeof value !== 'string' || value.length === 0) return [];
  const out = [];

  // url(#...) references can appear inside any attribute's value. Using
  // matchAll lets us catch multi-reference values like
  // "fill:url(#a) stroke:url(#b)" inline on a `style` attribute.
  const pattern = new RegExp(URL_REF_PATTERN.source, 'g');
  let m;
  while ((m = pattern.exec(value)) !== null) {
    out.push({ id: m[1], via: 'url' });
  }

  // #<id> fragment reference, only on href-family attributes.
  if (HREF_ATTRS.has(attrName) && value.length > 1 && value.startsWith('#')) {
    const id = value.slice(1);
    // Guard against garbage like "#" or "#?" — an id must be at least
    // one character and should not contain whitespace.
    if (id.length > 0 && !/\s/.test(id)) {
      out.push({ id, via: 'href' });
    }
  }

  return out;
}

function pushTo(map, key, entry) {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
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
 * Run the analyzer across N project roots.
 *
 * Each finding is file-scoped by construction (the url(#) anchor lives
 * in the same file as the declaration). Two files that happen to
 * hardcode the same id produce two findings, not one — they are
 * independent bugs, since the render-multiplicity question is per-
 * component, not per-string.
 */
export function analyzeProjects(projectRoots) {
  const projects = projectRoots.map(resolveProject);
  const findings = [];

  for (const project of projects) {
    for (const absFile of walkSourceFiles(project.root)) {
      let code;
      try {
        code = fs.readFileSync(absFile, 'utf8');
      } catch {
        continue;
      }
      let fileFindings;
      try {
        fileFindings = analyzeSource(code, absFile);
      } catch {
        continue; // graceful parse-failure skip
      }
      const rel = path.relative(project.root, absFile);
      for (const f of fileFindings) {
        findings.push({
          kind: f.kind,
          id: f.id,
          element: f.element,
          occurrences: f.occurrences.map((o) => ({
            project: project.id,
            file: rel,
            ...o,
          })),
        });
      }
    }
  }

  // Deterministic order: by id, then by first-occurrence file+line.
  findings.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    const la = a.occurrences[0];
    const lb = b.occurrences[0];
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
 * Summarize a result for human display (stderr).
 */
export function summarize(result) {
  let totalReferences = 0;
  let totalDeclarations = 0;
  const affectedFiles = new Set();
  for (const f of result.findings) {
    for (const o of f.occurrences) {
      if (o.op === 'reference') totalReferences++;
      else if (o.op === 'declare') totalDeclarations++;
      affectedFiles.add(`${o.project}:${o.file}`);
    }
  }
  return {
    projectCount: result.projects.length,
    findingCount: result.findings.length,
    totalDeclarations,
    totalReferences,
    affectedFiles: affectedFiles.size,
  };
}
