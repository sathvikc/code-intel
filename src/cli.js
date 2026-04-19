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
//   code-intel shape-drift     [paths...] [--pretty]
//   code-intel duplicate-static-svg-id [paths...] [--pretty]
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
import * as duplicateStaticSvgId from './duplicate-static-svg-id.js';
import * as impact from './impact.js';
import * as trace from './trace.js';
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
  'duplicate-static-svg-id': {
    analyzer: duplicateStaticSvgId,
    summarize: (s) => [
      `code-intel / duplicate-static-svg-id`,
      `projects:          ${s.projectCount}`,
      `findings:          ${s.findingCount}`,
      `  declarations:    ${s.totalDeclarations}`,
      `  references:      ${s.totalReferences}`,
      `  affected files:  ${s.affectedFiles}`,
    ],
  },
};

const USAGE = `Usage:
  code-intel impact          [paths...] [--since <ref>] [--markdown|--json] [--pretty] [--exclude <path>]
  code-intel trace           (--storage <backend:key> | --event <channel> | --global <name>)
                             [paths...] [--format json|mermaid] [--pretty] [--exclude <path>]
  code-intel shared-state    [paths...] [--pretty] [--exclude <path>]
  code-intel shared-events   [paths...] [--pretty] [--exclude <path>]
  code-intel shared-globals  [paths...] [--pretty] [--exclude <path>]
  code-intel stale-captures  [paths...] [--pretty] [--exclude <path>]
  code-intel paired-keys     [paths...] [--pretty] [--exclude <path>]
  code-intel shape-drift     [paths...] [--pretty] [--exclude <path>]
  code-intel duplicate-static-svg-id [paths...] [--pretty] [--exclude <path>]

Subcommands:
  impact          Unified report across all detectors. With --since <ref>, filters
                  and sorts by what intersects the git change set, and computes the
                  import-graph blast radius of the changed files.
  trace           Per-symbol graph query. Given a target (storage key, event channel,
                  or global name), returns a star-topology graph of every site that
                  touches it: one hub node + N occurrence nodes, one edge per
                  occurrence labelled with its relation (reads-from / writes-to /
                  dispatches-to / etc.). Pure reshape over existing analyzer output;
                  answers the agent-query shape "what else touches X before I
                  refactor it?".
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
  duplicate-static-svg-id
                  Detect static string-literal id attributes on JSX SVG elements
                  that are referenced in the same file via url(#id) or
                  xlinkHref="#id". If the component ever renders more than once
                  on a page (SSR pre-render, lists, grids) the browser resolves
                  every url(#id) to whichever copy it saw first, silently
                  corrupting gradients/filters/masks/use-symbols.

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
  --storage <backend:key>
                  (trace only) target a storage key. backend is localStorage or
                  sessionStorage; everything after the first colon is the key.
  --event <channel>
                  (trace only) target a CustomEvent / addEventListener channel.
  --global <name> (trace only) target a classic-script global-binding name.
  --format <fmt>  (trace only) json (default) or mermaid.
  --pretty        Pretty-print JSON output.
  --exclude <path>
                  Project-root-relative directory path to skip. Repeatable.
                  Literal paths only (no globs in v1); --exclude examples and
                  --exclude examples/generated both work. Hardcoded ignores
                  (node_modules, dist, build, .git, coverage, .next, .turbo,
                  .cache) always apply on top and cannot be overridden.
  -h, --help      Show this help.
`;

function parseCommonArgs(argv) {
  const args = { paths: [], pretty: false, help: false, exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') args.pretty = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--exclude') {
      const v = argv[++i];
      if (!v) throw new Error(`--exclude requires a value`);
      args.exclude.push(v);
    }
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
    exclude: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--since') { args.since = argv[++i]; }
    else if (a === '--json') args.format = 'json';
    else if (a === '--markdown') args.format = 'markdown';
    else if (a === '--pretty') args.pretty = true;
    else if (a === '--exclude') {
      const v = argv[++i];
      if (!v) throw new Error(`--exclude requires a value`);
      args.exclude.push(v);
    }
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
  const result = impact.analyzeProjects(args.paths, { since: args.since, exclude: args.exclude });

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

function parseTraceArgs(argv) {
  const args = {
    paths: [],
    target: null, // { kind: 'storage' | 'event' | 'global', ... }
    format: 'json',
    pretty: false,
    help: false,
    exclude: [],
  };
  const setTarget = (t) => {
    if (args.target) {
      throw new Error(`Only one of --storage / --event / --global may be given`);
    }
    args.target = t;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--pretty') args.pretty = true;
    else if (a === '--format') {
      const v = argv[++i];
      if (v !== 'json' && v !== 'mermaid') {
        throw new Error(`--format expects 'json' or 'mermaid', got: ${v ?? '(missing)'}`);
      }
      args.format = v;
    }
    else if (a === '--storage') {
      const v = argv[++i];
      if (!v) throw new Error(`--storage requires a value of the form <backend:key>`);
      const { backend, key } = trace.parseStorageTarget(v);
      setTarget({ kind: 'storage', backend, name: key });
    }
    else if (a === '--event') {
      const v = argv[++i];
      if (!v) throw new Error(`--event requires a channel name`);
      setTarget({ kind: 'event', name: v });
    }
    else if (a === '--global') {
      const v = argv[++i];
      if (!v) throw new Error(`--global requires a name`);
      setTarget({ kind: 'global', name: v });
    }
    else if (a === '--exclude') {
      const v = argv[++i];
      if (!v) throw new Error(`--exclude requires a value`);
      args.exclude.push(v);
    }
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else args.paths.push(a);
  }
  if (!args.help && !args.target) {
    throw new Error(
      `trace requires one of --storage <backend:key>, --event <channel>, --global <name>`,
    );
  }
  if (args.paths.length === 0) args.paths.push('.');
  return args;
}

async function runTrace(argv) {
  let args;
  try {
    args = parseTraceArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let result;
  if (args.target.kind === 'storage') {
    result = trace.traceStorage(args.paths, args.target.backend, args.target.name, {
      exclude: args.exclude,
    });
  } else if (args.target.kind === 'event') {
    result = trace.traceEvent(args.paths, args.target.name, { exclude: args.exclude });
  } else {
    result = trace.traceGlobal(args.paths, args.target.name, { exclude: args.exclude });
  }

  if (args.format === 'mermaid') {
    process.stdout.write(trace.renderMermaid(result));
  } else {
    const json = args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
    process.stdout.write(json + '\n');
  }
  process.stderr.write(trace.summarize(result).join('\n') + '\n');
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
  const result = cmd.analyzer.analyzeProjects(args.paths, { exclude: args.exclude });
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
  if (sub === 'trace') return runTrace(rest);
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
