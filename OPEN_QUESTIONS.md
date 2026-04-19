# Open Questions

Unresolved, product-facing questions for `code-intel`. Items here are the
backlog of design decisions we know we'll eventually need to make, logged
so we don't re-debate them from scratch later.

## Scope

Same scope as [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md): things that
affect what the tool does, detects, outputs, or exposes. Not internal
tooling.

## Format

Each entry is numbered (`Q<N>`). When an open question is resolved, it
moves to `DESIGN_DECISIONS.md` with a new `D<N>` number (we do not reuse
numbers — the Q slot is left empty in history).

```
## Q<N> — <Title>

**Why it matters:** <what consequence a wrong/absent answer has>
**Working assumption:** <what we're doing in the meantime, if anything>
**Needs:** <info or experience required before we can decide>
```

---

## Q1 — Aliased storage bindings

`const s = window.localStorage; s.setItem('app.session', v);`

**Why it matters:** Real code aliases the storage object into a local
variable. The current analyzer only resolves `localStorage`, `sessionStorage`,
`window.localStorage`, `globalThis.localStorage`. It misses all aliased
forms — silent blind spot.

**Working assumption:** Unsupported in v0.1. Users who care can avoid the
alias or wait. Log as a known limitation in `SCHEMA.md` when that ships.

**Needs:** Decide whether to do a simple intra-file scan for
`const X = localStorage` bindings (cheap, covers most cases) or commit to
full type-flow analysis (violates D5, large cost). Probably the cheap
version first.

---

## Q2 — Wrapper modules

`import { storage } from './utils'; storage.set('app.session', v);`

**Why it matters:** Many codebases wrap storage behind a thin utility
module (`storage.ts`, `cache.ts`, `persist.ts`). The analyzer sees method
calls on a regular object and has no way to know they're storage ops.

**Working assumption:** Unsupported in v0.1. The user's wrapper will show
up to the analyzer as ordinary code. The reviewer (AI) may connect the
dots manually.

**Needs:** Configuration surface (see Q3) that lets a project declare
"this function name wraps `localStorage.setItem`." Without user-supplied
hints, reliable detection requires type-flow analysis.

---

## Q3 — Configuration format

**Why it matters:** Every project has different needs — what to
include/exclude, which wrappers to recognize, which findings to suppress,
what analyzers to run. Without config, the tool is either too noisy or
can't adapt.

**Working assumption:** No configuration exists yet. CLI takes positional
project paths and nothing else. Add configuration as specific demands
surface (not speculatively).

**Needs:** Shape decisions. Candidate scope:
- Include/exclude globs.
- Per-analyzer enable/disable and options.
- Wrapper declarations (for Q2).
- Suppression rules, category-level and specific (see D4, Q5).
- Custom storage provider declarations (for Q4).
- Output format preferences.

File location candidates: `code-intel.config.json`, `code-intel.config.js`,
or a key in `package.json`. Merge strategy for multi-project.

---

## Q4 — Non-web storage providers

**Why it matters:** Implicit coupling lives in many storage backends, not
just Web Storage. React Native `AsyncStorage`, `chrome.storage.*` (browser
extensions), `IndexedDB`, cookies, URL query/hash params, environment
variables, and HTTP headers all carry the same class of bug.

**Working assumption:** v0.1 handles `localStorage` and `sessionStorage`
only. Everything else is a known gap.

**Needs:** Decide whether each backend is a separate analyzer (separate
`analyzer` id, separate finding `kind`) or whether they fold into
`shared-storage-key` with a `backend` field. Also: which backends are worth
prioritizing based on real codebases we'd run against.

---

## Q5 — Inline suppression comments

`// code-intel-ignore-next-line shared-storage-key`

**Why it matters:** Some noise is per-site, not per-category — a
reviewer's "yes this is actually fine here" signal that config-level rules
can't express cleanly. ESLint-style inline suppressions solve this.

**Working assumption:** No inline suppression in v0.1. All suppression is
external.

**Needs:** Decide: inline comments, config-only, or both with clear
precedence. Decide comment syntax. Decide whether suppressions persist
across schema versions (they probably should, so we need stable
suppression identifiers not tied to schema shape).

---

## Q6 — Cross-repo git change-coupling

**Why it matters:** Vision promises "change-coupling between files with no
import edge (from git history)." Within one repo this is tractable. Across
repos (multi-project mode), histories are separate and unlinked.

**Working assumption:** Not implemented. Single-repo change-coupling isn't
implemented either yet.

**Needs:** Decide whether multi-repo correlation is in scope at all (it
may require a shared registry, conventions about monorepo vs
multi-repo, or explicit mappings from the user). This may also be a
question for a future version of the vision, not the tool itself.

---

## Q7 — MCP surface shape

**Why it matters:** Vision commits to a first-class MCP server. The shape
of that surface determines how well AI agents can query us.

**Working assumption:** No MCP server yet. CLI + JSON only.

**Needs:** Decide query primitives. Candidates:
- `analyze(projects)` — run everything, return result.
- `whoReadsKey(storage, key)` / `whoWritesKey(storage, key)`.
- `impactOf(file:line)` — blast radius query.
- `findCrossProjectCouplings()`.
Also decide: one MCP tool per analyzer, or one unified `query` tool.

---

## Q8 — Dynamic key constant-folding

**Resolved by D8.** Same-file `const` / never-reassigned `let` with a
bare string-literal or no-substitution template initializer is now
folded across every detector that extracts a string key or channel.
Cross-file / concatenated / substituted-template cases are explicitly
deferred — see D8 for the exact scope and the rejected alternatives.

---

## Q9 — Where does the self-improving suppression loop live?

**Why it matters:** The ambition (per the recall-over-precision principle)
is that an AI reviewer generates suppression rules from review outcomes,
making each run more focused than the last. That loop is a system that
consumes our output and produces config.

**Working assumption:** Not scoped yet. Assumed to be a separate component
or consumer, not part of `code-intel` itself.

**Needs:** Decide whether the loop's rule format is defined by `code-intel`
(as part of its config schema) or by the consumer. Decide whether the loop
lives in this repo at all.

---

## Q10 — Confidence field on findings

**Why it matters:** Recall-first means some findings are stronger than
others. A reviewer might want to prioritize by confidence. A structured
field makes that easy.

**Working assumption:** No explicit confidence field. `detectedVia` +
`dynamic` + `snippet` are the signals a reviewer uses to judge.

**Needs:** Decide whether the implicit signals are enough, or whether
we should add an explicit `confidence: "high" | "medium" | "low"` (or
numeric 0–1). If we add it, decide how analyzers produce it without
guessing.

---

## Q11 — Third-party pub/sub libraries

`import mitt from 'mitt'; const bus = mitt(); bus.emit('profile:changed'); bus.on('profile:changed', …);`

**Why it matters:** The `shared-event-channel` analyzer detects native
`window.dispatchEvent` / `addEventListener` coupling, but many codebases
route events through third-party buses (`mitt`, `nanoevents`,
`EventEmitter`, `RxJS` subjects, framework-specific event systems like
Redux actions or Vue's `$emit`). Missing these means silent blind spots on
a large share of real implicit event coupling.

**Working assumption:** v1 of `shared-event-channel` detects only native
`window` / `globalThis` event APIs. Third-party buses are not detected.
The reviewer sees `bus.emit('x')` as an ordinary method call with no
special meaning.

**Needs:** Config-driven wrapper declarations — very similar to Q2 (storage
wrappers). A project declares "function `X.emit` is a dispatch; function
`X.on` is a listen; first string arg is the channel name." Without that
declaration, reliable detection requires type-flow analysis (violates D5).
Probably resolves together with Q2 and Q3 (config format).

---

## Q12 — Graph / trace API for a named symbol

`code-intel trace --storage localStorage:app.session <roots>` →
every reader, writer, and remover of that key across all projects,
shaped as a graph an AI agent (or a human) can consume directly.

**Why it matters:** The detectors already compute what amounts to a
per-symbol graph — every reader / writer of a storage key, every
dispatcher / listener of an event channel, every declarer / assigner of
a global name — but that information is only reachable by running the
full `impact` report and filtering the resulting findings by `id`. A
first-class "give me the graph of X" query would:

- Serve AI agents that need to reason about a specific symbol they're
  about to modify ("what else touches `app.session` before I rename it?").
- Serve humans auditing a single storage key / event channel before a
  refactor without having to parse a 40-finding report.
- Fit the planned MCP surface (Q7 already lists `whoReadsKey(storage, key)`
  / `whoWritesKey(storage, key)` / `impactOf(file:line)` as candidate
  primitives — this is the CLI manifestation of the same API).

**Working assumption:** No `trace` subcommand. Users who want a
per-symbol view run `impact --markdown` and visually filter by symbol
id. Tolerable for humans; awkward for agents.

**Needs:** Three separable tiers; decide how far the first shipped
version reaches.

- **Tier 1 — literal-target trace (≈1 day of work).** Subcommands
  `trace --storage <storage:key>`, `trace --event <channel>`,
  `trace --global <name>`, `trace --paired-cluster "k1,k2"`. Reshapes
  existing detector output into a graph of nodes (sites with
  `file:line:column`, `op`, `snippet`) and edges (read-from, writes-to,
  dispatches, listens, captures). No new detection; pure presentation
  on top of the analyzers we already ship. Covers the common agent-query
  shapes.

- **Tier 2 — declared-symbol trace (≈1 week of work).** `trace --symbol <name>`
  for module-scope identifiers (functions, exported constants, etc.).
  Requires a symbol-resolution pass using the TS compiler API's
  `TypeChecker` / symbol table. Handles literal-name calls and
  re-exports reliably; method dispatch (`obj.foo()`) is best-effort
  without full type inference, same caveat as Q2 and Q11. Opens the
  door to "find all call sites of function X across projects," which
  is a natural companion to the import-graph blast radius.

- **Tier 3 — not feasible statically.** Runtime happens-before
  ordering across async callbacks, microtasks, event handlers, or
  load-order-dependent scripts. Fundamentally not a syntactic
  property. Approximation possible (intra-file lexical order, pair
  dispatchers with listeners) but the exact "X runs before Y" answer
  needs a runtime trace (DevTools timeline, profiler). Orthogonal tool;
  explicitly out of scope.

Design questions within the decision:

- **Output format.** JSON graph `{ target, nodes, edges }` is the
  minimum. Mermaid / DOT formatters for visual consumption are cheap
  additions — ship one or all via `--format`? (Probably `json` default,
  `mermaid` additive.)
- **Subcommand vs flag on `impact`.** Should `trace` be a peer
  subcommand of `impact`, or should `impact --trace <target>` reuse the
  same runner? Peer subcommand is cleaner for MCP; flag is cheaper to
  ship first and can always split later.
- **Symbol scope for Tier 2.** Module-scope variables and functions are
  clear. Class methods, enum members, type aliases — in scope or out?
  Start narrow (module-scope only), expand on demand.
- **Alignment with Q7 (MCP surface).** The CLI `trace` subcommand and
  the MCP `whoReadsKey` / `whoWritesKey` tools answer the same
  question. Their shapes should stay in sync; decide whether the
  schema lives in the CLI surface, the MCP surface, or a shared one.

---

## Q13 — `stale-module-capture` finding language: "will be stale" vs "module-scope capture"

**Why it matters:** D10 pins the rule that detectors describe what is,
not what might become. The `stale-module-capture` detector currently
emits findings whose confidence-reason paragraph uses language like
"the stale value will be returned" — a prediction about a specific
runtime scenario (SPA / SSR client / worker). The underlying fact
the detector observes — "module-scope binding captures a dynamic
source at import time" — is descriptive and correct under D10; only
the *explanation* has prediction-flavored wording.

**Working assumption:** The detector stays as-is. The prediction
wording in the confidence-reason paragraph is borderline, not
outright wrong — the stale value literally will be returned once the
captured source's state changes in a runtime where modules persist.
The finding's headline message and schema are descriptive already.

**Needs:** A pass over the confidence-reason text to separate the
observation ("module-scope capture of X") from the runtime context
("in SPAs / workers / SSR this means Y") so readers can distinguish
the fact from the forecast. Low priority — deferred until either a
dogfood review surfaces noise on this detector, or the framework-
context config from the D10 / Q3 track lands and we can say "in this
project `navigation=full-reload`, so this finding is informational
only" structurally.

---

## Q14 — User-configurable directory excludes

**Resolved by D11.** `--exclude <path>` is now a repeatable CLI flag
on `impact` and every per-analyzer subcommand. Each path is resolved
project-root-relative; the walker prunes the subtree. `IGNORED_DIRS`
stays hardcoded on top (user cannot re-include `node_modules`).
Literal paths only in v1 — glob support is deferred to the Q3
config-format track. Exposed programmatically as `opts.exclude` on
every analyzer's `analyzeProjects` so downstream consumers (the
planned MCP tool Q7, the planned `trace` subcommand Q12) can use the
same knob. See D11 for the full scope, alternatives considered, and
reasoning.
