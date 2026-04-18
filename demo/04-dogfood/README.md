# `04-dogfood/` — running code-intel against real open-source code

This folder contains a **real report from running code-intel against a
production open-source codebase**. It is the "does this work on
anything other than your fixtures?" answer. Highest-credibility
artifact in the demo set: the findings below are on code nobody on
this project wrote.

The two artifacts in this folder:

- [`self-dogfood.md`](self-dogfood.md) — code-intel run against its own
  `src/`. One-line answer: **zero findings**. The tool does not
  false-alarm on itself.
- [`excalidraw-report.md`](excalidraw-report.md) — code-intel run
  against the Excalidraw SPA (`excalidraw-app/` from `excalidraw/excalidraw`).
  **42 findings in 1.28 seconds.** One is a high-confidence shared
  global, five are medium-confidence stale-captures. Details below.

## What the dogfood proves

1. **The tool runs on real code.** Excalidraw is ~40 `.ts`/`.tsx`
   files including a 39K-line `App.tsx`. Runtime was under 1.3
   seconds end-to-end. No crashes, no parse errors.
2. **Findings are actionable, not noise.** The high-confidence finding
   (`visualDebug`) is a real cross-file coupling on `window`. The
   medium-confidence stale-captures include **a real SPA bug pattern
   in production code** — `isExcalidrawPlusSignedUser` captures
   `document.cookie` at module scope and never refreshes if the user
   signs in or out mid-session.
3. **The `confidence` + `confidenceReason` fields do real work.** 36 of
   42 findings are `low confidence` because Excalidraw uses a
   `STORAGE_KEYS` constants object, and the v1 detector does not
   const-fold. The report tells the reviewer this out loud instead of
   pretending those are concrete coupling claims. Triage takes seconds.
4. **The tool found its own blind spot.** A listener for
   `beforeinstallprompt` (the PWA install-prompt event) surfaces as a
   medium-confidence finding; that native-browser event is not in our
   `NATIVE_DOM_EVENTS` filter. Adding it is a one-line follow-up. This
   is what dogfood is supposed to produce.

## How to reproduce

From this repo's root, with `git` installed:

```bash
# Clone a shallow, sparse checkout of excalidraw-app (~200KB).
mkdir -p /tmp/codeintel-dogfood
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/excalidraw/excalidraw \
  /tmp/codeintel-dogfood/excalidraw
cd /tmp/codeintel-dogfood/excalidraw
git sparse-checkout set excalidraw-app
cd -

# Run code-intel against it.
node src/cli.js impact /tmp/codeintel-dogfood/excalidraw/excalidraw-app --markdown
```

Output lands on stdout. Redirect to a file to snapshot it:

```bash
node src/cli.js impact /tmp/codeintel-dogfood/excalidraw/excalidraw-app --markdown \
  > /tmp/excalidraw-report.md
```

Self-dogfood is even simpler:

```bash
node src/cli.js impact src --markdown
# => No findings.
```

## Running it on your team's codebase

The dogfood recipe works on any JS/TS project. From the root of a repo
that uses npm / yarn / pnpm:

```bash
# From inside this repo, against a checkout of YOUR app elsewhere:
node /path/to/code-intel/src/cli.js impact /path/to/your/app/src --markdown

# Or against two apps at once (multi-project coupling):
node /path/to/code-intel/src/cli.js impact /path/to/app-a /path/to/app-b --markdown

# With --since to filter to a PR:
node /path/to/code-intel/src/cli.js impact /path/to/app --since main --markdown
```

What to look for in the output, in order of decreasing credibility:

1. **`shared-global-binding` findings at `high confidence`.** These are
   almost always either (a) a real cross-file coupling or (b) an
   intentional debug pattern worth documenting. Either way, worth a
   5-second look.
2. **`shared-storage-key` findings at `high confidence`.** Two-sided
   (write + read in different files) literal-key coupling is the
   canonical shared-state bug. Every such finding is a refactor hazard.
3. **`paired-keys` findings.** Tells you which storage keys must move
   together. Archives design intent that was previously invisible.
4. **`shared-event-channel` findings at `high confidence`.** A
   dispatch-listen pair across files/projects marks an event-bus
   contract with no type enforcement.
5. **`stale-module-capture` findings, cross-referenced against your
   runtime model.** In SPAs / SSR client bundles / workers / long-
   running Node, these bite. In classic MPAs, most don't. The
   `confidenceReason` names the contexts, so the reviewer decides.

## A note on noise

Dogfood output will include findings the tool is not yet confident
about — dynamic keys it cannot fold, one-sided couplings where it can't
see the other side, etc. These ship as `low` or `medium` confidence
with a reason string that says *why*. A tool that suppressed them to
look "clean" would miss the real bugs they occasionally point at.
A tool that shipped them as critical warnings would be indistinguishable
from noise. The confidence field is the difference.

## Credibility checklist for presenting dogfood

When someone asks "where did these findings come from?" the answer
should be provable on the spot:

- [x] **Source is public.** The Excalidraw report is on upstream
      Excalidraw, cloned fresh. Any audience member can reproduce it.
- [x] **Nothing was cherry-picked.** The 42-finding count and the
      severity / confidence breakdown in `excalidraw-report.md` are
      verbatim from the tool. No findings were suppressed.
- [x] **Self-dogfood shows the tool does not false-alarm on itself.**
      A tool with a 30% false-positive rate on its own source would
      fail this test. This one produces zero.
- [x] **One finding is a real SPA bug** (`isExcalidrawPlusSignedUser`)
      that matches the exact pattern the detector was built for.
      That is the dogfood endorsing itself.
