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
//       byKind, bySeverity, byConfidence,
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
//         severity,             // "critical" | "warning" | "info" (blast-radius
//                               //   heuristic — how bad is this IF it's a bug).
//         confidence,           // "high" | "medium" | "low" (signal quality —
//                               //   how sure are we that it IS a bug).
//         confidenceReason,     // one-paragraph explanation of why this
//                               //   finding earns that confidence. Tells the
//                               //   reviewer whether to act or dig deeper.
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

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createAstCache } from './ast-cache.js';
import { buildConstantsIndex, makeCrossFileResolver } from './cross-file-constants.js';
import * as importGraph from './import-graph.js';
import { resolveProject } from './project.js';
import { selectDetectors } from './detectors/index.js';

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
    case 'shape-drift': {
      // Reader accessing a field no writer writes is the canonical crash
      // shape (undefined property access); readOnlyKeys > 0 is a strong
      // signal. Cross-project always escalates to critical.
      const projects = new Set(detail.occurrences.map((o) => o.project));
      if (projects.size > 1) return 'critical';
      if ((detail.readOnlyKeys?.length ?? 0) > 0) return 'critical';
      return 'warning';
    }
    case 'event-shape-drift': {
      // Same bug class as shape-drift, different boundary (CustomEvent.detail
      // instead of JSON.stringify/getItem). Listener accessing a field no
      // dispatcher emits → undefined-property-access crash shape; cross-project
      // bumps to critical.
      const projects = new Set(detail.occurrences.map((o) => o.project));
      if (projects.size > 1) return 'critical';
      if ((detail.readOnlyKeys?.length ?? 0) > 0) return 'critical';
      return 'warning';
    }
    case 'structural-drift': {
      // v1 only emits when readOnlyKeys is non-empty (see structural-drift.js
      // emission rule), so the reader-accesses-undeclared-field case is the
      // only shape we see. Cross-project escalates to critical.
      const projects = new Set(detail.occurrences.map((o) => o.project));
      if (projects.size > 1) return 'critical';
      return 'warning';
    }
    case 'event-bridge':
      // Bridges are coupling claims (one host's event re-dispatched to
      // another host) — not always bugs, but always worth a reviewer's eye
      // because they create implicit cross-host listeners that are easy to
      // miss when refactoring either side.
      return 'warning';
    case 'missing-teardown':
    case 'abort-never-called':
    case 'handler-identity-mismatch':
      // Lifecycle leaks: silent in dev, accumulate in long-running runtimes
      // (SPA, workers, Node services). Warning by default; reviewer judges
      // whether the enclosing scope is short-lived enough to ignore.
      return 'warning';
    case 'duplicate-static-svg-id':
      // User-visible rendering corruption (gradients, filters, masks), not
      // data loss. Warning tier is right: the bug is bad but bounded.
      return 'warning';
    default:
      return 'info';
  }
}

// ---------- confidence: "is this actually a bug, or noise?" ----------
//
// Every finding carries:
//   - confidence: 'high' | 'medium' | 'low'
//   - confidenceReason: one-paragraph justification
//
// confidence is about *signal quality* — how sure are we this is a real
// issue a human should look at. It is distinct from severity, which is
// about *blast radius* — how bad it would be IF it's a bug.
//
// The split matters because static analysis ships with false positives by
// nature, and a tool that dumps 200 findings without saying which ones it
// stands behind is indistinguishable from noise. For each pattern we ask:
//
//   - What shape of the finding is undeniably a bug?     → high
//   - What shape is real coupling but context-dependent? → medium
//   - What shape needs human eyes to even know what it   → low
//     refers to (e.g. dynamic keys the analyzer can't
//     resolve)?
//
// Reasons are written as one paragraph a reviewer can read in 5 seconds
// and decide whether to act. They intentionally name the context (SPA vs
// MPA, same-file vs cross-project, etc.) that governs the classification.
function confidenceFor(kind, detail) {
  switch (kind) {
    case 'shared-storage-key':
      return confidenceStorageKey(detail);
    case 'shared-event-channel':
      return confidenceEventChannel(detail);
    case 'shared-global-binding':
      return confidenceGlobalBinding(detail);
    case 'stale-module-capture':
      return confidenceStaleCapture(detail);
    case 'paired-keys':
      return confidencePairedKeys(detail);
    case 'shape-drift':
      return confidenceShapeDrift(detail);
    case 'event-shape-drift':
      return confidenceEventShapeDrift(detail);
    case 'structural-drift':
      return confidenceStructuralDrift(detail);
    case 'event-bridge':
      return confidenceEventBridge(detail);
    case 'missing-teardown':
      return confidenceMissingTeardown(detail);
    case 'abort-never-called':
      return confidenceAbortNeverCalled(detail);
    case 'handler-identity-mismatch':
      return confidenceHandlerIdentityMismatch(detail);
    case 'duplicate-static-svg-id':
      return confidenceDuplicateSvgId(detail);
    default:
      return { confidence: 'medium', reason: 'No specific confidence rule for this finding kind.' };
  }
}

function confidenceStorageKey(detail) {
  if (detail.dynamic) {
    return {
      confidence: 'low',
      reason:
        'The storage key is computed at runtime, so occurrence grouping is heuristic — '
        + 'two dynamic sites that happen to share the same dynamic-site fingerprint may or '
        + 'may not reference the same logical key. Treat this finding as "a dynamic storage '
        + 'site worth auditing" rather than a concrete coupling claim.',
    };
  }
  const projects = new Set(detail.occurrences.map((o) => o.project));
  const files = new Set(detail.occurrences.map((o) => `${o.project}:${o.file}`));
  const ops = new Set(detail.occurrences.map((o) => o.op));
  const hasWrite = ops.has('write');
  const hasRead = ops.has('read') || ops.has('remove');
  if (projects.size >= 2) {
    return {
      confidence: 'high',
      reason:
        `Literal key '${detail.key}' is touched by ${files.size} files across ${projects.size} projects. `
        + 'Cross-project storage coupling is direct and almost always intentional — if one project changes '
        + "the shape or timing of writes, readers in another project silently break. There is no type-level "
        + 'contract across a storage boundary, so the analyzer is reporting a real coupling, not a guess.',
    };
  }
  if (files.size >= 2 && hasWrite && hasRead) {
    return {
      confidence: 'high',
      reason:
        `Literal key '${detail.key}' is written in one file and read in another within the same project. `
        + 'This is the canonical shared-state shape: the writer\'s data contract is implicitly consumed '
        + "by the reader with no compiler enforcement. Refactors on either side break the other silently.",
    };
  }
  if (files.size >= 2) {
    return {
      confidence: 'medium',
      reason:
        `Literal key '${detail.key}' is touched by ${files.size} files but all occurrences are the same `
        + `operation type (${[...ops].join(', ')}). The coupling is real but weaker — e.g. several readers `
        + 'with no visible writer may mean the writer is in a module the analyzer did not scan (a wrapper '
        + 'or a worker file), or the write happens on a different branch that was pruned.',
    };
  }
  return {
    confidence: 'medium',
    reason:
      `Literal key '${detail.key}' is used within a single file. The in-file coupling is real (if one `
      + 'function writes and another reads, shape drift across a refactor still bites), but the blast '
      + 'radius is local. Verify the key is not read or written elsewhere via a wrapper module this '
      + "analyzer can't see.",
  };
}

function confidenceEventChannel(detail) {
  if (detail.dynamic) {
    return {
      confidence: 'low',
      reason:
        'The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch '
        + 'or listener site; whether this channel actually collides with another site depends on '
        + 'what the expression evaluates to. Audit the site and decide if it needs a stable channel name.',
    };
  }
  const projects = new Set(detail.occurrences.map((o) => o.project));
  const files = new Set(detail.occurrences.map((o) => `${o.project}:${o.file}`));
  const ops = new Set(detail.occurrences.map((o) => o.op));
  if (projects.size >= 2) {
    return {
      confidence: 'high',
      reason:
        `CustomEvent channel '${detail.channel}' is used across ${projects.size} projects. `
        + "The dispatcher and listener have an implicit contract on the event's `detail` payload — "
        + 'shape drift on one side breaks the other silently, and the event bus has no type system '
        + 'to catch it.',
    };
  }
  if (files.size >= 2 && ops.has('dispatch') && ops.has('listen')) {
    return {
      confidence: 'high',
      reason:
        `CustomEvent channel '${detail.channel}' is dispatched by one file and listened to by another. `
        + "Any change to the event's detail shape requires coordinated edits to both sides; the coupling "
        + 'is real and unchecked by the compiler.',
    };
  }
  return {
    confidence: 'medium',
    reason:
      `CustomEvent channel '${detail.channel}' has ${files.size} file(s) touching it with ops `
      + `${[...ops].join(', ')}. The coupling is plausible but one-sided — e.g. a listener with no `
      + 'visible dispatcher may mean the dispatcher is in code the analyzer did not scan, or the event '
      + 'is fired by a library.',
  };
}

function confidenceGlobalBinding(detail) {
  // The shared-globals analyzer already filters out self-assign and
  // same-file redeclaration (§2.6 fix), so every finding that makes it
  // here involves ≥2 distinct files. Cross-file global overwrite is
  // unambiguous: whichever script loads last wins, with no runtime error.
  const files = new Set(detail.occurrences.map((o) => `${o.project}:${o.file}`));
  return {
    confidence: 'high',
    reason:
      `Global name '${detail.name}' is declared or assigned by ${files.size} files. At runtime, `
      + 'whichever script loads last silently overwrites the earlier definition. The browser gives no '
      + 'warning; TypeScript and ESLint do not see across classic-script boundaries. The coupling is '
      + 'certain; the only question is which definition wins in your production load order.',
  };
}

function confidenceStaleCapture(detail) {
  // Stale module-scope captures are the most context-dependent pattern
  // we emit — they are bugs in persistent-module runtimes (SPAs, SSR
  // client bundles, workers, long-running Node) but not in MPAs with
  // full page reloads. Always medium; the reason names the contexts.
  return {
    confidence: 'medium',
    reason:
      `Module-scope capture of a dynamic source (${detail.capturedVia}). This is a bug in runtime `
      + 'models where modules persist across state changes: single-page apps (React Router, Vue Router, '
      + 'Svelte navigation), SSR client bundles after hydration, web and service workers, and long-running '
      + "Node services. It is lower-risk in classic multi-page apps (full page reload on every navigation), "
      + "static-site builds, and CLI tools. Check how '" + (detail.name ?? '<anon>') + "' is read — if any "
      + 'caller runs after the captured value could have changed, the stale value will be returned.',
  };
}

function confidencePairedKeys(detail) {
  // v1 finds the cluster; v2 (on the backlog) correlates across the
  // codebase. The cluster itself is a factual observation (these keys
  // ARE written together inside this function); the bug claim depends
  // on whether another writer elsewhere touches only a subset.
  return {
    confidence: 'medium',
    reason:
      `Paired-write cluster: ${detail.storage} keys [${detail.keys.map((k) => `'${k}'`).join(', ')}] are `
      + 'written together inside a single function. The cluster itself is a factual observation, not a '
      + 'bug claim — the bug materializes when another writer elsewhere in the codebase touches only some '
      + 'of these keys, breaking the pair. v1 of the detector finds the cluster but does not correlate '
      + 'across files; v2 is on the backlog. Until then, treat this as "these keys must travel together" '
      + 'and audit every writer of each key to ensure the full set is updated.',
  };
}

function confidenceDuplicateSvgId(detail) {
  // v2 per D10: confidence reflects whether the duplication is
  // demonstrable in the current code (high) or merely an observed
  // textual fact whose page-level impact we can't prove (low). We
  // never predict future bugs.
  const ev = detail.evidence ?? [];
  const strong = ev.some(
    (e) => e.type === 'in-file-loop'
      || e.type === 'caller-loop'
      || e.type === 'same-component-duplicate',
  );
  const compLabel = detail.component ? `<${detail.component}>` : 'this component';
  if (strong) {
    const reasons = [];
    for (const e of ev) {
      if (e.type === 'in-file-loop') {
        reasons.push(`rendered inside a \`${e.method}(…)\` callback in the same file`);
      } else if (e.type === 'caller-loop') {
        reasons.push(`rendered inside a \`${e.method}(…)\` callback by an importer`);
      } else if (e.type === 'same-component-duplicate') {
        reasons.push(`declared ${e.count} times inside ${compLabel}`);
      }
    }
    return {
      confidence: 'high',
      reason:
        `Static id='${detail.id}' on <${detail.element}> — ${reasons.join(', ')}. `
        + 'Every render emits ≥2 elements with the same id into the DOM, and the browser resolves every '
        + 'url(#…) / href="#…" reference to whichever copy it saw first; the others paint with the wrong '
        + '(or missing) gradient / filter / mask / symbol. Fix by deriving the id per instance '
        + '(React.useId, nanoid, or a prop) and threading it through every declaration and reference.',
    };
  }
  const crossOther = ev.find((e) => e.type === 'cross-component-duplicate')?.other;
  const otherLabel = crossOther
    ? `<${crossOther.component ?? '<anon>'}> (${crossOther.project}:${crossOther.file})`
    : 'another component in the scanned set';
  return {
    confidence: 'low',
    reason:
      `Static id='${detail.id}' is declared by ${compLabel} and by ${otherLabel}. `
      + 'The analyzer cannot prove the two components ever mount on the same page, so this is an observed '
      + "textual duplication whose impact is uncertain — if the two components never co-render, nothing "
      + 'breaks. Worth a quick audit: are these meant to share the id, or is one a copy-paste that should '
      + 'be parameterized?',
  };
}

function confidenceEventShapeDrift(detail) {
  // Mirrors confidenceShapeDrift's tiering. event-shape-drift only emits
  // when BOTH dispatch and listen sides have ≥1 literal shape AND the
  // unions disagree, so the factual claim is always true; confidence
  // modulates on which kind of drift it is.
  const readOnly = detail.readOnlyKeys ?? [];
  const writeOnly = detail.writeOnlyKeys ?? [];
  const opaqueNote = (detail.opaqueWrites || detail.opaqueReads)
    ? ` Note: ${detail.opaqueWrites} dispatcher site(s) and ${detail.opaqueReads} listener site(s) are opaque `
      + '(the analyzer couldn\'t resolve their detail shape — e.g. a non-literal detail object, '
      + 'a destructure into a name the analyzer couldn\'t walk); they are listed in occurrences '
      + 'but did not contribute to the shape union.'
    : '';
  if (readOnly.length > 0) {
    return {
      confidence: 'high',
      reason:
        `Listener accesses [${readOnly.map((k) => `'${k}'`).join(', ')}] on CustomEvent channel '${detail.channel}', `
        + 'but no dispatcher emits these keys in `event.detail`. At runtime the listener will see '
        + '`undefined` for these fields and either crash on a property access or silently fall through. '
        + 'CustomEvent.detail has no type-level contract; TypeScript and linters do not see across the '
        + 'dispatch boundary.'
        + opaqueNote,
    };
  }
  return {
    confidence: 'medium',
    reason:
      `Dispatcher emits [${writeOnly.map((k) => `'${k}'`).join(', ')}] in event.detail on CustomEvent channel `
      + `'${detail.channel}' that no visible listener reads. Weaker than the listener-sees-undefined case — `
      + 'these fields may be dead payload, or a listener the analyzer did not scan (an inline-script '
      + 'handler, a wrapper, a different repo) may still depend on them. Verify before dropping.'
      + opaqueNote,
  };
}

function confidenceStructuralDrift(detail) {
  // Per the v1 emission rule, only readOnlyKeys-non-empty findings reach
  // here (importer accesses fields the export doesn't declare). The factual
  // claim is always true — confidence mostly tracks blast radius.
  const readOnly = detail.readOnlyKeys ?? [];
  const projects = new Set(detail.occurrences.map((o) => o.project));
  const opaqueNote = detail.opaqueReaders
    ? ` Note: ${detail.opaqueReaders} reader site(s) had partial / opaque access patterns the analyzer could not fully resolve.`
    : '';
  if (projects.size > 1) {
    return {
      confidence: 'high',
      reason:
        `Importer in another project accesses [${readOnly.map((k) => `'${k}'`).join(', ')}] on `
        + `\`${detail.exportedName}\` from ${detail.module}, but the export does not declare these keys. `
        + 'Cross-project structural drift on a shared object — refactor on the declaring side silently '
        + 'breaks the importer; TypeScript only catches this when the export has a tight literal type.'
        + opaqueNote,
    };
  }
  return {
    confidence: 'high',
    reason:
      `Importer accesses [${readOnly.map((k) => `'${k}'`).join(', ')}] on \`${detail.exportedName}\` from `
      + `${detail.module}, but the export does not declare these keys. The reader will see \`undefined\` `
      + 'at runtime and either crash on chained access or silently fall through. The export site and '
      + 'reader site need to agree on the key set.'
      + opaqueNote,
  };
}

function confidenceEventBridge(detail) {
  // A bridge is a coupling claim, not a bug claim — the listener
  // intentionally re-dispatches to a different host. Worth flagging because
  // refactoring either side without the other silently severs the bridge.
  return {
    confidence: 'medium',
    reason:
      `CustomEvent channel '${detail.channel}' is bridged from ${detail.fromHost} to ${detail.toHost} — `
      + 'a listener on one host re-dispatches the same channel to another host, creating an implicit '
      + 'cross-host coupling. The bridge itself is usually intentional (iframe / worker / popup '
      + 'communication), but any refactor that removes the listener silently breaks consumers on the '
      + 'other side, and any change to the detail shape now has two reader populations to update.',
  };
}

function confidenceMissingTeardown(detail) {
  // The detector requires the registration to be observed AND no matching
  // teardown reachable in the same function body. The factual claim is
  // strong; confidence mostly modulates on registration kind.
  const regKind = detail.registrationKind ?? 'unknown';
  // setTimeout is often intentionally one-off (no teardown needed for the
  // happy path — the timer fires and is gone). The other kinds always
  // accumulate when a function is re-run.
  if (regKind === 'setTimeout') {
    return {
      confidence: 'medium',
      reason:
        'setTimeout registered with no clearTimeout reachable in the same function body. Often this is '
        + 'intentional (a one-off scheduled action), but if the enclosing function can be re-invoked '
        + 'before the timer fires (React effect re-run, route change, repeated user action), the un-cleared '
        + 'timer leaks state into the next invocation. Verify the enclosing scope is single-shot.',
    };
  }
  return {
    confidence: 'high',
    reason:
      `${regKind} registered with no matching teardown reachable in the same function body. In runtimes `
      + 'where the enclosing function can be re-invoked (React effect re-run, SPA navigation, repeated '
      + 'setup), each invocation accumulates another live registration — silent memory leak and '
      + 'duplicated handler firing. The cleanup-return pattern (returning a teardown function from a '
      + 'useEffect / disposer) is recognised; if the registration genuinely outlives the function, the '
      + 'fix is usually to hoist it to a one-shot init path.',
  };
}

function confidenceAbortNeverCalled(detail) {
  return {
    confidence: 'high',
    reason:
      'An `AbortController` was constructed and its `.signal` was passed to ≥1 fetch / addEventListener / '
      + 'subscriber call, but `.abort()` is never invoked anywhere in the same function body. The signal '
      + 'is therefore wired up but never fired — the controller is dead-weight, and the operations it '
      + 'gates will never be cancelled. Either remove the controller or wire `.abort()` into the teardown '
      + 'path.',
  };
}

function confidenceHandlerIdentityMismatch(detail) {
  return {
    confidence: 'high',
    reason:
      `\`addEventListener('${detail.channel ?? '?'}', X)\` is paired with \`removeEventListener('${detail.channel ?? '?'}', Y)\` `
      + 'in the same function body, where X and Y are provably different references (different inline '
      + 'arrow / function literal, different bound method, etc.). `removeEventListener` matches by '
      + 'reference equality, so the remove call is silently a no-op — the handler stays attached forever. '
      + 'Fix by hoisting the handler to a stable variable and passing the same reference to both calls.',
  };
}

function confidenceShapeDrift(detail) {
  // shape-drift only emits when BOTH sides have at least one literal
  // shape observation AND the aggregated shapes disagree — so the
  // factual claim "these keys don't match" is always true for emitted
  // findings. Confidence modulates on which *kind* of drift it is:
  //
  //   - readOnlyKeys > 0  → reader accesses a field no writer writes.
  //     This is the undefined-property-access crash shape. High.
  //   - writeOnlyKeys only → writer writes a field no reader reads.
  //     Could be dead data, could be a missing reader elsewhere we
  //     didn't scan (wrapper module, worker, different project). Medium.
  //
  // Opaque counts appear in the reason so the reviewer knows there are
  // sites we couldn't see through.
  const readOnly = detail.readOnlyKeys ?? [];
  const writeOnly = detail.writeOnlyKeys ?? [];
  const opaqueNote = (detail.opaqueWrites || detail.opaqueReads)
    ? ` Note: ${detail.opaqueWrites} writer site(s) and ${detail.opaqueReads} reader site(s) are opaque `
      + '(the analyzer couldn\'t resolve their shape — e.g. a stringify of a variable, a returned-only '
      + 'parse result); they are listed in occurrences but did not contribute to the shape union.'
    : '';
  if (readOnly.length > 0) {
    return {
      confidence: 'high',
      reason:
        `Reader accesses [${readOnly.map((k) => `'${k}'`).join(', ')}] on ${detail.storage}['${detail.key}'], `
        + 'but no writer sets these keys. At runtime the reader will see `undefined` for these fields and '
        + 'either crash on a property access or silently fall through. This is the canonical shape-drift '
        + 'bug shape (writer refactored, reader not updated, or vice versa) — the storage boundary hides '
        + 'the mismatch from TypeScript and linters.'
        + opaqueNote,
    };
  }
  return {
    confidence: 'medium',
    reason:
      `Writer stores [${writeOnly.map((k) => `'${k}'`).join(', ')}] on ${detail.storage}['${detail.key}'] `
      + 'that no visible reader accesses. This is weaker than the "reader sees undefined" case — the fields '
      + 'may simply be dead data, or a reader the analyzer did not scan (a worker, a wrapper module, a '
      + 'different repo) may still rely on them. Verify none of those consumers exist before concluding '
      + 'it is safe to drop the write.'
      + opaqueNote,
  };
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
    case 'shared-global-binding': {
      const declaringFiles = new Set(
        detail.occurrences
          .filter(o => o.op === 'declare' || o.op === 'assign')
          .map(o => `${o.project}:${o.file}`),
      );
      const deleteCount = detail.occurrences.filter(o => o.op === 'remove').length;
      const declarerNote = `declared/assigned by ${declaringFiles.size} files`;
      const deleteNote = deleteCount > 0 ? ` (plus ${deleteCount} delete site${deleteCount === 1 ? '' : 's'})` : '';
      return `Global name '${detail.name}' ${declarerNote}${crossProj}${deleteNote}`;
    }
    case 'stale-module-capture':
      return `'${detail.name}' captures dynamic source at module scope (via ${detail.capturedVia})`;
    case 'paired-keys':
      return `${detail.storage} paired-write cluster: [${detail.keys.map((k) => `'${k}'`).join(', ')}]`
        + ` — all callers should update together`;
    case 'duplicate-static-svg-id': {
      const compLabel = detail.component ? `<${detail.component}>` : 'component';
      const ev = detail.evidence?.[0];
      if (ev?.type === 'in-file-loop') {
        return `Static id='${detail.id}' on <${detail.element}> in ${compLabel} rendered inside ${ev.method}(…) — each iteration emits the same id`;
      }
      if (ev?.type === 'caller-loop') {
        return `Static id='${detail.id}' on <${detail.element}> in ${compLabel} rendered inside ${ev.method}(…) at ${ev.at.project}:${ev.at.file} — each iteration emits the same id`;
      }
      if (ev?.type === 'same-component-duplicate') {
        return `Static id='${detail.id}' declared ${ev.count} times inside ${compLabel} — duplicate in every render`;
      }
      if (ev?.type === 'cross-component-duplicate') {
        const otherComp = ev.other.component ?? '<anon>';
        return `Static id='${detail.id}' declared by ${compLabel} and <${otherComp}> (${ev.other.project}:${ev.other.file}) — may collide if both render together`;
      }
      return `Static id='${detail.id}' on <${detail.element}> in ${compLabel}`;
    }
    case 'shape-drift': {
      const wo = detail.writeOnlyKeys ?? [];
      const ro = detail.readOnlyKeys ?? [];
      const fmt = (arr) => arr.map((k) => `'${k}'`).join(', ');
      if (ro.length > 0 && wo.length > 0) {
        return `${detail.storage}['${detail.key}']: writer stores [${fmt(wo)}] but reader accesses [${fmt(ro)}] — shape drift`;
      }
      if (ro.length > 0) {
        return `${detail.storage}['${detail.key}']: reader accesses [${fmt(ro)}] that no writer sets`;
      }
      return `${detail.storage}['${detail.key}']: writer stores [${fmt(wo)}] that no reader accesses`;
    }
    case 'event-shape-drift': {
      const wo = detail.writeOnlyKeys ?? [];
      const ro = detail.readOnlyKeys ?? [];
      const fmt = (arr) => arr.map((k) => `'${k}'`).join(', ');
      if (ro.length > 0 && wo.length > 0) {
        return `CustomEvent '${detail.channel}': dispatcher emits [${fmt(wo)}] but listener accesses [${fmt(ro)}] — detail shape drift`;
      }
      if (ro.length > 0) {
        return `CustomEvent '${detail.channel}': listener accesses [${fmt(ro)}] that no dispatcher emits`;
      }
      return `CustomEvent '${detail.channel}': dispatcher emits [${fmt(wo)}] that no listener reads`;
    }
    case 'structural-drift': {
      const ro = detail.readOnlyKeys ?? [];
      const fmt = (arr) => arr.map((k) => `'${k}'`).join(', ');
      return `\`${detail.exportedName}\` from ${detail.module}: importer accesses [${fmt(ro)}] not declared on the export${crossProj}`;
    }
    case 'event-bridge':
      return `CustomEvent '${detail.channel}' bridged ${detail.fromHost} → ${detail.toHost}${crossProj}`;
    case 'missing-teardown':
      return `${detail.registrationKind ?? '<unknown>'} registered with no matching teardown in the same function body`;
    case 'abort-never-called':
      return `AbortController constructed and .signal used, but .abort() is never called`;
    case 'handler-identity-mismatch':
      return `addEventListener / removeEventListener for '${detail.channel ?? '?'}' use different handler references — remove is a silent no-op`;
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
 * output. That was the bug reported in an earlier dogfood review (§2.5).
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
  if (kind === 'duplicate-static-svg-id') {
    // Component-scoped: two components in the same file declaring the
    // same id are independent findings (each may have distinct evidence).
    const loc = detail.occurrences.find((o) => o.op === 'declare') ?? detail.occurrences[0];
    const comp = detail.component ?? '<anon>';
    return `${kind}:${detail.id}@${loc?.project ?? '?'}:${loc?.file ?? '?'}:${comp}`;
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
    case 'shape-drift':
      // Per-channel identity: the finding is "the shape contract on
      // (storage, key) is broken." Adding more writers or readers that
      // keep disagreeing does not change which channel the drift is on.
      parts.push(detail.storage ?? '?', detail.key ?? '');
      break;
    case 'event-shape-drift':
      // Per-channel identity: the finding is "the shape contract on the
      // CustomEvent channel is broken." Adding more dispatch/listen sites
      // that keep disagreeing does not change which channel the drift is on.
      parts.push(detail.channel ?? '');
      break;
    case 'structural-drift':
      // Per-export identity: the finding is "the shape contract on this
      // exported name from this module is broken." Adding more readers
      // that keep disagreeing does not change which export the drift is on.
      parts.push(detail.module ?? '', detail.exportedName ?? '');
      break;
    case 'event-bridge':
      parts.push(detail.channel ?? '', detail.fromHost ?? '', detail.toHost ?? '',
                 detail.occurrences?.[0]?.file ?? '', String(detail.occurrences?.[0]?.line ?? ''));
      break;
    case 'missing-teardown':
      parts.push(detail.registrationKind ?? '', detail.occurrences?.[0]?.file ?? '',
                 String(detail.occurrences?.[0]?.line ?? ''));
      break;
    case 'abort-never-called':
      parts.push(detail.occurrences?.[0]?.file ?? '',
                 String(detail.occurrences?.[0]?.line ?? ''));
      break;
    case 'handler-identity-mismatch':
      parts.push(detail.channel ?? '', detail.occurrences?.[0]?.file ?? '',
                 String(detail.occurrences?.[0]?.line ?? ''));
      break;
    case 'duplicate-static-svg-id': {
      // Per-component, per-id identity. Moving the component to a new
      // file or renaming it changes the fingerprint (different bug site);
      // adding / removing url(#) refs or evidence kinds in place does not.
      const loc = detail.occurrences.find((o) => o.op === 'declare') ?? detail.occurrences[0] ?? {};
      parts.push(detail.id ?? '', loc.project ?? '?', loc.file ?? '?', detail.component ?? '<anon>');
      break;
    }
    default:
      // Unknown kind: hash whatever identity the detail carries, so at
      // least the fingerprint is deterministic per-run.
      parts.push(JSON.stringify(detail));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// patternFingerprintFor — sibling to fingerprintFor, hashes only the
// SHAPE of a finding (kind + logical identity facts), never location.
// See D18 for the per-kind recipe; this function is the canonical implementation.
function patternFingerprintFor(kind, detail) {
  const parts = [kind];
  switch (kind) {
    case 'shared-storage-key':
      if (detail.dynamic) {
        parts.push('dynamic', detail.storage ?? '?');
      } else {
        parts.push(detail.storage ?? '?', detail.key ?? '');
      }
      break;
    case 'shared-event-channel':
      if (detail.dynamic) {
        parts.push('dynamic');
      } else {
        parts.push(detail.channel ?? '');
      }
      break;
    case 'shared-global-binding':
      parts.push(detail.name ?? '');
      break;
    case 'stale-module-capture':
      parts.push(detail.capturedVia ?? '');
      break;
    case 'paired-keys':
      parts.push(detail.storage ?? '?', [...(detail.keys ?? [])].sort().join('+'));
      break;
    case 'shape-drift':
      parts.push(detail.storage ?? '?', detail.key ?? '');
      break;
    case 'event-shape-drift':
      parts.push(detail.channel ?? '');
      break;
    case 'structural-drift':
      parts.push(detail.module ?? '', detail.exportedName ?? '');
      break;
    case 'event-bridge':
      parts.push(detail.channel ?? '', detail.fromHost ?? '', detail.toHost ?? '');
      break;
    case 'missing-teardown':
      parts.push(detail.registrationKind ?? '');
      break;
    case 'abort-never-called':
      // Degenerate: the pattern is the kind itself. Documented in D18.
      break;
    case 'handler-identity-mismatch':
      parts.push(detail.channel ?? '');
      break;
    case 'duplicate-static-svg-id':
      parts.push(detail.id ?? '');
      break;
    default:
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
    // Use execFileSync (argv array) instead of execSync (single shell
    // string). The --since ref is user-supplied; with execSync, shell
    // metacharacters in `base` would be interpreted by /bin/sh. With
    // execFileSync, `base` is passed verbatim as a single argument to git.
    const out = execFileSync('git', ['diff', '--name-only', base], {
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
 * @param {string[]} [opts.exclude]       project-root-relative directory paths to skip
 * @param {string[]} [opts.only]          detector ids to run; if given, others are skipped
 * @param {string[]} [opts.skip]          detector ids to skip; applied after `only`
 * @param {ReturnType<typeof createAstCache>} [opts.astCache]  injected cache,
 *                                         used by tests and by `--cache-stats`
 *                                         to inspect hit/miss totals after
 *                                         the run. Normal callers omit this
 *                                         and get a fresh per-run cache.
 * @param {boolean} [opts.noCache]         explicit opt-out: when true, no
 *                                         cache is created and every detector
 *                                         falls back to its own fs + parse
 *                                         path (pre-D14 behaviour). Useful
 *                                         for benchmarking, debugging, and
 *                                         worst-case regression safety.
 */
export function analyzeProjects(projectRoots, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const maxDepth = opts.maxDepth ?? 6;
  const exclude = opts.exclude;
  const includeBuildArtifacts = opts.includeBuildArtifacts;
  // One cache for the whole run. Each source file is read + parsed on first
  // touch and reused by every subsequent detector and by import-graph. The
  // cache is deliberately per-run: no cross-run persistence, no content
  // hashing. `opts.noCache` is an explicit opt-out that returns the
  // pre-D14 "each detector parses its own copy" behaviour; detectors
  // already handle a null/undefined astCache by falling through to their
  // own fs + parse path, so passing null here is sufficient.
  const astCache = opts.noCache ? null : (opts.astCache ?? createAstCache());
  // Registry-driven detector selection. Unknown ids in `only`/`skip` throw
  // from selectDetectors — we let that propagate so a typo surfaces at the
  // CLI boundary rather than quietly producing an empty-but-valid report.
  const detectors = selectDetectors({ only: opts.only, skip: opts.skip });

  // Cross-file string-literal constant folder (D15). Built once per run
  // over the AST cache: walks every file to collect string-literal
  // exports and each file's imports, then hands back a closure that
  // detectors call from inside `resolveStringArg` when same-file
  // folding misses. Null when the cache is disabled — without a cache
  // the bookkeeping cost starts to dwarf the win, and `--no-cache` is
  // an opt-out to pre-D14 behaviour by design.
  let crossFileResolver = null;
  if (astCache) {
    const resolvedProjects = projectRoots.map(resolveProject);
    const constantsIndex = buildConstantsIndex(resolvedProjects, { astCache, exclude, includeBuildArtifacts });
    crossFileResolver = makeCrossFileResolver(constantsIndex);
  }

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

  // 2. Run every selected detector. Each returns its native result shape;
  //    we keep the result paired with its registry entry so step 3 can look
  //    up the right `findingKind` wrapper label without a second map.
  const detectorResults = detectors.map((d) => ({
    detector: d,
    result: d.module.analyzeProjects(projectRoots, { exclude, astCache, crossFileResolver, includeBuildArtifacts }),
  }));

  // Project id -> project root (for resolving occurrence.file -> absolute).
  const projects = projectRoots.map(resolveProject);
  const rootById = new Map(projects.map((p) => [p.id, p.root]));

  // 3. Wrap each finding into the unified envelope. Per-finding `kind`
  //    takes precedence over the registry's declared `findingKind`, so a
  //    single analyzer that emits multiple finding kinds (e.g. shape-drift
  //    emits `shape-drift` for storage and `event-shape-drift` for events;
  //    lifecycle-cleanup-drift emits `missing-teardown` /
  //    `abort-never-called` / `handler-identity-mismatch`) gets each
  //    finding routed to its own severity / confidence / message / fingerprint
  //    case. The registry's `findingKind` is the fallback for analyzers
  //    that don't carry their own kind on each finding. Registry order
  //    is preserved, which keeps sort-stable behavior identical to the
  //    pre-registry hand-coded order.
  const wrapped = [];
  for (const { detector, result } of detectorResults) {
    for (const f of result.findings) {
      wrapped.push(wrap(f.kind ?? detector.findingKind, f, rootById, changedFilesAbs));
    }
  }

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
    const graphResult = importGraph.analyzeProjects(projectRoots, [...changedFilesAbs], { maxDepth, exclude, astCache, includeBuildArtifacts });
    blastRadius = graphResult.dependents.map((d) => ({
      file: d.file,
      project: projectIdFor(d.file, rootById),
      depth: d.depth,
    }));
  }

  // 6. Summary stats.
  const byKind = {};
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byConfidence = { high: 0, medium: 0, low: 0 };
  let findingsTouchingChange = 0;
  for (const w of wrapped) {
    byKind[w.kind] = (byKind[w.kind] ?? 0) + 1;
    bySeverity[w.severity] = (bySeverity[w.severity] ?? 0) + 1;
    byConfidence[w.confidence] = (byConfidence[w.confidence] ?? 0) + 1;
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
      byConfidence,
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
  const { confidence, reason: confidenceReason } = confidenceFor(kind, detail);
  return {
    id: findingIdFor(kind, detail),
    fingerprint: fingerprintFor(kind, detail),
    patternFingerprint: patternFingerprintFor(kind, detail),
    kind,
    severity: severityFor(kind, detail),
    confidence,
    confidenceReason,
    message: messageFor(kind, detail),
    detail,
    relatedFiles,
    touchesChange,
  };
}

/**
 * Compute the fingerprint-keyed diff between a current run's wrapped
 * findings and a prior baseline's wrapped findings.
 *
 * Returns { new: [], resolved: [], unchanged: [] } where each array
 * contains wrapped finding objects. "new" = in current, absent in
 * baseline. "resolved" = in baseline, absent in current. "unchanged" =
 * in both.
 *
 * Both arrays must be the `findings` array from an `impact --json`
 * output (i.e. already-wrapped objects with a `fingerprint` field).
 */
export function computeDiff(currentFindings, baselineFindings) {
  // Build fingerprint -> finding maps for O(1) membership checks, and
  // surface any fingerprint collision to stderr. Two findings sharing a
  // fingerprint is unlikely with a 64-bit hash but not impossible; if it
  // happens, the diff would silently undercount findings on whichever
  // side the collision lives. Warn so the user knows the diff is fuzzy.
  const baselineByFp = new Map();
  for (const f of baselineFindings ?? []) {
    if (baselineByFp.has(f.fingerprint)) {
      process.stderr.write(
        `code-intel/impact --baseline: warning: duplicate fingerprint ${f.fingerprint} in baseline (`
        + `${f.kind}); the diff may undercount findings on that key.\n`,
      );
    }
    baselineByFp.set(f.fingerprint, f);
  }
  const currentByFp = new Map();
  for (const f of currentFindings ?? []) {
    if (currentByFp.has(f.fingerprint)) {
      process.stderr.write(
        `code-intel/impact --baseline: warning: duplicate fingerprint ${f.fingerprint} in current run (`
        + `${f.kind}); the diff may undercount findings on that key.\n`,
      );
    }
    currentByFp.set(f.fingerprint, f);
  }

  const added = [];
  const unchanged = [];
  for (const f of currentFindings ?? []) {
    if (baselineByFp.has(f.fingerprint)) unchanged.push(f);
    else added.push(f);
  }
  const resolved = [];
  for (const f of baselineFindings ?? []) {
    if (!currentByFp.has(f.fingerprint)) resolved.push(f);
  }

  return { new: added, resolved, unchanged };
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
