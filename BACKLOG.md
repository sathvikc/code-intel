# Backlog

Lightweight list of things we want to build, try, or investigate — but not
right now. One line per item. Moves to code (plus a `D<N>` in
`DESIGN_DECISIONS.md` if a design decision was made) when picked up.

Not a spec. Details belong in the commit or in `DESIGN_DECISIONS.md` when
the item is picked up — not here. If an item requires a design decision to
unblock, it usually has a matching `Q<N>` in `OPEN_QUESTIONS.md`; this file
links to it with `(see Q<N>)`.

## Analyzers

Shipped (also listed for cross-reference with `PATTERNS.md`):
- [x] `shared-state` — web storage key coupling (covers P1, partial P4)
- [x] `shared-events` — CustomEvent / addEventListener / dispatchEvent (P2)
- [x] `shared-globals` — classic-script / `window.*` collisions (P3)
- [x] `stale-captures` — stale module-scope capture of dynamic sources (P5)
- [x] `paired-keys` — co-located `setItem` cluster in one function body (P10)
- [x] `shape-drift` v1 — storage channel; literal-literal write/read shape disagreement on a shared key (addresses P9 for the storage case; catches the literal side of P4)
- [x] `duplicate-static-svg-id` — static SVG ids with in-file `url(#id)` / `xlinkHref="#id"` anchors, emitted only when actual multi-render is demonstrable: in-file loop, caller-loop via the import graph, same-component duplicate, or cross-component duplicate (P6 / see D10 supersedes D9)
- [x] `impact` — unified orchestrator: runs all detectors, adds `--since <ref>` diff-awareness, blast-radius via import graph, markdown + JSON reporters
- [x] import-graph — AST-based reverse import graph + BFS blast-radius traversal

Planned:
- [ ] Built-output scanning mode — parse `dist/**/*.html` and flag manifest duplicate ids, duplicate meta tags, duplicated script srcs, etc. (complements `duplicate-static-svg-id` source mode; catches what's actually shipped after SSR/SSG)
- [ ] `module-scope-handler` — module-scope fn passed by name to `addEventListener` inside a re-runnable setup (see P7)
- [ ] `proxied-platform-global` — `window.history = new Proxy(...)` and similar wholesale replacements of built-in globals (see P8)
- [ ] `BroadcastChannel` / `MessageChannel`
- [ ] Change-coupling from git history (co-changed files with no import edge)
- [ ] `shape-drift` v2 — broaden channels (cookies, CustomEvent detail, URL params), follow single-hop alias chains on reads (`const raw = storage.getItem(K); JSON.parse(raw)`), and resolve cross-function / wrapper-module / constant-folded shapes so the SSR-inline-script opaque-writer case (P4) lights up
- [ ] `paired-keys` v2 — cross-cluster correlation: flag other writers that touch only one key of a known pair elsewhere in the codebase (v1 emits the intra-cluster finding only; see P10)
- [ ] Non-web storage: `chrome.storage.*`, React Native AsyncStorage, IndexedDB, cookies, URL params (see Q4)
- [ ] `hydration-unsafe-read` — component render path reads a browser-only global, time-varying primitive, or client-only state in a file reachable from a server-rendered entry (P11; **unvalidated** — surfaced via web research, not a lived incident; see P11 Source for evidence trail; detector likely depends on framework-context config)
- [ ] `shared-events` v2 — alias-follow for `dispatchEvent(var)` paired with same-scope `const X = new CustomEvent('lit', ...)` (P22; shared alias infrastructure with `shape-drift` v2)
- [ ] `shared-events` v2 — orphan-channel sub-finding (writer-only / listener-only channels, info severity)
- [ ] `event-bridge` — listener whose handler re-dispatches the same channel to a different host; emits a new `bridge` occurrence kind (P23; depends on `shared-events` v2 alias-follow)
- [ ] `element-scoped-listener` — low-confidence listeners on non-`window` hosts, candidate-linked to same-channel window listeners (P24; ships after `event-bridge`)
- [ ] `structural-drift` — loose-typed cross-file object property drift without a serialization boundary (P12; reuses `shape-drift` AST machinery)
- [ ] `lifecycle-cleanup-drift` — missing `removeEventListener` / `clearInterval` / observer `.disconnect()` / `AbortController.abort()` in paired register/teardown sites (P13)
- [ ] `side-effect-at-import` — module-top-level writes / fetches / timers / DOM mutations (P14; reuses `stale-captures` walker)
- [ ] `shared-request-state` — mutable module-scope state reachable from request-handler entry points; SSR multi-tenancy leak (P15; depends on framework-context config / Q3)
- [ ] `discriminated-union-drift` — string-literal union extended without updating exhaustive switch/if consumers (P16; feasibility of syntactic-only resolution still open)
- [ ] `stateful-shared-regex` — module/class-scope `/g` or `/y` regex used with `.test()` / `.exec()` across ≥2 call sites (P17)
- [ ] `env-var-drift` — `process.env.*` / `import.meta.env.*` references vs `.env.example` / `zod` / `envsafe` schema declarations (P19)
- [ ] `storage-clear-cascade` — `localStorage.clear()` / `sessionStorage.clear()` that would wipe keys owned by other files (P20; piggybacks on `shared-state`)
- [ ] `lost-this-callback` — method reference passed as a callback whose body reads `this` without bind/arrow (P21)
- [ ] `stale-captures` catalogue extension — browser-only APIs (`navigator.*`, `matchMedia`, `IntersectionObserver`, `indexedDB`, etc.) with critical-tier escalation when reached from an SSR entry (P18; depends on framework-context config / Q3)

## Infrastructure

- [ ] MCP server POC — expose `impact.analyzeProjects` as an MCP tool (see Q7)
- [ ] Configuration file format (see Q3)
- [ ] Inline suppression comments (see Q5)
- [x] Same-file string-literal constant folding across `shared-state`, `shared-events`, `paired-keys`, `shape-drift` — resolves Q8 / see D8
- [x] Cross-file constant folding (imported string-literal constants, re-export chains, barrel files) — see D15
- [ ] Cross-file constant folding v2.5 (namespace imports `NS.K`, object-literal exports read by property, CommonJS `require('./k').X`, computed / concatenated / substituted-template exports, dynamic imports) — see D15 "Out of scope"
- [ ] Wrapper-module detection (see Q2)
- [x] Per-run AST cache shared across detectors + `import-graph` (~45% wall-time reduction on self-scan) — see D14
- [ ] Cross-run content-hash AST cache on disk (watch-mode / CI warm-start; orthogonal to D14)
- [ ] Nx integration — `npx nx show projects --affected` overlay on blast radius
- [ ] Risk score (0–100) per finding and per report
- [ ] Glob-aware `--exclude` — support `**/__tests__` / `**/*.spec.*` patterns (currently literal-path only)
- [ ] Compare mode (`--baseline <prior.json>`) — fingerprint-keyed set-difference between two runs; emits `diff.new` / `diff.resolved` / `diff.unchanged`
- [ ] Framework-file parsing — `.astro` (frontmatter + inline `<script>` blocks, line-preserved); generalise to `.vue` / `.svelte` in a shared framework-file extractor
- [ ] Populate `graph` field in `impact --json` output (currently only rendered in markdown); MCP-consumer prep
- [ ] `--since` soft warning on huge diffs (cap changed-files list in markdown; warn when >50)
- [ ] `trace --layout star|flow|grouped` — writers / hub / readers split with file-group subgraphs; default `grouped` for N > 5
- [ ] Test-context-aware confidence scoring — weight production occurrences higher than test occurrences; depends on glob `--exclude` above or framework-context config (see Q3)

## Orchestration (commodity tools)

- [ ] Knip integration (dead code)
- [ ] dependency-cruiser integration (circular deps)
- [ ] Biome integration (lint, complexity)

## Docs

- [ ] `SCHEMA.md` — once ≥2 analyzers exist and the shape is observed, not guessed
- [x] `README.md` — snapshot; will be rewritten as catalogue grows
- [ ] `examples/` — real-world dogfood outputs beyond the synthetic fixtures

## Ideas / exploratory

- [ ] Self-improving suppression loop (see Q9)
- [x] Confidence field on findings (see Q10) — shipped (`confidence` + `confidenceReason` on every finding)
- [ ] Blast-radius query ("what breaks if I change this file?")
- [x] `trace` subcommand — per-symbol graph query, Tier 1 (reshape-only, `--storage` / `--event` / `--global`, JSON + Mermaid output); shipped (see D12). Tier 1.5 (`--paired-cluster`) and Tier 2 (`--symbol <name>`, needs `TypeChecker`) still open under Q12.
- [x] Detector registry (`src/detectors/index.js`) + `impact --only <ids>` / `--skip <ids>` — shipped (see D13). Adding a new detector is now a one-line registry edit; plugin architecture below has its attach point.
- [ ] Run on a real multi-repo codebase — see what actually falls apart
- [ ] Plugin / rule-pack architecture — user-authored detection rules, per-project enable / disable, and framework-specific rule packs (e.g. "SPA with full-reload navigation: don't flag shared-state across pages"). Depends on config format (Q3) + inline-suppression syntax (Q5) + the self-improving suppression loop (Q9) as the three pieces of the same puzzle; this bullet is the synthesis that turns them from plumbing into a product shape. Registry landing (D13) gave it a clean attach point.
- [ ] Framework context config — user-declared `rendering: ssr | ssg | spa | ssr-prerender` and `navigation: spa | full-reload` on each project, consumed by detectors to tier / filter findings. Primary near-term use case: let the SVG detector and shared-state detectors treat findings differently under different rendering / navigation models without auto-detecting the framework (see D10 for the rationale; implementation lives under Q3).
