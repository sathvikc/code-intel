// Detector registry.
//
// Every detector MUST export:
//   - analyzeProjects(projectRoots, opts = {}): { version, analyzer, projects, findings }
//   - summarize(result): object with projectCount, findingCount, and
//     detector-specific counters
//
// The registry below is the single source of truth for:
//   - Which detectors impact.js runs in its default pass.
//   - Which subcommands cli.js exposes (one per detector id).
//   - Which ids --only / --skip accept on the impact subcommand.
//   - How each detector's findings are wrapped in the unified impact envelope
//     (the findingKind string used on each wrapped finding's `kind` property).
//
// Add a new detector by appending a single entry here. No other edits
// required in cli.js or impact.js.
//
// trace.js intentionally does NOT consume the registry — it's target-
// specific, not a generic orchestrator. Its three imports name the exact
// detectors it projects over.

import * as webStorage from '../shared-state-web-storage.js';
import * as events from '../shared-state-events.js';
import * as globals from '../shared-state-globals.js';
import * as staleCapture from '../stale-module-capture.js';
import * as pairedKeys from '../paired-keys.js';
import * as shapeDrift from '../shape-drift.js';
import * as duplicateStaticSvgId from '../duplicate-static-svg-id.js';
import * as eventBridge from '../event-bridge.js';
import * as structuralDrift from '../structural-drift.js';

/**
 * @typedef {object} DetectorEntry
 * @property {string} id
 *   Stable public identifier. Used as the CLI subcommand name and as the
 *   --only / --skip value. Must be unique across the registry.
 * @property {object} module
 *   The detector module (imported namespace). Must export analyzeProjects
 *   and summarize.
 * @property {string} findingKind
 *   The value stored on each wrapped finding's `.kind` inside the impact
 *   unified envelope. Usually matches `id` but not always (historical:
 *   `stale-captures` CLI id maps to `stale-module-capture` finding kind).
 * @property {(summary: object) => string[]} summarize
 *   Produces the per-subcommand stderr summary lines for the CLI.
 */

/** @type {DetectorEntry[]} */
export const DETECTORS = [
  {
    id: 'shared-state',
    module: webStorage,
    findingKind: 'shared-storage-key',
    summarize: (s) => [
      `code-intel / shared-state.web-storage`,
      `projects:        ${s.projectCount}`,
      `findings:        ${s.findingCount}`,
      `  localStorage:  ${s.byStorage.localStorage ?? 0}`,
      `  sessionStorage:${s.byStorage.sessionStorage ?? 0}`,
      `cross-project:   ${s.crossProject}`,
      `cross-file:      ${s.crossFile}`,
      `dynamic keys:    ${s.dynamic}`,
    ],
  },
  {
    id: 'shared-events',
    module: events,
    findingKind: 'shared-event-channel',
    summarize: (s) => [
      `code-intel / shared-state.events`,
      `projects:        ${s.projectCount}`,
      `findings:        ${s.findingCount}`,
      `  dispatch:      ${s.byOp.dispatch ?? 0}`,
      `  listen:        ${s.byOp.listen ?? 0}`,
      `  unlisten:      ${s.byOp.unlisten ?? 0}`,
      `cross-project:   ${s.crossProject}`,
      `cross-file:      ${s.crossFile}`,
      `dynamic channels:${s.dynamic}`,
    ],
  },
  {
    id: 'shared-globals',
    module: globals,
    findingKind: 'shared-global-binding',
    summarize: (s) => [
      `code-intel / shared-state.globals`,
      `projects:        ${s.projectCount}`,
      `findings:        ${s.findingCount}`,
      `  declare:       ${s.byOp.declare ?? 0}`,
      `  assign:        ${s.byOp.assign ?? 0}`,
      `  remove:        ${s.byOp.remove ?? 0}`,
      `cross-project:   ${s.crossProject}`,
      `cross-file:      ${s.crossFile}`,
    ],
  },
  {
    id: 'stale-captures',
    module: staleCapture,
    findingKind: 'stale-module-capture',
    summarize: (s) => [
      `code-intel / stale-module-capture`,
      `projects:           ${s.projectCount}`,
      `findings:           ${s.findingCount}`,
      `  direct-api:       ${s.byCapturedKind['direct-api'] ?? 0}`,
      `  indirect-wrapper: ${s.byCapturedKind['indirect-wrapper'] ?? 0}`,
      `auto-detected readers: ${s.detectedReaders}`,
    ],
  },
  {
    id: 'paired-keys',
    module: pairedKeys,
    findingKind: 'paired-keys',
    summarize: (s) => [
      `code-intel / paired-keys`,
      `projects:        ${s.projectCount}`,
      `findings:        ${s.findingCount}`,
      `  localStorage:  ${s.byStorage.localStorage ?? 0}`,
      `  sessionStorage:${s.byStorage.sessionStorage ?? 0}`,
      `keys (total):    ${s.totalKeys}`,
      `keys (max/cluster): ${s.maxKeys}`,
    ],
  },
  {
    id: 'shape-drift',
    module: shapeDrift,
    findingKind: 'shape-drift',
    summarize: (s) => [
      `code-intel / shape-drift`,
      `projects:        ${s.projectCount}`,
      `findings:        ${s.findingCount}`,
      `  localStorage:  ${s.byStorage.localStorage ?? 0}`,
      `  sessionStorage:${s.byStorage.sessionStorage ?? 0}`,
      `  read-only drift:  ${s.withReadOnlyDrift}`,
      `  write-only drift: ${s.withWriteOnlyDrift}`,
      `  both sides drift: ${s.withBothDrift}`,
    ],
  },
  {
    id: 'duplicate-static-svg-id',
    module: duplicateStaticSvgId,
    findingKind: 'duplicate-static-svg-id',
    summarize: (s) => [
      `code-intel / duplicate-static-svg-id`,
      `projects:          ${s.projectCount}`,
      `findings:          ${s.findingCount}`,
      `  declarations:    ${s.totalDeclarations}`,
      `  references:      ${s.totalReferences}`,
      `  affected files:  ${s.affectedFiles}`,
    ],
  },
  {
    id: 'event-bridge',
    module: eventBridge,
    findingKind: 'event-bridge',
    summarize: (lines) => lines,
  },
  {
    id: 'structural-drift',
    module: structuralDrift,
    findingKind: 'structural-drift',
    analyzeProjects: structuralDrift.analyzeStructuralDriftProjects,
    summarize: structuralDrift.summarize,
  },
];

/**
 * Stable list of all detector ids, in registry order.
 */
export const DETECTOR_IDS = DETECTORS.map((d) => d.id);

/**
 * Look up a detector by id. Returns undefined if unknown.
 */
export function getDetector(id) {
  return DETECTORS.find((d) => d.id === id);
}

/**
 * Return the subset of the registry that matches a filter.
 *
 * - `only`: if given and non-empty, keep only these ids.
 * - `skip`: if given and non-empty, drop these ids.
 * - Both can be combined: `--only shared-state,shared-events --skip shared-events`
 *   keeps only `shared-state`.
 * - Unknown ids in either list throw, so typos fail fast rather than
 *   silently no-opping (a silent no-op would have the user believe their
 *   filter was respected when it wasn't).
 * - The returned order always matches registry order, regardless of the
 *   order the ids appeared in `only` / `skip`.
 *
 * @param {{ only?: string[] | null, skip?: string[] | null }} [opts]
 * @returns {DetectorEntry[]}
 */
export function selectDetectors(opts = {}) {
  const { only = null, skip = null } = opts;
  const unknown = [];
  const check = (list) => {
    if (!list) return;
    for (const id of list) {
      if (!DETECTOR_IDS.includes(id)) unknown.push(id);
    }
  };
  check(only);
  check(skip);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown detector id(s): ${unknown.join(', ')}. `
        + `Known ids: ${DETECTOR_IDS.join(', ')}.`,
    );
  }
  let picked = DETECTORS;
  if (only && only.length > 0) picked = picked.filter((d) => only.includes(d.id));
  if (skip && skip.length > 0) picked = picked.filter((d) => !skip.includes(d.id));
  return picked;
}
