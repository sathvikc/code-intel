# Backlog

Lightweight list of things we want to build, try, or investigate — but not
right now. One line per item. Moves to code (plus a `D<N>` in
`DESIGN_DECISIONS.md` if a design decision was made) when picked up.

Not a spec. Details belong in the commit or in `DESIGN_DECISIONS.md` when
the item is picked up — not here. If an item requires a design decision to
unblock, it usually has a matching `Q<N>` in `OPEN_QUESTIONS.md`; this file
links to it with `(see Q<N>)`.

## Analyzers

- [ ] `shared-event-channel` (CustomEvent / addEventListener / dispatchEvent) — **next up**
- [ ] `BroadcastChannel` / `MessageChannel`
- [ ] Change-coupling from git history (co-changed files with no import edge)
- [ ] Global namespace pollution (`window.APP = …`, `globalThis.*`)
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
- [ ] `README.md` — user-facing, when we have something runnable to show
- [ ] `examples/` — real-world dogfood outputs

## Ideas / exploratory

- [ ] Self-improving suppression loop (see Q9)
- [ ] Confidence field on findings (see Q10)
- [ ] Blast-radius query ("what breaks if I change this file?")
- [ ] Run on a real multi-repo codebase — see what actually falls apart
