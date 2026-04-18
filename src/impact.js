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
//         fingerprint,          // 16-hex deterministic hash of the finding's
//                               //   stable identity (see fingerprintFor below).
//                               //   Use this to tag a finding persistently
//                               //   across re-runs.
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as webStorage from './shared-state-web-storage.js';
import * as events from './shared-state-events.js';
import * as globals from './shared-state-globals.js';
import * as staleCapture from './stale-module-capture.js';
import * as pairedKeys from './paired-keys.js';
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
    case 'paired-keys':
      // Intra-function co-writes. Warning by default — the bug only bites
      // once another writer touches one of the paired keys without the
      // others, which we don't correlate in v1.
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
    case 'shared-storage-key': {
      const label = describeKey(detail.key, detail.dynamic, detail.expression);
      return `${detail.storage} key ${label} is touched by ${files.size} files${crossProj}`;
    }
    case 'shared-event-channel': {
      const label = describeKey(detail.channel, detail.dynamic, detail.expression);
      return `CustomEvent channel ${label} used by ${files.size} files${crossProj}`;
    }
    case 'shared-global-binding':
      return `Global name '${detail.name}' declared by ${files.size} files${crossProj}`;
    case 'stale-module-capture':
      return `'${detail.name}' captures dynamic source at module scope (via ${detail.capturedVia})`;
    case 'paired-keys':
      return `${detail.storage} paired-write cluster: [${detail.keys.map((k) => `'${k}'`).join(', ')}]`
        + ` — all callers should update together`;
    default:
      return 'finding';
  }
}

/**
 * Render a channel / key label for human-readable messages.
 *
 *   static:   'app.session'
 *   dynamic:  (dynamic: cacheKey)         — when the analyzer has the expression text
 *   dynamic:  (dynamic)                   — when it doesn't
 *
 * Before this fix, dynamic findings rendered as `'null'` — a template-literal
 * stringification of a JS `null` that looked like a literal string key in the
 * output. That was the bug reported in the meganav dogfood §2.5.
 */
function describeKey(key, dynamic, expression) {
  if (key != null) return `'${key}'`;
  if (dynamic && typeof expression === 'string' && expression.length > 0) {
    return `(dynamic: ${expression})`;
  }
  return '(dynamic)';
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
  if (kind === 'paired-keys') {
    // A paired-keys finding is intra-function, so id includes the first
    // occurrence's file + line to disambiguate multiple clusters that
    // happen to share a key set across the codebase.
    const keySig = `${detail.storage}:${[...detail.keys].sort().join('+')}`;
    const loc = detail.occurrences[0];
    return `${kind}:${keySig}@${loc?.project ?? '?'}:${loc?.file ?? '?'}:${loc?.line ?? 0}`;
  }
  const key = detail.key ?? detail.channel ?? detail.name ?? 'anon';
  return `${kind}:${key}`;
}

// ---------- fingerprint ----------
//
// Each finding carries a deterministic `fingerprint: "<16 hex chars>"`
// derived from stable identity facts about the finding. Two purposes:
//
//   1. Lets consumers tag a finding ("this is noise", "this is real")
//      by a key that survives re-runs. Without it, tagging is fuzzy and
//      fragile.
//   2. Is a future-proof foundation for a baseline/compare primitive and
//      a memory/history layer; this slice does NOT build either — it just
//      ships the field so data can accumulate now and those features can
//      land later without a schema break.
//
// Stability rules, chosen so "the same logical finding" keeps its
// fingerprint across typical codebase evolution:
//
//   - **Static** coupling findings (`shared-storage-key`, `shared-event-
//     channel`, `shared-global-binding`) hash only the *logical identity*
//     — kind + coupling key (+ storage for storage keys). Adding or
//     removing occurrence files does NOT change the fingerprint; the
//     finding is "the same coupling" whether 2 files or 20 touch it.
//   - **Dynamic** findings are per-site by construction (the analyzers
//     emit one finding per dynamic site), so the fingerprint must be
//     per-site too — kind + `dynamic` tag + first occurrence's project,
//     file, line, column. Moving the site to a new line changes the
//     fingerprint; that is the intended behaviour for dynamic findings.
//   - **Stale captures** are per-binding: kind + name + first
//     occurrence's project + file. Relocating the binding to a new file
//     changes the fingerprint (it IS a different binding then); renaming
//     or line-number changes do not.
//   - **Paired-keys** clusters are per-function: kind + storage + sorted
//     keys + first occurrence's project + file + line. Moving the cluster
//     inside the file changes the fingerprint; moving the whole file to
//     a new path changes it too. Both reflect "different cluster."
//
// This is deliberately MINIMAL — no compare primitive, no history log,
// no CLI surface, no stability-across-schema-versions guarantee. Just a
// field that's deterministic today and useful to downstream consumers.
function fingerprintFor(kind, detail) {
  const parts = [kind];
  switch (kind) {
    case 'shared-storage-key':
      if (detail.dynamic) {
        const loc = detail.occurrences[0] ?? {};
        parts.push('dynamic', detail.storage ?? '?', loc.project ?? '?', loc.file ?? '?', String(loc.line ?? 0), String(loc.column ?? 0));
      } else {
        parts.push(detail.storage ?? '?', detail.key ?? '');
      }
      break;
    case 'shared-event-channel':
      if (detail.dynamic) {
        const loc = detail.occurrences[0] ?? {};
        parts.push('dynamic', loc.project ?? '?', loc.file ?? '?', String(loc.line ?? 0), String(loc.column ?? 0));
      } else {
        parts.push(detail.channel ?? '');
      }
      break;
    case 'shared-global-binding':
      parts.push(detail.name ?? '');
      break;
    case 'stale-module-capture': {
      const loc = detail.occurrences[0] ?? {};
      parts.push(detail.name ?? '', loc.project ?? '?', loc.file ?? '?');
      break;
    }
    case 'paired-keys': {
      const loc = detail.occurrences[0] ?? {};
      parts.push(
        detail.storage ?? '?',
        [...(detail.keys ?? [])].sort().join('+'),
        loc.project ?? '?',
        loc.file ?? '?',
        String(loc.line ?? 0),
      );
      break;
    }
    default:
      // Unknown kind: hash whatever identity the detail carries, so at
      // least the fingerprint is deterministic per-run.
      parts.push(JSON.stringify(detail));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
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
  const prsResult = pairedKeys.analyzeProjects(projectRoots);

  // Project id -> project root (for resolving occurrence.file -> absolute).
  const projects = projectRoots.map(resolveProject);
  const rootById = new Map(projects.map((p) => [p.id, p.root]));

  // 3. Wrap each finding into the unified envelope.
  const wrapped = [];
  for (const f of webResult.findings) wrapped.push(wrap('shared-storage-key', f, rootById, changedFilesAbs));
  for (const f of evtResult.findings) wrapped.push(wrap('shared-event-channel', f, rootById, changedFilesAbs));
  for (const f of glbResult.findings) wrapped.push(wrap('shared-global-binding', f, rootById, changedFilesAbs));
  for (const f of stlResult.findings) wrapped.push(wrap('stale-module-capture', f, rootById, changedFilesAbs));
  for (const f of prsResult.findings) wrapped.push(wrap('paired-keys', f, rootById, changedFilesAbs));

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
    fingerprint: fingerprintFor(kind, detail),
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
