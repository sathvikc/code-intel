import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractImportSpecifiers,
  resolveImport,
  loadAliases,
  buildReverseGraph,
  findDependents,
  analyzeProjects,
} from '../src/import-graph.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-importgraph-test-'));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ---------- extractImportSpecifiers ----------

test('extracts ES import specifiers', () => {
  const specs = extractImportSpecifiers(
    `import a from 'x';
     import { b } from './y';
     import * as c from '../z';`,
    'f.ts',
  );
  assert.deepEqual(specs.sort(), ['../z', './y', 'x']);
});

test('extracts dynamic import() specifiers', () => {
  const specs = extractImportSpecifiers(
    `async function load() {
       const m = await import('./dyn');
       return m;
     }`,
    'f.ts',
  );
  assert.deepEqual(specs, ['./dyn']);
});

test('extracts CommonJS require() specifiers', () => {
  const specs = extractImportSpecifiers(
    `const a = require('./a');
     const b = require('b');`,
    'f.js',
  );
  assert.deepEqual(specs.sort(), ['./a', 'b']);
});

test('extracts export-from specifiers', () => {
  const specs = extractImportSpecifiers(
    `export { a } from './a';
     export * from './b';`,
    'f.ts',
  );
  assert.deepEqual(specs.sort(), ['./a', './b']);
});

test('ignores string literals inside comments / regular strings', () => {
  const specs = extractImportSpecifiers(
    `// import fake from './not-real';
     const s = 'import fake2 from "./also-not-real"';
     import real from './real';`,
    'f.ts',
  );
  assert.deepEqual(specs, ['./real']);
});

test('handles .tsx syntax without crashing', () => {
  const specs = extractImportSpecifiers(
    `import React from 'react';
     export const C = () => <div>{require('./inline')}</div>;`,
    'f.tsx',
  );
  assert.deepEqual(specs.sort(), ['./inline', 'react']);
});

// ---------- resolveImport ----------

test('resolves relative import by adding .ts extension', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'src/b.ts', '');
  const aAbs = path.join(root, 'src', 'a.ts');
  const resolved = resolveImport('./b', aAbs, {});
  assert.equal(resolved, path.join(root, 'src', 'b.ts'));
});

test('resolves relative import to index file', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'src/pkg/index.ts', '');
  const aAbs = path.join(root, 'src', 'a.ts');
  const resolved = resolveImport('./pkg', aAbs, {});
  assert.equal(resolved, path.join(root, 'src', 'pkg', 'index.ts'));
});

test('returns null for bare (node_modules) import', () => {
  const aAbs = '/tmp/x/src/a.ts';
  assert.equal(resolveImport('lodash', aAbs, {}), null);
  assert.equal(resolveImport('@scope/pkg', aAbs, {}), null);
});

test('resolves alias imports', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  write(root, 'src/lib/util.ts', '');
  const aAbs = path.join(root, 'src', 'a.ts');
  const aliasMap = { '@lib': path.join(root, 'src', 'lib') };
  const resolved = resolveImport('@lib/util', aAbs, aliasMap);
  assert.equal(resolved, path.join(root, 'src', 'lib', 'util.ts'));
});

test('returns null for unresolvable relative import', () => {
  const root = mktmp();
  write(root, 'src/a.ts', '');
  const aAbs = path.join(root, 'src', 'a.ts');
  assert.equal(resolveImport('./nonexistent', aAbs, {}), null);
});

// ---------- loadAliases ----------

test('loadAliases: returns empty map when no tsconfig', () => {
  const root = mktmp();
  const { aliases } = loadAliases(root);
  assert.deepEqual(aliases, {});
});

test('loadAliases: reads compilerOptions.paths from tsconfig.json', () => {
  const root = mktmp();
  write(
    root,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@lib/*': ['src/lib/*'],
          '@util': ['src/util'],
        },
      },
    }),
  );
  const { aliases } = loadAliases(root);
  assert.equal(aliases['@lib'], path.resolve(root, 'src/lib'));
  assert.equal(aliases['@util'], path.resolve(root, 'src/util'));
});

test('loadAliases: strips JSON comments and trailing commas', () => {
  const root = mktmp();
  write(
    root,
    'tsconfig.json',
    `{
      // this is a comment
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@lib/*": ["src/lib/*"], /* trailing comment */
        },
      },
    }`,
  );
  const { aliases } = loadAliases(root);
  assert.equal(aliases['@lib'], path.resolve(root, 'src/lib'));
});

// ---------- buildReverseGraph ----------

test('buildReverseGraph: edge target->importer', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/a.ts', `import { x } from './b';`);
  write(root, 'src/b.ts', `export const x = 1;`);

  const { graph } = buildReverseGraph([root]);
  const bAbs = path.join(root, 'src', 'b.ts');
  const aAbs = path.join(root, 'src', 'a.ts');
  assert.ok(graph.has(bAbs));
  assert.ok(graph.get(bAbs).has(aAbs));
});

test('buildReverseGraph: skips bare imports', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/a.ts', `import x from 'lodash';`);
  const { graph } = buildReverseGraph([root]);
  // Nothing resolvable → empty graph.
  assert.equal(graph.size, 0);
});

test('buildReverseGraph: works across two projects by absolute path only', () => {
  const a = mktmp();
  const b = mktmp();
  write(a, 'package.json', JSON.stringify({ name: 'app-a' }));
  write(a, 'src/a.ts', `import { x } from './ax';`);
  write(a, 'src/ax.ts', `export const x = 1;`);
  write(b, 'package.json', JSON.stringify({ name: 'app-b' }));
  write(b, 'src/b.ts', `export const y = 1;`);

  const { graph, filesByProject } = buildReverseGraph([a, b]);
  assert.equal(filesByProject.size, 2);
  assert.ok(filesByProject.get('app-a').size > 0);
  assert.ok(filesByProject.get('app-b').size > 0);
  // Edge inside project a.
  const axAbs = path.join(a, 'src', 'ax.ts');
  assert.ok(graph.has(axAbs));
});

// ---------- findDependents (BFS) ----------

test('findDependents: direct dependent is depth 1', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/a.ts', `import { x } from './b';`);
  write(root, 'src/b.ts', `export const x = 1;`);

  const { graph } = buildReverseGraph([root]);
  const bAbs = path.join(root, 'src', 'b.ts');
  const aAbs = path.join(root, 'src', 'a.ts');
  const dependents = findDependents(graph, new Set([bAbs]));
  assert.equal(dependents.get(aAbs), 1);
  assert.equal(dependents.size, 1);
});

test('findDependents: transitive chain a->b->c yields depths 1 and 2', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/a.ts', `import { y } from './b';`);
  write(root, 'src/b.ts', `import { x } from './c'; export const y = x;`);
  write(root, 'src/c.ts', `export const x = 1;`);

  const { graph } = buildReverseGraph([root]);
  const cAbs = path.join(root, 'src', 'c.ts');
  const bAbs = path.join(root, 'src', 'b.ts');
  const aAbs = path.join(root, 'src', 'a.ts');
  const dependents = findDependents(graph, new Set([cAbs]));
  assert.equal(dependents.get(bAbs), 1);
  assert.equal(dependents.get(aAbs), 2);
});

test('findDependents: maxDepth truncates traversal', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/a.ts', `import { y } from './b';`);
  write(root, 'src/b.ts', `import { x } from './c'; export const y = x;`);
  write(root, 'src/c.ts', `export const x = 1;`);

  const { graph } = buildReverseGraph([root]);
  const cAbs = path.join(root, 'src', 'c.ts');
  const aAbs = path.join(root, 'src', 'a.ts');
  const dependents = findDependents(graph, new Set([cAbs]), 1);
  assert.equal(dependents.has(aAbs), false);
});

test('findDependents: does not revisit nodes', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  // diamond: a->b, a->c, b->d, c->d
  write(root, 'src/a.ts', `import './b'; import './c';`);
  write(root, 'src/b.ts', `import { x } from './d';`);
  write(root, 'src/c.ts', `import { x } from './d';`);
  write(root, 'src/d.ts', `export const x = 1;`);

  const { graph } = buildReverseGraph([root]);
  const dAbs = path.join(root, 'src', 'd.ts');
  const dependents = findDependents(graph, new Set([dAbs]));
  // b and c at depth 1, a at depth 2. Total 3, not 4 (a not double-counted).
  assert.equal(dependents.size, 3);
});

// ---------- analyzeProjects integration ----------

test('analyzeProjects: filters unknown changed paths gracefully', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/a.ts', `import './b';`);
  write(root, 'src/b.ts', `export const x = 1;`);

  const result = analyzeProjects(
    [root],
    [path.join(root, 'src/b.ts'), '/tmp/outside/unknown.ts'],
  );
  assert.equal(result.changedFiles.length, 1);
  assert.equal(result.dependents.length, 1);
  assert.equal(result.dependents[0].depth, 1);
});

test('analyzeProjects: schema shape', () => {
  const root = mktmp();
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/a.ts', `import './b';`);
  write(root, 'src/b.ts', `export const x = 1;`);

  const result = analyzeProjects([root], [path.join(root, 'src/b.ts')]);
  assert.equal(result.analyzer, 'import-graph');
  assert.equal(result.projects[0].id, 'app');
  assert.equal(result.maxDepth, 6);
  assert.ok(Array.isArray(result.dependents));
});
