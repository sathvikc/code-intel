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
