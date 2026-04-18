# `01-live-script/` — the live demo

A runnable terminal demo you can project on a shared screen at a team
meeting. Walks through four bug scenarios back-to-back. Each one shows
the real code, then what `grep` would find, then what code-intel
finds. Total runtime is about 5-6 minutes.

## How to run it

From the repo root:

```bash
# Auto-play (each step pauses ~2s; whole demo ~6 min)
./demo/01-live-script/demo.sh

# Interactive (wait for Enter between steps; go at your own pace)
./demo/01-live-script/demo.sh -i

# Fast (no pauses; useful for smoke-testing the script itself)
./demo/01-live-script/demo.sh -f
```

The script is self-contained. It reads from `examples/app-a/` and
`examples/app-b/` — no modifications, no side effects.

## What the audience will see

1. **Opening frame** — 15 seconds. What the tool is, what we are going
   to show, why you should care.
2. **Scenario 1 — Classic-script global overwrite.** Two teams, two
   `.js` files, both defining a top-level `function parseCookie()`.
   Grep sees two definitions; code-intel proves they will collide.
3. **Scenario 2 — Cross-project CustomEvent shape contract.**
   App A dispatches `'profile:changed'`, App B listens. Grep sees the
   string; code-intel surfaces the dispatcher-listener pair with its
   implicit payload contract.
4. **Scenario 3 — The paired-key cache bug.** Two storage keys that
   must be written together, extracted automatically from the source.
   The most unique signal the tool produces.
5. **Scenario 4 — Stale module-scope capture.** The context-dependent
   pattern. Shows how `confidence: medium` + a reason string lets the
   reviewer decide in 5 seconds whether this is a bug in their runtime.
6. **Closing frame** — the unified `impact` report, so the audience
   sees everything together as a PR-style artifact.

## Narration tips

- **Do not read the code aloud.** Let it sit on screen for 3 seconds
  and narrate what it *is* (e.g. "this is App A's cookie helper,
  loaded as a classic script"). The room sees the code; saying the
  words on screen just wastes time.
- **When a finding appears, read the `confidenceReason` out loud** — it
  is written to be readable, and it answers the "how do we know this is
  real?" question everyone has.
- **Close with the `impact` report**. This is the PR-review artifact.
  If nothing else lands, this is the thing they will remember.

## What to say if someone asks "can I just grep for this?"

> "You can grep for the strings involved. What you cannot grep for is
> the *relationship*. Let me show you."

Then run the demo. The contrast is the pitch.

## Script internals

`demo.sh` is a plain bash script that calls `node src/cli.js` and a
few `rg` commands. It does not need any dependencies beyond what the
repo already has (Node, TypeScript as a Node dep, and `rg`
`ripgrep`).

If `rg` is not on the presenter's machine, the script falls back to
`grep -rn`. The demo degrades gracefully.
