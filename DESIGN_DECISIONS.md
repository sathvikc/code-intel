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
