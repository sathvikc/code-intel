#!/usr/bin/env node
// code-intel CLI dispatcher.
//
// Usage:
//   code-intel shared-state [paths...] [--pretty]
//
// Emits JSON result to stdout, human summary to stderr. Multi-project is
// first-class: pass N paths, each becomes a project in the result.

import { analyzeProjects, summarize } from './shared-state-web-storage.js';

const USAGE = `Usage:
  code-intel shared-state [paths...] [--pretty]

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

function printSummary(summary) {
  const lines = [
    `code-intel / shared-state.web-storage`,
    `projects:       ${summary.projectCount}`,
    `findings:       ${summary.findingCount}`,
    `  localStorage: ${summary.byStorage.localStorage ?? 0}`,
    `  sessionStorage: ${summary.byStorage.sessionStorage ?? 0}`,
    `cross-project:  ${summary.crossProject}`,
    `cross-file:     ${summary.crossFile}`,
    `dynamic keys:   ${summary.dynamic}`,
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub !== 'shared-state') {
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
  const result = analyzeProjects(args.paths);
  const json = args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
  process.stdout.write(json + '\n');
  printSummary(summarize(result));
  return 0;
}

main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch(err => {
    process.stderr.write(`code-intel: ${err.message}\n`);
    process.exit(1);
  });
