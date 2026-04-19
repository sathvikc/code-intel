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

// ---------- unit: observation shape (analyzeSource) ----------
//
// Under v2 (D10), `analyzeSource` does NOT emit findings; it produces a
// per-file observation record. Cross-file stitching happens in
// `analyzeProjects`. These tests pin the observation record.

test('canonical shape produces one staticIdSite + anchor, but no analyzeSource findings API', () => {
  const obs = analyzeSource(
    `export const Icon = () => (
       <svg>
         <defs><linearGradient id="icon-fx" /></defs>
         <rect fill="url(#icon-fx)" />
       </svg>
     );`,
    'Icon.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  const site = obs.staticIdSites[0];
  assert.equal(site.id, 'icon-fx');
  assert.equal(site.element, 'linearGradient');
  assert.equal(site.component, 'Icon');
  assert.equal(site.inIteration, false);
  assert.ok(obs.anchoredIds.has('icon-fx'));
  assert.equal(obs.anchorRefs.length, 1);
  assert.equal(obs.anchorRefs[0].via, 'url');
  assert.equal(obs.anchorRefs[0].attribute, 'fill');
});

test('clipPath / mask / filter / stroke carry url(#id) anchors', () => {
  for (const [attr, value] of [
    ['clipPath', 'url(#cp-1)'],
    ['mask', 'url(#m1)'],
    ['filter', 'url(#f1)'],
    ['stroke', 'url(#s1)'],
  ]) {
    const id = value.match(/#([^)]+)/)[1];
    const obs = analyzeSource(
      `export const C = () => (
         <svg>
           <defs><linearGradient id="${id}" /></defs>
           <rect ${attr}="${value}" />
         </svg>
       );`,
      `C-${attr}.tsx`,
    );
    assert.ok(obs.anchoredIds.has(id), `expected anchor for ${attr}`);
    const ref = obs.anchorRefs.find((r) => r.id === id);
    assert.equal(ref.via, 'url');
    assert.equal(ref.attribute, attr);
  }
});

test('xlinkHref="#sym" produces an href-style anchor', () => {
  const obs = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><symbol id="arrow"><path d="M0 0 L10 10" /></symbol></defs>
         <use xlinkHref="#arrow" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.ok(obs.anchoredIds.has('arrow'));
  const ref = obs.anchorRefs.find((r) => r.id === 'arrow');
  assert.equal(ref.via, 'href');
  assert.equal(ref.attribute, 'xlinkHref');
});

test('href="#sym" (SVG2) is recorded as an href-style anchor', () => {
  const obs = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><symbol id="arrow" /></defs>
         <use href="#arrow" />
       </svg>
     );`,
    'C.tsx',
  );
  const ref = obs.anchorRefs.find((r) => r.id === 'arrow');
  assert.equal(ref.via, 'href');
  assert.equal(ref.attribute, 'href');
});

test('a regular URL (no leading #) on <a href> is NOT an anchor', () => {
  const obs = analyzeSource(
    `export const C = () => <a href="https://example.com">link</a>;`,
    'C.tsx',
  );
  assert.equal(obs.anchorRefs.length, 0);
  assert.equal(obs.anchoredIds.size, 0);
});

test('folded same-file `const GRAD = "literal"` records foldedFrom on the site', () => {
  const obs = analyzeSource(
    `const GRAD = 'grad-1';
     export const C = () => (
       <svg>
         <defs><linearGradient id={GRAD} /></defs>
         <rect fill="url(#grad-1)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  assert.equal(obs.staticIdSites[0].id, 'grad-1');
  assert.equal(obs.staticIdSites[0].foldedFrom, 'GRAD');
});

test('id={"literal"} JSX expression is treated as static', () => {
  const obs = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id={"grad-2"} /></defs>
         <rect fill={"url(#grad-2)"} />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  assert.equal(obs.staticIdSites[0].id, 'grad-2');
});

test('id={useId()} is dynamic — no staticIdSite', () => {
  const obs = analyzeSource(
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
  assert.equal(obs.staticIdSites.length, 0);
});

test('template-literal id with a substitution is dynamic', () => {
  const obs = analyzeSource(
    `export const C = ({ suffix }) => (
       <svg>
         <defs><linearGradient id={\`grad-\${suffix}\`} /></defs>
         <rect fill={\`url(#grad-\${suffix})\`} />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(obs.staticIdSites.length, 0);
});

test('prop-passed id is dynamic', () => {
  const obs = analyzeSource(
    `export const C = ({ id }) => (
       <svg>
         <defs><linearGradient id={id} /></defs>
         <rect fill={'url(#' + id + ')'} />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(obs.staticIdSites.length, 0);
});

test('reassigned `let` disqualifies folding', () => {
  const obs = analyzeSource(
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
  assert.equal(obs.staticIdSites.length, 0);
});

test('static id without a matching anchor is observed but anchoredIds omits it', () => {
  const obs = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id="icon-unused" /></defs>
         <rect fill="red" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  assert.equal(obs.anchoredIds.has('icon-unused'), false);
});

test('JsxSpreadAttribute ({...props}) is ignored without crashing', () => {
  const obs = analyzeSource(
    `export const C = (props) => (
       <svg>
         <defs><linearGradient {...props} id="g" /></defs>
         <rect fill="url(#g)" />
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  assert.equal(obs.staticIdSites[0].id, 'g');
});

test('parses .jsx without crashing', () => {
  const obs = analyzeSource(
    `export const C = () => (
       <svg>
         <defs><linearGradient id="jsxid" /></defs>
         <rect fill="url(#jsxid)" />
       </svg>
     );`,
    'C.jsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
});

test('plain .ts (no JSX) produces empty observations gracefully', () => {
  const obs = analyzeSource(`export const k = 'not-an-svg';`, 'f.ts');
  assert.equal(obs.staticIdSites.length, 0);
  assert.equal(obs.anchorRefs.length, 0);
  assert.equal(obs.jsxUsages.length, 0);
});

// ---------- iteration detection ----------

test('in-file .map wrapping the declaration marks inIteration', () => {
  const obs = analyzeSource(
    `export const Grid = ({ items }) => (
       <svg>
         {items.map((i) => (
           <g key={i.id}>
             <defs><linearGradient id="g-iter" /></defs>
             <rect fill="url(#g-iter)" />
           </g>
         ))}
       </svg>
     );`,
    'Grid.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  const site = obs.staticIdSites[0];
  assert.equal(site.inIteration, true);
  assert.equal(site.iterationMethod, 'map');
  assert.ok(site.iterationSiteLine > 0);
});

test('forEach and flatMap count as iteration too', () => {
  for (const method of ['forEach', 'flatMap']) {
    const obs = analyzeSource(
      `export const C = ({ items }) => (
         <svg>
           {items.${method}((i) => <rect fill="url(#m)" key={i}><linearGradient id="m" /></rect>)}
         </svg>
       );`,
      `${method}.tsx`,
    );
    assert.equal(obs.staticIdSites.length, 1, `expected site for ${method}`);
    assert.equal(obs.staticIdSites[0].inIteration, true);
    assert.equal(obs.staticIdSites[0].iterationMethod, method);
  }
});

test('Array.from(..., cb) is recognized as iteration', () => {
  const obs = analyzeSource(
    `export const C = ({ n }) => (
       <svg>
         {Array.from({ length: n }, (_, i) => (
           <g key={i}>
             <linearGradient id="arr-from-g" />
             <rect fill="url(#arr-from-g)" />
           </g>
         ))}
       </svg>
     );`,
    'C.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  assert.equal(obs.staticIdSites[0].inIteration, true);
  assert.equal(obs.staticIdSites[0].iterationMethod, 'Array.from');
});

test('named callback passed to .map does NOT flag as iteration (v1 gap)', () => {
  // `items.map(renderIcon); function renderIcon() { return <X /> }` —
  // the JSX inside renderIcon crosses a non-iteration function boundary,
  // so we conservatively don't mark it. Documented as a known gap.
  const obs = analyzeSource(
    `function renderIcon(i) {
       return (
         <svg>
           <linearGradient id="named-cb" />
           <rect fill="url(#named-cb)" />
         </svg>
       );
     }
     export const List = ({ items }) => <>{items.map(renderIcon)}</>;`,
    'List.tsx',
  );
  assert.equal(obs.staticIdSites.length, 1);
  assert.equal(obs.staticIdSites[0].inIteration, false);
});

test('JSX usages of user components are captured; HTML/SVG lowercase tags are not', () => {
  const obs = analyzeSource(
    `export const Page = () => (
       <div>
         <CategoryIcon />
         <SideBar />
         <svg><rect /></svg>
       </div>
     );`,
    'Page.tsx',
  );
  const names = obs.jsxUsages.map((u) => u.component).sort();
  // Only user components rendered inside Page's JSX; lowercase tags (div/svg/rect)
  // are not captured. Page itself is defined here, not rendered, so it is absent.
  assert.deepEqual(names, ['CategoryIcon', 'SideBar']);
});

test('usage inside .map records inIteration on the jsxUsage', () => {
  const obs = analyzeSource(
    `export const Nav = ({ items }) => (
       <>{items.map((i) => <CategoryIcon key={i.id} />)}</>
     );`,
    'Nav.tsx',
  );
  const use = obs.jsxUsages.find((u) => u.component === 'CategoryIcon');
  assert.ok(use);
  assert.equal(use.inIteration, true);
  assert.equal(use.iterationMethod, 'map');
});

// ---------- integration: analyzeProjects emission ----------
//
// These tests pin the v2 emission rule: candidates only emit with at
// least one evidence entry (E1-E4).

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-svg-id-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test('integration: lone component with static id + anchor, no loop, no duplicate → NO finding', () => {
  // v2 pivot: this used to emit a "latent bug" finding under D9; D10
  // says we don't predict the future, so the lone case is silent.
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
  assert.equal(r.findings.length, 0);
});

test('integration: E1 in-file loop emits one finding with in-file-loop evidence', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Grid.tsx', `
    export const Grid = ({ items }) => (
      <svg>
        {items.map((i) => (
          <g key={i.id}>
            <defs><linearGradient id="g-iter" /></defs>
            <rect fill="url(#g-iter)" />
          </g>
        ))}
      </svg>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.id, 'g-iter');
  assert.equal(f.component, 'Grid');
  const evTypes = f.evidence.map((e) => e.type);
  assert.ok(evTypes.includes('in-file-loop'));
  const inFile = f.evidence.find((e) => e.type === 'in-file-loop');
  assert.equal(inFile.method, 'map');
  assert.ok(f.occurrences.some((o) => o.op === 'declare'));
  assert.ok(f.occurrences.some((o) => o.op === 'reference'));
  assert.ok(f.occurrences.some((o) => o.op === 'iteration-site'));
});

test('integration: E2 caller loop — importer maps over <Icon />, emits caller-loop evidence', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Icon.tsx', `
    export const Icon = () => (
      <svg>
        <defs><linearGradient id="cat-fx" /></defs>
        <rect fill="url(#cat-fx)" />
      </svg>
    );
  `);
  write(a, 'src/NavGrid.tsx', `
    import { Icon } from './Icon';
    export const NavGrid = ({ items }) => (
      <nav>{items.map((i) => <Icon key={i.id} />)}</nav>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.id, 'cat-fx');
  assert.equal(f.component, 'Icon');
  const caller = f.evidence.find((e) => e.type === 'caller-loop');
  assert.ok(caller, 'expected caller-loop evidence');
  assert.equal(caller.method, 'map');
  assert.equal(caller.at.file, 'src/NavGrid.tsx');
  // The declaration lives in Icon.tsx even though the evidence points at NavGrid.tsx.
  const decl = f.occurrences.find((o) => o.op === 'declare');
  assert.equal(decl.file, 'src/Icon.tsx');
});

test('integration: E2 respects rename — `import { Icon as NavIcon }` still matched', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/icons.tsx', `
    export const Icon = () => (
      <svg><defs><linearGradient id="r-id" /></defs><rect fill="url(#r-id)" /></svg>
    );
  `);
  write(a, 'src/nav.tsx', `
    import { Icon as NavIcon } from './icons';
    export const Nav = ({ items }) => <>{items.map((i) => <NavIcon key={i} />)}</>;
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.ok(f.evidence.some((e) => e.type === 'caller-loop'));
});

test('integration: E2 default import — `import Foo from`', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Icon.tsx', `
    const Icon = () => (
      <svg><defs><linearGradient id="def-fx" /></defs><rect fill="url(#def-fx)" /></svg>
    );
    export default Icon;
  `);
  write(a, 'src/nav.tsx', `
    import Icon from './Icon';
    export const Nav = ({ items }) => <>{items.map((i) => <Icon key={i} />)}</>;
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  assert.ok(r.findings[0].evidence.some((e) => e.type === 'caller-loop'));
});

test('integration: E3 same-component duplicate — two declarations of same id in one component', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/C.tsx', `
    export const C = () => (
      <svg>
        <defs>
          <linearGradient id="same-fx" />
          <linearGradient id="same-fx" />
        </defs>
        <rect fill="url(#same-fx)" />
      </svg>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  const e = f.evidence.find((x) => x.type === 'same-component-duplicate');
  assert.ok(e, 'expected same-component-duplicate evidence');
  assert.equal(e.count, 2);
});

test('integration: E4 cross-component duplicate — same id in two different components', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/A.tsx', `
    export const A = () => (
      <svg><defs><linearGradient id="shared" /></defs><rect fill="url(#shared)" /></svg>
    );
  `);
  write(a, 'src/B.tsx', `
    export const B = () => (
      <svg><defs><linearGradient id="shared" /></defs><rect fill="url(#shared)" /></svg>
    );
  `);
  const r = analyzeProjects([a]);
  // Two candidates (one per component). Each has E4 pointing at the
  // other, so both emit.
  assert.equal(r.findings.length, 2);
  for (const f of r.findings) {
    const e = f.evidence.find((x) => x.type === 'cross-component-duplicate');
    assert.ok(e, 'expected cross-component-duplicate evidence on every finding');
    assert.ok(e.other.component);
  }
});

test('integration: lone candidate → skipped; same id in a loop → emitted (demonstrates pivot)', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Lone.tsx', `
    export const Lone = () => (
      <svg><defs><linearGradient id="lone-id" /></defs><rect fill="url(#lone-id)" /></svg>
    );
  `);
  write(a, 'src/Looped.tsx', `
    export const Looped = ({ items }) => (
      <svg>{items.map((i) => <g key={i}><linearGradient id="looped-id" /><rect fill="url(#looped-id)" /></g>)}</svg>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, 'looped-id');
});

test('integration: candidate with both E1 and E4 carries both evidence entries', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Grid.tsx', `
    export const Grid = ({ items }) => (
      <svg>
        {items.map((i) => (
          <g key={i}><linearGradient id="mixed" /><rect fill="url(#mixed)" /></g>
        ))}
      </svg>
    );
  `);
  write(a, 'src/Other.tsx', `
    export const Other = () => (
      <svg><linearGradient id="mixed" /><rect fill="url(#mixed)" /></svg>
    );
  `);
  const r = analyzeProjects([a]);
  const grid = r.findings.find((f) => f.component === 'Grid');
  assert.ok(grid);
  const evTypes = grid.evidence.map((e) => e.type).sort();
  assert.ok(evTypes.includes('in-file-loop'));
  assert.ok(evTypes.includes('cross-component-duplicate'));
});

test('integration: ignores node_modules', () => {
  const a = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app' }));
  write(a, 'src/Grid.tsx', `
    export const Grid = ({ items }) => (
      <svg>{items.map((i) => <g key={i}><linearGradient id="app-id" /><rect fill="url(#app-id)" /></g>)}</svg>
    );
  `);
  write(a, 'node_modules/pkg/Bad.tsx', `
    export const B = ({ items }) => (
      <svg>{items.map((i) => <g key={i}><linearGradient id="vendor-id" /><rect fill="url(#vendor-id)" /></g>)}</svg>
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
  write(a, 'src/G.tsx', `
    export const G = ({ items }) => (
      <svg>
        {items.map((i) => <g key={i}><linearGradient id="schema-id" /><rect fill="url(#schema-id)" /></g>)}
      </svg>
    );
  `);
  const r = analyzeProjects([a]);
  assert.equal(r.version, SCHEMA_VERSION);
  assert.equal(r.analyzer, ANALYZER_ID);
  assert.equal(r.analyzer, 'duplicate-static-svg-id');
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.kind, 'duplicate-static-svg-id');
  assert.equal(typeof f.id, 'string');
  assert.equal(typeof f.element, 'string');
  assert.ok('component' in f);
  assert.ok(Array.isArray(f.evidence));
  assert.ok(f.evidence.length > 0);
  assert.ok(Array.isArray(f.occurrences));
  const o = f.occurrences[0];
  assert.equal(typeof o.project, 'string');
  assert.equal(typeof o.file, 'string');
  assert.ok(typeof o.line === 'number' && o.line > 0);
  assert.match(o.op, /^(declare|reference|iteration-site|duplicate-declaration)$/);
});
