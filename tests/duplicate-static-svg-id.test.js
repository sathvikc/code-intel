import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSource,
  analyzeProjects,
  SCHEMA_VERSION,
  ANALYZER_ID,
} from '../src/duplicate-static-svg-id.js';

// ---------- unit: the canonical bug shape ----------

test('canonical: <linearGradient id="g"> + fill="url(#g)" emits one finding', () => {
  const findings = analyzeSource(
    `export const Icon = () => (
       <svg>
         <defs>
           <linearGradient id="icon-fx" />
         </defs>
         <rect fill="url(#icon-fx)" />
       </svg>
     );`,
    'Icon.tsx',
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.kind, 'duplicate-static-svg-id');
  assert.equal(f.id, 'icon-fx');
  assert.equal(f.element, 'linearGradient');
  assert.equal(f.occurrences.length, 2);
  const decl = f.occurrences.find((o) => o.op === 'declare');
  const ref = f.occurrences.find((o) => o.op === 'reference');
  assert.equal(decl.element, 'linearGradient');
  assert.equal(ref.attribute, 'fill');
  assert.equal(ref.via, 'url');
});

test('clipPath attribute carries a url(#id) reference', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><clipPath id="cp-1"><rect /></clipPath></defs>
         <image clipPath="url(#cp-1)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'cp-1');
  const ref = findings[0].occurrences.find((o) => o.op === 'reference');
  assert.equal(ref.attribute, 'clipPath');
  assert.equal(ref.via, 'url');
});

test('mask / filter / stroke carry url(#id) references', () => {
  for (const [attr, value] of [
    ['mask', 'url(#m1)'],
    ['filter', 'url(#f1)'],
    ['stroke', 'url(#s1)'],
  ]) {
    const id = value.match(/#([^)]+)/)[1];
    const findings = analyzeSource(
      `export const C = () => (
         <svg>
           <defs><linearGradient id="${id}" /></defs>
           <rect ${attr}="${value}" />
         </svg>
       );`,
      `C-${attr}.tsx`,
    );
    assert.equal(findings.length, 1, `expected finding for ${attr}`);
    assert.equal(findings[0].id, id);
    const ref = findings[0].occurrences.find((o) => o.op === 'reference');
    assert.equal(ref.attribute, attr);
    assert.equal(ref.via, 'url');
  }
});

test('xlinkHref="#sym" on <use> emits a href-style reference', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><symbol id="arrow"><path d="M0 0 L10 10" /></symbol></defs>
         <use xlinkHref="#arrow" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'arrow');
  const ref = findings[0].occurrences.find((o) => o.op === 'reference');
  assert.equal(ref.via, 'href');
  assert.equal(ref.attribute, 'xlinkHref');
});

test('href="#sym" (SVG2) on <use> emits a href-style reference', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><symbol id="arrow" /></defs>
         <use href="#arrow" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  const ref = findings[0].occurrences.find((o) => o.op === 'reference');
  assert.equal(ref.via, 'href');
  assert.equal(ref.attribute, 'href');
});

test('a regular href URL (no leading #) is NOT treated as a fragment reference', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <a href="https://example.com">link</a>
         <defs><linearGradient id="only-declared" /></defs>
       </svg>
     );`,
    'C.tsx',
  );
  // only-declared is declared but has no in-file anchor → no finding
  assert.equal(findings.length, 0);
});

// ---------- unit: fold helper wiring ----------

test('folds same-file `const GRAD = "literal"` on the id attribute', () => {
  const findings = analyzeSource(
    `const GRAD = 'grad-1';
     export const C = () => (
       <svg>
         <defs><linearGradient id={GRAD} /></defs>
         <rect fill="url(#grad-1)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'grad-1');
  const decl = findings[0].occurrences.find((o) => o.op === 'declare');
  assert.equal(decl.foldedFrom, 'GRAD');
});

test('id={"literal"} JSX expression with inline string literal is treated as static', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id={"grad-2"} /></defs>
         <rect fill={"url(#grad-2)"} />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'grad-2');
});

// ---------- unit: dynamic cases that must NOT fire ----------

test('id={useId()} is dynamic — no finding', () => {
  const findings = analyzeSource(
    `import { useId } from 'react';
     export const C = () => {
       const gid = useId();
       return (
         <svg>
           <defs><linearGradient id={gid} /></defs>
           <rect fill={\`url(#\${gid})\`} />
         </svg>
       );
     };`,
    'C.tsx',
  );
  assert.equal(findings.length, 0);
});

test('template-literal id with a substitution is dynamic — no finding', () => {
  const findings = analyzeSource(
    `export const C = ({ suffix }) => (
       <svg>
         <defs><linearGradient id={\`grad-\${suffix}\`} /></defs>
         <rect fill={\`url(#grad-\${suffix})\`} />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 0);
});

test('prop-passed id is dynamic — no finding', () => {
  const findings = analyzeSource(
    `export const C = ({ id }) => (
       <svg>
         <defs><linearGradient id={id} /></defs>
         <rect fill={'url(#' + id + ')'} />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 0);
});

test('reassigned `let` disqualifies folding, so it stays dynamic', () => {
  const findings = analyzeSource(
    `let GRAD = 'grad-3';
     GRAD = 'grad-3-alt';
     export const C = () => (
       <svg>
         <defs><linearGradient id={GRAD} /></defs>
         <rect fill="url(#grad-3)" />
       </svg>
     );`,
    'C.tsx',
  );
  // GRAD is reassigned → not folded. The url(#grad-3) has no matching
  // static declaration → no finding.
  assert.equal(findings.length, 0);
});

// ---------- unit: anchor rule ----------

test('static id without any url(#id) / #id reference in the same file → no finding', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id="icon-unused" /></defs>
         <rect fill="red" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 0);
});

test('DOM id on a div without a matching url/fragment reference → no finding', () => {
  const findings = analyzeSource(
    `export const C = () => <div id="main-app">hello</div>;`,
    'C.tsx',
  );
  assert.equal(findings.length, 0);
});

test('url(#X) reference with no matching static declaration → no finding', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <rect fill="url(#nowhere)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 0);
});

// ---------- unit: richer shapes ----------

test('multiple url() references to the same id are all listed as occurrences', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id="g" /></defs>
         <rect fill="url(#g)" />
         <circle stroke="url(#g)" />
         <path fill="url(#g)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  const refs = findings[0].occurrences.filter((o) => o.op === 'reference');
  assert.equal(refs.length, 3);
});

test('two distinct ids in one file produce two findings', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs>
           <linearGradient id="g1" />
           <linearGradient id="g2" />
         </defs>
         <rect fill="url(#g1)" />
         <rect fill="url(#g2)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 2);
  const ids = findings.map((f) => f.id).sort();
  assert.deepEqual(ids, ['g1', 'g2']);
});

test('an inline style attribute containing url(#id) still matches', () => {
  // Inline style as a plain string (HTML-like) — some codebases still
  // ship SVG with string-style attributes. The detector should catch this.
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id="sg" /></defs>
         <rect style="fill:url(#sg); stroke:black" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  const ref = findings[0].occurrences.find((o) => o.op === 'reference');
  assert.equal(ref.attribute, 'style');
  assert.equal(ref.via, 'url');
});

test('non-SVG element with a static id still fires if a url(#id) references it', () => {
  // Mixed DOM + SVG — the bug shape survives the boundary.
  const findings = analyzeSource(
    `export const C = () => (
       <div>
         <i id="mark" />
         <svg><rect fill="url(#mark)" /></svg>
       </div>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'mark');
});

test('JsxSpreadAttribute ({...props}) is ignored — does not crash or emit', () => {
  const findings = analyzeSource(
    `export const C = (props) => (
       <svg>
         <defs><linearGradient {...props} id="g" /></defs>
         <rect fill="url(#g)" />
       </svg>
     );`,
    'C.tsx',
  );
  // Spread is skipped; the explicit id="g" is still a static declaration.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'g');
});

test('boolean attribute without initializer is ignored', () => {
  // `<path disabled />` — `disabled` has no initializer; must not crash.
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id="g" /></defs>
         <rect disabled fill="url(#g)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'g');
});

test('parses jsx (non-TS) without crashing', () => {
  const findings = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id="jsxid" /></defs>
         <rect fill="url(#jsxid)" />
       </svg>
     );`,
    'C.jsx',
  );
  assert.equal(findings.length, 1);
});

test('plain .ts file (no JSX) produces no findings gracefully', () => {
  // TypeScript parses .ts as non-JSX; JSX tokens would be errors.
  // A .ts file with only regular code should not error or emit.
  const findings = analyzeSource(
    `export const k = 'not-an-svg';`,
    'f.ts',
  );
  assert.equal(findings.length, 0);
});

// ---------- integration: analyzeProjects ----------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-svg-id-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('integration: single-file canonical bug surfaces one finding', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Icon.tsx', `
    export const Icon = () => (
      <svg>
        <defs><linearGradient id="icon-fx"><stop /></linearGradient></defs>
        <rect fill="url(#icon-fx)" />
      </svg>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.id, 'icon-fx');
  for (const o of f.occurrences) {
    assert.equal(o.project, 'app');
    assert.equal(o.file, 'src/Icon.tsx');
    assert.ok(o.line > 0);
    assert.ok(o.column > 0);
  }
});

test('integration: two files with the same hardcoded id produce two findings (not grouped)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/A.tsx', `
    export const A = () => (
      <svg><defs><linearGradient id="g" /></defs><rect fill="url(#g)" /></svg>
    );
  `);
  write(a, 'src/B.tsx', `
    export const B = () => (
      <svg><defs><linearGradient id="g" /></defs><rect fill="url(#g)" /></svg>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 2);
  const files = r.findings.map((f) => f.occurrences[0].file).sort();
  assert.deepEqual(files, ['src/A.tsx', 'src/B.tsx']);
});

test('integration: ignores node_modules', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Good.tsx', `
    export const G = ({ id }) => <svg><rect fill={\`url(#\${id})\`} /></svg>;
  `);
  write(a, 'node_modules/pkg/Bad.tsx', `
    export const B = () => (
      <svg><defs><linearGradient id="vendor" /></defs><rect fill="url(#vendor)" /></svg>
    );
  `);
  const r = analyzeProjects([a]);
  for (const f of r.findings) {
    for (const o of f.occurrences) {
      assert.ok(!o.file.includes('node_modules'), `unexpected node_modules occurrence: ${o.file}`);
    }
  }
});

test('integration: schema shape', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Icon.tsx', `
    export const Icon = () => (
      <svg>
        <defs><linearGradient id="icon-fx"><stop /></linearGradient></defs>
        <rect fill="url(#icon-fx)" />
      </svg>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.version, SCHEMA_VERSION);
  assert.equal(r.analyzer, ANALYZER_ID);
  assert.equal(r.analyzer, 'duplicate-static-svg-id');
  const f = r.findings[0];
  assert.equal(f.kind, 'duplicate-static-svg-id');
  assert.equal(typeof f.id, 'string');
  assert.equal(typeof f.element, 'string');
  assert.ok(Array.isArray(f.occurrences));
  const o = f.occurrences[0];
  assert.equal(typeof o.project, 'string');
  assert.equal(typeof o.file, 'string');
  assert.ok(typeof o.line === 'number' && o.line > 0);
  assert.ok(typeof o.column === 'number' && o.column > 0);
  assert.match(o.op, /^(declare|reference)$/);
  assert.equal(typeof o.snippet, 'string');
});
