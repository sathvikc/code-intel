#!/usr/bin/env node
// code-intel CLI dispatcher.
//
// Usage:
//   code-intel shared-state  [paths...] [--pretty]   # localStorage / sessionStorage
//   code-intel shared-events [paths...] [--pretty]   # window CustomEvent / listeners
//
// Emits JSON result to stdout, human summary to stderr. Multi-project is
// first-class: pass N paths, each becomes a project in the result.

import * as webStorage from './shared-state-web-storage.js';
import * as events from './shared-state-events.js';
import * as globals from './shared-state-globals.js';

const COMMANDS = {
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
};

const USAGE = `Usage:
  code-intel shared-state   [paths...] [--pretty]
  code-intel shared-events  [paths...] [--pretty]
  code-intel shared-globals [paths...] [--pretty]

Subcommands:
  shared-state    Detect localStorage / sessionStorage key coupling.
  shared-events   Detect window / globalThis CustomEvent coupling.
  shared-globals  Detect cross-script global-binding collisions (e.g. two files defining window.getCookie).

Args:
  paths          One or more project roots. Defaults to "." if omitted.
                 Each path is treated as an independent project; findings
                 are grouped across projects so cross-repo coupling surfaces.

Options:
  --pretty       Pretty-print JSON output (default: compact).
  -h, --help     Show this help.
`;

function parseArgs(argv) {
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

async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const cmd = COMMANDS[sub];
  if (!cmd) {
    process.stderr.write(`Unknown command: ${sub}\n\n${USAGE}`);
    return 2;
  }
  let args;
  try {
    args = parseArgs(rest);
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

main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch(err => {
    process.stderr.write(`code-intel: ${err.message}\n`);
    process.exit(1);
  });
