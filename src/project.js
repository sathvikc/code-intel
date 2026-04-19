// Project discovery utilities shared across analyzers.
//
// A "project" is a directory containing source files that logically belong
// together. The `id` is taken from package.json `name` if present, else the
// directory basename. Multi-project analysis (D1) is just "run the analyzer
// across N resolved projects."
//
// Graceful degradation: unreadable directories and malformed package.json
// files fall back to safe defaults instead of throwing.

import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
]);

export const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.turbo', '.cache',
]);

/**
 * Resolve a project descriptor from a root path.
 * Project id = package.json `name` if present, else directory basename.
 */
export function resolveProject(root) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Project root is not a directory: ${abs}`);
  }
  const pkgPath = path.join(abs, 'package.json');
  let id = path.basename(abs);
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0) id = pkg.name;
    } catch {
      // graceful degradation: bad package.json → fall back to basename
    }
  }
  return { id, root: abs };
}

/**
 * Walk a directory and yield absolute paths to source files worth parsing.
 *
 * opts.exclude: array of root-relative directory paths to skip (literal, no
 * globs in v1). Each entry is resolved against `root`; when the walker
 * reaches a directory whose absolute path equals one of those, the entire
 * subtree is pruned. IGNORED_DIRS stays hardcoded on top of this — a user
 * cannot re-include `node_modules` via this option.
 */
export function* walkSourceFiles(root, opts = {}) {
  const excludeSet = new Set(
    (opts.exclude ?? []).map((e) => path.resolve(root, e)),
  );
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // graceful: unreadable dir → skip
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        // allow hidden source roots only if explicitly listed; default skip
        if (IGNORED_DIRS.has(e.name)) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (excludeSet.has(full)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (SOURCE_EXTENSIONS.has(path.extname(e.name))) yield full;
      }
    }
  }
}
