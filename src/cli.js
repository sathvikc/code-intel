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

import fs from 'node:fs';

import { createAstCache } from './ast-cache.js';
import * as impact from './impact.js';
import * as trace from './trace.js';
import { renderMarkdown } from './report-markdown.js';
import { DETECTORS, DETECTOR_IDS } from './detectors/index.js';

// Per-subcommand command table, derived from the detector registry. Each
// entry wraps one detector for the per-analyzer CLI surface (`code-intel
// shared-state`, `code-intel paired-keys`, ...). Adding a new detector is a
// registry edit only — no change here.
const ANALYZER_COMMANDS = Object.fromEntries(
  DETECTORS.map((d) => [d.id, { analyzer: d.module, summarize: d.summarize }]),
);

const USAGE = `Usage:
  code-intel impact          [paths...] [--since <ref>] [--baseline <path>] [--markdown|--json] [--pretty] [--exclude <path>]
                             [--only <ids>] [--skip <ids>] [--no-cache | --cache-stats] [--include-build-artifacts] [--include-test-context] [--world closed|open] [--all-findings]
  code-intel trace           (--storage <backend:key> | --event <channel> | --global <name>)
                             [paths...] [--format json|mermaid] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel shared-state    [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel shared-events   [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel shared-globals  [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel stale-captures  [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel paired-keys     [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel shape-drift     [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel duplicate-static-svg-id [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel proxied-globals [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]
  code-intel stateful-regex [paths...] [--pretty] [--exclude <path>] [--include-build-artifacts] [--include-test-context] [--world closed|open]

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
  proxied-globals Detect Proxy-replacement of browser platform globals
                  (window.history = new Proxy(...), window.fetch = new Proxy(...),
                  …). Per-site recall-first; no cross-file threshold.
  stateful-regex  Detect module-scope /g or /y regexes used with .test()/.exec()
                  (lastIndex carries across calls and silently flips results).
                  Per-declaration recall-first; intra-file v1.

Args:
  paths           One or more project roots. Defaults to "." if omitted.
                  Each path is treated as an independent project; findings are
                  grouped across projects so cross-repo coupling surfaces.

Options:
  --since <ref>   (impact only) git base ref to diff against. Resolves the set
                  of changed files; findings that touch them are sorted first
                  and marked; blast radius is computed.
  --baseline <path>
                  (impact only) Path to a prior impact --json output. When set,
                  computes a fingerprint-keyed diff and adds a 'diff' key to the
                  JSON output (new / resolved / unchanged finding arrays). In
                  markdown mode, prepends a diff summary section.
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
  --exclude <pat> Project-root-relative path or glob pattern to skip.
                  Repeatable. Literal paths still work (--exclude examples,
                  --exclude src/generated). Glob syntax: ** matches any
                  number of path segments, * matches a single segment,
                  ? matches one character. Common idioms:
                    --exclude '**/__tests__'    (prune test dirs anywhere)
                    --exclude '**/*.spec.*'     (prune spec files anywhere)
                    --exclude 'src/**'          (prune all of src/)
                  Hardcoded ignores (node_modules, dist, build, .git,
                  coverage, .next, .turbo, .cache) always apply on top and
                  cannot be overridden.
  --include-build-artifacts
                  Re-enable walking files that are classified as build
                  artifacts (*.min.js, files under vendor/vendors/bundle/
                  bundles/chunks directories, files whose first line exceeds
                  1000 characters). Default: off (artifacts are skipped).
  --include-test-context
                  Re-enable walking files that are classified as test context
                  (*.test.*, *.spec.*, jest.setup.*, vitest.config.*, files
                  inside __tests__/ or __mocks__/ at any depth, files under
                  top-level tests/ test/ e2e/ cypress/ playwright/). Default:
                  off (test-context files are skipped). See D21.
  --world closed|open
                  Assert the closure of the world \`code-intel\` is
                  scanning. Default \`open\`: producers/consumers may
                  live in code we did not scan (other repos, workers,
                  inline-script handlers); confidence reasons hedge
                  accordingly. \`closed\`: the paths given are the
                  complete world; orphan-side findings (writer-only,
                  listener-only) are tiered up and "may live elsewhere"
                  hedges are dropped from reason text. See D19.
  --only <ids>    (impact only) comma-separated detector ids to run; other
                  detectors are skipped entirely (not just filtered post-hoc).
                  Repeatable. Unknown ids fail fast.
  --skip <ids>    (impact only) comma-separated detector ids to skip. Applied
                  after --only if both are given. Repeatable. Unknown ids
                  fail fast.
                  Known ids: ${DETECTOR_IDS.join(', ')}.
  --no-cache      (impact only) disable the per-run AST cache. Each detector
                  reads and parses each file itself (pre-D14 behaviour).
                  Useful for benchmarking or as a safety escape hatch.
                  Mutually exclusive with --cache-stats.
  --all-findings  (impact only) Always show the detailed findings list in the
                  markdown report, even if --since reports 0 findings touching
                  the change set.
  --cache-stats   (impact only) print { size, hits, misses, readErrors,
                  parseErrors } of the per-run AST cache to stderr after
                  the run. Observability flag; does not change output
                  content. Mutually exclusive with --no-cache.
  -h, --help      Show this help.
`;

function parseCommonArgs(argv) {
  const args = { paths: [], pretty: false, help: false, exclude: [], includeBuildArtifacts: false, includeTestContext: false, closure: 'open' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') args.pretty = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--exclude') {
      const v = argv[++i];
      if (!v) throw new Error(`--exclude requires a value`);
      args.exclude.push(v);
    }
    else if (a === '--include-build-artifacts') args.includeBuildArtifacts = true;
    else if (a === '--include-test-context') args.includeTestContext = true;
    else if (a === '--world') {
      const v = argv[++i];
      if (v !== 'closed' && v !== 'open') {
        throw new Error(`--world must be 'closed' or 'open', got '${v ?? '<missing>'}'`);
      }
      args.closure = v;
    }
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else args.paths.push(a);
  }
  if (args.paths.length === 0) args.paths.push('.');
  return args;
}

// Split a --only / --skip value on commas, trim, drop empties. Allows
// both `--only a,b` (one flag) and `--only a --only b` (two flags, which
// we concatenate at the call site).
function splitIdList(v) {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseImpactArgs(argv) {
  const args = {
    paths: [],
    since: null,
    baseline: null,
    format: null, // 'markdown' | 'json' — decided below if null
    pretty: false,
    help: false,
    exclude: [],
    includeBuildArtifacts: false,
    includeTestContext: false,
    only: [],
    skip: [],
    noCache: false,
    cacheStats: false,
    closure: 'open',
    allFindings: false,
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
    else if (a === '--include-build-artifacts') args.includeBuildArtifacts = true;
    else if (a === '--include-test-context') args.includeTestContext = true;
    else if (a === '--baseline') {
      const v = argv[++i];
      if (!v) throw new Error(`--baseline requires a path to a prior impact --json output`);
      args.baseline = v;
    }
    else if (a === '--only') {
      const v = argv[++i];
      if (!v) throw new Error(`--only requires a value (comma-separated detector ids)`);
      args.only.push(...splitIdList(v));
    }
    else if (a === '--skip') {
      const v = argv[++i];
      if (!v) throw new Error(`--skip requires a value (comma-separated detector ids)`);
      args.skip.push(...splitIdList(v));
    }
    else if (a === '--no-cache') args.noCache = true;
    else if (a === '--cache-stats') args.cacheStats = true;
    else if (a === '--world') {
      const v = argv[++i];
      if (v !== 'closed' && v !== 'open') {
        throw new Error(`--world must be 'closed' or 'open', got '${v ?? '<missing>'}'`);
      }
      args.closure = v;
    }
    else if (a === '--all-findings') args.allFindings = true;
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else args.paths.push(a);
  }
  if (args.noCache && args.cacheStats) {
    throw new Error(`--no-cache and --cache-stats are mutually exclusive (stats are empty when the cache is disabled)`);
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
  // When --cache-stats is set, we construct the cache here so we can read
  // its stats after the run. Otherwise impact.analyzeProjects creates its
  // own internal cache (or skips it, under --no-cache).
  const astCache = args.cacheStats ? createAstCache() : undefined;
  const result = impact.analyzeProjects(args.paths, {
    since: args.since,
    exclude: args.exclude,
    includeBuildArtifacts: args.includeBuildArtifacts,
    includeTestContext: args.includeTestContext,
    only: args.only.length > 0 ? args.only : undefined,
    skip: args.skip.length > 0 ? args.skip : undefined,
    noCache: args.noCache || undefined,
    astCache,
    closure: args.closure,
  });

  if (args.baseline) {
    let baselineData;
    try {
      const raw = fs.readFileSync(args.baseline, 'utf8');
      baselineData = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`--baseline: could not read ${args.baseline}: ${e.message}\n`);
      return 2;
    }
    result.diff = impact.computeDiff(result.findings, baselineData.findings ?? []);
  }

  if (args.format === 'markdown') {
    process.stdout.write(renderMarkdown(result, { allFindings: args.allFindings }));
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
  if (astCache) {
    const c = astCache.stats();
    process.stderr.write(
      `cache: size=${c.size} hits=${c.hits} misses=${c.misses}`
        + ` readErrors=${c.readErrors} parseErrors=${c.parseErrors}\n`,
    );
  }
  process.stderr.write(
    `code-intel / impact${gitLine}: `
      + `${s.totalFindings} finding(s) — `
      + `${s.bySeverity.critical ?? 0} critical, `
      + `${s.bySeverity.warning ?? 0} warning, `
      + `${s.bySeverity.info ?? 0} info`
      + (s.findingsTouchingChange !== null ? ` (${s.findingsTouchingChange} touch change)` : '')
      + (s.blastRadius ? ` | blast radius: ${s.blastRadius.total}` : '')
      + (result.diff ? ` | diff: +${result.diff.new.length} -${result.diff.resolved.length}` : '')
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
    includeBuildArtifacts: false,
    includeTestContext: false,
    closure: 'open',
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
    else if (a === '--include-build-artifacts') args.includeBuildArtifacts = true;
    else if (a === '--include-test-context') args.includeTestContext = true;
    else if (a === '--world') {
      const v = argv[++i];
      if (v !== 'closed' && v !== 'open') {
        throw new Error(`--world must be 'closed' or 'open', got '${v ?? '<missing>'}'`);
      }
      args.closure = v;
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
      includeBuildArtifacts: args.includeBuildArtifacts,
      includeTestContext: args.includeTestContext,
    });
  } else if (args.target.kind === 'event') {
    result = trace.traceEvent(args.paths, args.target.name, { exclude: args.exclude, includeBuildArtifacts: args.includeBuildArtifacts, includeTestContext: args.includeTestContext });
  } else {
    result = trace.traceGlobal(args.paths, args.target.name, { exclude: args.exclude, includeBuildArtifacts: args.includeBuildArtifacts, includeTestContext: args.includeTestContext });
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
  const result = cmd.analyzer.analyzeProjects(args.paths, { exclude: args.exclude, includeBuildArtifacts: args.includeBuildArtifacts, includeTestContext: args.includeTestContext, closure: args.closure });
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
