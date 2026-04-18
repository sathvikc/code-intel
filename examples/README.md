# Examples

Two stable example projects (`app-a` and `app-b`) that host real-world
implicit-coupling patterns, drawn from production bugs. We don't grow a
new top-level folder per scenario; new patterns get added as files inside
`app-a/src/<feature>/` or `app-b/src/<feature>/`, often with a matching
counterpart in the other app to exercise cross-project detection.

## Apps

- `app-a/` — primary application. Hosts most scenarios; coupling often
  points *from* here.
- `app-b/` — secondary application sharing the same runtime environment.
  Exists specifically so we can exercise cross-project detection.

## Scenarios currently in the fixtures

| Scenario | Location | Analyzer (status) |
|---|---|---|
| `app.session` in `localStorage` (login writes, api-client reads) | `app-a/src/auth/` | `shared-state` ✓ |
| `profile:changed` CustomEvent (app-a dispatches, app-b listens) | `app-a/src/events/`, `app-b/src/events/` | `shared-events` ✓ |
| Native DOM events (must-not-emit) — `resize` / `scroll` / `popstate` listeners are browser wire-up, not coupling | `app-a/src/events/native-events.ts` | `shared-events` ✓ (no finding) |
| SSR-injected vs CSR-cached feature flags — same `sessionStorage['app.runtime-config']` key, two writers, shape mismatch | `app-a/src/flags/` | `shared-state` ✓ (detects coupling; reviewer/AI spots the shape mismatch) |
| Classic-script collision — both apps define the same top-level `function parseCookie(...)` in a .js script, later load overwrites earlier | `app-a/src/cookies/`, `app-b/src/cookies/` | `shared-globals` ✓ |
| Self-assign (must-not-emit) — one file with multiple `window.X = …` writes to the same global; intra-file, not a collision | `app-a/src/globals/` | `shared-globals` ✓ (no finding) |
| Stale module-scope capture — `const accountTier = getAccountTier()` at module scope, value frozen at import time | `app-a/src/account/` | `stale-captures` ✓ |

A ✓ means the analyzer already detects the pattern (run the command in
the next section to see it). "Planned" means the pattern is a fixture
but the analyzer is on the way.

## Running the analyzers

From the repo root:

```bash
# Web storage coupling (single-project scan of app-a)
node src/cli.js shared-state examples/app-a --pretty

# Cross-project event coupling (both apps as separate projects)
node src/cli.js shared-events examples/app-a examples/app-b --pretty

# Cross-script global-binding collisions (parseCookie in both apps)
node src/cli.js shared-globals examples/app-a examples/app-b --pretty

# Stale module-scope captures (accountTier frozen at import time)
node src/cli.js stale-captures examples/app-a --pretty
```

## Adding a new scenario

1. Strip the pattern to the smallest reproduction. Use fictional names;
   never ship real production code.
2. Pick a feature slug (`auth`, `events`, `flags`, `cookies`, `account`…)
   and put files in `app-a/src/<slug>/` and/or `app-b/src/<slug>/`.
3. Add a row to the scenario table above. If the analyzer doesn't yet
   detect the pattern, that's a lead — file it in `BACKLOG.md` or
   `OPEN_QUESTIONS.md`, then fix the analyzer.

The rule: **noise is better than missing** (per `DESIGN_DECISIONS.md` D2).
Fixtures exercise recall; if an analyzer walks these examples and emits a
finding, that's success, even if a human might dismiss it.
