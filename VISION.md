# code-intel — Project Vision

> **The static analyzer that finds the JS/TS production bugs your linter,
> your type checker, and your import graph don't see — packaged for an AI
> agent to reason about.**

This document is the north star. When a feature, PR, or roadmap item is proposed,
the question is always: *does this move us toward the vision, or away from it?*
Phases, milestones, and implementation details live in separate docs.

---

## The Problem

Real systems have two dependency graphs:

1. **The explicit graph** — imports, exports, types, calls. Every existing static
   analyzer (Knip, Biome, dependency-cruiser, ESLint, tsc) sees this graph well.
2. **The implicit graph** — state shared through `sessionStorage` / `localStorage`
   keys, `CustomEvent` channels, `window.*` globals, `BroadcastChannel`s,
   module-load-time reads of runtime values, module-level singletons mutated from
   multiple import sites, file pairs that always change together but have no
   import edge.

No open-source tool sees the implicit graph. Nor does any catch the adjacent
class of bugs where the cause is *visible in source but invisible to type
checkers and linters* — a value frozen at module load, a duplicated DOM ID in
a component rendered many times, a built-in global replaced by a Proxy that
swallows third-party writes, a module-scope handler reference that confuses
a production-only instrumentation wrapper. These are the bugs mature JS/TS
codebases lose time to — where senior engineers already know to look, and
where linters, type checkers, and AI agents are blind.

## What We're Building

A **local-first code intelligence tool** for JavaScript and TypeScript with two
layers:

### Layer 1 — The engine (our moat)

A catalogue of **bug-pattern detectors** built on the TypeScript compiler API.
Every detector corresponds to a real production bug — observed, post-mortem'd,
or remembered — tracked in [`PATTERNS.md`](./PATTERNS.md) as `P<N>`. The
catalogue grows every time a new pattern is shared.

Three categories cover what the engine finds today. The categories, like the
catalogue, are expected to grow:

**Cross-file implicit coupling (P1–P4).** State shared through storage keys,
event channels, globals, cookies, module singletons. Files talk to each other
without an import edge; no existing tool sees the link.

**Module-scope lifecycle bugs (P5, P6).** Values captured from dynamic sources
at module load and then frozen; DOM-scope identifiers duplicated across
repeated component instances. Visible in source; invisible to type checkers
and linters.

**Runtime bugs with a static signature (P7, P8).** Third-party wrappers,
production-only instrumentation, proxy-replaced platform globals. The bug
fires at runtime — often only in production — but the *smell* is visible in
source. Detection for these is recall-first and noisier (closer to how
SonarQube flags "code smells"), because the alternative is no detection at
all: these are bugs that *no existing tool* reports.

The engine ships with a unified `impact` command that runs every detector
in one pass and — given a git base ref via `--since` — filters / sorts
findings by what intersects the change set, plus computes the transitive
import-graph blast radius of the changed files. See `README.md` for usage
and the unified JSON schema (`meta` / `summary` / `findings` / `graph` /
`integrations`).

Orthogonal engine capabilities (planned): change-coupling from git history,
incremental cache for sub-second warm scans, richer blast-radius queries.

This is the code we own, the problem we uniquely solve, and the reason the
tool exists.

### Layer 2 — The orchestrator (completeness without scope creep)

A thin runner that shells out to the tools the ecosystem already trusts — Knip,
Biome, dependency-cruiser, ESLint — parses their JSON output, and merges
everything into one unified schema.

We do **not** re-implement dead-code, circular-deps, complexity, or lint rules.
Those problems are solved. We orchestrate and normalize so the user gets one
report, one CI step, one MCP surface.

```
code-intel
  ├─ engine:        shared-state, shared-events, shared-globals,        ← we own
  │                 stale-captures, (+ planned detectors per PATTERNS.md)
  ├─ orchestrator:  impact command → unified markdown / JSON report     ← we own
  ├─ import-graph:  blast radius from --since <ref>                     ← we own
  ├─ knip:          dead code                                           ← planned shell-out
  ├─ biome:         lint + complexity + security patterns               ← planned shell-out
  └─ depcruiser:    circular deps                                       ← planned shell-out
  ─────────────────────────────────────────────────────────────
  → unified JSON · markdown report · (MCP surface — planned)
```

If a sub-tool is missing, we degrade gracefully and tell the user what's skipped.

## Who This Is For

Two users, in priority order.

1. **AI coding agents** reasoning about a change in an unfamiliar codebase.
   They need "if I touch this file, what silently depends on it?" — and the
   import graph under-answers that question. An MCP-native tool that answers it
   precisely is a first-class agent capability.
2. **Senior engineers** in mature monorepos — PR review, refactors, incident
   forensics — where implicit coupling is where the real bugs live.

## Why This Wins Long-Term

- **Implicit coupling compounds with codebase age.** Every year a repo ages,
  the ratio of implicit-to-explicit dependencies grows. The tool gets more
  valuable over time.
- **AI agents are becoming the primary consumer of static analysis.** A tool
  designed from day one for machine reasoning (MCP-native, structured findings,
  queryable blast radius) beats tools that bolt JSON onto a human-first CLI.
- **Orchestration is a moat for enterprises.** Air-gapped and regulated
  customers can't use SonarQube Cloud or CodeScene. A local-first orchestrator
  wrapping *already-audited* open-source tools is dramatically easier to clear
  through security review than any single-vendor rewrite.

## Where This Sits In The Ecosystem

The positioning frame, stated positively: **code-intel runs alongside
the tools a team already has — not instead of them.** Every tool in
the adjacent space covers a different layer of the problem. A grounded
comparison of each, with direct citations from each tool's own
documentation, lives in [`COMPETITIVE_LANDSCAPE.md`](./COMPETITIVE_LANDSCAPE.md);
the one-paragraph summary is:

- Linters (ESLint, Biome, Oxlint, SonarJS) check code quality
  **within a file**.
- The type checker (TypeScript) checks types **within import graphs**,
  and erases that information at every serialization boundary.
- Query-based static analyzers (CodeQL, Semgrep) ship **engines**
  and curated query packs that concentrate on **security**
  vulnerabilities and data-flow attacks.
- AI PR reviewers (Greptile, CodeRabbit, Cursor review) index the
  whole codebase and emit human-language review comments — and
  (self-admitted in their own marketing) miss cross-file bugs and
  need a deterministic backstop.
- Structural tools (Knip, dependency-cruiser, Madge, Skott) detect
  dead code and import-graph cycles.
- Knowledge-graph tools (graphify, CodeGraph, GraphGen4Code) build
  generic codebase graphs for LLM context and navigation.
- Runtime-validation libraries (Zod, Valibot, io-ts, ArkType) are a
  **prevention** layer — they require the codebase to adopt them at
  every boundary, and they detect nothing about code that does not.

**Three characteristics, taken together, describe a slot no tool in
that list fully occupies**: (1) a named, incident-driven catalogue of
production-bug patterns, (2) cross-file / cross-serialization-boundary
/ runtime-context-aware detection, (3) review-shaped output in an
open-source, local-first package with no paid tier. That is the slot
code-intel is built to fill.

The positioning stance, operationalized:

- **Phase 1 — gap-filler, connective tissue.** Primary framing.
  code-intel fills a slot the ecosystem has left empty; it runs
  alongside what a team already uses. The findings don't overlap,
  because every other tool in the space explicitly targets a
  different layer.
- **Phase 2 — border-touching where we are demonstrably better.**
  As the catalogue thickens, selectively overlap with Semgrep Pro
  on infrastructure (we are free + local + OSS vs paid + SaaS) and
  with AI reviewers on verification (we are deterministic + curated;
  they are sampling-based and admit cross-file bug misses). We do
  not touch borders with linters or the type checker — they win
  their categories cleanly and there is no wedge.

## The North Star Test

> *Could an AI agent, given only this tool's output, safely refactor a file it
> has never seen — in a way that a senior engineer familiar with the codebase
> would endorse?*

Every feature we ship should move that answer from **"no"** toward **"yes."**
Features that don't serve that question get cut.

## Non-Goals (What This Tool Is Not)

- **Not a dead-code / circular-deps / complexity tool.** Knip, dependency-cruiser,
  and Biome already do this well. We orchestrate them, we don't re-implement them.
- **Not a lint replacement.** Biome and ESLint win that category.
- **Not a SaaS on day one.** Local-first CLI plus MCP server earns trust first.
  A cloud dashboard (history, trends, team views) is a later question, not a
  starting position.
- **Not all-in-one-by-rewriting.** All-in-one by *integrating*.
- **Not a runtime profiler, type inferencer for untyped JS, or human code review
  replacement.** Judgment, design intent, and bugs with no visible source
  signature stay with humans. (Note: runtime bugs that *do* have a static
  signature — proxied globals, stable-reference handlers, etc. — are in
  scope as best-effort code smells.)

## Scope Guardrails

Every feature request gets run through this gate:

1. **Is it a pre-production bug pattern detector?** → belongs in the engine.
   (Today that spans implicit coupling, module-scope lifecycle bugs, and
   runtime-with-static-signature code smells. Tomorrow, whatever the next
   entry in `PATTERNS.md` looks like.)
2. **Is it commodity analysis an existing tool already does well?** → orchestrate
   it, don't rebuild.
3. **Does it make AI-agent consumption better (MCP, schema, blast radius queries)?**
   → first-class priority.
4. **None of the above?** → probably out of scope.

## Design Principles

- **Recall over precision — find it at whatever tier we can.** If we can
  detect a pattern perfectly, we do. If we can only identify it partially,
  we still surface it. If we can only flag "you changed a shared channel —
  go validate it touches the other sites," that is still worth shipping.
  Missing a real bug is worse than surfacing a false one: false positives
  cost minutes of a reviewer's time; missed bugs cost production incidents.
  Consumers (human or AI) are the filter; we are the net.
- **Zero-config by default, fully configurable when needed.** `code-intel`
  works on any JS/TS repo with no setup. Every behavior is also exposed as a
  config key and a CLI flag, so power users and AI agents can invoke it
  explicitly instead of relying on inferred defaults.
- **Graceful degradation over hard dependencies.** Git missing, a sub-tool not
  installed, partial type info — skip cleanly, tell the user, keep going.
- **AI-native output contract.** The JSON schema is a real API. It's stable,
  versioned, documented, and designed for machine reasoning first.
- **Honest precision (planned).** A benchmark corpus with recall/precision
  numbers on our novel analyzers is intended but not yet built. Until it
  exists, accuracy claims are explicitly flagged as heuristic, not measured.
- **Small dependency surface, pragmatic not dogmatic.** Today: only the
  TypeScript compiler API and Node built-ins. This keeps installation fast
  and the tool easy to clear through enterprise security review, where
  some teams run on tight allow-lists. If a popular, well-maintained
  dependency later makes a capability materially better, adding it is a
  decision on the merits — not a rule we break.

---

*Phases and roadmap live elsewhere. This doc is what we're building and why.
Edit it only when the vision itself changes.*
