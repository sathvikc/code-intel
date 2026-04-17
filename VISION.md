# code-intel — Project Vision

> **The static analyzer that finds the coupling your import graph can't see —
> and hands it to an AI agent in a form it can reason about.**

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

Orthogonal engine capabilities (planned): change-coupling from git history,
blast-radius queries across the implicit graph.

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
  ├─ engine:       shared-state, stale-captures, change-coupling   ← we own
  ├─ knip:         dead code                                       ← shelled out
  ├─ biome:        lint + complexity + security patterns           ← shelled out
  └─ depcruiser:   circular deps                                   ← shelled out
  ─────────────────────────────────────────────────────────────
  → unified JSON · unified terminal report · single MCP surface
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

- **Zero-config by default, fully configurable when needed.** `code-intel`
  works on any JS/TS repo with no setup. Every behavior is also exposed as a
  config key and a CLI flag, so power users and AI agents can invoke it
  explicitly instead of relying on inferred defaults.
- **Graceful degradation over hard dependencies.** Git missing, a sub-tool not
  installed, partial type info — skip cleanly, tell the user, keep going.
- **AI-native output contract.** The JSON schema is a real API. It's stable,
  versioned, documented, and designed for machine reasoning first.
- **Honest precision.** We publish a benchmark corpus with recall/precision
  numbers on our novel analyzers. No accuracy claims without evidence.
- **Small dependency surface.** TypeScript compiler API, node built-ins, and
  whatever sub-tools the user already has. That's it.

---

*Phases and roadmap live elsewhere. This doc is what we're building and why.
Edit it only when the vision itself changes.*
