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
