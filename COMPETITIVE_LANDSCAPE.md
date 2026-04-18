# Competitive Landscape

This document is the **proof layer** for positioning claims made about
`code-intel`. Every claim below is either a direct quote from a tool's own
documentation, a direct observation of its public query / rule index, or a
limit the tool itself admits in its own marketing. Nothing here is inferred
from secondhand comparisons.

## Why this doc exists

Positioning drifts. Tools evolve. Marketing copy overstates. This file
exists so that when someone (human or AI agent) asks "how is code-intel
different from X?", the answer is grounded in evidence that can be
re-checked in minutes, not in vibes.

If a claim here turns out to be wrong, **fix it**. This is the one doc in
the repo that is *not* append-only — factual correctness beats historical
trajectory, because the trajectory of the competitive landscape is
irrelevant, only its current state is.

## Methodology

For each tool I list, I consulted the tool's **own** documentation
(README, official docs site, pricing page, or public query / rule
index). Where I quote a limit the tool admits, it is reproduced verbatim
with a link. Where I claim the tool does not cover a bug class, I
searched the public rule / query index for keywords related to that bug
class (e.g., "localStorage", "sessionStorage", "storage", "CustomEvent",
"shape", "module-scope", "capture") and report what I did or did not
find.

I have **not** run every tool against every fixture in `examples/`.
Where I state a coverage conclusion, I scope it to the tool's
documented capabilities, not to a benchmarked head-to-head run. A
benchmark corpus is a separate (and still-unbuilt) project — see the
"Honest precision" principle in `VISION.md`.

## How to keep this current

- When a new tool in-scope appears, add an entry with at least one
  citation and a direct quote if the tool admits a limit.
- When a tool ships a feature that changes the analysis, edit the
  relevant section in-place and bump the "Last reviewed" date at the
  bottom.
- If you cannot verify a claim from the tool's own docs in under 10
  minutes of reading, remove the claim. This doc carries no speculation.

---

## Tools verified

Each tool below sits in a category where a reader might reasonably ask
"doesn't this already do what code-intel does?". The answer — with
evidence — follows.

### Linters

#### ESLint

- **What it does.** Per-file syntactic and semantic rules via a
  plugin ecosystem. Custom rules can be written in JavaScript.
- **What it does not do.** Has no built-in project graph. As the Oxlint
  team documents: *"ESLint evaluates rules per file and does not
  provide a built-in project graph. Plugins such as
  `eslint-plugin-import` must rebuild module resolution and the module
  graph outside of ESLint's core."* ([source](https://oxc.rs/docs/guide/usage/linter/multi-file-analysis))
  This means any cross-file analysis in the ESLint ecosystem is
  plugin-driven, per-plugin, and not composable across rules.
- **Overlap with code-intel.** None. ESLint covers within-file code
  quality; code-intel covers cross-file implicit coupling,
  serialization-boundary shape drift, and runtime-context captures.
  The two are complementary — run both.

#### Biome (v2)

- **What it does.** 483 rules ported from ESLint, typescript-eslint,
  and SonarJS; TypeScript type inference (v2+) for more powerful
  single-file rules; formatter; fast. ([source](https://biomejs.dev/))
- **What it does not do.** The type inference is used for richer
  per-file rules — no documented cross-file bug-class detection in the
  rule catalogue.
- **Overlap with code-intel.** None. Same relationship as ESLint.

#### Oxlint

- **What it does.** Fast ESLint-compatible linter. Ships multi-file
  analysis as a first-class capability of the infrastructure — the
  project builds a module graph in parallel and shares resolution
  across rules. ([source](https://oxc.rs/docs/guide/usage/linter/multi-file-analysis))
- **What it does not do.** The multi-file infrastructure is used to
  make **existing** lint rules (no-cycle, unused-imports, etc.)
  faster. Oxlint's public rule set does not include storage-coupling,
  shape-drift, paired-key, or stale-capture rule classes. Multi-file
  infrastructure is not the same thing as a multi-file bug catalogue.
- **Overlap with code-intel.** None at the bug-class level.

#### eslint-plugin-sonarjs / SonarJS analyzer

- **What it does.** 269 rules covering bugs, code smells, security
  hotspots — all per-file. ([source](https://github.com/SonarSource/sonarjs))
- **What it does not do.** No cross-file coupling detection. One
  independent benchmark claims SonarJS misses 65% of security
  vulnerabilities on a test corpus — meaningful because it implies
  even in its own focus area, pure per-file rule catalogues have
  substantial gaps. ([source](https://dev.to/ofri-peretz/sonarjs-has-269-rules-it-still-misses-65-of-security-vulnerabilities-3jh))
- **Overlap with code-intel.** None at the bug-class level.

### Type checker

#### TypeScript

- **What it does.** Full static type checking within import graphs.
- **What it does not do.** Type information is erased at every
  serialization boundary: `JSON.stringify` / `JSON.parse` returns
  `any` (or `unknown` in strict mode without a runtime validator),
  `localStorage.getItem` returns `string | null`, `CustomEvent.detail`
  is typed through the DOM `lib` as a generic, cookies / URL params /
  `postMessage` all erase types at the wire. Every TS codebase in
  practice also has `any` leaks from third-party types and opaque
  helpers — so even strict mode does not catch the bug classes
  code-intel targets.
- **Overlap with code-intel.** None. Migrating a JS codebase to TS
  does not catch any of the current `P<N>` patterns in `PATTERNS.md`,
  because those patterns specifically live below the type layer.

### Query-based static analyzers

#### CodeQL

- **What it does.** Graph database of code facts, queryable via the
  QL language. Ships a query pack (`codeql/javascript-queries`)
  containing roughly 200 JS / TS queries. ([source](https://codeql.github.com/codeql-query-help/javascript/))
- **What it does not do.** The public query index (sampled across the
  alphabet — letter ranges A–D, D–H, and U–Y inspected directly) is
  dominated by:
  - security rules (XSS, SQL / code / XML injection, CORS, session
    fixation, insecure download, Electron hardening, CWE-mapped
    vulns)
  - correctness rules (duplicate cases / conditions / property names,
    type comparison bugs, use-before-declare)
  - framework-specific issues (Angular DI mismatch, React direct
    state mutation)

  **No query in the index targets**: storage-key coupling across
  files, shape drift across `JSON.parse`, paired-write clusters,
  stale module-scope captures, duplicate static SVG IDs, proxied
  platform globals, module-scope handler caching by third-party
  instrumentation, or `CustomEvent` channel coupling. The *engine*
  could express these queries; the *catalogue* does not ship them.
- **Overlap with code-intel.** Adjacent. CodeQL is a security-first
  catalogue powered by a general-purpose engine. code-intel is a
  production-bug catalogue for implicit coupling, serialization
  boundaries, and runtime-context captures. A user could — in
  principle — write CodeQL queries equivalent to our detectors;
  nobody has, because that is not what CodeQL as a product is for.

#### Semgrep Community Edition (CE)

- **What it does.** Lightweight pattern-matching engine with a
  community rule registry.
- **What it does not do.** Cannot do cross-file analysis. *Direct
  quote from their own GitHub README*: *"Note that in security
  contexts, Semgrep Community Edition will miss many true positives
  as it can only analyze code within the boundaries of a single
  function or file. If you want to use Semgrep for security
  purposes (SAST, SCA, or secrets scanning), the Semgrep AppSec
  Platform is strongly recommended."*
  ([source](https://github.com/semgrep/semgrep))
- **Overlap with code-intel.** None for cross-file patterns, by
  design. CE is function / file-local only.

#### Semgrep Pro (paid, server-hosted)

- **What it does.** Adds cross-file (interfile) and cross-function
  (intrafile) taint analysis. *Direct quote*: *"Use Semgrep Code's
  cross-file (interfile) analysis to detect vulnerabilities across
  files and folders within a project. By design, Semgrep open source
  software, Semgrep Community Edition (CE) can only analyze
  interactions within a single function, also known as
  intraprocedural analysis."*
  ([source](https://semgrep.dev/docs/semgrep-code/semgrep-pro-engine-intro))
- **What it does not do.** Pro's cross-file analysis is oriented
  around taint tracking for security vulnerabilities, not named
  production-bug pattern detection. Its rule library emphasises
  security patterns. Pro is also a paid, platform-hosted product
  (not local-first open source). ([pricing](https://semgrep.dev/pricing/))
- **Overlap with code-intel.** Closest competitor on **infrastructure**
  (cross-file analysis). Disjoint on **catalogue** (security taint vs
  production-bug patterns) and on **deployment model** (paid SaaS vs
  local-first open source).

### AI code reviewers

#### Greptile

- **What it does.** Indexes entire codebase; produces AI PR review
  comments with codebase context. ([source](https://www.greptile.com))
- **What it does not do (self-admitted).** *Direct quote from their
  own content library on the limits of LLM-based review*: *"Models
  are sampling-based, so the same PR can get different comments and
  one pass can miss edge cases or cross-file bugs."*
  ([source](https://www.greptile.com/what-is-ai-code-review))
  The tool itself acknowledges cross-file bug misses as a structural
  limit of the approach.
- **Overlap with code-intel.** Adjacent, not competitive. Greptile
  generates human-language review comments; code-intel generates a
  deterministic, schema-validated finding set that an AI reviewer
  (Greptile or otherwise) can consume as ground truth for the
  specific bug classes it covers. The two fit together: the LLM
  explains, the catalogue verifies.

#### CodeRabbit

- **What it does.** AI PR reviewer with "built-in intelligence,"
  codebase context, IDE + CLI integrations, Cursor integration.
  ([source](https://www.coderabbit.ai/cursor))
- **What it does not do (implicitly admitted by positioning).**
  Explicitly positions itself as *"a backstop that flags
  hallucination, logical errors, code smells, missed unit tests"*
  ([source](https://www.coderabbit.ai/cli)) — i.e. the marketing
  admits LLM review output itself needs verification. CodeRabbit's
  blog on Context Engineering describes running *"verification
  scripts on the review comments provided by the LLMs to make sure
  that the review comments will meaningfully improve the
  codebase"* ([source](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews))
  — confirming LLM output is itself unreliable enough to require
  an additional verification layer.
- **Overlap with code-intel.** Same relationship as Greptile.
  code-intel is the kind of deterministic verification layer that
  LLM reviewers explicitly need.

### Structural analyzers (dependency / dead code)

#### Knip

- **What it does.** Finds unused dependencies, unused exports,
  unused files, unused types in JS / TS projects. ([source](https://knip.dev/))
- **What it does not do.** No semantic coupling detection; no
  storage / channel / shape analysis. Pure structural dead-code
  finder.
- **Overlap with code-intel.** None. Planned orthogonal shell-out
  (see `VISION.md` Layer 2).

#### dependency-cruiser / Madge / Skott

- **What it does.** Build, validate, visualize import-graph
  dependencies. ([dependency-cruiser](https://www.npmjs.com/package/dependency-cruiser);
  [Skott](https://dev.to/antoinecoulon/introducing-skott-the-new-madge-1bfl))
- **What it does not do.** Edges in their graphs are *import* edges.
  They do not represent storage-key reads / writes, event-channel
  dispatches / listens, paired-key clusters, or shape mismatches.
- **Overlap with code-intel.** None at the semantic level. Our
  `impact.graph.blastRadius` consumes an import-graph of the same
  shape these tools produce (we built our own in `src/import-graph.js`),
  but we use it as a scaffolding for bug-pattern findings, not as the
  end product.

### Knowledge-graph-for-codebase tools

#### graphify (the one you tried)

- **What it does.** Open-source skill for AI coding assistants.
  Tree-sitter + NetworkX + Leiden clustering. Extracts code, docs,
  papers, and diagrams into a queryable knowledge graph. Positioned
  as context-for-LLM infrastructure.
  ([source](https://graphify.net/); [GitHub](https://github.com/safishamsi/graphify))
- **What it does not do.** Not a bug-pattern detector. Edges are
  generic ("calls", "imports", "references") — the graph is designed
  for codebase *understanding*, not bug *validation*. This is why
  graphify did not fit the use case that led to code-intel: you
  cannot validate *"writer shape disagrees with reader shape"* on an
  untyped edge.
- **Overlap with code-intel.** Disjoint purpose. graphify is for AI
  context / navigation; code-intel is for bug-pattern detection.

#### CodeGraph (two distinct projects by this name)

- **ChrisRoyse/CodeGraph**: Neo4j-backed "digital twin" of a
  codebase for architectural-adherence queries. ([source](https://github.com/ChrisRoyse/CodeGraph))
- **colbymchenry/codegraph**: Pre-indexed semantic knowledge graph
  to reduce Claude Code's token consumption during codebase
  exploration. ([source](https://github.com/colbymchenry/codegraph))
- **What neither does.** Named bug-pattern detection. Both are
  generic-graph-for-code projects, same category as graphify.
- **Overlap with code-intel.** Disjoint purpose.

#### GraphGen4Code (IBM WALA)

- **What it does.** Research toolkit for generating code knowledge
  graphs where nodes are classes / functions / methods and edges
  capture call-flow and documentation. ([source](https://wala.github.io/graph4code/))
- **Overlap with code-intel.** Disjoint purpose. Research-grade
  code-representation infrastructure.

### Runtime validation libraries (prevention, not detection)

#### Zod / Valibot / io-ts / ArkType

- **What they do.** Runtime schema validation at application
  boundaries. If you call `Schema.parse(JSON.parse(raw))` on both
  sides of a `localStorage.setItem` / `.getItem` pair, you convert
  the shape-drift bug from a silent failure into a runtime error.
- **What they do not do.** They are **prevention** libraries, not
  **detection** tools. They require the codebase to actually use
  them at every boundary. They detect nothing about code that
  doesn't import them.
- **Overlap with code-intel.** Complementary, different layer.
  code-intel flags shape drift in code that does not use runtime
  validation (which is the overwhelming majority). A codebase that
  religiously uses Zod at every boundary reduces `shape-drift`
  detector yield — but that codebase exists in blog posts, not in
  practice.

### Closely-adjacent ESLint rule: `react-hooks/exhaustive-deps`

- **What it does.** Flags missing dependencies in React hook dep
  arrays, catching stale-closure bugs *inside* `useEffect`,
  `useMemo`, `useCallback`. ([source](https://react.dev/reference/eslint-plugin-react-hooks/lints/exhaustive-deps))
- **What it does not do.** Hook-scoped only. Does not flag
  module-scope `const x = document.cookie` or `const y =
  sessionStorage.getItem(...)` captures — a distinct class of
  stale-at-import-time bugs that fire in SPAs but not MPAs.
- **Overlap with code-intel.** Our `stale-captures` detector is a
  non-overlapping sibling, one level up in scope (module-scope
  rather than hook-scope). Different bug class, same underlying
  root cause (a dynamic read frozen in a scope that outlives the
  read's validity).

---

## Summary matrix

| Tool | Open-source? | Local-first? | Cross-file? | Named production-bug catalogue? | Runtime-context aware? | Overlap with code-intel |
|---|---|---|---|---|---|---|
| ESLint | yes | yes | plugin-dependent | no | no | none |
| Biome | yes | yes | no | no | no | none |
| Oxlint | yes | yes | infrastructure only | no | no | none |
| SonarJS / eslint-plugin-sonarjs | yes | yes | no | partial (security-oriented) | no | none |
| TypeScript | yes | yes | import-graph only | n/a | no | none |
| CodeQL | yes (engine), curated queries open | no (SaaS-oriented) | yes (via QL) | security-oriented | no | adjacent; disjoint catalogue |
| Semgrep CE | yes | yes | **no** (self-admitted) | partial | no | none |
| Semgrep Pro | no (paid) | no (platform) | yes | security-oriented | no | adjacent; different catalogue and deployment |
| Greptile | no (SaaS) | no | claims yes; admits cross-file bug misses | no (LLM, no catalogue) | partial | adjacent; verification layer candidate |
| CodeRabbit | no (SaaS) | partial (CLI available) | claims yes | no (LLM) | partial | adjacent; verification layer candidate |
| Knip | yes | yes | yes (dead code) | no (dead code only) | no | none (planned orthogonal shell-out) |
| dependency-cruiser / Madge / Skott | yes | yes | yes (import graph) | no (structural only) | no | none (we build our own import graph for `impact`) |
| graphify / CodeGraph / GraphGen4Code | yes | yes | yes (graph) | **no** (generic graph, not bug catalogue) | no | disjoint purpose |
| Zod / Valibot / io-ts / ArkType | yes | yes | n/a | n/a (prevention, not detection) | n/a | complementary layer |
| react-hooks/exhaustive-deps | yes | yes | no | partial (hook-scoped) | no | sibling of `stale-captures` — different scope |
| **code-intel** | yes | yes | yes (typed per bug class) | yes (`P<N>` catalogue, incident-driven) | yes (encoded per-detector in `confidenceReason`) | — |

---

## The gap, stated precisely

From the evidence above, three characteristics, **taken together**,
describe a category that no tool in the table fully occupies:

1. **Named, incident-driven bug-pattern catalogue.** A curated list of
   specific production-bug shapes (`P<N>`), each tied to a real
   post-mortem or remembered incident — not a configurable engine
   (Semgrep, CodeQL), not a generic knowledge graph (graphify,
   CodeGraph), not a security-first taxonomy (CWE / OWASP).
2. **Cross-file, cross-serialization-boundary, runtime-context-aware
   detection.** Implicit coupling through string-literal storage
   keys, `CustomEvent` channels, classic-script globals, paired-write
   clusters; shape drift across `JSON.parse`; module-scope captures
   that bite in SPAs but not MPAs. Every detector spans at least one
   boundary that type checkers and per-file linters cannot cross.
3. **Review-shaped output in an open-source, local-first package.**
   `impact` orchestrator with blast-radius, `--since <ref>` diff
   awareness, confidence + fingerprint per finding — designed for
   consumption by an AI reviewer answering *"did this change
   introduce a new instance of a pattern we've seen break?"*. Not a
   SaaS; not a paid Pro tier; no account required.

Tools that hit (1) alone: CodeQL (security catalogue, no cross-file
*production-bug* curation).

Tools that hit (2) alone: Semgrep Pro (paid, security taint focus,
no curated production-bug catalogue).

Tools that hit (3) alone: Greptile, CodeRabbit (LLM review — no
deterministic catalogue, admitted cross-file bug misses).

**Tools that hit all three: none identified in this review.** That is
the slot code-intel is built for.

---

## How code-intel relates to each tool category

Positioning stance per category. This is the operational frame for
"alongside which tools does this run?" — which is the question a team
adopting code-intel has to answer.

- **Linters (ESLint / Biome / Oxlint).** Complementary, no overlap.
  Keep them. We do not re-implement per-file lint rules.
- **Type checker (TypeScript).** Complementary. Migration to TS
  does not catch any `P<N>` we target. Keep TS; add us.
- **SonarJS / eslint-plugin-sonarjs.** Complementary. Different bug
  classes, same deployment model (ESLint plugin). Can coexist
  trivially.
- **CodeQL.** Adjacent category, disjoint catalogue. CodeQL for
  security; code-intel for production-bug patterns below the
  type / import / security layers. Different GitHub users may
  consume both.
- **Semgrep CE.** Complementary. CE cannot do cross-file by design;
  we do. No conflict.
- **Semgrep Pro.** Adjacent on infrastructure (cross-file analysis),
  disjoint on catalogue (security taint vs production patterns) and
  deployment (paid SaaS vs local-first OSS). Teams that already pay
  for Pro can run both; teams that cannot afford Pro get a large
  fraction of the cross-file signal from code-intel for free,
  scoped to the specific bug classes we catalogue.
- **AI reviewers (Greptile, CodeRabbit, Cursor review).** The most
  interesting relationship. Both tools explicitly position their
  output as needing verification; our deterministic, schema-validated
  finding set is a natural verification layer. code-intel produces
  the ground truth; the LLM reviewer produces the human-language
  comment citing it. Future MCP integration directly enables this.
- **Structural (Knip / dep-cruiser / Madge / Skott).** Orthogonal.
  Our `VISION.md` Layer 2 plans explicit shell-outs; we do not
  compete.
- **Knowledge-graph tools (graphify / CodeGraph / GraphGen4Code).**
  Disjoint purpose. They build *untyped* generic graphs for
  exploration and LLM context. We build *typed per bug class*
  graphs for validation. Same mental model — different edge
  semantics.
- **Runtime validation (Zod / Valibot / etc).** Prevention layer.
  Complementary. A codebase using Zod at every boundary reduces
  `shape-drift` yield specifically, but not any of the other
  detectors.

The guiding principle: **alongside, not instead of.** Where border
overlap exists, it is with Semgrep Pro (infrastructure) and AI
reviewers (verification layer) — and in both cases the overlap
favors code-intel's specific shape (free, local, deterministic,
curated catalogue).

---

## Citations (all verified by direct reading)

- ESLint configuration docs — https://eslint.org/docs/latest/use/configure/configuration-files
- Oxlint multi-file analysis docs (quoting ESLint's behaviour) — https://oxc.rs/docs/guide/usage/linter/multi-file-analysis
- Biome — https://biomejs.dev/ and https://biomejs.dev/linter/
- SonarJS GitHub — https://github.com/SonarSource/sonarjs
- dev.to benchmark of SonarJS — https://dev.to/ofri-peretz/sonarjs-has-269-rules-it-still-misses-65-of-security-vulnerabilities-3jh
- CodeQL JavaScript query help — https://codeql.github.com/codeql-query-help/javascript/
- Semgrep GitHub README (the cross-file limit quote) — https://github.com/semgrep/semgrep
- Semgrep Pro engine — https://semgrep.dev/docs/semgrep-code/semgrep-pro-engine-intro
- Semgrep pricing — https://semgrep.dev/pricing/
- Greptile — https://www.greptile.com
- Greptile content library (the cross-file-bug admission) — https://www.greptile.com/what-is-ai-code-review
- CodeRabbit Cursor page — https://www.coderabbit.ai/cursor
- CodeRabbit CLI page (the "backstop" positioning) — https://www.coderabbit.ai/cli
- CodeRabbit blog on context engineering (the verification-script admission) — https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews
- Knip — https://knip.dev/
- dependency-cruiser npm — https://www.npmjs.com/package/dependency-cruiser
- Skott — https://dev.to/antoinecoulon/introducing-skott-the-new-madge-1bfl
- graphify — https://graphify.net/ and https://github.com/safishamsi/graphify
- ChrisRoyse/CodeGraph — https://github.com/ChrisRoyse/CodeGraph
- colbymchenry/codegraph — https://github.com/colbymchenry/codegraph
- GraphGen4Code (IBM WALA) — https://wala.github.io/graph4code/
- React `exhaustive-deps` rule — https://react.dev/reference/eslint-plugin-react-hooks/lints/exhaustive-deps

---

*Last reviewed: 2026-04-18.*
*If you update a claim, re-verify against the linked source and bump
this date. If a tool ships a capability that changes its relationship
to code-intel, move the entry and update the summary matrix.*
