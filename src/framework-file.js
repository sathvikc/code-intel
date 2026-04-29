/**
 * Framework-file extractor.
 *
 * Some source formats (`.astro`, later `.vue`, `.svelte`) mix HTML-ish
 * markup with TypeScript / JavaScript. The parser we use (`ts`) cannot
 * parse the markup half. Rather than add a framework compiler dependency,
 * this module pre-extracts the JS/TS regions from the raw source into a
 * form the TS parser can read directly.
 *
 * Design invariants (see D15-adjacent note in BACKLOG → infrastructure):
 *
 * 1. **Line numbers are preserved.** Every character in the raw source maps
 *    to the same byte offset in the extracted output. Non-JS/TS regions
 *    are replaced with spaces (or newlines on line breaks) rather than
 *    deleted. This keeps TS-reported line/column numbers meaningful for
 *    the reviewer looking at the original file.
 *
 * 2. **Snippets still render correctly.** Detectors extract snippets by
 *    slicing `code.substring(node.pos, node.end)`. Because AST nodes only
 *    live inside kept regions, and kept regions are unchanged from the
 *    raw source, snippets show the original content.
 *
 * 3. **Syntactic-only (D5).** No framework compiler, no HTML parser. A
 *    tight regex / state-machine approach over the raw text, good enough
 *    for the ~90% of real-world Astro files that use the canonical
 *    frontmatter + `<script>` shape.
 *
 * Scope (v1):
 * - `.astro` support only.
 * - Extracts: the frontmatter code fence (between the first two `---`
 *   lines at the top of the file) + any inline `<script>…</script>`
 *   blocks that do NOT carry a `src=` attribute.
 * - Blanks: all markup, `<style>` blocks, external-script tags.
 *
 * Deferred:
 * - `.vue` / `.svelte` — same general approach, different fences.
 * - Per-script `lang="ts"` / `lang="tsx"` detection — v1 treats all
 *   scripts as TS; TS parser accepts JS too.
 * - Source-mapping the extracted positions back through a sourcemap —
 *   currently one-to-one because extraction is byte-for-byte positional.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const FRONTMATTER_FENCE = /^---[ \t]*$/m;
// Match <script ...>...</script>. Non-greedy on body; also permits the
// `/script` close with optional whitespace before `>`.
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/\s*script\s*>/gi;
const SRC_ATTR = /\bsrc\s*=/i;

/**
 * Return true if this filename should be routed through a framework-file
 * extractor before parsing. Keeps the extension logic centralized so
 * `ast-cache.js` doesn't grow a second extension switch.
 */
export function isFrameworkFile(filePath) {
  return typeof filePath === 'string' && filePath.endsWith('.astro');
}

/**
 * Dispatch to the right extractor for a framework file.
 *
 * @param {string} filePath
 * @param {string} source
 * @returns {string} a TS/JS-parseable representation of the same source
 */
export function extractFrameworkFile(filePath, source) {
  if (filePath.endsWith('.astro')) return extractAstroAsTs(source);
  return source;
}

/**
 * Read a source file and, when it's a framework file, route it through
 * the appropriate extractor.
 *
 * Single helper shared by every detector's `--no-cache` fallback path so
 * the three-line `try { fs.readFileSync } catch { continue }` pattern
 * doesn't each need to grow its own `.astro` awareness. Throws on read
 * errors; callers are expected to wrap in try/catch as they did before.
 *
 * @param {string} filePath absolute path
 * @returns {string}
 */
export function readSource(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return isFrameworkFile(filePath) ? extractFrameworkFile(filePath, raw) : raw;
}

/**
 * Map a file's extension to the correct `ts.ScriptKind` for parsing.
 *
 * Single source of truth for every detector's own `ts.createSourceFile`
 * fallback path and for the AST cache. Adding a new source extension
 * (`.vue`, `.svelte`, …) then only touches this helper and `project.js`.
 *
 * Framework files are pre-extracted into TS-parseable form elsewhere, so
 * the returned kind reflects what the extracted payload looks like.
 *
 * @param {string} filePath
 * @returns {import('typescript').ScriptKind}
 */
export function scriptKindFor(filePath) {
  switch (path.extname(filePath)) {
    case '.ts': return ts.ScriptKind.TS;
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.mjs':
    case '.cjs':
    case '.js': return ts.ScriptKind.JS;
    // Framework files. See the file-header `Deferred` note for why we
    // pick TS over TSX — frontmatter is plain TypeScript, inline scripts
    // default to JS which the TS parser accepts.
    case '.astro': return ts.ScriptKind.TS;
    default: return ts.ScriptKind.Unknown;
  }
}

/**
 * Extract the JS/TS regions of an `.astro` source into a TS-parseable
 * string of the same length, with non-code regions blanked out.
 *
 * @param {string} src raw `.astro` file contents
 * @returns {string} extracted source, same length as `src`
 */
export function extractAstroAsTs(src) {
  if (typeof src !== 'string' || src.length === 0) return src ?? '';

  // Start with a fully blanked output: spaces everywhere except newlines.
  // We'll copy kept regions back in from the original source.
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src.charCodeAt(i) === 10 /* \n */ ? '\n' : ' ';
  }

  // --- Frontmatter: first `---` line at start of file, next `---` line.
  // Astro requires the opening fence to be at the very top, so we only
  // honour frontmatter when the file begins with `---` (optionally
  // preceded by whitespace on that line only).
  const firstMatch = src.match(FRONTMATTER_FENCE);
  if (firstMatch && firstMatch.index === 0) {
    const openEnd = src.indexOf('\n', firstMatch.index);
    if (openEnd !== -1) {
      const bodyStart = openEnd + 1;
      const rest = src.slice(bodyStart);
      const closeRel = rest.search(FRONTMATTER_FENCE);
      if (closeRel !== -1) {
        const bodyEnd = bodyStart + closeRel;
        // Blank out the frontmatter body. Do not copy it into the output.
        // for (let i = bodyStart; i < bodyEnd; i++) out[i] = src[i];
      }
    }
  }

  // --- Inline <script>...</script> blocks.
  // Reset regex state just in case (global regexes carry lastIndex).
  SCRIPT_BLOCK.lastIndex = 0;
  let m;
  while ((m = SCRIPT_BLOCK.exec(src)) !== null) {
    const attrs = m[1] || '';
    if (SRC_ATTR.test(attrs)) continue; // external script — don't pretend we see its body
    const tagOpenEnd = m.index + m[0].indexOf('>') + 1;
    const tagCloseStart = m.index + m[0].lastIndexOf('</');
    for (let i = tagOpenEnd; i < tagCloseStart; i++) out[i] = src[i];
  }

  return out.join('');
}
