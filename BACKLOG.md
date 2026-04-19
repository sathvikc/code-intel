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
- [ ] `shape-drift` v2 — broaden channels (cookies, CustomEvent detail, URL params) and resolve cross-function / wrapper-module / constant-folded shapes so the SSR-inline-script opaque-writer case (P4) lights up
- [ ] `paired-keys` v2 — cross-cluster correlation: flag other writers that touch only one key of a known pair elsewhere in the codebase (v1 emits the intra-cluster finding only; see P10)
- [ ] Non-web storage: `chrome.storage.*`, React Native AsyncStorage, IndexedDB, cookies, URL params (see Q4)

## Infrastructure

- [ ] MCP server POC — expose `impact.analyzeProjects` as an MCP tool (see Q7)
- [ ] Configuration file format (see Q3)
- [ ] Inline suppression comments (see Q5)
- [x] Same-file string-literal constant folding across `shared-state`, `shared-events`, `paired-keys`, `shape-drift` — resolves Q8 / see D8
- [ ] Cross-file constant folding (imported string-literal constants, re-export chains, barrel files) — the v2 of the folding helper
- [ ] Wrapper-module detection (see Q2)
- [ ] Content-hash cache for AST parses (target <1s warm scan, per CODE-INTEL.md)
- [ ] Nx integration — `npx nx show projects --affected` overlay on blast radius
- [ ] Risk score (0–100) per finding and per report

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
- [ ] `trace` subcommand — per-symbol graph query (all readers/writers/dispatchers/listeners for a named storage key, event channel, or global); Tier 1 is reshape-only, Tier 2 adds declared-symbol resolution (see Q12)
- [ ] Run on a real multi-repo codebase — see what actually falls apart
- [ ] Plugin / rule-pack architecture — user-authored detection rules, per-project enable / disable, and framework-specific rule packs (e.g. "SPA with full-reload navigation: don't flag shared-state across pages"). Depends on config format (Q3) + inline-suppression syntax (Q5) + the self-improving suppression loop (Q9) as the three pieces of the same puzzle; this bullet is the synthesis that turns them from plumbing into a product shape.
- [ ] Framework context config — user-declared `rendering: ssr | ssg | spa | ssr-prerender` and `navigation: spa | full-reload` on each project, consumed by detectors to tier / filter findings. Primary near-term use case: let the SVG detector and shared-state detectors treat findings differently under different rendering / navigation models without auto-detecting the framework (see D10 for the rationale; implementation lives under Q3).
