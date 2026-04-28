// Per-symbol graph query — Q12 tier 1 reshape-only trace.
//
// Takes a target (storage key, event channel, or global name) and returns a
// star-topology graph: a single target hub node with N occurrence nodes, one
// edge per occurrence describing its operation on the target.
//
// Tier 1 scope (per Q12 / D12):
// - Reshape only. No new detection. Every occurrence node maps 1:1 to an
//   occurrence emitted by shared-state / shared-events / shared-globals.
// - Three target kinds: --storage <backend:key>, --event <channel>,
//   --global <name>.
// - JSON output by default; --format mermaid is an additive renderer over
//   the same graph shape, not a separate pipeline.
//
// Out of tier 1:
// - --paired-cluster (tier 1.5; needs to reconcile paired-keys + shared-state)
// - --symbol <name> (tier 2; needs TypeChecker-based symbol resolution)
// - Runtime happens-before ordering (tier 3; explicitly out of scope per Q12)

import * as webStorage from './shared-state-web-storage.js';
import * as events from './shared-state-events.js';
import * as globals from './shared-state-globals.js';
import { resolveProject } from './project.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'trace';

// op → edge kind. Uniform "role-verb" phrasing so a consumer (human or AI
// agent) doesn't need to translate ops into relation labels themselves.
const EDGE_KIND = {
  read: 'reads-from',
  write: 'writes-to',
  remove: 'removes-from',
  dispatch: 'dispatches-to',
  listen: 'listens-to',
  unlisten: 'unlistens-from',
  declare: 'declares',
  assign: 'assigns-to',
};

/**
 * Parse --storage <backend:key>. backend = the substring before the first
 * colon; key = everything after. Returns { backend, key } or throws.
 *
 * Splits on the FIRST colon only so keys containing `:` (e.g. a
 * namespaced key like "user:profile:v2") are preserved verbatim.
 */
export function parseStorageTarget(arg) {
  const idx = arg.indexOf(':');
  if (idx < 0) {
    throw new Error(`--storage expects <backend:key>, got: ${arg}`);
  }
  const backend = arg.slice(0, idx);
  const key = arg.slice(idx + 1);
  if (backend !== 'localStorage' && backend !== 'sessionStorage') {
    throw new Error(
      `Unknown storage backend: '${backend}'. Expected localStorage or sessionStorage.`,
    );
  }
  if (!key) {
    throw new Error(`--storage expects a non-empty key after '<backend>:'`);
  }
  return { backend, key };
}

// ---------- graph construction ----------

function occurrenceToNode(occ, idx) {
  const node = {
    id: `n${idx}`,
    role: 'occurrence',
    project: occ.project,
    file: occ.file,
    line: occ.line,
    column: occ.column ?? null,
    op: occ.op,
    snippet: occ.snippet ?? null,
  };
  if (occ.detectedVia) node.detectedVia = occ.detectedVia;
  if (occ.host) node.host = occ.host;
  return node;
}

function starGraph(targetNode, findings) {
  const nodes = [targetNode];
  const edges = [];
  let idx = 0;
  for (const f of findings) {
    for (const occ of f.occurrences) {
      const node = occurrenceToNode(occ, ++idx);
      nodes.push(node);
      edges.push({
        from: node.id,
        to: targetNode.id,
        kind: EDGE_KIND[occ.op] ?? occ.op,
      });
    }
  }
  return { nodes, edges };
}

function projectDescriptors(projectRoots) {
  return projectRoots
    .map(resolveProject)
    .map((p) => ({ id: p.id, root: p.root }));
}

function buildResult({ target, projects, nodes, edges }) {
  const byOp = {};
  const fileSet = new Set();
  const projectSet = new Set();
  for (const n of nodes) {
    if (n.role !== 'occurrence') continue;
    byOp[n.op] = (byOp[n.op] ?? 0) + 1;
    fileSet.add(`${n.project}::${n.file}`);
    projectSet.add(n.project);
  }
  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    target,
    projects,
    nodes,
    edges,
    summary: {
      totalOccurrences: nodes.filter((n) => n.role === 'occurrence').length,
      byOp,
      affectedFiles: fileSet.size,
      affectedProjects: projectSet.size,
    },
  };
}

// ---------- public: per-target trace functions ----------

/**
 * trace --storage <backend:key>
 */
export function traceStorage(projectRoots, backend, key, opts = {}) {
  const projects = projectDescriptors(projectRoots);
  const result = webStorage.analyzeProjects(projectRoots, { exclude: opts.exclude, includeBuildArtifacts: opts.includeBuildArtifacts, includeTestContext: opts.includeTestContext });
  const matching = result.findings.filter(
    (f) => f.storage === backend && f.key === key,
  );
  const target = {
    id: 'target',
    role: 'target',
    kind: 'storage',
    backend,
    name: key,
  };
  const { nodes, edges } = starGraph(target, matching);
  return buildResult({
    target: { kind: 'storage', backend, name: key },
    projects,
    nodes,
    edges,
  });
}

/**
 * trace --event <channel>
 */
export function traceEvent(projectRoots, channel, opts = {}) {
  const projects = projectDescriptors(projectRoots);
  const result = events.analyzeProjects(projectRoots, { exclude: opts.exclude, includeBuildArtifacts: opts.includeBuildArtifacts, includeTestContext: opts.includeTestContext });
  const matching = result.findings.filter((f) => f.channel === channel);
  const target = {
    id: 'target',
    role: 'target',
    kind: 'event',
    name: channel,
  };
  const { nodes, edges } = starGraph(target, matching);
  return buildResult({
    target: { kind: 'event', name: channel },
    projects,
    nodes,
    edges,
  });
}

/**
 * trace --global <name>
 */
export function traceGlobal(projectRoots, name, opts = {}) {
  const projects = projectDescriptors(projectRoots);
  const result = globals.analyzeProjects(projectRoots, { exclude: opts.exclude, includeBuildArtifacts: opts.includeBuildArtifacts, includeTestContext: opts.includeTestContext });
  const matching = result.findings.filter((f) => f.name === name);
  const target = {
    id: 'target',
    role: 'target',
    kind: 'global',
    name,
  };
  const { nodes, edges } = starGraph(target, matching);
  return buildResult({
    target: { kind: 'global', name },
    projects,
    nodes,
    edges,
  });
}

// ---------- renderers ----------

/**
 * Render a trace result as a Mermaid flowchart. The rendered shape is a
 * star: a single labelled hub in the center, one directional edge per
 * occurrence labelled with the relation kind. Useful for pasting into a
 * markdown doc, GitHub issue, or PR description.
 */
export function renderMermaid(result) {
  const lines = ['flowchart TD'];
  lines.push(`  target["${mermaidLabel(renderTargetLabel(result.target))}"]`);
  for (const e of result.edges) {
    const n = result.nodes.find((x) => x.id === e.from);
    if (!n || n.role !== 'occurrence') continue;
    const loc = `${n.file}:${n.line}`;
    lines.push(`  ${n.id}["${mermaidLabel(`${n.op} @ ${loc}`)}"]`);
    lines.push(`  ${n.id} -->|${e.kind}| target`);
  }
  return lines.join('\n') + '\n';
}

function renderTargetLabel(target) {
  if (target.kind === 'storage') return `${target.backend}:${target.name}`;
  return target.name;
}

function mermaidLabel(s) {
  // Keep labels mermaid-safe: swap double-quotes, escape angle brackets.
  return s.replace(/"/g, "'").replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function summarize(result) {
  const kind = result.target.kind;
  const label = kind === 'storage'
    ? `${result.target.backend}:${result.target.name}`
    : result.target.name;
  const byOpLine = Object.entries(result.summary.byOp)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || '-';
  return [
    `code-intel / trace (${kind})`,
    `target:            ${label}`,
    `occurrences:       ${result.summary.totalOccurrences}`,
    `  by op:           ${byOpLine}`,
    `affected files:    ${result.summary.affectedFiles}`,
    `affected projects: ${result.summary.affectedProjects}`,
  ];
}
