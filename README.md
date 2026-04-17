# code-intel

> The JavaScript / TypeScript bugs that make it to production — found before they do.

Your linter is happy. Your types compile. Your tests pass. It ships.

Then, in production, something subtle breaks:

- A cookie flips mid-session but the module-scope `const accountTier = getAccountTier()` captured the old value at import time and never re-reads it.
- An SVG gradient renders as a solid grey because a navigation component was pre-rendered many times on one page, every copy has the same hardcoded `id="icon-fx"`, and browsers resolve `url(#icon-fx)` to whichever element they saw first.
- A `sessionStorage` key that your SSR inline script wrote in one shape gets read by your CSR loader expecting a different shape, two months after the deploy that introduced the drift.
- A click handler silently stops firing in **production only**, because a third-party analytics wrapper cached the handler's reference and quietly decided it had already been registered.
- A per-route UI feature replaces `window.history` with a `Proxy` to intercept `pushState` — ships fine — then breaks a page a month later when a third-party library tries to attach its own keys to `window.history` and those writes disappear into the proxy.

These are the bugs **code-intel** is built to find. Every pattern it detects started as a real incident — logged in [`PATTERNS.md`](./PATTERNS.md), then turned into a detector. No theoretical taxonomy, no best-practice posturing. Just: the things that actually shipped and broke.

No CI setup. No cloud dashboard. No daemon. Point it at one or more project directories; get a JSON or markdown report of the coupling, captures, collisions, and code smells that every other tool you have is blind to.

---

## The primary entry point

```bash
# Scan one or more projects; aggregate all detectors into one report.
code-intel impact path/to/project [more-paths...] --markdown

# Same, but scoped to a PR / branch: findings that touch changed files are
# surfaced first, and the import-graph blast radius of those files is
# computed and included.
code-intel impact path/to/project --since main --markdown

# Emit the unified JSON schema for an AI agent / CI pipeline to consume.
code-intel impact path/to/project --since main --json
```

The `impact` command is designed to answer *"what did this change put at risk?"* — not *"list every pattern in this repo."* It runs all four detectors below in one pass, annotates each finding with `touchesChange` when a change set is given, sorts change-touching findings first, and includes the transitive import-graph blast radius of the changed files.

Per-analyzer commands remain available when you want one signal in isolation.

---

## What it finds today

Four detectors ship as of this README. Each corresponds to a pattern in [`PATTERNS.md`](./PATTERNS.md) (the `P<N>` references below); each has tests under `tests/` and a reproduction in `examples/`.

### `shared-state` — storage-key coupling (P1, partial P4)

Finds `localStorage` / `sessionStorage` keys where two or more files (or two or more projects in a monorepo) touch the same literal key string. The "implicit contract by string literal" class: no import edge connects them, no type checker sees the link, the serialized shape drifts silently after a deploy.

```bash
code-intel shared-state path/to/project [more-paths...] --pretty
```

### `shared-events` — `CustomEvent` channel coupling (P2)

Finds `window` / `globalThis` `dispatchEvent(new CustomEvent(...))` and `addEventListener(...)` sites that share the same event name literal. Shows up in micro-frontend and multi-bundle setups where event channels became the de-facto bus because nothing else crossed the bundle boundary cleanly.

```bash
code-intel shared-events path/to/app [more-paths...] --pretty
```

### `shared-globals` — classic-script global-binding collisions (P3)

Flags top-level names (functions, vars, classes) declared in non-module `.js` files that collide across files, plus explicit `window.X = ...` writes. Catches the "two teams independently defined the same top-level helper function, deploy order decides whose implementation wins" class of bug.

```bash
code-intel shared-globals path/to/project [more-paths...] --pretty
```

### `stale-captures` — stale module-scope captures (P5)

Finds module-scope `const / let / var` bindings whose initializer reads a dynamic source (cookie, `sessionStorage` / `localStorage`, `navigator.*`, `fetch`, DOM queries) either directly or via a wrapper function. Cross-file wrapper detection is automatic — the analyzer walks every function body in every file to identify which functions touch dynamic APIs, then looks for module-scope captures that call them. Catches the "session-scoped value frozen at import time" class of bug.

```bash
code-intel stale-captures path/to/project --pretty
```

## What's coming

Four more detectors are already sketched in `PATTERNS.md`, with backlog entries in `BACKLOG.md`:

| Detector | Pattern | What it catches |
|---|---|---|
| `duplicate-static-svg-id` | P6 | Hardcoded IDs inside inline SVG `<defs>` in components that render many times — gradient/filter/mask corruption from DOM-global ID resolution. |
| `module-scope-handler` | P7 | Module-scope function references passed by name to `addEventListener` — the shape that production-only instrumentation wrappers can cache and silently stop firing. |
| `proxied-platform-global` | P8 | Wholesale replacement of a built-in browser global (`window.history = new Proxy(...)`, `window.fetch = new Proxy(...)`) — a code smell because third-party writes can vanish through the proxy. |
| Shape-drift on shared storage keys | completes P4 | Same storage key written from multiple places with structurally different right-hand sides — the SSR/CSR shape-mismatch case. |

The catalogue grows whenever a new production bug is dumped into `PATTERNS.md`. It's built to grow; that's the point.

## Output

The `impact` command emits a unified report with top-level fields `meta`, `summary`, `findings`, `graph`, and `integrations`. Each finding carries `id`, `kind`, `severity` (heuristic, not measured), `message`, `detail` (analyzer-specific payload), `relatedFiles`, and `touchesChange` (when a change set was given via `--since`). The `graph.blastRadius[]` section lists every file that transitively imports a changed file, with `{ file, project, depth }`.

Per-analyzer commands (`shared-state`, `shared-events`, `shared-globals`, `stale-captures`) emit their native shape: a `findings[]` array where each finding has `kind`, a key/channel/name field, and `occurrences[]` with project, file, line, column, op, snippet, and `detectedVia` (the exact syntactic pattern matched — `bracket-access`, `indexed-access`, `classic-script-function`, `direct-api`, `indirect-wrapper`, etc.).

The schema is pre-1.0. Designed for AI-agent consumption first, humans second, and will stabilize as the catalogue grows — see `BACKLOG.md` → `SCHEMA.md`.

## Running it

Requirements: **Node 22+**. No database, no daemon, no external services.

```bash
# Install dependencies
npm install

# Run the full test suite
npm test

# Run a detector against one or more project roots
node src/cli.js <subcommand> <path> [more-paths...] [--pretty]

# Or, once linked / published:
code-intel <subcommand> <path> [more-paths...] [--pretty]
```

Each path is treated as an independent project. Findings are grouped across all of them — so *cross-project* coupling in a monorepo surfaces the same way in-project coupling does. This is a deliberate choice: most real codebases that feel this pain are multi-app, not single-package.

Try it against the consolidated example apps in the repo:

```bash
# Unified impact report — primary entry point, markdown output
node src/cli.js impact          examples/app-a examples/app-b --markdown

# Individual detectors — JSON, one signal at a time
node src/cli.js shared-state    examples/app-a examples/app-b --pretty
node src/cli.js shared-events   examples/app-a examples/app-b --pretty
node src/cli.js shared-globals  examples/app-a examples/app-b --pretty
node src/cli.js stale-captures  examples/app-a --pretty
```

Each of those fixtures reproduces a real production bug. See [`examples/README.md`](./examples/README.md) for the story behind each one.

## What it is not

- **Not a linter.** Biome and ESLint already win that category. `code-intel` looks for patterns where the source is syntactically fine but the *contract between files* is broken, or where a value is *captured at the wrong moment*, or where a *runtime-only actor* (third-party wrapper, production instrumentation) changes the meaning of otherwise-correct code.
- **Not a dead-code, circular-dependency, or complexity tool.** Knip, dependency-cruiser, and the Biome/sonar ecosystem already do this well. A future orchestrator layer will shell out to those; we won't re-implement them.
- **Not a type checker.** TypeScript already does that. `code-intel` starts where the type checker stops — at the string-literal contracts, the dynamic reads, and the cross-bundle coupling that no type system sees.
- **Not a replacement for human review.** Findings are leads. Some are ship-blocking bugs; some are code smells a reviewer will legitimately dismiss. Recall over precision is deliberate — missing a real bug is worse than surfacing a false one, because false positives cost minutes and missed bugs cost incidents.

## Status

Early. Pre-1.0. Four detectors plus the `impact` orchestrator (with import-graph blast radius and `--since <ref>` diff-awareness) tested and dogfooded against fixtures that reproduce real incidents. Nine patterns logged, four more detectors to build. The JSON schema is a working contract, not a stable one. There's no configuration file, no suppression syntax, no MCP server yet — those are backlog items, not promises.

This README is a **snapshot** of the project as of version `0.8.x`. It will be rewritten as the catalogue grows and the scope becomes clearer — consider it supersedable in the same sense that [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) entries can be superseded by later ones. Git history is the timeline; this file is always *now*.

## Read more

- [`VISION.md`](./VISION.md) — what we're building and why. The north star doc.
- [`PATTERNS.md`](./PATTERNS.md) — append-only log of bug patterns, `P<N>`. The raw material of the catalogue.
- [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) — resolved product-facing decisions, `D<N>`.
- [`OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md) — unresolved product-facing questions, `Q<N>`.
- [`BACKLOG.md`](./BACKLOG.md) — planned detectors, infrastructure items, exploratory ideas.
- [`examples/README.md`](./examples/README.md) — dogfood fixture apps reproducing real incidents.
