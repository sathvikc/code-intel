#!/usr/bin/env node
// code-intel CLI dispatcher.
//
// Primary entry point:
//   code-intel impact [--since <ref>] [--markdown|--json] [--pretty] [paths...]
//
// Per-analyzer entry points (useful when you want just one signal as JSON):
//   code-intel shared-state    [paths...] [--pretty]
//   code-intel shared-events   [paths...] [--pretty]
//   code-intel shared-globals  [paths...] [--pretty]
//   code-intel stale-captures  [paths...] [--pretty]
//   code-intel paired-keys     [paths...] [--pretty]
//
// Multi-project is first-class: every path is a separate project; findings
// are grouped across them so cross-repo coupling surfaces the same way
// in-project coupling does.

import * as webStorage from './shared-state-web-storage.js';
import * as events from './shared-state-events.js';
import * as globals from './shared-state-globals.js';
import * as staleCapture from './stale-module-capture.js';
import * as pairedKeys from './paired-keys.js';
import * as shapeDrift from './shape-drift.js';
import * as impact from './impact.js';
import { renderMarkdown } from './report-markdown.js';

const ANALYZER_COMMANDS = {
  'shared-state': {
    analyzer: webStorage,
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
  'shared-events': {
    analyzer: events,
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
  'shared-globals': {
    analyzer: globals,
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
  'stale-captures': {
    analyzer: staleCapture,
    summarize: (s) => [
      `code-intel / stale-module-capture`,
      `projects:           ${s.projectCount}`,
      `findings:           ${s.findingCount}`,
      `  direct-api:       ${s.byCapturedKind['direct-api'] ?? 0}`,
      `  indirect-wrapper: ${s.byCapturedKind['indirect-wrapper'] ?? 0}`,
      `auto-detected readers: ${s.detectedReaders}`,
    ],
  },
  'paired-keys': {
    analyzer: pairedKeys,
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
  'shape-drift': {
    analyzer: shapeDrift,
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
};

const USAGE = `Usage:
  code-intel impact          [paths...] [--since <ref>] [--markdown|--json] [--pretty]
  code-intel shared-state    [paths...] [--pretty]
  code-intel shared-events   [paths...] [--pretty]
  code-intel shared-globals  [paths...] [--pretty]
  code-intel stale-captures  [paths...] [--pretty]
  code-intel paired-keys     [paths...] [--pretty]
  code-intel shape-drift     [paths...] [--pretty]

Subcommands:
  impact          Unified report across all detectors. With --since <ref>, filters
                  and sorts by what intersects the git change set, and computes the
                  import-graph blast radius of the changed files.
  shared-state    Detect localStorage / sessionStorage key coupling.
  shared-events   Detect window / globalThis CustomEvent coupling.
  shared-globals  Detect cross-script global-binding collisions (e.g. two files
                  defining the same top-level helper on window).
  stale-captures  Detect module-scope captures of dynamic sources (cookie / storage
                  / DOM / navigator / fetch frozen at import time).
  paired-keys     Detect intra-function setItem clusters — storage keys designed to
                  be written together (e.g. value + timestamp). Any writer who touches
                  only one of the pair breaks the cache-freshness invariant.
  shape-drift     Detect write-shape vs read-shape mismatches across a storage
                  channel. Writer stores {name}; reader accesses .firstName; the
                  refactor type-checked fine because TypeScript does not see across
                  the JSON.stringify / JSON.parse boundary. v1 is storage-only and
                  catches literal object-literal writes against literal property
                  accesses; wider channels and wrapper modules come later.

Args:
  paths           One or more project roots. Defaults to "." if omitted.
                  Each path is treated as an independent project; findings are
                  grouped across projects so cross-repo coupling surfaces.

Options:
  --since <ref>   (impact only) git base ref to diff against. Resolves the set
                  of changed files; findings that touch them are sorted first
                  and marked; blast radius is computed.
  --markdown      (impact only) Emit markdown report (default when --since is set
                  or when stdout is a TTY).
  --json          (impact only) Emit unified JSON report.
  --pretty        Pretty-print JSON output.
  -h, --help      Show this help.
`;

function parseCommonArgs(argv) {
  const args = { paths: [], pretty: false, help: false };
  for (const a of argv) {
    if (a === '--pretty') args.pretty = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else args.paths.push(a);
  }
  if (args.paths.length === 0) args.paths.push('.');
  return args;
}

function parseImpactArgs(argv) {
  const args = {
    paths: [],
    since: null,
    format: null, // 'markdown' | 'json' — decided below if null
    pretty: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--since') { args.since = argv[++i]; }
    else if (a === '--json') args.format = 'json';
    else if (a === '--markdown') args.format = 'markdown';
    else if (a === '--pretty') args.pretty = true;
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else args.paths.push(a);
  }
  if (args.paths.length === 0) args.paths.push('.');
  // Default format: markdown when --since is set (PR-report use case) or when
  // stdout is a TTY (human invocation); otherwise JSON for tool chains.
  if (args.format === null) {
    args.format = args.since || process.stdout.isTTY ? 'markdown' : 'json';
  }
  return args;
}

async function runImpact(argv) {
  let args;
  try {
    args = parseImpactArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const result = impact.analyzeProjects(args.paths, { since: args.since });

  if (args.format === 'markdown') {
    process.stdout.write(renderMarkdown(result));
  } else {
    const json = args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
    process.stdout.write(json + '\n');
  }
  // Always a brief stderr summary so humans invoking the JSON variant still
  // see something.
  const s = result.summary;
  const gitLine = result.integrations?.git?.available
    ? ` | base ${result.meta.base} | ${result.meta.changedFileCount} changed`
    : '';
  process.stderr.write(
    `code-intel / impact${gitLine}: `
      + `${s.totalFindings} finding(s) — `
      + `${s.bySeverity.critical ?? 0} critical, `
      + `${s.bySeverity.warning ?? 0} warning, `
      + `${s.bySeverity.info ?? 0} info`
      + (s.findingsTouchingChange !== null ? ` (${s.findingsTouchingChange} touch change)` : '')
      + (s.blastRadius ? ` | blast radius: ${s.blastRadius.total}` : '')
      + '\n',
  );
  return 0;
}

async function runAnalyzer(sub, argv) {
  const cmd = ANALYZER_COMMANDS[sub];
  let args;
  try {
    args = parseCommonArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const result = cmd.analyzer.analyzeProjects(args.paths);
  const json = args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
  process.stdout.write(json + '\n');
  const summary = cmd.analyzer.summarize(result);
  process.stderr.write(cmd.summarize(summary).join('\n') + '\n');
  return 0;
}

async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub === 'impact') return runImpact(rest);
  if (ANALYZER_COMMANDS[sub]) return runAnalyzer(sub, rest);
  process.stderr.write(`Unknown command: ${sub}\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`code-intel: ${err.message}\n`);
    process.exit(1);
  });
