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
- [x] `shape-drift` v2 (CustomEvent.detail channel) — `event-shape-drift` finding kind; write-side detail extraction from `new CustomEvent(ch, { detail: {...} })`; read-side detail shape from inline handlers (plain param, nested destructure, binding alias); alias-follow on dispatch; same literal-threshold emission rule as storage (see D17)
- [ ] `shape-drift` v2 (remaining channels) — cookies, URL params; same detection pattern; BACKLOG until Q4 (non-web storage) shapes the backend taxonomy
- [ ] `paired-keys` v2 — cross-cluster correlation: flag other writers that touch only one key of a known pair elsewhere in the codebase (v1 emits the intra-cluster finding only; see P10)
- [ ] Non-web storage: `chrome.storage.*`, React Native AsyncStorage, IndexedDB, cookies, URL params (see Q4)
- [ ] `hydration-unsafe-read` — component render path reads a browser-only global, time-varying primitive, or client-only state in a file reachable from a server-rendered entry (P11; **unvalidated** — surfaced via web research, not a lived incident; see P11 Source for evidence trail; detector likely depends on framework-context config)
- [x] `shared-events` v2 — alias-follow for `dispatchEvent(var)` paired with same-scope `const X = new CustomEvent('lit', ...)` (P22; shared alias infrastructure with `shape-drift` v2)
- [ ] `shared-events` v2 — orphan-channel sub-finding (writer-only / listener-only channels, info severity)
- [x] `event-bridge` — listener whose handler re-dispatches the same channel to a different host; emits a new `event-bridge` finding kind (P23); v1: inline handlers only, same-channel only, see Q15/Q16/Q17
- [ ] `element-scoped-listener` — low-confidence listeners on non-`window` hosts, candidate-linked to same-channel window listeners (P24; ships after `event-bridge`)
- [x] `structural-drift` — exported const object literal shape vs. importer access-shape disagreement (P12); v1: direct exports only, top-level keys only; see Q18 for parameter-passing case
- [x] `lifecycle-cleanup-drift` — missing teardown for addEventListener/setInterval/setTimeout/observer/WebSocket/EventSource/AbortController in same function scope (P13); three kinds: `missing-teardown`, `abort-never-called`, `handler-identity-mismatch`; v1 intra-function only
- [ ] `nullable-callable-binding` — same-scope `let X = <callable>` that is nulled in one path and called unguarded in another (e.g. a teardown / dispose / cleanup callback that fires after the binding has been reset); see P25. **Hold until a second real-world instance is observed before building** (D2 + D10 discipline — one instance documents a pattern; two instances justifies a detector).
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
- [x] Glob-aware `--exclude` — supports `**/__tests__` / `**/*.spec.*` / `src/**` (in-house tiny glob matcher in `src/glob.js`, zero deps)
- [x] Compare mode (`--baseline <prior.json>`) — fingerprint-keyed set-difference between two runs; emits `diff.new` / `diff.resolved` / `diff.unchanged`. Stable-fingerprint primitive shipped earlier (see D-series fingerprint entries) made this a small extension on top of `computeDiff` in `impact.js`.
- [x] Framework-file parsing — `.astro` (frontmatter + inline `<script>` blocks, line-preserved) — see D16
- [ ] Framework-file parsing v2 — generalise the `.astro` extractor to `.vue` (`<script setup>`) and `.svelte` (`<script>`) in the shared framework-file module (see D16 "Scope of v1")
- [ ] Populate `graph` field in `impact --json` output (currently only rendered in markdown); MCP-consumer prep
- [ ] `--since` soft warning on huge diffs (cap changed-files list in markdown; warn when >50)
- [ ] `trace --layout star|flow|grouped` — writers / hub / readers split with file-group subgraphs; default `grouped` for N > 5
- [ ] Test-context-aware confidence scoring — weight production occurrences higher than test occurrences; depends on glob `--exclude` above or framework-context config (see Q3)
- [x] `patternFingerprint` field on every finding (location-free pattern identity, parallel to existing `fingerprint`) — see D18. Schema-additive; foundation for two-axis suppression (Q5/Q9) and `--baseline --by pattern` ratcheting.
- [x] `--world closed|open` flag — user-asserted closure axis; drops "may live in another repo" hedges and bumps orphan-side confidence tiers (writer-only, listener-only, single-dispatcher) under closed-world; CLI-only in v1, config-file integration deferred to Q3 — see D19
- [ ] `--baseline --by pattern` mode — ratchet diff at `patternFingerprint` granularity (treat coupling moves between files as `unchanged`); piggy-backs on D18 once shipped
- [ ] Triage-collapse rendering — markdown / future MCP consumers group findings by `patternFingerprint` and emit one row per shape with a count; piggy-backs on D18

## Detector noise reduction (dogfood-driven)

Systemic false-positive categories surfaced by running `impact` against a real multi-app monorepo. Each item below either filters out non-production code at the right layer or fixes a threshold/wording bug in an existing detector. Higher leverage than building any net-new detector because they reduce noise across **every** detector at once. All examples are generic; the underlying patterns reproduce on any monorepo that ships test setups, vendor bundles, framework defaults, or single-file event channels.

- [x] **Skip minified / bundled files at file-discovery time.** When a project commits production bundles into a publicly-served path (`public/`, `static/`, `assets/`, etc.), the file walker currently parses them. Result: findings emitted with 5-digit line numbers and `op` columns containing stringified native function tokens — un-actionable. Cheap content-based heuristic in `src/project.js` (filename hints + first-line-length sample) classifies these out at the walk layer; benefits every detector at once. Highest single ROI of the noise-reduction items per the dogfood report.
- [ ] **Default-exclude test-context files from cross-file thresholds.** Test setup files (`jest.setup.*`, `setup-jest.*`, `vitest.config.*`) and spec files (`*.spec.*`, `*.test.*`, `__tests__/`) routinely stub browser globals (`window.IntersectionObserver = ...`), declare per-test sessionStorage values, and `delete globalThis.X` in cleanup blocks. Each isolated test process is its own world; counting two test files that stub the same global as a "production load-order coupling" is wrong. Apply via either (a) a shared `isTestContext(filePath)` helper consulted by every detector before recording an occurrence, or (b) per-occurrence `context: 'test' | 'production' | 'build-artifact' | 'unknown'` metadata + filtering on the cross-file threshold step. Option (b) preserves visibility for users who explicitly want test-only collisions surfaced (separate low-severity kind).
- [x] **Filter `op === 'remove'` out of the cross-file collision threshold for `shared-state-globals`.** A `delete globalThis.X` inside an `afterEach` cleanup is not a competing declarer; current code counts it toward the ≥2-file threshold and the natural-language message says "declared by N files". Two fixes: (a) only `'declare' | 'assign'` ops contribute to the file-distinct count; (b) update the message template to reflect the actual op mix (`"...declared by N files (plus M delete sites)"`). Same shape applies to `shared-state-web-storage` for `removeItem` once we look.
- [ ] **Apply the same `op === 'remove'` filter to `shared-state-web-storage`** for `removeItem` occurrences. Same shape as the globals fix; surfaced for completeness once the globals tests land.
- [ ] **Apply ≥2-file threshold to static `shared-event-channel` findings** (matches `shared-state-globals` precedent) — see D20. Dynamic findings unchanged (per-site by construction; separate question).
- [ ] **`event-orphan` finding kind** for single-file dispatch-only / listen-only signals dropped by D20 — surface them under their own kind/severity tier instead of diluting `shared-event-channel`. Useful in open-world where the missing side may exist but be unscanned; less interesting under D19 closed-world. Defer until a real-codebase example justifies the kind.
- [ ] **Allowlist for framework-owned / language-internal storage keys.** Keys such as `__next` (Next.js router), `NEXT_LOCALE` (Next.js i18n), `__proto__` (JS prototype slot), and other framework-defined names are not user-actionable couplings — the user did not choose them and cannot rename them. Add a built-in allowlist in `shared-state-web-storage.js`, opt-out via a future config field. Start small; grow incrementally as new framework keys are observed.
- [ ] **Op column formatting for dynamic expressions.** When the resolved op text is the result of `Function.prototype.toString` on a native function, the markdown column reads `function toString() { [native code] }`. Replace with `<dynamic>` or a short hashed excerpt so report rows stay scan-able.
- [ ] **Default-quiet detail section under `--since` when no findings touch the change set.** When `impact --since <ref>` reports `0 findings touch the change set`, the full detailed listing is noise to the PR reviewer. Default to a one-line banner; gate the detail listing behind `--all-findings` / `--verbose`.

## Detector recall / accuracy follow-ups (dogfood-driven)

Narrower than the noise items above — each fixes a specific recall gap inside an already-shipped detector.

- [ ] **Drop Astro frontmatter from the extracted JS/TS payload.** The framework-file extractor currently lifts both the `---` frontmatter (server-side, per-request SSR) and the inline `<script>` blocks (client-side browser code) into a single payload. Runtime-state detectors then treat frontmatter `const X = await serverFn()` as a browser module-scope binding — false positive. Until the first SSR-semantic detector lands, the safe move is to blank the frontmatter bytes (treat them like markup or `<style>`). Trivial and high-ROI on Astro projects (~13% FP rate reduction observed).
- [ ] **Single-hop return-value chain follow for `shape-drift`.** Today the detector follows same-scope variable aliases (`const raw = getItem(K); JSON.parse(raw)`). Real codebases often wrap the read in a helper function and read fields on the wrapper's return value (`function readCache() { ... return JSON.parse(...) } ... const data = readCache(); data.field`). Extend `extractReadShape` so when a binding's initializer is a same-file function call, resolve to the local function body and merge the caller's `x.k` accesses into the union read-shape. One hop only; no inter-procedural fixpoint.
- [ ] **Virtualize Astro `<script>` blocks as separate compilation units.** Multiple `<script>` blocks in a single `.astro` file are bundled per-block by Astro (each non-`is:inline` script is its own hoisted module; `is:inline` scripts are independent per-render). The current extractor merges all blocks into one TS payload, so they share module scope from the parser's view — inaccurate. Schedule after the frontmatter blank-out lands and after more dogfood evidence shapes the requirements.

## Code health / maintainability

Items surfaced by an internal audit pass. Listed here so the surface stays discoverable without growing a separate doc file:

- [ ] Consolidate duplicated `isFunctionLike` helper (3 copies: `fold-string-literals.js`, `shape-drift.js`, `paired-keys.js`) — export once, import three times
- [ ] Consolidate duplicated `isAssignmentOperator` helper (3 copies) — and **fix recall gap** in `shared-state-globals.js` which is missing 4 operators (`**=`, `<<=`, `>>=`, `>>>=`); compound-assignment writes on those operators are silently not flagged today
- [ ] Consolidate duplicated `collectReassignedNames` (2 copies: `fold-string-literals.js`, `cross-file-constants.js`); the comment claiming an import-cycle blocker in `cross-file-constants.js` is stale — there is no cycle
- [ ] Consolidate duplicated `storageNameOf` helper (3 copies: `shared-state-web-storage.js`, `shape-drift.js`, `paired-keys.js`)
- [ ] Drop the `g` flag from module-level `URL_REF_PATTERN` in `duplicate-static-svg-id.js` — the live `extractReferencedIds` already creates a fresh RegExp per call; the constant's `g` flag is misleading and a foot-gun for any future caller that uses it directly
- [ ] Replace `execSync` in `gitChangedFiles` with an async `execFile` + make `analyzeProjects` async; lifts the event-loop block on large `--since` diffs; orthogonal to the security fix already shipped in this branch
- [ ] Reduce `fs.existsSync` + `fs.statSync` calls in `import-graph.js#firstExistingCandidate` (currently up to 18 syscalls per import specifier) to a single `try { statSync } catch` per candidate
- [ ] Normalise path separators between `impact.js#projectIdFor` (`path.sep`) and `report-markdown.js` (hardcoded `/`) for Windows compatibility
- [ ] Tighten `walkSourceFiles` hidden-dir handling — currently only `.git` is pruned among dotfile dirs, others (`.vscode`, `.idea`, `.husky`) are walked but yield no source files (extension filter catches them)
- [ ] Fix `scripts/version-bump.js` main-guard for Windows — the current `import.meta.url === "file://" + process.argv[1]` shape always evaluates false on Windows because of forward-vs-back-slash mismatch; use `pathToFileURL` from `node:url` instead

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
