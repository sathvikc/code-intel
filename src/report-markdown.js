// report-markdown.js — render a unified impact result as a markdown report.
//
// Target audience: human reviewer on a PR, or an AI agent reading the same
// output before proposing a change. Sections mirror the analyze-impact.js
// format on the phase-1 branch so anyone familiar with that tool sees the
// same shape here.
//
// Structure:
//   # code-intel — Impact Report
//   _timestamp | base_
//
//   ## Summary           (totals, severity counts, blast radius size)
//   ## Changed Files     (only when base is set)
//   ## Blast Radius      (only when base is set)
//   ## Findings
//     ### Critical       (sub-grouped by kind)
//     ### Warning
//     ### Info
//   ## Nothing found?    (only when total == 0)
//
// Recall-first: every finding is rendered; the reviewer / AI decides what to
// act on.

const SEV_SYMBOLS = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

const CONFIDENCE_TAGS = {
  high: '`high confidence`',
  medium: '`medium confidence`',
  low: '`low confidence`',
};

const KIND_LABELS = {
  'shared-storage-key': 'Shared storage key',
  'shared-event-channel': 'Shared event channel',
  'shared-global-binding': 'Shared global binding',
  'stale-module-capture': 'Stale module-scope capture',
  'paired-keys': 'Paired storage keys',
  'shape-drift': 'Shape drift across storage channel',
  'duplicate-static-svg-id': 'Duplicate static SVG id',
};

export function renderMarkdown(result) {
  const out = [];
  const { meta, summary, findings, graph, integrations } = result;

  out.push('# code-intel — Impact Report');
  const tsShort = (meta.timestamp ?? '').replace('T', ' ').slice(0, 19);
  const baseStr = meta.base ? ` | base: \`${meta.base}\`` : '';
  out.push(`_${tsShort}${baseStr}_`);
  out.push('');

  // ---------- Diff (baseline compare mode) ----------
  if (result.diff) {
    const { new: added, resolved, unchanged } = result.diff;
    out.push('## Diff');
    out.push('');
    if (added.length === 0 && resolved.length === 0) {
      out.push(`No new findings since baseline. ${unchanged.length} unchanged.`);
    } else {
      out.push(`**+${added.length} new** · **-${resolved.length} resolved** · ${unchanged.length} unchanged`);
      if (added.length > 0) {
        out.push('');
        out.push(`### New findings (${added.length})`);
        out.push('');
        for (const f of added) {
          renderFindingLine(out, f);
        }
      }
      if (resolved.length > 0) {
        out.push('');
        out.push(`### Resolved findings (${resolved.length})`);
        out.push('');
        for (const f of resolved) {
          const confTag = f.confidence ? ` ${CONFIDENCE_TAGS[f.confidence] ?? ''}` : '';
          out.push(`- ~~**\`${f.id}\`**~~${confTag} — ~~${f.message}~~`);
          out.push(`  > Resolved since baseline.`);
        }
      }
    }
    out.push('');
  }

  // ---------- Summary ----------
  out.push('## Summary');
  out.push('');
  const totalLine = summary.findingsTouchingChange !== null
    ? `- **Findings:** ${summary.totalFindings} total (${summary.findingsTouchingChange} touch the change set)`
    : `- **Findings:** ${summary.totalFindings} total`;
  out.push(totalLine);
  out.push(
    `- **By severity:** ${SEV_SYMBOLS.critical} ${summary.bySeverity.critical ?? 0} critical · `
      + `${SEV_SYMBOLS.warning} ${summary.bySeverity.warning ?? 0} warning · `
      + `${SEV_SYMBOLS.info} ${summary.bySeverity.info ?? 0} info`,
  );
  if (summary.byConfidence) {
    out.push(
      `- **By confidence:** ${summary.byConfidence.high ?? 0} high · `
        + `${summary.byConfidence.medium ?? 0} medium · `
        + `${summary.byConfidence.low ?? 0} low`,
    );
  }
  const kindLine = Object.entries(summary.byKind)
    .map(([k, n]) => `${KIND_LABELS[k] ?? k}: ${n}`)
    .join(' · ');
  if (kindLine) out.push(`- **By kind:** ${kindLine}`);
  if (summary.blastRadius) {
    out.push(
      `- **Blast radius:** ${summary.blastRadius.total} file(s) transitively import changed files`
        + ` (max depth ${summary.blastRadius.maxDepth})`,
    );
  }
  out.push('');

  // ---------- Changed files ----------
  if (meta.changedFileCount !== null && integrations?.git?.changedFiles?.length) {
    out.push(`## Changed Files (${integrations.git.changedFiles.length})`);
    out.push('');
    for (const f of integrations.git.changedFiles) {
      out.push(`- \`${relIfWithin(f, result.projects)}\``);
    }
    out.push('');
  }

  // ---------- Blast radius ----------
  if (graph?.blastRadius?.length) {
    out.push(`## Blast Radius (${graph.blastRadius.length})`);
    out.push('> Files that transitively import one or more of the changed files.');
    out.push('> If any of these files relies on the changed behavior, it may break.');
    out.push('');
    const byDepth = groupBy(graph.blastRadius, (r) => r.depth);
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      out.push(`**Depth ${depth}** — ${byDepth.get(depth).length} file(s)`);
      for (const r of byDepth.get(depth)) {
        const projTag = r.project ? ` _[${r.project}]_` : '';
        out.push(`- \`${relIfWithin(r.file, result.projects)}\`${projTag}`);
      }
      out.push('');
    }
  }

  // ---------- Findings ----------
  if (!findings.length) {
    out.push('## No findings');
    out.push('');
    out.push('_No implicit-coupling, stale-capture, or global-binding findings produced for this scope._');
    out.push('');
    return out.join('\n');
  }

  out.push('## Findings');
  out.push('');

  const bySev = groupBy(findings, (f) => f.severity);
  const order = ['critical', 'warning', 'info'];

  for (const sev of order) {
    const group = bySev.get(sev) ?? [];
    if (!group.length) continue;
    out.push(`### ${SEV_SYMBOLS[sev]} ${capitalize(sev)} (${group.length})`);
    out.push('');

    const byKind = groupBy(group, (f) => f.kind);
    for (const kind of [...byKind.keys()].sort()) {
      out.push(`#### ${KIND_LABELS[kind] ?? kind}`);
      out.push('');
      for (const f of byKind.get(kind)) {
        renderFindingLine(out, f);
      }
    }
  }

  return out.join('\n').trimEnd() + '\n';
}

// ---------- helpers ----------

function renderFindingLine(out, f) {
  const changedMark = f.touchesChange ? ' ⬅ **touches change**' : '';
  const confTag = f.confidence ? ` ${CONFIDENCE_TAGS[f.confidence] ?? ''}` : '';
  out.push(`- **\`${f.id}\`**${confTag}${changedMark} — ${f.message}`);
  if (f.confidenceReason) {
    out.push(`  > ${f.confidenceReason}`);
  }
  if (f.relatedFiles?.length) {
    out.push('  | Project | File | Line | Op |');
    out.push('  | :--- | :--- | ---: | :--- |');
    for (const rf of f.relatedFiles) {
      out.push(
        `  | \`${rf.project}\` | \`${rf.file}\` | ${rf.line ?? ''} | \`${rf.op ?? ''}\` |`,
      );
    }
    out.push('');
  }
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function relIfWithin(absFile, projects) {
  for (const p of projects ?? []) {
    if (absFile.startsWith(p.root + '/')) {
      return `${p.id}:${absFile.slice(p.root.length + 1)}`;
    }
  }
  return absFile;
}
