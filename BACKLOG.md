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

Planned:
- [ ] `duplicate-static-svg-id` — hardcoded SVG IDs in multi-rendered components (see P6)
- [ ] `module-scope-handler` — module-scope fn passed by name to `addEventListener` inside a re-runnable setup (see P7)
- [ ] `proxied-platform-global` — `window.history = new Proxy(...)` and similar wholesale replacements of built-in globals (see P8)
- [ ] `BroadcastChannel` / `MessageChannel`
- [ ] Change-coupling from git history (co-changed files with no import edge)
- [ ] Shape-drift on shared storage keys (completes P4 — key agreement detected, shape mismatch not yet)
- [ ] Non-web storage: `chrome.storage.*`, React Native AsyncStorage, IndexedDB, cookies, URL params (see Q4)

## Infrastructure

- [ ] MCP server POC — expose `analyzeProjects` as an MCP tool (see Q7)
- [ ] Configuration file format (see Q3)
- [ ] Inline suppression comments (see Q5)
- [ ] Dynamic key constant-folding, same-file only (see Q8)
- [ ] Wrapper-module detection (see Q2)

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
- [ ] Confidence field on findings (see Q10)
- [ ] Blast-radius query ("what breaks if I change this file?")
- [ ] Run on a real multi-repo codebase — see what actually falls apart
