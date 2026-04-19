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

# Skip specific directories under each project root (repeatable). Useful
# when the repo root contains examples/, docs/, e2e/, or a sibling
# package's build output you don't want in the report.
code-intel impact . --exclude examples --exclude docs --markdown
```

The `impact` command is designed to answer *"what did this change put at risk?"* — not *"list every pattern in this repo."* It runs every detector in one pass, annotates each finding with `touchesChange` when a change set is given, sorts change-touching findings first, and includes the transitive import-graph blast radius of the changed files. Every finding also carries a severity (blast-radius heuristic), a confidence level (`high` / `medium` / `low`) with a one-paragraph justification, and a stable fingerprint for dedup and tracking across runs.

`--exclude <path>` works on `impact` and on every per-analyzer subcommand. Paths are literal, directory-level, and resolved against each project root; the hardcoded ignore set (`node_modules`, `dist`, `build`, `.git`, `coverage`, `.next`, `.turbo`, `.cache`) always applies on top and cannot be re-included. Globs are deferred to the forthcoming config format (see D11 for the scope, Q3 for the wider config track).

Per-analyzer commands remain available when you want one signal in isolation.

## Per-symbol trace

`impact` answers *"what did this change put at risk?"* across the whole repo. `trace` answers the narrower agent-friendly question *"what else touches this specific symbol before I rename / refactor / delete it?"*

```bash
# Every reader / writer / remover of a localStorage key, as a graph.
code-intel trace --storage localStorage:app.session path/to/project

# Every dispatcher / listener of a CustomEvent channel.
code-intel trace --event profile:changed path/to/project

# Every declarer / assigner of a classic-script global.
code-intel trace --global parseCookie path/to/project [more-paths...]

# Mermaid output for pasting into a doc or PR description.
code-intel trace --storage localStorage:app.session path/to/project --format mermaid
```

Output is a star-topology graph: one target hub node, one occurrence node per site, one edge per occurrence labelled with the relation (`reads-from` / `writes-to` / `dispatches-to` / `listens-to` / `declares` / etc.). `trace` is a pure reshape over the existing `shared-state` / `shared-events` / `shared-globals` detectors — every occurrence node maps 1:1 to a site those analyzers already surface. See D12 for the schema and edge-kind map.

---

## What it finds today

Seven detectors ship today. Each corresponds to a pattern in [`PATTERNS.md`](./PATTERNS.md) (the `P<N>` references below); each has tests under `tests/` and a reproduction in `examples/`.

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

### `paired-keys` — co-located `setItem` clusters that travel together (P10)

Detects function bodies where ≥2 distinct literal storage keys are written within a few statements of each other — a paired-write cluster whose invariant ("these keys must be written together or readers see a stale cache") lives only inside the function, not in any type or storage contract. Any other writer elsewhere that touches only one of the keys silently breaks that invariant. v1 emits the cluster; the v2 on the backlog will correlate across clusters to flag the offending partial writers directly.

```bash
code-intel paired-keys path/to/project [more-paths...] --pretty
```

### `shape-drift` — write-shape vs read-shape across a shared storage channel (P9)

Finds `(storage, key)` channels where one file writes `JSON.stringify({ a, b })` and another file reads `.c` (or destructures `{ c, d }`) on the same key — a shape mismatch that TypeScript cannot see across the `JSON.stringify` / `JSON.parse` boundary. v1 covers `localStorage` / `sessionStorage` with literal object shapes on both sides; later slices broaden to cookies, CustomEvent `detail`, and URL params.

```bash
code-intel shape-drift path/to/project [more-paths...] --pretty
```

### `duplicate-static-svg-id` — hard-coded SVG ids that actually render more than once (P6)

Finds JSX components that declare a static `id` on a JSX element (`<linearGradient id="icon-fx">`) AND reference that same id in the same file via `url(#icon-fx)` or `xlinkHref="#icon-fx"` — AND the analyzer can demonstrate the component actually renders more than once in the scanned code. "Actually renders more than once" means one of four observable conditions today: the declaration sits inside a `.map` / `.forEach` / `.flatMap` / `Array.from(…)` callback in the same file; an importer renders the component inside such an iterator (one-hop caller-graph walk); the same id literal is declared multiple times inside one component; or the same id literal is declared in two separate components anywhere in the scan. A lone `<Icon />` with a static id and no visible multi-render produces no finding — the analyzer describes what is, not what might become (see D10). The fix is still the same: derive the id per instance (`React.useId`, `nanoid`, or a prop) and thread it through every declaration and reference.

```bash
code-intel duplicate-static-svg-id path/to/project [more-paths...] --pretty
```

### Folded keys across all of the above

Every detector that extracts a string key or channel also resolves same-file `const K = 'literal'` (and never-reassigned `let`) to the underlying literal before grouping. So `const APP_SESSION_KEY = 'app.session'; localStorage.setItem(APP_SESSION_KEY, v);` pairs correctly with an inline-literal `localStorage.getItem('app.session')` elsewhere in the codebase; the occurrence gains a `foldedFrom: 'APP_SESSION_KEY'` hint so the reviewer can see the path the analyzer took. Cross-file imports are a later slice.

## What's coming

Two more detectors are already sketched in `PATTERNS.md`, with backlog entries in `BACKLOG.md`:

| Detector | Pattern | What it catches |
|---|---|---|
| `module-scope-handler` | P7 | Module-scope function references passed by name to `addEventListener` — the shape that production-only instrumentation wrappers can cache and silently stop firing. |
| `proxied-platform-global` | P8 | Wholesale replacement of a built-in browser global (`window.history = new Proxy(...)`, `window.fetch = new Proxy(...)`) — a code smell because third-party writes can vanish through the proxy. |

A parallel **built-output scanning mode** is also planned: parse the HTML emitted by your SSR / SSG build and flag manifest bugs in the shipped artifacts — duplicate ids within a document, duplicate `<meta>` tags, duplicated script srcs, hydration-mismatch shapes. Complements the source analyzers by catching the "this is wrong in what we ship right now" case directly from the rendered output, reaching bugs the source detectors can't observe — e.g. two components that happen to render on the same page under framework-specific routing conventions that don't show up as an explicit import edge.

Existing detectors also have v2 slices planned: `shape-drift` to broaden beyond storage (cookies, `CustomEvent.detail`, URL params); `paired-keys` to correlate across clusters; constant folding to cross file boundaries.

Infrastructure and orchestration items tracked in `BACKLOG.md` include: MCP server, configuration file, inline suppression syntax, change-coupling from git history, Nx-affected overlay, content-hash cache for sub-second warm scans, risk score per finding, and shell-outs to Knip / Biome / dependency-cruiser.

The catalogue grows whenever a new production bug is shared. It's built to grow; that's the point.

## Output

The `impact` command emits a unified report with top-level fields `meta`, `summary`, `findings`, `graph`, and `integrations`. Each finding carries `id`, `fingerprint` (stable 16-hex hash of the finding's identity), `kind`, `severity` (blast-radius heuristic — how bad this would be IF it's a bug), `confidence` (`high` / `medium` / `low` — how sure we are it IS a bug), `confidenceReason` (one-paragraph justification a reviewer can read in five seconds), `message`, `detail` (analyzer-specific payload), `relatedFiles`, and `touchesChange` (when a change set was given via `--since`). The `graph.blastRadius[]` section lists every file that transitively imports a changed file, with `{ file, project, depth }`.

Per-analyzer commands (`shared-state`, `shared-events`, `shared-globals`, `stale-captures`, `paired-keys`, `shape-drift`) emit their native shape: a `findings[]` array where each finding has `kind`, a key / channel / name field, and `occurrences[]` with project, file, line, column, op, snippet, `detectedVia` (the exact syntactic pattern matched), and optionally `foldedFrom` (the identifier name a key or channel was resolved through, when same-file constant folding fired).

The schema is pre-1.0. Designed for AI-agent consumption first, humans second, and will stabilize as the catalogue grows.

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
node src/cli.js shared-state             examples/app-a examples/app-b --pretty
node src/cli.js shared-events            examples/app-a examples/app-b --pretty
node src/cli.js shared-globals           examples/app-a examples/app-b --pretty
node src/cli.js stale-captures           examples/app-a --pretty
node src/cli.js paired-keys              examples/app-a --pretty
node src/cli.js shape-drift              examples/app-a --pretty
node src/cli.js duplicate-static-svg-id  examples/app-a --pretty
```

Each of those fixtures reproduces a real production bug. See [`examples/README.md`](./examples/README.md) for the story behind each one.

## What it is not

- **Not a linter.** Biome and ESLint already win that category. `code-intel` looks for patterns where the source is syntactically fine but the *contract between files* is broken, or where a value is *captured at the wrong moment*, or where a *runtime-only actor* (third-party wrapper, production instrumentation) changes the meaning of otherwise-correct code.
- **Not a dead-code, circular-dependency, or complexity tool.** Knip, dependency-cruiser, and the Biome/sonar ecosystem already do this well. A future orchestrator layer will shell out to those; we won't re-implement them.
- **Not a type checker.** TypeScript already does that. `code-intel` starts where the type checker stops — at the string-literal contracts, the dynamic reads, and the cross-bundle coupling that no type system sees.
- **Not a replacement for human review.** Findings are leads. Some are ship-blocking bugs; some are code smells a reviewer will legitimately dismiss. Recall over precision is deliberate — missing a real bug is worse than surfacing a false one, because false positives cost minutes and missed bugs cost incidents.

## How this fits alongside your existing tools

code-intel is **not** a replacement for anything. Each category below owns its slot; `code-intel` fills a different one.

- **Linters** (ESLint, Biome, Oxlint) — check code quality within a file.
- **Type checkers** (TypeScript) — check types within import graphs, and erase that information at every serialization boundary.
- **Query-based analyzers** (CodeQL, Semgrep) — ship engines whose curated query packs concentrate on security vulnerabilities and data-flow attacks.
- **AI PR reviewers** (Greptile, CodeRabbit) — index the whole codebase and emit human-language review comments; they explicitly admit in their own marketing that they miss cross-file bugs and need a deterministic backstop.
- **Structural tools** (Knip, dependency-cruiser, Madge) — find dead code and import-graph cycles.
- **Runtime validators** (Zod, Valibot) — prevention layer that requires the codebase to adopt them at every boundary.

None of these catalogue the specific, named production-bug patterns that bite JS / TS apps at the implicit contracts between files:

- String-literal storage keys
- `CustomEvent` channels
- Classic-script globals
- Module-scope captures of dynamic sources
- Paired-key clusters
- Serialized shape drift across `JSON.parse`

That is the slot this tool is built for. Run it alongside what you already have; the findings don't overlap with any of the above.

A grounded comparison of each tool in the list, with direct quotes from their own documentation, lives in [`COMPETITIVE_LANDSCAPE.md`](./COMPETITIVE_LANDSCAPE.md).

## Status

Early. Pre-1.0. The `impact` orchestrator — import-graph blast radius, `--since <ref>` diff-awareness, confidence and fingerprint per finding — runs every detector in one pass and is dogfooded against fixtures that reproduce real incidents. The JSON schema is a working contract, not a stable one. There's no configuration file, no suppression syntax, no MCP server yet — those are backlog items, not promises.

This README is a **snapshot**. It will be rewritten as the catalogue grows and the scope becomes clearer — consider it supersedable in the same sense that [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) entries can be superseded by later ones. Git history is the timeline; this file is always *now*.

## Read more

- [`VISION.md`](./VISION.md) — what we're building and why. The north star doc.
- [`PATTERNS.md`](./PATTERNS.md) — append-only log of bug patterns, `P<N>`. The raw material of the catalogue.
- [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) — resolved product-facing decisions, `D<N>`.
- [`OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md) — unresolved product-facing questions, `Q<N>`.
- [`BACKLOG.md`](./BACKLOG.md) — planned detectors, infrastructure items, exploratory ideas.
- [`COMPETITIVE_LANDSCAPE.md`](./COMPETITIVE_LANDSCAPE.md) — grounded comparison against every adjacent tool, with direct citations from each tool's own docs. The proof layer for the "how is this different from X?" question.
- [`examples/README.md`](./examples/README.md) — dogfood fixture apps reproducing real incidents.
