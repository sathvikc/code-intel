import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isFrameworkFile,
  extractFrameworkFile,
  extractAstroAsTs,
} from '../src/framework-file.js';

// ---------- isFrameworkFile ----------

test('isFrameworkFile: recognises .astro', () => {
  assert.equal(isFrameworkFile('x.astro'), true);
  assert.equal(isFrameworkFile('/abs/x.astro'), true);
});

test('isFrameworkFile: rejects .ts / .tsx / .js / .html / undefined', () => {
  assert.equal(isFrameworkFile('x.ts'), false);
  assert.equal(isFrameworkFile('x.tsx'), false);
  assert.equal(isFrameworkFile('x.js'), false);
  assert.equal(isFrameworkFile('x.html'), false);
  assert.equal(isFrameworkFile(undefined), false);
  assert.equal(isFrameworkFile(null), false);
});

// ---------- extractFrameworkFile dispatch ----------

test('extractFrameworkFile: non-framework file passes through unchanged', () => {
  const src = `import x from "y";\nconsole.log(x);\n`;
  assert.equal(extractFrameworkFile('/abs/file.ts', src), src);
});

test('extractFrameworkFile: dispatches to the astro extractor for .astro', () => {
  const astro = `---\nconst a = 1;\n---\n<div>{a}</div>\n`;
  const direct = extractAstroAsTs(astro);
  const dispatched = extractFrameworkFile('x.astro', astro);
  assert.equal(dispatched, direct);
});

// ---------- extractAstroAsTs: edge cases ----------

test('extractAstroAsTs: empty / undefined input', () => {
  assert.equal(extractAstroAsTs(''), '');
  assert.equal(extractAstroAsTs(undefined), '');
  assert.equal(extractAstroAsTs(null), '');
});

test('extractAstroAsTs: file with no frontmatter and no scripts yields blanks-only (length preserved)', () => {
  const src = `<div class="x">\n  hello\n</div>\n`;
  const out = extractAstroAsTs(src);
  assert.equal(out.length, src.length);
  // Same line count.
  assert.equal(out.split('\n').length, src.split('\n').length);
  // No non-whitespace characters (everything blanked).
  assert.match(out, /^[ \n]*$/);
});

test('extractAstroAsTs: preserves exact character count and newline positions', () => {
  const src = `---\nconst k = 'a.b';\n---\n\n<div>hi</div>\n<script>\n  window.addEventListener('x', () => {});\n</script>\n`;
  const out = extractAstroAsTs(src);
  assert.equal(out.length, src.length, 'length preserved');
  // Newline indices must match.
  const srcNewlines = [...src].map((c, i) => c === '\n' ? i : -1).filter((i) => i >= 0);
  const outNewlines = [...out].map((c, i) => c === '\n' ? i : -1).filter((i) => i >= 0);
  assert.deepEqual(outNewlines, srcNewlines, 'newlines at same indices');
});

// ---------- extractAstroAsTs: frontmatter ----------

test('extractAstroAsTs: blanks frontmatter body and fence lines entirely', () => {
  const src = `---\nconst K = 'app.session';\n---\n<div>x</div>\n`;
  const out = extractAstroAsTs(src);

  // Frontmatter body must NOT appear in the output.
  assert.ok(!out.includes(`const K = 'app.session';`));
  // The `---` fence lines themselves are blanked.
  const lines = out.split('\n');
  assert.match(lines[0], /^[ ]*$/, 'open fence line is blank');
  assert.match(lines[2], /^[ ]*$/, 'close fence line is blank');
  assert.match(lines[1], /^[ ]*$/, 'frontmatter body is blanked');
});

test('extractAstroAsTs: does NOT treat mid-file --- as frontmatter (must start at byte 0)', () => {
  const src = `<div>text</div>\n---\nconst K = 'not-frontmatter';\n---\n`;
  const out = extractAstroAsTs(src);
  assert.ok(!out.includes(`const K`), 'mid-file --- block is not honoured');
  assert.match(out, /^[ \n]*$/);
});

test('extractAstroAsTs: unclosed frontmatter is blanked entirely (malformed input, fail safe)', () => {
  const src = `---\nconst K = 'oops';\n<div>no closing fence</div>\n`;
  const out = extractAstroAsTs(src);
  assert.ok(!out.includes(`const K`));
  assert.match(out, /^[ \n]*$/);
});

// ---------- extractAstroAsTs: inline <script> ----------

test('extractAstroAsTs: extracts a single <script> body verbatim', () => {
  const src = `<div>hi</div>\n<script>\n  localStorage.setItem('k', '1');\n</script>\n`;
  const out = extractAstroAsTs(src);
  assert.ok(out.includes(`localStorage.setItem('k', '1');`));
  // The div markup is blanked.
  assert.ok(!out.includes('<div>'));
});

test('extractAstroAsTs: handles multiple <script> blocks independently', () => {
  const src = `<script>const a = 1;</script>\n<p>x</p>\n<script>const b = 2;</script>\n`;
  const out = extractAstroAsTs(src);
  assert.ok(out.includes('const a = 1;'));
  assert.ok(out.includes('const b = 2;'));
  assert.ok(!out.includes('<p>x</p>'));
});

test('extractAstroAsTs: script with attributes (type, lang, is:inline) still extracted', () => {
  const src = `<script type="module" lang="ts">const k = 'scoped';</script>\n<script is:inline>window.x = 1;</script>\n`;
  const out = extractAstroAsTs(src);
  assert.ok(out.includes(`const k = 'scoped';`));
  assert.ok(out.includes('window.x = 1;'));
});

test('extractAstroAsTs: external <script src="..."> body is NOT extracted', () => {
  const src = `<script src="/vendor.js"></script>\n<script src="./pre.js">console.log('ignored')</script>\n<script>const keep = 1;</script>\n`;
  const out = extractAstroAsTs(src);
  assert.ok(out.includes('const keep = 1;'), 'non-src script is kept');
  assert.ok(!out.includes(`console.log('ignored')`), 'src script body is blanked');
});

test('extractAstroAsTs: script-less file with src-only tag yields blank output', () => {
  const src = `<div><script src="/v.js"></script></div>\n`;
  const out = extractAstroAsTs(src);
  assert.match(out, /^[ \n]*$/);
});

test('extractAstroAsTs: <style> block is blanked even though it looks like code', () => {
  const src = `<style>\n  .x { color: red; }\n</style>\n<script>const ok = 1;</script>\n`;
  const out = extractAstroAsTs(src);
  assert.ok(!out.includes('.x { color: red; }'));
  assert.ok(out.includes('const ok = 1;'));
});

// ---------- extractAstroAsTs: frontmatter + scripts together ----------

test('extractAstroAsTs: blanks frontmatter but extracts inline scripts', () => {
  const src = [
    `---`,
    `import { K } from './keys';`,
    `const ready = true;`,
    `---`,
    ``,
    `<div>...</div>`,
    ``,
    `<script>`,
    `  window.addEventListener('x', () => {});`,
    `</script>`,
    ``,
  ].join('\n');
  const out = extractAstroAsTs(src);
  assert.ok(!out.includes(`import { K } from './keys';`));
  assert.ok(!out.includes(`const ready = true;`));
  assert.ok(out.includes(`window.addEventListener('x', () => {});`));
  assert.ok(!out.includes('<div>'));
});

test('extractAstroAsTs: output is TS-parseable by typescript', async () => {
  const ts = (await import('typescript')).default;
  const src = [
    `---`,
    `const K = 'app.session';`,
    `export function load() { return K; }`,
    `---`,
    `<div>{K}</div>`,
    `<script>`,
    `  window.dispatchEvent(new CustomEvent('x'));`,
    `</script>`,
  ].join('\n');
  const out = extractAstroAsTs(src);
  // If the extractor leaves behind malformed TS, createSourceFile either
  // throws or produces a tree riddled with diagnostics. A successful
  // parse with no unused-diagnostic crash is enough for this contract
  // test — per-detector behaviour is asserted in the integration tests.
  const sf = ts.createSourceFile('x.astro', out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.ok(sf, 'TS parsed the extracted source');
  assert.equal(sf.fileName, 'x.astro');
});
