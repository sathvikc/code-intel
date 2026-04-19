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
