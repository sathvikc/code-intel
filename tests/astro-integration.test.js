/**
 * Integration tests for `.astro` file support.
 *
 * Verifies every detector that matters for Astro dogfood can see coupling
 * inside `.astro` files — frontmatter + inline `<script>` — and that the
 * line numbers reported point back to the original `.astro` source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeProjects as analyzeStorage } from '../src/shared-state-web-storage.js';
import { analyzeProjects as analyzeEvents } from '../src/shared-state-events.js';
import { analyzeProjects as analyzeGlobals } from '../src/shared-state-globals.js';
import { analyzeProjects as analyzePaired } from '../src/paired-keys.js';
import { analyzeProjects as analyzeShape } from '../src/shape-drift.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'astro-int-'));
}
function write(root, rel, contents) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

// ---------- Storage detection in .astro frontmatter + script ----------

test('.astro frontmatter: shared-state-web-storage detects a setItem', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-storage' }));
  write(
    root,
    'src/pages/index.astro',
    `---
const value = 'ok';
sessionStorage.setItem('page.flags', value);
---
<div>hello</div>
`,
  );

  const result = analyzeStorage([root]);
  const finding = result.findings.find((f) => f.key === 'page.flags');
  assert.ok(finding, 'finding emitted for the setItem call in frontmatter');
  assert.equal(finding.occurrences.length, 1);
  const o = finding.occurrences[0];
  assert.ok(o.file.endsWith('.astro'));
  assert.equal(o.line, 3, 'line maps to the original .astro line');
  assert.equal(o.op, 'write');
});

test('.astro inline <script>: shared-state-web-storage detects a setItem', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-script' }));
  write(
    root,
    'src/pages/index.astro',
    `<div>hello</div>
<script>
  localStorage.setItem('user.session', JSON.stringify({ id: 1 }));
</script>
`,
  );

  const result = analyzeStorage([root]);
  const finding = result.findings.find((f) => f.key === 'user.session');
  assert.ok(finding, 'finding emitted for setItem inside inline <script>');
  const o = finding.occurrences[0];
  assert.ok(o.file.endsWith('.astro'));
  assert.equal(o.line, 3, 'line maps to the inline <script> content line');
});

// ---------- Cross-file coupling: .astro + .ts ----------

test('.astro frontmatter + .ts consumer: shared-state-web-storage groups both', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-cross' }));
  write(
    root,
    'src/pages/page.astro',
    `---
sessionStorage.setItem('app.cart', JSON.stringify({ items: [] }));
---
<main />
`,
  );
  write(
    root,
    'src/cart.ts',
    `export function read() {
  return JSON.parse(sessionStorage.getItem('app.cart') || '{}');
}
`,
  );

  const result = analyzeStorage([root]);
  const finding = result.findings.find((f) => f.key === 'app.cart');
  assert.ok(finding, 'detector finds the coupling across .astro + .ts');
  const files = [...new Set(finding.occurrences.map((o) => path.extname(o.file)))];
  assert.ok(files.includes('.astro'));
  assert.ok(files.includes('.ts'));
});

// ---------- Events in .astro inline <script> ----------

test('.astro inline <script>: shared-state-events detects dispatch + listen coupling', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-evt' }));
  write(
    root,
    'src/pages/home.astro',
    `<div>hi</div>
<script>
  window.addEventListener('app:ready', () => {});
</script>
`,
  );
  write(
    root,
    'src/bootstrap.ts',
    `window.dispatchEvent(new CustomEvent('app:ready'));`,
  );

  const result = analyzeEvents([root]);
  const finding = result.findings.find((f) => f.channel === 'app:ready');
  assert.ok(finding, 'channel finding emitted across .astro + .ts');
  assert.equal(finding.occurrences.length, 2);
  const ops = new Set(finding.occurrences.map((o) => o.op));
  assert.ok(ops.has('dispatch') && ops.has('listen'));
});

// ---------- Globals declared in .astro frontmatter ----------

test('.astro frontmatter: shared-state-globals detects window.X assignment colliding with a .ts writer', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-glob' }));
  write(
    root,
    'src/pages/page.astro',
    `---
window.__mnCartReady__ = true;
---
<main />
`,
  );
  write(root, 'src/cart.ts', `window.__mnCartReady__ = false;\n`);

  const result = analyzeGlobals([root]);
  const finding = result.findings.find((f) => f.name === '__mnCartReady__');
  assert.ok(finding, 'globals collision detected across .astro + .ts');
  assert.ok(finding.occurrences.some((o) => o.file.endsWith('.astro')));
});

// ---------- paired-keys inside an .astro inline <script> ----------

test('.astro inline <script>: paired-keys detects a co-write cluster', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-pairs' }));
  write(
    root,
    'src/pages/index.astro',
    `<div>hi</div>
<script>
  function cache(v) {
    sessionStorage.setItem('cache.v', JSON.stringify(v));
    sessionStorage.setItem('cache.v.ts', String(Date.now()));
  }
</script>
`,
  );

  const result = analyzePaired([root]);
  assert.equal(result.findings.length, 1, 'one paired-keys cluster found');
  const finding = result.findings[0];
  assert.deepEqual(finding.keys.sort(), ['cache.v', 'cache.v.ts']);
  for (const o of finding.occurrences) {
    assert.ok(o.file.endsWith('.astro'));
  }
});

// ---------- shape-drift across .astro writer + .ts reader ----------

test('.astro frontmatter writer + .ts reader: shape-drift detects the disagreement', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-drift' }));
  write(
    root,
    'src/pages/page.astro',
    `---
localStorage.setItem('profile.v1', JSON.stringify({ firstName: 'a', lastName: 'b' }));
---
<main />
`,
  );
  write(
    root,
    'src/profile.ts',
    `const { first_name } = JSON.parse(localStorage.getItem('profile.v1') || '{}');`,
  );

  const result = analyzeShape([root]);
  const finding = result.findings.find((f) => f.key === 'profile.v1');
  assert.ok(finding, 'shape-drift finding emitted across .astro + .ts');
  assert.deepEqual(finding.writeShape.sort(), ['firstName', 'lastName']);
  assert.deepEqual(finding.readShape, ['first_name']);
});

// ---------- Line preservation guarantee ----------

test('.astro line numbers in findings match the original file positions exactly', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'astro-lines' }));
  // Intentionally put the statement on a very specific line so we can assert
  // against it. Nothing else is on lines 1-7; the setItem lives on line 8.
  const body = [
    `---`,                                                          // 1
    `// top comment`,                                               // 2
    `// another comment`,                                           // 3
    ``,                                                             // 4
    `const v = 'literal';`,                                         // 5
    `// noise`,                                                     // 6
    `// more noise`,                                                // 7
    `sessionStorage.setItem('line.test', v);`,                      // 8
    `---`,                                                          // 9
    `<main>{v}</main>`,                                             // 10
  ].join('\n');
  write(root, 'src/pages/page.astro', body);

  const result = analyzeStorage([root]);
  const finding = result.findings.find((f) => f.key === 'line.test');
  assert.ok(finding);
  assert.equal(finding.occurrences[0].line, 8, 'line number preserved through extraction');
});
