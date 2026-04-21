/**
 * Per-run AST cache shared across detectors and import-graph.
 *
 * Why this exists
 * ---------------
 * On a single `impact` run, the same source file is currently read and
 * parsed by every detector that walks it — 7 detectors plus the import
 * graph all call `fs.readFileSync` and `ts.createSourceFile` on overlapping
 * file sets. The AST is re-built from scratch each time.
 *
 * This module lets the orchestrator parse each file once and hand the same
 * `ts.SourceFile` to every downstream consumer. Behaviour is identical with
 * or without the cache — detectors accept a pre-built SourceFile as an
 * optional third argument to `analyzeSource` and fall back to parsing
 * themselves when called directly (as in unit tests).
 *
 * Scope
 * -----
 * - Per-run only. The cache lives for the lifetime of one `analyzeProjects`
 *   call in `impact.js`. It is not persisted to disk.
 * - No content-hash keying; the cache trusts that file contents do not
 *   change mid-run. Content-hash keying for cross-run reuse is a separate
 *   concern tracked in `BACKLOG.md`.
 * - No concurrency primitives. This is a plain `Map` behind a thin API.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import {
  isFrameworkFile,
  extractFrameworkFile,
  scriptKindFor,
} from './framework-file.js';

/**
 * @typedef {{ code: string, sourceFile: import('typescript').SourceFile }} CacheEntry
 */

/**
 * Create a new per-run AST cache.
 *
 * The returned object is not thread-safe and is intended to live on the
 * stack of a single `analyzeProjects` call. It does not escape the
 * orchestrator boundary.
 */
export function createAstCache() {
  /** @type {Map<string, CacheEntry | null>} */
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let readErrors = 0;
  let parseErrors = 0;

  return {
    /**
     * Return a cached `{ code, sourceFile }` pair for `absPath`.
     *
     * On first access, reads the file and parses it. On subsequent accesses,
     * returns the same object reference. Returns `null` if the file could
     * not be read or parsed — callers should treat that like today's
     * `try { ... } catch { continue; }` path.
     *
     * @param {string} absPath
     * @returns {CacheEntry | null}
     */
    get(absPath) {
      if (store.has(absPath)) {
        hits++;
        return store.get(absPath);
      }
      misses++;
      let raw;
      try {
        raw = fs.readFileSync(absPath, 'utf8');
      } catch {
        readErrors++;
        store.set(absPath, null);
        return null;
      }
      // For framework files (.astro etc.), lift the JS/TS regions out of
      // the surrounding markup before parsing. The extractor is
      // byte-for-byte positional — line/column numbers and AST offsets
      // still map back to the same locations in the original file, so
      // detector snippets and diagnostics remain meaningful.
      const code = isFrameworkFile(absPath) ? extractFrameworkFile(absPath, raw) : raw;
      let sf;
      try {
        sf = ts.createSourceFile(
          absPath,
          code,
          ts.ScriptTarget.Latest,
          /* setParentNodes */ true,
          scriptKindFor(absPath),
        );
      } catch {
        parseErrors++;
        store.set(absPath, null);
        return null;
      }
      const entry = { code, sourceFile: sf };
      store.set(absPath, entry);
      return entry;
    },

    /**
     * Observability for the orchestrator. Useful for --verbose runs and
     * for benchmarking.
     *
     * @returns {{ size: number, hits: number, misses: number, readErrors: number, parseErrors: number }}
     */
    stats() {
      return { size: store.size, hits, misses, readErrors, parseErrors };
    },
  };
}
