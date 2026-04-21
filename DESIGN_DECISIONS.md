# Design Decisions

A chronological log of resolved, product-facing decisions for `code-intel`.
This file complements [`VISION.md`](./VISION.md): the vision says *what* we're
building; this log says *how* and *why*, decision by decision.

## Scope

Entries here describe choices that affect what the tool **does** — its
behavior, output, schema, CLI surface, what it detects, what it doesn't.

Out of scope for this file: repo layout, commit conventions, test runner
choice, internal refactors, CI plumbing. Those live in the repo itself or in
agent-local notes.

## These entries evolve

A decision logged here is a snapshot of reasoning at the time it was made.
It is not a permanent commitment. New information, new use cases, or a
better approach can and should change it. What stays permanent is the
*record* — the trajectory of how the thinking moved, so future readers
(human or AI) understand *why* the tool behaves the way it does today.

Rules for evolving a decision:

1. **Append-only.** Never rewrite the body of an existing entry to reflect
   a new decision. The old reasoning stays visible; that's how the
   trajectory remains legible.
2. **Supersession.** When a decision changes substantively, add a new
   `D<M>` entry with a `Supersedes: D<N>` line that explains *what
   changed* and *why*. Then flip the old entry's `Status` from `active`
   to `superseded-by: D<M>`. Status is the one permitted in-place edit;
   never alter the reasoning.
3. **Cross-references.** An entry may carry a `Related:` line listing
   other `D<N>` / `Q<N>` numbers it depends on or affects. Before
   changing a decision, grep for back-references — a new choice should
   not silently invalidate a prior one.
4. **Clarifications vs. changes.** Fix typos, rewording, or formatting
   freely. Anything that alters what the tool does → new entry.
5. **Timeline via git.** `git log -- DESIGN_DECISIONS.md` is the
   authoritative chronology. Dates are not duplicated into entries.

## Format

Each entry is numbered (`D<N>`), append-only. Numbers are never reused,
even when an entry is superseded. When a question from `OPEN_QUESTIONS.md`
is resolved, it moves here with a new `D<N>` number.

```
## D<N> — <Title>

**Status:** active | superseded-by: D<M>
**Supersedes:** D<K>                    (optional; only when this entry replaces a prior one)
**Related:** D<A>, D<B>, Q<C>           (optional)
**Decision:** <one sentence>
**Context:** <why the question came up>
**Alternatives considered:** <what else we looked at>
**Reasoning:** <why we chose this>
```

---

## D1 — Multi-project support is "N roots," not a VISION amendment

**Status:** active
**Decision:** Accept N project roots as analyzer input. Each root is a
project with an `id` (from its `package.json` `name`, else directory
basename). Findings group across projects by the coupling key they describe,
so cross-repo coupling surfaces as one finding with occurrences from
multiple projects.

**Context:** Enterprise SPAs are commonly split across multiple repositories
or packages, and implicit coupling (storage keys, event channels) absolutely
crosses those boundaries. The analyzer needed to handle this.

**Alternatives considered:**
- Amend `VISION.md` to call out multi-project as a first-class scope item.
- Defer to later; ship single-root first.

**Reasoning:** Multi-project is mechanically "loop over N roots instead of
1" — no new concepts, no new data shapes beyond a `project` field on each
occurrence. It doesn't warrant a vision-level change. It also doesn't
warrant deferring, because retrofitting project-tagged findings later would
be a breaking schema change. Build it in from day 1, keep it light.

---

## D2 — Recall over precision

**Status:** active
**Related:** D4, Q3, Q5
**Decision:** When in doubt between reporting a finding and suppressing it,
report. The analyzer's job is to surface signal. The reviewer (AI agent or
human) decides what's noise.

**Context:** Real codebases are messy: aliased variables, wrapper modules,
unusual idioms. A precision-first analyzer would need deep type analysis to
handle them without false positives — costly and still fragile. A
recall-first analyzer emits weaker signals too, and delegates filtering to a
separate layer.

**Alternatives considered:**
- Precision-first: only emit findings we're highly confident about. Minimizes
  noise but misses real coupling and creates silent blind spots.
- Hybrid with a confidence score on each finding.

**Reasoning:** The primary consumer is an AI agent reviewing or refactoring
code. Missing a real coupling causes a silent bug; a false positive costs
the reviewer a few seconds to dismiss. The asymmetry favors recall. The
suppression architecture (see D4) handles the false-positive cost directly.

---

## D3 — Schema `version` is a real contract

**Status:** active
**Decision:** The `version` field in analyzer output (`"0.1"` today) is a
public API versioning signal. Until `SCHEMA.md` is published, additive
changes (new optional fields) stay on the same version. After `SCHEMA.md` is
published, any change to field names, required fields, finding shapes, or
occurrence shapes bumps the version.

**Context:** The vision treats JSON output as a first-class API for AI
agents. Consumers will depend on its shape; breaking it silently is the
worst thing we can do to the tool's trustworthiness.

**Alternatives considered:**
- No version field, treat breaking changes as package-version events.
- Version field but no stability commitment.

**Reasoning:** Consumers need a programmatic signal for schema compatibility
that's independent of the npm package version (a `fix:` patch bump might
still ship additive fields). An explicit schema version separates
"implementation changed" from "contract changed."

---

## D4 — `detectedVia` structured metadata on every occurrence

**Status:** active
**Related:** D2, Q5, Q9, Q10
**Decision:** Every occurrence in a finding carries a `detectedVia` string
indicating *how* the coupling was detected (`"method-call"`,
`"indexed-access"`, `"property-access"`, `"delete"`, …). Enables
category-level suppression downstream.

**Context:** Recall-first analyzers produce noise. The suppression layer
(future) and AI reviewers need structured handles on that noise to say
"suppress all `property-access` findings in test files" without fuzzy
string matching on snippets.

**Alternatives considered:**
- No metadata; let reviewers match on snippets.
- A coarser `confidence` score (see Q10).

**Reasoning:** `detectedVia` is cheap (one string per occurrence), enables
precise filter rules, and is additive — it doesn't force a finding shape
that we'd later regret. `confidence` is deferred as open.

---

## D5 — Syntactic parsing only (no type checker)

**Status:** active
**Related:** Q1, Q2, Q8
**Decision:** Analyzers use `ts.createSourceFile` to get an AST and do not
create a full TypeScript program or invoke the type checker. Detection is
syntactic and pattern-based.

**Context:** Full-program analysis offers deeper resolution (aliased
bindings, cross-module inference) but costs config (tsconfig.json
discovery), speed (order-of-magnitude slower), and correctness on real
repos that have broken types.

**Alternatives considered:**
- Create a full TS program per project.
- Hybrid: syntactic by default, type-checker on demand behind a flag.

**Reasoning:** Zero-config, speed, and the graceful-degradation principle
from the vision all favor syntactic. Coverage gaps (aliased storage,
wrapper modules, constant-folded keys) are real — they are logged as open
questions (Q1, Q2, Q8). When the cost/benefit flips, this decision is
revisited, not the other way around.

---

## D6 — Dot-access detection with method-name whitelist

**Status:** active
**Related:** D2
**Decision:** `localStorage.foo` (dot property access) IS detected as a
storage access. A whitelist of known Storage API method/property names
(`setItem`, `getItem`, `removeItem`, `clear`, `key`, `length`) prevents
false positives on method references like `const fn = localStorage.setItem`.

**Context:** Rare but real: some code uses `localStorage.foo = value` as
shorthand for `setItem`. Skipping it would create a silent blind spot.

**Alternatives considered:**
- Skip dot-access entirely (prior proposal).
- Detect all dot-access, no whitelist.

**Reasoning:** Per D2, we prefer a false positive on `localStorage.length`
over missing a real `localStorage.authToken` write. The whitelist is the
minimum filter to avoid the obviously-wrong case (method references).
Everything else emits.

---

## D7 — Compound assignments emit two occurrences

**Status:** active
**Decision:** A compound assignment (`+=`, `-=`, `||=`, `??=`, `&&=`, `*=`,
`/=`, `%=`, `**=`, `<<=`, `>>=`, `>>>=`, `&=`, `|=`, `^=`) on a storage
element access emits two occurrences at the same line/column: one `read`,
one `write`.

**Context:** `localStorage['k'] += '!'` both reads and writes the key. A
single-op classification would lose information either way.

**Alternatives considered:**
- Emit once as `write` (loses read signal).
- Emit once as a new op like `read-modify-write` (new vocabulary for a
  rare case).

**Reasoning:** Two occurrences is semantics-accurate, requires no schema
change, and lets downstream consumers see exactly what the statement does.

---

## D8 — Same-file string-literal constant folding

**Status:** active
**Related:** D2, D3, D5, Q1, Q2
**Supersedes-open-question:** Q8
**Decision:** When a detector extracts a string key / channel / event name
from an argument, a bare identifier that resolves within the same file
to a non-reassigned `const` (or `let`) initialised with a `StringLiteral`
/ `NoSubstitutionTemplateLiteral` is folded to that literal. The
resulting occurrence is treated as a static key: it is NOT marked
`dynamic`, and it groups across files with every other occurrence of
the same literal. An optional `foldedFrom: <identifierName>` field is
added to the occurrence so downstream consumers can tell the literal
came through a constant and which constant it was.

**Scope of v1:**

- **Same file only.** Cross-file / imported / re-exported / barrel
  constants are NOT followed. A second pass that threads symbols across
  files is a separate, larger decision (see Q2).
- **`const` and never-reassigned `let`.** `var` is excluded (hoisting
  semantics).
- **Bare string literals only.** No concatenation (`'a' + 'b'`), no
  substituted templates, no `.` access, no function calls, no
  ternaries.
- **Plain identifier bindings only.** Destructuring patterns (`const
  { K } = …`) are skipped.
- **Reassignment is fatal, file-wide.** If a name is ever the target of
  `=`, `+=`, `++`, `--`, or a destructuring-assignment target anywhere
  in the file, no binding of that name folds. Conservative-but-safe.
- **Temporal dead zone respected cheaply.** A use site must appear
  strictly after its declaration's start position.
- **Nearest-declaration wins.** Inner-scope shadowing resolves to the
  innermost containing declaration.

**Output schema impact (additive — honours D3):**

Occurrences gain an optional `foldedFrom: string` field, present only
when folding fired. No existing field's meaning changes. Inline
literals continue to look identical to pre-folding output. Downstream
consumers that ignore `foldedFrom` keep working unchanged; consumers
that want to filter or explain "this match came via a constant" can use
it.

**Context:** A very common real-world pattern is a `constants.ts`-style
top-of-file block (`const APP_SESSION_KEY = 'app.session';`) whose name
is then passed to `localStorage.setItem`, `addEventListener`, etc.
Before folding, such code landed in `dynamic: true` output, which is
technically correct but practically useless — the key is in the same
file, fully resolvable syntactically. The pattern appeared frequently
enough that every detector that touched string keys was losing recall
to it.

**Alternatives considered:**

- **Do nothing.** Rejected — the false-negative rate was high enough
  that the detectors' usefulness on real codebases was being
  systematically under-sold.
- **Full symbol resolution via the TypeScript checker.** Rejected — it
  violates D5 (syntactic only), costs startup time, and fails on
  repos with broken types, which is exactly where these bugs tend to
  live. The syntactic 70% is worth more than the full-program 100%
  that never runs.
- **Fold cross-file imports too.** Held back for a later slice. Needs
  re-export resolution, barrel handling, default-vs-named distinction,
  and alias tracking — too much surface for v1 given that the
  same-file case alone carries most of the real-world wins.
- **Fold concatenation (`'a' + '.b'`) and substituted templates.**
  Deferred. Low incremental complexity, but no in-the-wild case has
  demanded it yet; YAGNI.

**Reasoning:** This is a pure recall multiplier across `shared-state`
(both storage + events), `paired-keys`, and `shape-drift` — it raises
the floor on every detector already shipped without changing any
schema guarantee and without introducing any new detector surface.
Scope kept narrow on purpose (D2 "ship partial, iterate"): we catch
the easy 70% and log the 30% as the next slice. `foldedFrom` keeps
the D4 spirit — consumers get structured metadata, not a fuzzy "maybe
this came from a constant."

---

## D9 — `duplicate-static-svg-id`: flag the pattern, not the render count

**Status:** superseded-by: D10
**Related:** D2, D5, D8
**Decision:** The `duplicate-static-svg-id` detector emits a finding
when a JSX file contains (a) a static string-literal `id` attribute on
any JSX element AND (b) at least one reference to that same id in the
same file via `url(#<id>)` inside any attribute value OR `#<id>` as
the value of an `href` / `xlinkHref` / `xlink:href` attribute. It does
NOT attempt to reason about whether the enclosing component renders
once or many times on any given page.

**What counts as "static" id:**

- `id="foo"` (string-literal JSX attribute)
- `id={"foo"}` (JSX expression wrapping a literal)
- `id={FOO}` where `FOO` folds under the same-file rules in D8

All other id expressions — `useId()`, `nanoid()`, prop references,
template literals with substitutions, anything else — are treated as
dynamic and skipped. The fold helper is the same one used by every
other string-key detector; "static" has a single consistent meaning
across the codebase.

**Why we require the in-file anchor:**

A `<div id="foo">` without a matching `url(#foo)` / `href="#foo"`
reference is most likely a test selector, an a11y target, a scroll
anchor, or a DOM-query hook — none of which are the bug we care
about. Without the anchor, the false-positive rate dominates. With
the anchor, the finding is tight: "this id is used as an in-graphic
reference in this component." Cross-file anchors are deliberately
out of v1; in real SVG code, the declaration and its `url(#)`
consumers virtually always live in the same file.

**Why we don't attempt to detect render multiplicity:**

Whether a component actually renders more than once on a page is not
statically decidable in general. The same component can render once
on a detail page and fifty times on a list page. A static-id SVG
component is a latent bug regardless — if *any* caller ever renders it
twice, it breaks, silently, in production. The incident that motivated
building this detector was exactly that shape: a sub-nav rendered
once-on-click for years, then pre-rendered for SEO on every category
at the same time; the existing code became wrong overnight. The bug
pre-existed the pre-render change; source analysis catches the
pattern before the pre-render change exposes it.

So confidence stays at `high` on every emitted finding, with a reason
paragraph that names the render scenarios that make the bug manifest
(list, grid, SSR / SSG pre-render) and the fix (derive the id per
instance — `React.useId`, `nanoid`, or a prop — and thread it through
both the declaration and every reference). Reviewers who want
stricter tiering can filter by confidence once cross-file reach
analysis lands in a later slice.

**Output schema (follows D3):**

Finding kind `duplicate-static-svg-id`, file-scoped by construction.
Each finding has `id` (the static string), `element` (the owning JSX
tag name on the primary declaration — purely informational), and
`occurrences[]` with `op: 'declare' | 'reference'`. Declaration
occurrences carry `element`; reference occurrences carry
`via: 'url' | 'href'` and `attribute: <jsx-attribute-name>`. Both
carry `foldedFrom` when the fold helper was used to resolve the id.
The `findingId` key includes the file path so that two files
hardcoding the same id produce two independent findings — they are
independent bugs, not a coupling.

**Alternatives considered:**

- **Emit every static `id` attribute, anchor or not.** Rejected for
  noise: tests, a11y anchors, and DOM hooks would drown the signal.
- **Try to detect render multiplicity statically** (scan the component
  tree, count call sites, classify as "likely-many-renders" vs
  "likely-one-render"). Rejected: the analysis is expensive, brittle,
  and at most a proxy for the actual runtime render count. A latent
  bug is worth surfacing regardless.
- **Scan the generated HTML from an SSR/SSG build and flag literal
  duplicate ids there.** This is a *complementary* direction, not an
  alternative — it catches the bug as a fact rather than a pattern.
  Built-output scanning is logged as its own future slice; it does
  not replace source analysis, which catches the latent-pattern case
  for SPAs and for code that will be pre-rendered next month.
- **Treat JSX `id` attributes on non-SVG elements (`<div id="x">`)
  specially.** Rejected: a `<div id="foo">` paired with a
  `<rect fill="url(#foo)">` elsewhere in the same file is still the
  same bug shape (and has been observed in the wild when a dev mixed
  SVG defs with DOM-hosted ids). The anchor is what matters, not the
  tag taxonomy.

**Reasoning:** Matches the D2 "ship partial, iterate" spirit —
narrow, deterministic, anchored on a tight syntactic shape that
almost never misfires, built to dovetail with future build-output
scanning rather than pre-empt it. The fold helper (D8) is reused
rather than re-implemented, keeping the "what counts as static"
rule unified across the detector catalogue.

---

## D10 — Detectors describe what is, not what might become

**Status:** active
**Supersedes:** D9
**Related:** D2, D3, D4
**Decision:** Detectors emit findings based on facts observable in the
code *as it is today* — shapes that already are a bug, or clusters /
coupling relationships / textual duplications that already exist.
Detectors do NOT emit findings based on predictions about future code
states ("if this component were ever rendered twice, it would…"). If
we can't demonstrate the duplication / drift / coupling in the current
scan, we stay silent.

**Scope of this rule:**

Applies to every detector. Concretely:

- `shared-*`, `paired-keys`, `shape-drift`, `stale-module-capture`,
  `duplicate-static-svg-id` — each already emits on present-tense
  observations (two files touch the same key, two shapes disagree on
  the same channel, etc.). The rule confirms the existing behaviour
  for these and pins it going forward.
- `duplicate-static-svg-id` previously violated this rule under D9,
  which argued the detector should emit on the latent pattern ("this
  component uses a static id; if it ever renders more than once, it
  collides") regardless of whether we could observe the multi-render.
  That approach produced noise on lone-use components. Under D10 it
  now requires evidence of actual multi-render in the scanned set
  (in-file loop, caller-loop via one-hop import graph, same-component
  duplicate declaration, cross-component duplicate declaration). No
  evidence → no emission.

**Confidence tiers under D10:**

- **`high`** — the duplication / coupling / drift is directly
  demonstrable from observed code (e.g. the same id is declared twice
  in one component, or the component sits inside a `.map(...)`).
- **`low`** — an observation that we captured (two components declare
  the same id string anywhere in the scanned set) whose page-level
  impact we can't prove statically. We report it so reviewers can
  audit; we do not claim it is a bug.
- We never use `medium` to paper over "this is probably a future bug";
  future-prediction claims are not emitted at all.

**Framework context as config, not inference (referenced, not resolved
here):**

Prediction pressure often comes from trying to guess what a framework
does to render behaviour (SSR / SSG / pre-render, SPA routing vs full
reload, file-convention routing, etc.). The intended way to modulate
findings on that axis is a project-level config the user declares
(see Q3 for the config-format open question and the direction logged
in `BACKLOG.md`). Detectors consume that config to tier / filter
observed findings; they do not auto-detect framework context in v1.

**Alternatives considered:**

- **Keep D9's "flag the pattern" framing and rely on confidence
  tiering to cool down noise.** Rejected on real output review: lone
  single-use components were emitting warnings with no observable bug
  today, and reviewers correctly pushed back. Confidence tiers can't
  rescue a finding whose factual claim is a prediction — lowering the
  tier makes the finding quieter but does not make it more true.
- **Park the SVG detector entirely until build-output scanning lands.**
  Rejected: there is a real bug class the source analyzer CAN observe
  (loop-based multi-render, caller-loop multi-render, duplicate
  declarations). Narrowing to what we can demonstrate preserves the
  detector and drops the noise.
- **Blanket silence for every `low`-confidence observation.** Rejected:
  textual-duplication observations are still useful leads for human
  review, and recall-first (D2) favors surfacing them with an honest
  label over dropping them silently.

**Reasoning:** The analyzer's credibility depends on every finding
being true. When we say "this is a bug" we must mean it about today's
code. Predictive findings move us from "here is coupling you may not
have seen" to "here is something that might bite you one day" — a
claim the reviewer can't verify without running the very experiment
the tool was supposed to do for them. The descriptive rule also
decouples each detector from its framework-specific assumptions: an
SSR-only bug is still a bug when it actually renders multiple times,
regardless of whether we happen to know the project is SSR.

Schema v0.2 on `duplicate-static-svg-id` reflects this pivot: each
finding now carries `component` (the enclosing component name) and
`evidence: []` (one entry per observation type), with two new
occurrence `op` values (`iteration-site`, `duplicate-declaration`) so
consumers can see where the evidence lives. Older consumers reading
v0.1 will need to re-read on the new shape; no v0.1 adaptor is
provided (pre-1.0).

---

## D11 — User-configurable directory excludes via `--exclude`

**Status:** active
**Resolves:** Q14
**Related:** Q3 (config format), Q5 (inline suppressions)

**Decision:** The CLI accepts a repeatable `--exclude <path>` flag on
`impact` and on every per-analyzer subcommand. Each `<path>` is a
**project-root-relative directory path** resolved against each project
root; the walker prunes the entire subtree at that path. The flag is
threaded through `analyzeProjects(projectRoots, opts = {})` on every
analyzer via a new `opts.exclude: string[]` parameter.

**Scope of the v1 slice:**

- **Literal paths, no globs.** `--exclude examples` and
  `--exclude examples/generated` both work. `--exclude "**/__tests__"`
  would be interpreted as a literal directory named `**/__tests__`
  (and therefore match nothing). Glob support is a v2 that lives under
  Q3 when the config format lands.
- **Directory-level only.** File-level excludes (`--exclude foo/bar.ts`)
  are not supported; the walker prunes by directory path match, and
  source files are yielded after pruning.
- **Repeatable.** Multiple `--exclude` flags are and-ed: each listed
  directory is pruned independently.
- **Hardcoded `IGNORED_DIRS` wins.** `node_modules`, `dist`, `build`,
  `.git`, `coverage`, `.next`, `.turbo`, `.cache` are always excluded,
  regardless of whether the user passes them to `--exclude`. A
  regression test pins this — a nonsensical `--exclude node_modules`
  stays a no-op (not a re-include).
- **Project-root-relative.** In multi-project mode, each `<path>` is
  resolved against *each* project root independently. `--exclude docs`
  on `code-intel impact apps/web apps/admin` skips `apps/web/docs` and
  `apps/admin/docs`; it does not require two separate flags.

**Alternatives considered:**

- **Hardcoded `IGNORED_DIRS` expanded to include `examples`, `docs`,
  `e2e`, `fixtures`, `storybook-static`.** Rejected: some projects
  legitimately want those directories scanned (a library whose
  `examples/` tree is real production code shipped to users, a
  `docs/` that contains live MDX imported by the app). A hardcoded
  default that guesses wrong is worse than no default.
- **Ship full glob matching in v1.** Rejected for this slice:
  requires either an experimental Node API (`path.matchesGlob` is
  flagged unstable in v22), a new runtime dependency (`micromatch` /
  `minimatch`), or a hand-rolled matcher. None of those belong in a
  30-minute dogfood-unblocking slice. The directory-path literal
  covers the 90% case (*"I have `examples/` at root, skip it"*) at
  zero cost.
- **File-pattern excludes (`--exclude "**/*.test.ts"`).** Rejected as
  scope creep for v1. Test files rarely produce findings anyway
  (detectors are tuned for production coupling, not mock setup in
  tests), and the directory-level cover is sufficient for the pain
  the flag was added to solve.
- **CLI flag only, no programmatic API.** Rejected: downstream
  consumers (the planned MCP tool Q7; the planned `trace` subcommand
  Q12; any automation) need the same knob. `opts.exclude` on each
  `analyzeProjects` is the programmatic surface; `--exclude` is its
  CLI affordance.

**Relationship to Q3 (config format) and Q5 (inline suppressions):**

- When Q3 lands, `exclude: []` will be the obvious config key; the
  CLI flag then becomes an **additive** override (not a replacement)
  so config-declared excludes survive one-off flag use. The flag
  shape ships unchanged.
- Q5 (inline suppressions) operates at a different layer — it
  filters at **emission**, not at **ingestion**. D11 and Q5 are
  non-overlapping; a user will commonly want both.

**Reasoning:** Dogfooding `code-intel impact .` on the repo surfaced
the pain immediately — 12 findings from `examples/`, zero from `src/`.
Any real repo with `examples/`, `docs/`, `e2e/`, or a sibling
package's build output at root would hit the same wall on first use.
The zero-config promise in `VISION.md` (*"works on any JS/TS repo
with no setup"*) specifically calls out that every behavior should
also be configurable via CLI flags; this flag is the first such
affordance after the positional paths themselves. Shipping the
simplest useful shape now and letting Q3's config format absorb the
richer cases later matches the recall-first, ship-partial-iterate
rhythm that D2 and D3 encode.

---

## D12 — `trace` subcommand: per-symbol graph via reshape (Q12 tier 1)

**Status:** active
**Resolves:** Q12 tier 1 (tiers 1.5, 2, 3 remain open)
**Related:** Q7 (MCP surface), Q2 (storage wrappers), D11 (`--exclude`)

**Decision:** `code-intel trace` is a peer subcommand of `impact`,
not a flag on it. It takes exactly one target from:

- `--storage <backend:key>` — backend is `localStorage` or
  `sessionStorage`; the key is everything after the **first** colon
  (so `user:profile:v2` survives verbatim as a key).
- `--event <channel>` — matched as-is against `CustomEvent` /
  `addEventListener` channel names (no colon-splitting).
- `--global <name>` — matched against classic-script global-binding
  names surfaced by `shared-globals`.

Exactly one of the three is required. The target flag, `--pretty`,
`--format json|mermaid`, `--exclude <path>` (per D11), and positional
project paths are the full CLI surface.

**Output shape (schema v0.1):**

```
{
  version: "0.1",
  analyzer: "trace",
  target: { kind: "storage" | "event" | "global", ... },
  projects: [{ id, root }],
  nodes: [
    { id: "target", role: "target", kind, ... },
    { id: "n1",     role: "occurrence", project, file, line, column,
                    op, snippet, detectedVia?, host? },
    ...
  ],
  edges: [{ from: "n1", to: "target", kind: "writes-to" | ... }],
  summary: { totalOccurrences, byOp, affectedFiles, affectedProjects }
}
```

The graph is a **star topology**: one target hub, N occurrence leaves,
one edge each. Edge kind is a uniform role-verb string derived
mechanically from the detector's `op`:

- storage: `read` → `reads-from`, `write` → `writes-to`, `remove` →
  `removes-from`
- events: `dispatch` → `dispatches-to`, `listen` → `listens-to`,
  `unlisten` → `unlistens-from`
- globals: `declare` → `declares`, `assign` → `assigns-to`,
  `remove` → `removes`

**Pure reshape — no new detection:**

Every occurrence node corresponds 1:1 to an occurrence already
emitted by `shared-state` / `shared-events` / `shared-globals`.
`trace.traceStorage` / `traceEvent` / `traceGlobal` each call the
matching analyzer's `analyzeProjects`, filter its findings to the
target, and fan the occurrence arrays into nodes + edges. This is
pinned by the integration test `integration: trace occurrences match
the same sites impact sees for the key` which asserts
`(file, line, op)` tuple-equality between `trace` and `impact` output
for the same target — a silent divergence between the two surfaces
fails the test.

**Renderers:**

- JSON (default) is the machine-readable shape; `--pretty` for
  human inspection.
- `--format mermaid` emits a `flowchart TD` with the target as the
  centred hub and one labelled edge per occurrence. Double-quotes
  are swapped for single quotes, angle brackets HTML-escaped, so
  labels containing snippets survive Mermaid's parser. This is an
  *additive* renderer over the same graph shape, not a separate
  pipeline; adding DOT later costs ~20 lines.

**What tier 1 does NOT ship (scope-pinned for later):**

- `trace --paired-cluster "k1,k2"` — tier 1.5. Small follow-on;
  `paired-keys` already emits per-function cluster findings, so the
  work is another reshape plus a new `siblings-in-cluster` edge
  kind. Gated on a user actually asking for it (YAGNI rhythm).
- `trace --symbol <name>` — tier 2. Requires a TS `TypeChecker`
  pass, which is a different cost class than reshape.
- Runtime happens-before ordering — tier 3, fundamentally out of
  scope (see Q12's reasoning).

**Alternatives considered:**

- **`impact --trace <target>` flag on the existing subcommand.**
  Rejected: `impact` is already dense with flags (`--since`,
  `--markdown`, `--json`, `--pretty`, `--exclude`); stacking a
  target selector on top would break the one-flag-one-concern
  grain. A peer subcommand also matches how the planned MCP tool
  (Q7) will expose this — `whoReadsKey` / `whoWritesKey` are
  separate RPCs, not an arg on a shared `impact` RPC — so a peer
  CLI subcommand keeps the shape consistent across surfaces.
- **Emit the graph as a flat `occurrences: []` array with an `op`
  field per entry and no explicit edges.** Rejected on consumer
  ergonomics: the star-with-edges shape is trivially convertible to
  a flat list (`nodes.filter(n => n.role === 'occurrence')`), but
  the reverse conversion from a flat list into a proper graph
  requires an agent or UI layer to re-derive edge semantics. Paying
  the edge-list cost once at emission saves every consumer from
  paying it themselves, and keeps the Mermaid renderer trivial.
- **Accept `--target <kind>:<value>` as a single unified flag.**
  Rejected: `--storage localStorage:app.session` reads naturally
  and auto-completes well in shell. A unified `--target
  storage:localStorage:app.session` gets visually noisy fast and
  loses the per-kind error messages (e.g. *"backend must be
  localStorage or sessionStorage"*).
- **Auto-render Mermaid when stdout is a TTY.** Rejected: the JSON
  default is the contract shape for automation and MCP. TTY auto-
  switching burns that contract for humans who pipe the output
  into `jq`. `--format mermaid` is one flag to type and composes
  cleanly with `--pretty` being JSON-only.

**Reasoning:** The detectors already compute everything needed to
answer *"what touches X?"* — the information was just buried inside
a full `impact` report that consumers had to parse and filter
themselves. The shortest path from that data to an agent-usable
shape is the reshape in tier 1: no new AST walks, no new heuristics,
no new schema surface beyond the graph envelope. Ship the 90%-case
CLI now so the next-tier work (paired clusters, symbol-level,
MCP tools) has a stable shape to extend; defer cost-increasing tiers
until a concrete caller asks for them.

Schema v0.1 on `trace` is deliberately minimal — no severity, no
confidence, no fingerprint. Those live on findings (where there is
a claim being made about a bug); `trace` makes no such claim, it
just projects observations. A future schema bump would add them
only if a caller needs them.

---

## D13 — Detector registry: single source of truth for orchestration

**Status:** active
**Related:** D11 (`--exclude`), D12 (`trace`), Q3 (config), Q7 (MCP)

**Decision:** All detectors are now registered in a single module
`src/detectors/index.js` as an array of entries:

```js
{
  id: string,           // stable public id; CLI subcommand name; --only/--skip value
  module: object,       // imported detector namespace (analyzeProjects + summarize)
  findingKind: string,  // impact envelope's .kind label for wrapped findings
  summarize: (s) => string[],  // per-subcommand CLI stderr lines
}
```

`cli.js` derives its per-analyzer `ANALYZER_COMMANDS` table from the
registry. `impact.js` loops over the registry (via `selectDetectors`)
instead of hand-coding seven direct calls. `trace.js` intentionally
keeps its three named imports because it is target-specific, not a
generic orchestrator.

Adding a new detector = one new entry in `DETECTORS`. No other edits
to `cli.js`, `impact.js`, or any existing test — the wire-through is
mechanical.

**New user-visible capability: `--only <ids>` / `--skip <ids>` on
`impact`.**

```
code-intel impact . --only shared-state,shared-events
code-intel impact . --skip duplicate-static-svg-id
```

Both flags are repeatable (`--only a --only b`) and comma-tolerant
(`--only a,b`); unknown ids fail fast with the known-ids list in the
error. Filtering happens **before** detection — a skipped detector
does not run at all — which makes this the cheapest available filter
for users who know they only care about a subset of signals on a
given run.

**Scope of the v1 slice:**

- **Registry carries static metadata only.** Detector-specific knobs
  (tier hints, severity overrides, confidence thresholds) are not in
  the registry; they remain inside each detector module. The registry
  is an orchestration surface, not a configuration surface.
- **`trace` stays direct.** `trace.js` imports the three detectors
  it projects over by name. Putting the registry in front of `trace`
  would add indirection without removing any coupling — `trace`
  knows exactly which three it wants.
- **Filters are detector-level only.** Post-emission filters (by
  severity, by confidence, by project, by kind inside a detector's
  output) remain out of scope for this slice. They depend on Q3 / Q5
  which haven't landed.

**Alternatives considered:**

- **Auto-discover detectors via filesystem scan** (read
  `src/*.js`, require any module that exports `analyzeProjects`).
  Rejected: ~~clever~~ magical. Makes the detector list invisible
  until the program runs; explicit registration is more greppable
  and forces the `id` / `findingKind` contract to be stated
  intentionally. The seven-entry ceremony is cheap.
- **Class-based detector interface** (each detector is an instance of
  a `Detector` class). Rejected: current detectors are pure function
  modules with no identity across calls. Introducing a class
  hierarchy would force every analyzer to change its public shape
  without unlocking anything the namespace-of-functions pattern
  can't already do. Classes become worth it when detector instances
  need per-instance state (e.g. a preloaded AST cache). Until then,
  the namespace module *is* the interface.
- **Ship `--only` / `--skip` but defer the registry.** Rejected: the
  flag implementation would have to live in `cli.js` and `impact.js`
  as a hardcoded list of ids mirroring the imports — exactly the
  duplication the registry is fixing. Shipping the flag and the
  registry together keeps them consistent from day one.
- **Inline comma-splitting on `--exclude` too, for consistency.**
  Deferred. `--exclude` was shipped as "repeatable flag, one value
  each" (D11) and there is no user pain with that shape yet. If the
  next common-opt addition (say `--severity`) also wants
  comma-tolerance, we'll refactor `splitIdList` into a shared helper
  and apply it uniformly; until then, gratuitous consistency changes
  risk breaking existing invocations.

**Alignment with upcoming work:**

- **Q3 (config file).** The config's `detectors.enabled: [...]` key
  will land as another input to `selectDetectors` — the same filter
  pipeline, with CLI flags as additive overrides on top of config.
  The registry is the natural anchor; the shape won't change when
  config lands.
- **Q7 (MCP surface).** MCP tools that want to run a subset of
  detectors (e.g. *"just check cross-project storage coupling"*) now
  have a clean knob to expose. `whoReadsKey` can keep using `trace`;
  `impact` analogues can use `{ only: [...] }` directly.
- **Plugin / rule-pack architecture (`BACKLOG.md`).** Plugins become a
  way to append entries to `DETECTORS` from a user-declared module.
  D13 does not ship the plugin surface — that depends on Q3 + Q5 +
  Q9 per the backlog gating — but the attach point is now obvious.

**Reasoning:** The project hit the inflection where the implicit
detector interface (every module exports `analyzeProjects` +
`summarize`; `cli.js` hand-maintains a table mirroring them;
`impact.js` hand-codes seven parallel calls) started costing real
time on common-opt additions: D11's `--exclude` took a seven-file
sweep that would have been a one-line registry edit if D13 had
shipped first. The registry is a pure refactor — behavior-identical
full-runs are pinned by a regression test — that eliminates that
sweep for every future common opt, and pays for itself immediately
by unlocking `--only` / `--skip` as a 15-line flag addition instead
of a seven-detector change.

Broader filtering (severity, confidence, kind-level) is deliberately
deferred: the shape depends on Q3 / Q5, and premature pipelining
would lock us into guesses about their shape. The registry is the
smallest abstraction that serves concrete current pain without
guessing at future pain — consistent with D2 (ship partial, iterate)
and D3 (don't abstract ahead of real pressure).

---

## D14 — Per-run AST cache shared across detectors

**Status:** active
**Related:** D2 (ship partial), D13 (registry), BACKLOG (content-hash cache for warm-start)

**Decision:** A single `impact` run creates one in-memory AST cache
(`src/ast-cache.js`) and threads it through every detector and through
`import-graph`. The cache reads each source file and calls
`ts.createSourceFile` on first touch, then returns the same `{ code,
sourceFile }` reference to every subsequent consumer. Each detector's
`analyzeSource(code, filePath, preparsed?)` accepts an optional
pre-built `SourceFile` and skips its own parse when given one.

**Context:** Every detector independently read the same source files
and rebuilt the same AST. On a small run this meant the same
`ts.createSourceFile` call happened 7–8 times per file (one per
detector plus `import-graph`). Measured on `code-intel`'s own `src/`
(15 files, 7 detectors) that was 2.26s user / 1.63s wall. With a
shared cache the same run drops to 1.33s user / 0.89s wall — a ~45%
wall-time reduction with no behavioral change.

**Scope of the v1 slice:**

- **Per-run only.** The cache lives on the stack of one
  `analyzeProjects` call. It is not persisted to disk, not keyed by
  content hash, and has no cross-run invalidation concerns.
- **Backward compatible.** `analyzeSource(code, filePath)` still works
  without the third arg — unit tests call it that way everywhere.
  Only `analyzeProjects` receives `opts.astCache`; when absent, each
  detector falls back to its own `fs.readFileSync` +
  `ts.createSourceFile` path.
- **Behaviour-identical.** A regression test in
  `tests/ast-cache.test.js` asserts that `impact` output is
  structurally equal (minus `meta.timestamp`) with and without the
  cache on a fixture project touched by multiple detectors.
- **Observability.** `cache.stats()` reports `{ size, hits, misses,
  readErrors, parseErrors }`. Exposed via `impact --cache-stats` (the
  CLI constructs the cache itself, threads it in via `opts.astCache`,
  and prints stats to stderr after the run).
- **Escape hatch.** `impact --no-cache` (programmatic:
  `opts.noCache: true`) disables the cache entirely; every detector
  falls back to its own fs + parse path. Kept for benchmarking,
  regression safety, and the rare case where a future bug in the
  cache needs a one-flag bypass. Mutually exclusive with
  `--cache-stats` (stats are meaningless when the cache is off).

**Alternatives considered:**

- **`Promise.all` over detectors.** Rejected. Detectors are CPU-bound
  synchronous code; wrapping them in `async` and firing with
  `Promise.all` produces no speedup because the event loop can't
  parallelise synchronous work. This is the most common "add
  parallelism" mistake and it does not apply here.
- **`worker_threads` pool.** Deferred. Real multi-core scaling, but
  costs worker lifecycle management, AST-across-boundary
  serialisation, and more complex error paths. Worth it at ~1k+
  files; premature at 15. Revisit when dogfooding on a real
  multi-repo codebase surfaces actual slowness, and only after the
  AST cache alone is measured to be insufficient.
- **Content-hash cross-run cache on disk.** Different problem —
  warm-start of repeated CLI invocations. Orthogonal to the in-run
  duplication this decision fixes. Remains in `BACKLOG.md`.
- **Refactor `analyzeSource` to only accept a `SourceFile` (no raw
  string).** Rejected. The string is still needed for snippets /
  `getText` bookkeeping inside some detectors, and forcing every
  unit test to pre-parse would break the pure
  "string-in / findings-out" contract that makes the detectors easy
  to test in isolation.
- **Bake the cache into the `walkSourceFiles` generator.** Rejected.
  The walker's job is directory traversal; adding parsing to it
  would conflate two responsibilities and force every caller (even
  non-parsing ones like a future file-count utility) to pay the
  `ts` dependency. Keeping the cache as a separate orchestrator-
  scoped helper preserves the walker's narrow contract.

**Reasoning:** The parse-duplication was the only CPU cost with a
clean fix that needed zero new concurrency primitives. The cache is
a plain `Map` behind a thin API — mechanically simpler than any
parallelism approach, and it leaves the door open for
`worker_threads` later (a worker pool that ships file paths + uses
its own cache per worker is an orthogonal extension, not a rewrite).
Shipping it now also sets the pattern for future cross-cutting
orchestration state (alias tables, import-graph reuse in the same
run) to thread through `opts` in the same style as `exclude`,
`only`, `skip`, and now `astCache`.

---

## D15 — Cross-file string-literal constant folding

**Status:** active
**Extends:** D8 (same-file folding)
**Resolves:** the "cross-file / imported / re-exported / barrel
constants" half of Q8 that D8 explicitly deferred
**Related:** D3 (stable schema — additive field), D14 (rides on the
AST cache), D6 (duplicate-static-svg-id folding path — deliberately
not wired in v2)

**Decision:** `resolveStringArg` (in `src/fold-string-literals.js`)
now accepts an optional fourth argument: a cross-file resolver
closure. When same-file folding misses and the argument is a bare
Identifier, the resolver is consulted. On hit, the occurrence gets
both `foldedFrom` (the identifier name, as before) and a new
additive field `foldedFromModule` (the module specifier as the
importer wrote it — e.g. `./keys` or `@app/shared`). The resolver is
built once per `impact` run by `src/cross-file-constants.js`, which
walks every file (through the D14 AST cache) to collect two maps:

- `exportsByFile`: for every file, the string-literal exports it
  declares (including re-exports and star re-exports, unresolved at
  collect time).
- `importsByFile`: for every file, its ES import bindings keyed by
  the local name.

At query time, the resolver looks up the using file's import map to
find the (module, exported-name) pair, resolves the module to an
absolute path via the existing `import-graph.js` `resolveImport`
(reusing tsconfig path aliases, extension candidates, and
`index.{ts,tsx,js,jsx}` fallback), then walks the target file's
export table — following re-export chains and expanding `export *
from …` lazily, with a visited set to break cycles.

The four detectors that consume folding (`shared-state-web-storage`,
`shared-state-events`, `paired-keys`, `shape-drift`) thread the
resolver through `analyzeSource` and `analyzeProjects` and propagate
`foldedFromModule` to every occurrence it flows to. `impact.js`
builds the index and the resolver once and hands the closure to each
detector's `analyzeProjects(opts)`. Detectors with no folding needs
ignore the extra opt key.

**Scope of v2 (deliberately narrow):**

- **Named and default imports of string literals only.** Covers
  `import { K } from './keys'`, `import { K as J } from './keys'`,
  `import K from './keys'` (default export of a string literal or
  a local-literal identifier).
- **Export forms handled:** `export const X = 'lit'`, `const X =
  'lit'; export { X }`, `export { X as Y }`, `export { X } from
  './mod'`, `export { X as Y } from './mod'`, `export * from
  './mod'`, `export default 'lit'`, `export default X` where X is a
  local literal.
- **Reassignment guard preserved.** A name that is ever the target
  of an assignment, compound assignment, or `++`/`--` in its own
  file is not registered as an exportable literal — mirrors D8's
  same-file discipline on the export side.
- **Same-file wins over cross-file.** When a consumer file both
  imports `K` and has a local `const K = '...'`, the local binding
  is returned by `resolveFoldedIdentifier` before the resolver is
  ever consulted. This matches JS shadowing semantics and means the
  v2 addition cannot silently change any v1 behaviour.
- **Backward compatible.** Detectors called without
  `opts.crossFileResolver` fall back to v1 same-file folding
  unchanged. Every existing unit test continues to exercise the
  same-file path.

**Explicitly out of scope (tracked on BACKLOG as "Cross-file
constant folding v2.5"):**

- **Namespace imports** (`import * as NS from './keys'; NS.K`).
  Requires property-access-aware resolution; a different shape than
  the identifier-to-literal path.
- **Object-literal exports read by property** (`export const KEYS =
  { S: 'lit' }; KEYS.S`). Same property-access problem.
- **CommonJS** `const { K } = require('./keys')` and `require('./k').K`.
- **Dynamic imports** (`await import('./keys')`) and **JSON imports**.
- **Computed / concatenated / substituted-template exports** —
  still deferred per D8.
- **`duplicate-static-svg-id` id-resolution path.** D6 uses
  `resolveStringArg` for JSX attribute values but we did not wire
  the cross-file resolver into its `collectJsx` walk. SVG ids are
  almost always inline literals in practice; revisit if dogfooding
  surfaces a real case.

**Interaction with D14's `--no-cache`:** the index-building walk
reuses the AST cache; when `--no-cache` is set the cache is `null`,
so the resolver is not built and detectors fall through to v1
same-file behaviour. `--no-cache` therefore returns both pre-D14
(no sharing) and pre-D15 (no cross-file fold) semantics in one
switch — consistent with D14's framing of `--no-cache` as the
single escape hatch to historic behaviour.

**Output-schema impact (D3):** purely additive. Occurrences grow an
optional `foldedFromModule: string` field when and only when the
cross-file path fires. `foldedFrom` continues to mean "same-file
identifier name" on hits where `foldedFromModule` is absent.

**Alternatives considered:**

- **Full TypeScript `Program` / `TypeChecker`.** Rejected. Would
  give us cross-file symbols plus way more, but pulls in the slow,
  project-config-dependent compiler pipeline (tsconfig resolution,
  module graph, diagnostics) we have deliberately avoided since
  D5. The syntactic resolver covers the ~90% of real cases (named
  imports of exported literals) at a tiny fraction of the cost and
  keeps us robust on repos with broken types.
- **Build the index inside each detector.** Rejected. Four copies
  of the walk would cost 4× the index-build time and make the
  invariants (cycle handling, re-export resolution) fragile. Doing
  it once in `impact.js` matches D14's orchestrator-scoped-state
  pattern.
- **Eagerly resolve the full constants graph at index-build
  time.** Rejected. Re-export chains are common but the vast
  majority of imported names are never folded (most identifiers in
  a file are not string constants the detectors care about). Lazy
  resolution keeps the cost proportional to fold-site count, not
  to import-edge count.
- **Widen the resolver return shape to carry full provenance
  (resolved target file, re-export chain).** Deferred. The current
  `{ value, moduleSource, importedAs }` is enough for the
  occurrences we emit and for the AI reviewer to reason about the
  coupling. Full provenance is logged as a v2.5 follow-up if a
  real consumer asks.

**Reasoning:** In real codebases, string keys / event channels /
paired-write clusters almost always live in a shared `constants.ts`
/ `keys.ts` / `events.ts` and are imported at the use sites. D8 saw
through the inline case only, which meant every such codebase's
cleanest code showed up as "dynamic keys" to the detectors — the
exact opposite of what a reviewer wants. D15 is a force multiplier:
zero new detector logic, but every folding-aware detector (and
every future one) gets wider coverage the moment this helper exists.
The v2 slice deliberately covers the forms a grep over real repos
turns up most; the deferred forms are logged so the next real-world
miss has an entry to revive.

**Benchmark (self-scan on `code-intel`'s own `src/`):**

- cached, D15 on: 1.41s user / ~0.85s wall (3-run avg)
- cached, pre-D15 baseline: 1.33s user / 0.89s wall
- `--no-cache` (D15 off, D14 off): 2.27s user / ~1.58s wall

The ~0.08s user-time bump (6%) is the index-build walk. Wall time
is within noise. Cache stats confirm the extra work: `size=60
hits=480 misses=60` vs the pre-D15 `size=58 hits=406 misses=58`.

---

## D16 — Framework-file parsing (`.astro` first)

**Status:** active
**Related:** D5 (syntactic-only), D14 (AST cache), D1 (multi-project),
BACKLOG ("Framework-file parsing")

**Decision:** The walker now treats `.astro` files as first-class source
files, and a shared `src/framework-file.js` module owns the
extension-aware plumbing that was previously duplicated across every
detector. The module exports four helpers:

- `isFrameworkFile(path)` — true for files that need pre-extraction
  before the TS parser can read them.
- `extractFrameworkFile(path, source)` — dispatches to the per-format
  extractor.
- `extractAstroAsTs(src)` — the actual `.astro` extractor. Returns a
  string of the **same length** as the input, with every byte that is
  not JS/TS code replaced by a space (newlines preserved). AST positions
  and line/column numbers therefore still map one-to-one back to the
  original `.astro` file.
- `readSource(path)` — single fs + extract helper shared by every
  detector's `--no-cache` fallback path.
- `scriptKindFor(path)` — single source of truth for extension →
  `ts.ScriptKind` mapping, used by the AST cache and by every detector
  that still calls `ts.createSourceFile` directly.

Only two kinds of region are extracted in v1:

1. **Frontmatter** — the code between the first two `---` lines, and
   only when the file begins at byte 0 with `---`. Mid-file `---` blocks
   are not honoured (matches the Astro parser's own rule).
2. **Inline `<script>` blocks** — any `<script …>…</script>` tag that
   does NOT carry a `src=` attribute. `<style>` blocks, Astro template
   expressions (`{user.name}` in markup), and external-script bodies
   are all blanked.

Everything else becomes spaces. That includes the `---` fence lines
themselves, the `<script>` / `</script>` tag characters, HTML tags, JSX
expressions, and so on.

`src/project.js` adds `.astro` to `SOURCE_EXTENSIONS`. `src/ast-cache.js`
routes framework files through the extractor before
`ts.createSourceFile`. Every detector that used to inline its own
`fs.readFileSync(absFile, 'utf8')` + `ts.createSourceFile(..., localScriptKindFor(absFile))`
pair now calls `readSource(absFile)` and `scriptKindFor(absFile)` from
this module — ten local helpers collapsed into one.

**Line-number invariant (why we blank rather than strip):**

Snippets and reporter line numbers both come from character offsets
into the cached `code`. If we stripped non-code content, every snippet
and every diagnostic would point at a different line than the one the
reviewer sees in their editor. By keeping the same byte count — spaces
where the markup used to be, newlines where they used to be — the
extracted source has identical line/column geometry to the original.
AST nodes only live inside kept regions (the TS parser never sees the
spaces), so `node.getStart()` / `node.getEnd()` correctly index back
into unmodified script/frontmatter text.

**Scope of v1 (deliberately narrow):**

- **`.astro` only.** `.vue` and `.svelte` use the same mechanism
  (frontmatter-ish block + `<script>` tags with different fences); they
  can ship as additional extractor cases in the same module without
  touching consumers. Logged on `BACKLOG.md` as the v2 slice.
- **No per-script `lang="ts"` / `lang="tsx"` detection.** Every
  `.astro` file parses under `ts.ScriptKind.TS`. Frontmatter is plain
  TypeScript; inline scripts default to JS which TS parses cleanly. If
  a user writes `<script lang="tsx">` with real JSX, it won't parse —
  filed as a v2.5 concern, not observed in real dogfood.
- **No source-mapping.** Because extraction is byte-for-byte
  positional, we get free one-to-one mapping without a sourcemap file.
  If we ever switch to a length-changing extraction we'll need a real
  sourcemap; today we don't.
- **No `<script is:inline>` special-casing.** For coupling analysis
  both compiled and runtime-only scripts are relevant — listeners /
  dispatches / storage writes in either show up in the graph. We parse
  both and leave disambiguation to a later detector.
- **Syntactic extractor only (D5).** No `astro/compiler` dependency,
  no HTML parser, no YAML parser. A regex for the `<script>` shape and
  a fence search for the frontmatter cover every real-world file we've
  looked at; edge cases (quoted `>` inside attribute values, nested
  script-in-template-literal) fall back to "don't extract" rather than
  "crash."

**Alternatives considered:**

- **`@astrojs/compiler` as a dependency.** Rejected. Pulls in a
  wasm/native binding, versions independently of Astro itself, and
  gives us full AST faithfulness we don't use — we only need to know
  where the TS regions live. The regex extractor is 40 lines and
  covers the ~95% case that matters syntactically. If the AI-consumer
  story ever requires full Astro-specific AST facts (hydration
  directives, slots, etc.) we'd revisit.
- **Per-detector extractor awareness.** Rejected. Keeping the
  extraction logic inside every detector means 10 files each need to
  know about `.astro`. That was the status quo for `scriptKindFor`
  and already bit us — the `cross-file-constants.js` helper had
  drifted from the detectors (different structure, no `.mjs` / `.cjs`
  cases). Centralising in `framework-file.js` closes the drift
  vector.
- **Strip markup (length-changing extract).** Rejected. Would make
  the extracted source shorter and easier to read, but break the
  line-number invariant and force a sourcemap round-trip for every
  snippet emitted. Byte-preserving is the cheap safe choice.
- **Extract into a sibling `.ts` file on disk.** Rejected. Writes to
  disk, pollutes workspaces, breaks the "pure in-memory analysis"
  contract. In-memory string swap keeps `--no-cache` and `--cache-stats`
  both working unchanged.
- **Treat the whole `.astro` file as TSX.** Rejected. The TS parser
  would interpret the markup as JSX, which would succeed-ish — but
  produce an AST riddled with JSX elements that the detectors don't
  want to see. Blanking non-script content produces a clean AST
  rooted only at the actual frontmatter / script statements.

**Reasoning:** The `.astro` blind spot was a systematic 100%-miss on
every Astro codebase — every detector showed zero findings on files
where real coupling lived, not because the patterns were absent but
because the files were invisible. Fixing the walker-level support is
mechanically small (40 lines of extractor, one `SOURCE_EXTENSIONS`
entry, one `ast-cache` hook) but unlocks correct behaviour on an
entire class of real codebases. Doing the consolidation of
`scriptKindFor` at the same time turns what would have been "update
11 files every time we add an extension" into "update 2 files"
(`framework-file.js` + `project.js`) — exactly the pattern D13 laid
down for the detector registry.

**Benchmark (self-scan on `code-intel`'s own `src/`):**

- cached, D16 on, warm: 1.38s user / ~0.78s wall (3-run avg, first
  run excluded as cold)
- cached, D15/pre-D16: 1.41s user / ~0.85s wall

Wall-time improved slightly — the consolidation removed a few dozen
duplicated function bodies the Node runtime used to load per detector
module. Cache stats: `size=63 hits=504 misses=63` vs the pre-D16
`size=60 hits=480 misses=60`. The extra 3 cache entries are
`framework-file.js` and its siblings now reachable via the walker in
the self-scan; the extra hits are the detectors touching each of
those files in turn, exactly the multiplicative pattern D14 is
designed to amortise.
