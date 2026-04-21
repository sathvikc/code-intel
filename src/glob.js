/**
 * Minimal glob → RegExp compiler for `--exclude` patterns.
 *
 * Scope (deliberately narrow): enough to express the patterns every
 * real invocation actually needs — `**\/__tests__`, `**\/*.spec.*`,
 * `src/**`, plus the pre-existing literal paths — without pulling in
 * `minimatch` / `picomatch` as a dependency.
 *
 * Supported syntax:
 *   - `**`    — any number of path segments (including zero)
 *   - `*`     — zero or more characters in a single segment (no `/`)
 *   - `?`     — a single character in a single segment (no `/`)
 *   - anything else is matched literally
 *
 * NOT supported (intentional — file on BACKLOG if a real pattern asks):
 *   - `!pat`  — negation
 *   - `{a,b}` — brace expansion
 *   - `[abc]` — character class
 *   - `@(a|b)` / `+(pat)` / `?(pat)` — extglob
 *
 * Back-compat with the pre-glob era: a pattern without glob
 * meta-characters (`*` / `?`) compiles to a regex that matches the
 * same root-relative path the old `--exclude` resolved, so
 * `--exclude examples` / `--exclude src/examples` keep working.
 */

/**
 * Compile a glob pattern into a RegExp matched against a normalized
 * (forward-slash) rel-path string.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function compileGlob(pattern) {
  // Normalise: forward slashes, strip trailing separators so both
  // `examples` and `examples/` produce the same regex.
  const norm = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '');
  let re = '^';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*' && norm[i + 1] === '*') {
      // `**/` → optional any-prefix ending in a `/`. This lets
      // `**/__tests__` match both `__tests__` (no prefix) and
      // `src/a/__tests__` (prefix `src/a/`).
      if (norm[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        // Bare `**` (or `**` at end of pattern): match anything,
        // including path separators.
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

/**
 * Precompile an array of exclude patterns, keeping the original string
 * alongside the regex so error messages / --verbose output can show
 * the user what they typed.
 *
 * @param {readonly string[] | undefined} patterns
 * @returns {Array<{ pattern: string, re: RegExp }>}
 */
export function compileGlobs(patterns) {
  return (patterns ?? []).map((p) => ({ pattern: p, re: compileGlob(p) }));
}

/**
 * True if `relPath` matches any of the precompiled globs.
 * `relPath` is normalized to forward slashes before matching.
 *
 * @param {string} relPath
 * @param {Array<{ pattern: string, re: RegExp }>} globs
 * @returns {boolean}
 */
export function matchesAnyGlob(relPath, globs) {
  if (!globs || globs.length === 0) return false;
  const norm = String(relPath).replace(/\\/g, '/');
  for (const g of globs) {
    if (g.re.test(norm)) return true;
  }
  return false;
}
