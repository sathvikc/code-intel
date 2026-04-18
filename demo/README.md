# `demo/` — presenting code-intel to a room

This folder is the single place to come when you need to show code-intel
to a team, an architect, a platform group, or a sceptical reviewer. Each
sub-folder is a **different format** for the same thing: a demo that
makes the tool land. Pick whichever one fits the audience; any single one
is self-contained.

The goal across all of them is to make four claims unmistakable:

1. **This is a real bug class.** Not a theoretical category — a shape that
   has bitten real production systems. Every demo anchors in a concrete
   incident, not an abstract rule.
2. **Nothing else catches it.** ESLint / TypeScript / IDE workspace search
   / `ripgrep` cannot, because the signal is a *relationship across
   multiple files*, not a lint at a single line. Every demo calls out,
   per pattern, what grep would see and why it misses the point.
3. **The tool runs in one second and says what it thinks with justified
   confidence.** Every finding carries a `confidence` field and a
   one-paragraph `confidenceReason`. There is no "here are 200 warnings,
   good luck" failure mode.
4. **It's additive to the review process.** This is PR-report infrastructure,
   not a pre-commit blocker. Reviewers (and AI reviewers) get more context;
   nothing breaks.

## The four formats

| Folder | What it is | When to use it |
|---|---|---|
| [`01-live-script/`](01-live-script/) | `demo.sh` runs 4–5 bug scenarios in a terminal, one command per story, with narration in the README. | Live presentation. Wants a room that can see a shared screen. ~8 minutes with time for questions. |
| [`02-hero-fixture/`](02-hero-fixture/) | A believable 2-team mini-app under `team-alpha/` and `team-bravo/` with planted bugs — storage coupling, event channel drift, global collision, paired-key cluster, stale capture. | Need to make code-intel look like "tool on a codebase that could be ours" rather than "tool on toy fixtures". Pairs with any other format. |
| [`03-bug-gallery/`](03-bug-gallery/) | Story-first walkthrough doc. Each pattern has: real-sounding scenario → code that triggers it → production symptom → code-intel output → *explicit* contrast with grep/eslint/IDE-search. | Async audience, or when you need something a staff engineer can read in 10 minutes and decide whether to champion. |
| [`04-dogfood/`](04-dogfood/) | Report from running code-intel against a public open-source codebase. Real findings on code no one planted. | Highest credibility. Answers "does this work on anything other than your fixtures?" Pairs well with a live demo as the closing slide. |

## Suggested running orders

- **8-minute slot at a team standup.** Open `03-bug-gallery/README.md`
  for the opener (~2 min), then run `01-live-script/demo.sh` against
  `02-hero-fixture/` for the live part (~4 min), then flash
  `04-dogfood/report.md` for credibility (~1 min). Leave 1 min for Q&A.
- **15-minute architecture-review slot.** Open with the gallery, deep-dive
  into the `paired-keys` story (it is the most unique signal nothing else
  catches), then the live demo, then dogfood. The `confidence` story —
  "every finding is justified, here's the reason string" — is the
  anti-noise argument that closes the skeptic.
- **Async staff-engineer review.** Just `03-bug-gallery/README.md`. It's
  self-contained and written to be read alone.

## The anti-noise argument (read this before the demo)

The first objection will be "static analysis ships noise, how is this
different?" The answer is structural, not rhetorical:

- **`severity` and `confidence` are split fields.** Severity is "how bad
  if this is a bug"; confidence is "how sure we are it IS a bug".
  Traditional tools collapse the two and ship a wall of warnings.
  code-intel says "medium-confidence warning" for stuff that depends on
  runtime context (like stale module captures in MPAs) and "high-confidence
  critical" for stuff that's undeniable (two scripts declaring the same
  top-level function).
- **Every finding carries a `confidenceReason` paragraph** explaining
  *why* it earns its classification. The reviewer decides whether to act
  in 5 seconds, not 5 minutes.
- **Detectors have explicit must-not-emit rules** written from real
  dogfood. See `src/shared-state-globals.js` (`§2.6` filter) and
  `src/shared-state-events.js` (`NATIVE_DOM_EVENTS` filter) for the
  in-code comments documenting the false-positive classes we have already
  killed.
- **Recall-first by design (D2), reported honestly.** The tool emits
  broadly and lets the `confidence` field do the triage. That is the
  opposite of "silent when it can't be sure," which is what linters do
  and what lets shared-state bugs through.

## One thing to say out loud

> "If you can do it with `grep`, we should have used `grep`. The reason we
> built this is every one of these patterns is a *relationship across
> multiple files*. Grep sees a line. This tool sees a graph."

The demos show graphs the tool draws. That's the whole pitch.
