// impact.js — unified impact orchestrator.
//
// Runs all built detectors against one or more project roots and emits a
// single report. When `changedFiles` (or `since: <ref>`) is provided, the
// report is scoped to a change set:
//
//   - Each finding is annotated with `touchesChange: boolean`.
//   - Findings that touch a changed file are sorted to the top.
//   - Blast radius (transitive import dependents of the changed files) is
//     computed and included.
//   - Summary counts split into "all findings" vs "findings touching change."
//
// Without a change set, the report is simply every finding the engine sees
// across all projects.
//
// Output shape (schema version 0.1):
//
//   {
//     version: "0.1",
//     analyzer: "impact",
//     meta:    { timestamp, base, projectCount, changedFileCount, ... },
//     summary: {
//       totalFindings, findingsTouchingChange,
//       byKind, bySeverity,
//       blastRadius: { total, byDepth, maxDepth } | null
//     },
//     projects: [{ id, root }],
//     findings: [
//       {
//         id,                   // e.g. "shared-storage-key:app.session"
//         kind,                 // finding kind (from analyzer)
//         severity,             // "critical" | "warning" | "info"
//         message,              // human-readable summary
//         detail,               // analyzer-specific payload (full analyzer finding)
//         relatedFiles: [{ project, file, line, role }],
//         touchesChange: bool,
//       }
//     ],
//     graph: {
//       blastRadius: [{ file, project, depth }]
//     } | null,
//     integrations: { git: { available, base, changedFiles } | null }
//   }
//
// The order above is meant to line up with the AI-consumption schema in
// CODE-INTEL.md (on the phase-1 branch): meta / summary / findings / graph
// / integrations. Per D2, we lean recall-first: every finding ships; the
// `touchesChange` boolean and `severity` heuristic let consumers filter.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as webStorage from './shared-state-web-storage.js';
import * as events from './shared-state-events.js';
import * as globals from './shared-state-globals.js';
import * as staleCapture from './stale-module-capture.js';
import * as importGraph from './import-graph.js';
import { resolveProject } from './project.js';

export const SCHEMA_VERSION = '0.1';
export const ANALYZER_ID = 'impact';

// ---------- severity heuristic (per finding kind) ----------

function severityFor(kind, detail) {
  switch (kind) {
    case 'shared-global-binding':
      // Cross-script overwrite is silent and high-impact.
      return 'critical';
    case 'shared-storage-key':
    case 'shared-event-channel': {
      const projects = new Set(detail.occurrences.map((o) => o.project));
      return projects.size > 1 ? 'critical' : 'warning';
    }
    case 'stale-module-capture':
      return 'warning';
    default:
      return 'info';
  }
}

// ---------- per-kind message + relatedFiles shaping ----------

function messageFor(kind, detail) {
  const projects = new Set(detail.occurrences?.map((o) => o.project) ?? []);
  const files = new Set(detail.occurrences?.map((o) => `${o.project}:${o.file}`) ?? []);
  const crossProj = projects.size > 1 ? ` across ${projects.size} projects` : '';
  switch (kind) {
    case 'shared-storage-key':
      return `${detail.storage} key '${detail.key}' is touched by ${files.size} files${crossProj}`;
    case 'shared-event-channel':
      return `CustomEvent channel '${detail.channel}' used by ${files.size} files${crossProj}`;
    case 'shared-global-binding':
      return `Global name '${detail.name}' declared by ${files.size} files${crossProj}`;
    case 'stale-module-capture':
      return `'${detail.name}' captures dynamic source at module scope (via ${detail.capturedVia})`;
    default:
      return 'finding';
  }
}

function relatedFilesFor(detail) {
  return (detail.occurrences ?? []).map((o) => ({
    project: o.project,
    file: o.file,
    line: o.line ?? null,
    op: o.op ?? null,
  }));
}

function findingIdFor(kind, detail) {
  const key = detail.key ?? detail.channel ?? detail.name ?? 'anon';
  return `${kind}:${key}`;
}

// ---------- git integration (optional) ----------

/**
 * Resolve changed files for a given base ref, as absolute paths.
 * Returns { available: boolean, changedFiles: string[], base: string, error? }.
 * Graceful: if git isn't present or the ref is unknown, returns available=false.
 */
export function gitChangedFiles(cwd, base) {
  try {
    const out = execSync(`git diff --name-only ${base}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((f) => path.resolve(cwd, f))
      .filter((f) => fs.existsSync(f));
    return { available: true, changedFiles: files, base };
  } catch (err) {
    return { available: false, changedFiles: [], base, error: err.message };
  }
}

// ---------- orchestrator ----------

/**
 * Run every detector, assemble a unified report, annotate with change info.
 *
 * @param {string[]} projectRoots
 * @param {object}   [opts]
 * @param {string}   [opts.since]         git base ref; git diff resolves changed files
 * @param {string[]} [opts.changedFiles]  absolute paths (overrides --since)
 * @param {string}   [opts.cwd]           working dir for git (default: process.cwd)
 * @param {number}   [opts.maxDepth]      blast radius max depth (default: 6)
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const maxDepth = opts.maxDepth ?? 6;

  // 1. Resolve the change set.
  let changedFilesAbs = null;
  let gitInfo = null;
  if (opts.changedFiles) {
    changedFilesAbs = new Set(
      opts.changedFiles.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f))),
    );
    gitInfo = { available: true, base: opts.since ?? '<explicit>', changedFiles: [...changedFilesAbs] };
  } else if (opts.since) {
    gitInfo = gitChangedFiles(cwd, opts.since);
    if (gitInfo.available) changedFilesAbs = new Set(gitInfo.changedFiles);
  }

  // 2. Run every detector. Each returns its native result shape.
  const webResult = webStorage.analyzeProjects(projectRoots);
  const evtResult = events.analyzeProjects(projectRoots);
  const glbResult = globals.analyzeProjects(projectRoots);
  const stlResult = staleCapture.analyzeProjects(projectRoots);

  // Project id -> project root (for resolving occurrence.file -> absolute).
  const projects = projectRoots.map(resolveProject);
  const rootById = new Map(projects.map((p) => [p.id, p.root]));

  // 3. Wrap each finding into the unified envelope.
  const wrapped = [];
  for (const f of webResult.findings) wrapped.push(wrap('shared-storage-key', f, rootById, changedFilesAbs));
  for (const f of evtResult.findings) wrapped.push(wrap('shared-event-channel', f, rootById, changedFilesAbs));
  for (const f of glbResult.findings) wrapped.push(wrap('shared-global-binding', f, rootById, changedFilesAbs));
  for (const f of stlResult.findings) wrapped.push(wrap('stale-module-capture', f, rootById, changedFilesAbs));

  // 4. Sort: change-touching first, then severity, then stable by id.
  const SEV_ORDER = { critical: 0, warning: 1, info: 2 };
  wrapped.sort((a, b) => {
    if (a.touchesChange !== b.touchesChange) return a.touchesChange ? -1 : 1;
    if (SEV_ORDER[a.severity] !== SEV_ORDER[b.severity]) return SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    return a.id.localeCompare(b.id);
  });

  // 5. Blast radius, if we have a change set.
  let blastRadius = null;
  if (changedFilesAbs && changedFilesAbs.size > 0) {
    const graphResult = importGraph.analyzeProjects(projectRoots, [...changedFilesAbs], { maxDepth });
    blastRadius = graphResult.dependents.map((d) => ({
      file: d.file,
      project: projectIdFor(d.file, rootById),
      depth: d.depth,
    }));
  }

  // 6. Summary stats.
  const byKind = {};
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  let findingsTouchingChange = 0;
  for (const w of wrapped) {
    byKind[w.kind] = (byKind[w.kind] ?? 0) + 1;
    bySeverity[w.severity] = (bySeverity[w.severity] ?? 0) + 1;
    if (w.touchesChange) findingsTouchingChange++;
  }

  const byDepth = {};
  if (blastRadius) {
    for (const r of blastRadius) {
      byDepth[r.depth] = (byDepth[r.depth] ?? 0) + 1;
    }
  }

  return {
    version: SCHEMA_VERSION,
    analyzer: ANALYZER_ID,
    meta: {
      timestamp: new Date().toISOString(),
      base: gitInfo?.base ?? null,
      projectCount: projectRoots.length,
      changedFileCount: changedFilesAbs ? changedFilesAbs.size : null,
    },
    projects: projects.map((p) => ({ id: p.id, root: p.root })),
    summary: {
      totalFindings: wrapped.length,
      findingsTouchingChange: changedFilesAbs ? findingsTouchingChange : null,
      byKind,
      bySeverity,
      blastRadius: blastRadius
        ? { total: blastRadius.length, byDepth, maxDepth }
        : null,
    },
    findings: wrapped,
    graph: blastRadius ? { blastRadius } : null,
    integrations: {
      git: gitInfo,
    },
  };
}

function wrap(kind, detail, rootById, changedFilesAbs) {
  const relatedFiles = relatedFilesFor(detail);
  const touchesChange = Boolean(
    changedFilesAbs
    && (detail.occurrences ?? []).some((o) => {
      const root = rootById.get(o.project);
      if (!root) return false;
      const abs = path.resolve(root, o.file);
      return changedFilesAbs.has(abs);
    }),
  );
  return {
    id: findingIdFor(kind, detail),
    kind,
    severity: severityFor(kind, detail),
    message: messageFor(kind, detail),
    detail,
    relatedFiles,
    touchesChange,
  };
}

function projectIdFor(absFile, rootById) {
  let best = null;
  let bestLen = -1;
  for (const [id, root] of rootById) {
    if (absFile.startsWith(root + path.sep) && root.length > bestLen) {
      best = id;
      bestLen = root.length;
    }
  }
  return best;
}
