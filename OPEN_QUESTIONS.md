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

**Resolved by D8 (same-file) + D15 (cross-file).** Same-file `const`
/ never-reassigned `let` with a bare string-literal or
no-substitution template initializer folds across every detector
that extracts a string key or channel (D8). D15 extends this to
imported constants — named and default imports, re-export chains,
barrel files, star re-exports — via a per-run index threaded through
the AST cache. Still deferred (v2.5 on BACKLOG): namespace imports,
object-literal exports read by property, CommonJS, dynamic imports,
computed / concatenated / substituted-template exports. See D15
"Out of scope" for the full list and the reasoning.

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

**Tier 1 resolved by D12.** `code-intel trace` is a peer subcommand
of `impact` with three target flags: `--storage <backend:key>`,
`--event <channel>`, `--global <name>`. Output is a star-topology
graph (`{ target, nodes, edges }`) — JSON by default, Mermaid
additive via `--format mermaid`. Every occurrence node maps 1:1 to an
occurrence already emitted by `shared-state` / `shared-events` /
`shared-globals`; tier 1 is pure reshape, no new detection. See D12
for the shape, the edge-kind map, and the alignment with Q7 (MCP)
and the planned paired-cluster / symbol-level tiers.

**Tiers 2 and 3 remain open** — tracked below so the next increment
has a clear drop-in point.

- **Tier 1.5 — `--paired-cluster "k1,k2"` (small follow-on).**
  Reconciles `paired-keys` findings (which already shape as function-
  scope clusters) into the trace graph: the target becomes the
  cluster name, occurrence nodes are the individual setItem calls,
  and a second edge kind (`siblings-in-cluster`) ties them. Small
  because the cluster data is already per-function; just another
  reshape.

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

**Still-open design questions for tier 2:**

- **Symbol scope.** Module-scope variables and functions are clear.
  Class methods, enum members, type aliases — in scope or out? Start
  narrow (module-scope only), expand on demand.
- **Alignment with Q7 (MCP surface).** The CLI `trace` shape
  established by D12 is the shared schema; the MCP tool layer
  (`whoReadsKey` etc.) will wrap the same `trace.traceStorage /
  traceEvent / traceGlobal` functions rather than re-derive graphs.

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

---

## Q15 — `event-bridge` v2: named-function handlers

v1 only catches `addEventListener(ch, <inline arrow/fn>)`. The common
pattern `addEventListener(ch, onResize)` where `onResize` is a
same-file function declaration or `const onResize = () => {...}` is
not detected.

**Working assumption:** skip. Detecting it requires intra-file
callee-resolution (cheaper than Q12 tier 2 — same-file only) but is a
distinct piece of infrastructure not needed for anything else yet.

**What's needed to decide:** a real-world codebase hit where this
pattern is the dominant shape; or the intra-file symbol-resolution
helper landing for another detector so reuse is cheap.

---

## Q16 — `event-bridge` v2: rename-bridges as a distinct sub-kind

v1 only emits when the listened channel name and the re-dispatched
channel name are identical. A rename-bridge (`listen('resize-notify')`
→ `dispatch('resize')`) is a different architectural claim and needs
its own fingerprint identity.

**Working assumption:** don't emit in v1. The cross-channel link
requires additional signal about intentional mapping vs. unrelated
events.

**What's needed to decide:** surfacing real rename-bridge instances in
a dogfood run; or the `event-bridge` detector maturing enough that
"no finding" for intentional forwarding feels like a gap rather than
correct scope.

---

## Q17 — `event-bridge` `toHost` verbosity: key vs. expression

`toHost` is currently the **leftmost identifier** of the dispatch
receiver (e.g. `iframe.contentWindow` → `"iframe"`). The dispatch
occurrence carries `toHostExpression` for the full receiver text.
This means the grouping key is on the leftmost identifier, which may
merge two logically distinct bridges if a file dispatches to both
`iframe1.contentWindow` and `iframe2.contentWindow`.

**Working assumption:** leftmost identifier is correct for grouping
(the claim is "this channel bridges from window to the iframe layer");
`toHostExpression` on the occurrence gives consumers the full detail.

**What's needed to decide:** a real dogfood run showing false merges;
or an AI-consumer that needs the precise target to take action safely.

---

## Q18 — `structural-drift` v2: function-parameter-passed objects

v1 only catches exported const object literals accessed by importers. The broader P12 case — `function f(cfg) { return cfg.host; }` called from another file with `f(CFG)` — requires resolving which call-site argument maps to which parameter, which is a type-flow or whole-program call-graph problem.

**Working assumption:** out of scope for v1. The exported-object shape covers the highest-signal case (config objects, shared constants) and is syntactically provable. Parameter-passing is the dominant remaining shape of P12.

**What's needed to decide:** intra-file call-graph resolution landing for another detector (making reuse cheap), or the TypeChecker integration question (Q4 / Q3 track) settling enough to know whether D5 gets relaxed for any detector.

---

## Q19 — `review-scaffold` subcommand: in scope, plugin, or external skill?

**Why it matters:** dogfooding `impact` against real PRs surfaces a gap that is shaped *like* the analyzer's job but is not the same job. On a "pure component refactor" PR (no new globals / storage keys / event channels / module captures), `impact --since` correctly returns `0 findings touch the change set` — a true negative. The reviewer (human or LLM) still has work left: extracting the change scope, the test tree, the fixture-health issues, the state-coupling cascade, and the matrix-axes coverage map that the change touches. That work is mechanical (AST + git) for the first 70% and reasoning (LLM / test-run) for the last 30%. A `code-intel review-scaffold <project> --since <ref>` subcommand would emit the structured "review brief" for the mechanical 70% so a downstream LLM (or human) skips the cold-read of every diff and starts from a map.

The unresolved question is *where this should live*:

1. **Inside `code-intel` as a peer subcommand to `impact` and `trace`.** Reuses the existing detector registry, the import graph, the AST cache, and the per-detector occurrence machinery. The brief plugs into the JSON / markdown reporters. Risk: scope creep — the subcommand isn't a *detector*, it's a *report shape*.
2. **As a per-stack plugin** (Recoil, Redux, Zustand, Jotai, custom store libraries) — the *stack-specific* part of the brief (selector cascade extraction, atom write graphs) is naturally pluggable. The *generic* part (change scope, test tree, fixture health) lives in core. Risk: needs the plugin / rule-pack architecture to land first (already on `BACKLOG.md` as a longer-term synthesis).
3. **As an external "skill" file consumed by an AI assistant**, calling `code-intel impact --json` for the parts that are already covered. Lowest scope cost on `code-intel` itself. Risk: the brief's value is in the structured aggregation — pushing that to a skill means every AI context re-implements it.

**Working assumption:** defer until `MCP server POC` (Q7) lands. Once MCP exposes the analyzer surface as structured tool calls, the answer becomes clearer: an LLM with MCP access can compose `impact + project graph + test extraction` without us shipping a `review-scaffold` subcommand at all. If MCP composition turns out to be too clumsy in practice, revisit option (1) or (2).

**Scope guardrail:** any version of this work must stay on the project's niche. The brief emits *facts* — it never makes a pass / fail judgement. Anything that requires evaluating arbitrary TS expressions (component render output, cascade outcomes, scenario reasoning) stays off the static analyzer; it lives with the LLM or with tests.

**What's needed to decide:** whether MCP composition (Q7) covers the use case naturally, or whether the brief's structured aggregation is uniquely worth building as a peer subcommand. Also: whether real users want this, or whether the demand is hypothetical.

---

## Q20 — File-context classifier: shared infrastructure or per-detector helpers?

**Why it matters:** several BACKLOG noise-reduction items share an underlying need: classify each source file as `production`, `test`, `build-artifact` (minified / vendor bundle), or `unknown`, so detectors can either skip or weight occurrences accordingly. Concretely:

- `Skip minified / bundled files at file-discovery time` (file walker layer).
- `Default-exclude test-context files from cross-file thresholds` (per-detector or per-occurrence layer).
- `Test-context-aware confidence scoring` (already on BACKLOG; same classification).

The question is whether these share one classifier or stay separate.

**Two shapes:**

1. **Shared `src/file-context.js` module** with a single `classify(filePath, sampleBytes?) → { kind, reasons[] }` function consulted by the file walker and every detector. Detectors decide what to do with the answer (drop, demote, annotate). One source of truth; one place to add new heuristics (e.g. recognise `cypress/` directories).
2. **Per-detector helpers, no shared module.** Each detector inlines the regex it needs. Cheaper today; risks divergence (the same Jest-setup regex, copy-pasted into every detector, drifts when new test runners appear).

**Working assumption:** lean toward (1) once a second detector needs the classification. Until then, the file-discovery skip for minified bundles is a one-off and lives in `src/project.js`. When the in-detector test filter lands, lift the helper to a shared module rather than copying the regex.

**Scope:** this question is product-facing because the *output schema* may carry the classification on each occurrence (`occurrence.context: 'production' | 'test' | 'build-artifact' | 'unknown'`). That's a schema decision, not just an implementation detail.

**What's needed to decide:** whether the schema benefits from per-occurrence `context` (yes, per the dogfood report — preserves visibility for users who want test-only collisions surfaced under a separate kind), and whether more than two detectors end up needing the helper. If the answer to either is yes, the shared module wins.
