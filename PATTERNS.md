# Pattern log

Append-only log of production bug patterns — observed by this team, read
about in post-mortems, or remembered from past incidents. Each entry is
raw material for a future detector. Some map to an existing analyzer in
`src/`; others are open candidates.

This file exists because the product owner explicitly does not want to
rely on remembering which bugs they've shared. Dump it once, it's logged,
it won't be lost.

## Entry format

Each `P<N>` entry captures:
- **Title** — one line, ideally in the product owner's own words
- **Symptoms** — what you see when it breaks (what brings someone to debug)
- **Root cause** — what's actually wrong
- **Static signal** — what a tool could plausibly see in source code
- **Detector** — `built (<id>)` / `partial (<id>)` / `planned` / `not-yet-designed`
- **Source** — where the pattern came from (real incident / postmortem / article)

Vivid original wording is preserved on purpose — narrative is the best
recall anchor when revisiting months later.

---

## P1 — Same `localStorage` / `sessionStorage` key used across files

- **Symptoms:** user state inconsistent; one file writes a value, another reads a stale or wrong-shape one; no one has a mental model of who owns the key.
- **Root cause:** two or more files coordinate by agreeing on a literal key string. No central declaration, no typing, no audit trail.
- **Static signal:** same key string appears in `localStorage.*` / `sessionStorage.*` calls across ≥2 files (or projects).
- **Detector:** built — `shared-state` (`src/shared-state-web-storage.js`).
- **Source:** foundational POC pattern.

## P2 — `window` / `globalThis` CustomEvent channel coupling

- **Symptoms:** an event listener silently stops receiving messages; or starts receiving payloads of the wrong shape after an unrelated change.
- **Root cause:** the dispatcher and the listener live in different files (often different projects) and agree only on a string channel name. No type contract, no compile-time link.
- **Static signal:** same event name literal in `dispatchEvent(new CustomEvent(...))` and `addEventListener(...)` across files.
- **Detector:** built — `shared-events` (`src/shared-state-events.js`).
- **Source:** common micro-frontend / multi-bundle pattern.

## P3 — Classic-script global-binding collision (e.g. `getCookie`)

- **Symptoms:** intermittent, environment-dependent behavior. The later-loaded script silently overwrites an identically-named global from an earlier one. Sometimes a deploy order change is enough to invert the bug.
- **Root cause:** two unrelated `.js` files (loaded as classic scripts, not ES modules) each declare a top-level `function X(...)` or `var X = ...`. Both become properties of `window`.
- **Static signal:** same name declared at top-level in ≥2 non-module source files; or explicit `window.X = ...` / `globalThis.X = ...` writes colliding with those.
- **Detector:** built — `shared-globals` (`src/shared-state-globals.js`).
- **Source:** real incident — two teams independently defined `function getCookie(name)` and the cookie-parsing logic silently flipped depending on load order.

## P4 — SSR-injected value vs CSR-cached value with shape drift

- **Symptoms:** feature flags appear stale or wrong-shaped after a deploy; CSR code path reads yesterday's serialized structure; SSR and CSR give different answers for the same key.
- **Root cause:** the SSR inline script writes storage key `K` with shape `S1`; the CSR loader caches key `K` with shape `S2` and a TTL. Same key, two writers, two shapes. When the CSR cache is fresh it serves the stale shape.
- **Static signal:** same storage key written by ≥2 sources with structurally different right-hand-side expressions. Bonus: at least one of those writers is an SSR/inline context (Astro `<script is:inline>`, Next.js `__NEXT_DATA__`, Remix meta, etc.).
- **Detector:** partial — `shared-state` surfaces the coupling. Shape-drift detection not yet built (see BACKLOG → wrapper / shape inference).
- **Source:** real incident — Astro SSR inline script and CSR hydration both wrote `sessionStorage['flags']` in incompatible shapes.

## P5 — Stale module-scope capture of a dynamic source

- **Symptoms:** some module-local "constant" doesn't reflect mid-session changes — cookie flipped, storage updated by another script, flag toggled — but consumers keep reading the frozen value and misbehaving.
- **Root cause:** a `const / let / var` at module scope was initialized from a dynamic source (`document.cookie`, `sessionStorage.getItem`, `navigator.*`, `fetch(...)`, or a wrapper function that touches any of these). The value is captured once at module load and never re-read.
- **Static signal:** module-scope variable declaration whose initializer expression tree contains either a direct dynamic API call/read or a call to a function whose body does. Cross-file reader detection works by function name.
- **Detector:** built — `stale-captures` (`src/stale-module-capture.js`).
- **Source:** real incident — `const customerType = getCustomerType()` at module scope where `getCustomerType` read `document.cookie`; impersonation and login flows silently saw the pre-impersonation customer type.

## P6 — Duplicate hard-coded IDs in inline SVG components rendered many times

- **Symptoms:** visual corruption in pages where an icon/component is rendered multiple times. Gradients render as solid colors, filters disappear, masks fill with wrong content. Only happens in pages with pre-rendering, SSR-of-many-instances, long repeating lists, or nav panels rendered for every tab up front.
- **Root cause:** the component contains an inline `<svg>` with a `<defs>` block declaring `<linearGradient id="myGrad">` (or `<mask>`, `<filter>`, `<clipPath>`, etc.) and later references it via `fill="url(#myGrad)"`. **SVG IDs are global to the document, not scoped to the component.** When the component is rendered N times, there are N elements with `id="myGrad"` in the DOM. Browsers resolve `url(#myGrad)` to the *first* one — every copy after the first renders against a definition that may not match, or whose parent was removed. Deleting the ID breaks the reference entirely; the fix is programmatic ID namespacing per instance.
- **Static signal:** a component source file contains an inline `<svg>` with an element carrying a `id="<static-string>"` attribute AND another element in the same SVG referencing `url(#<same-static-string>)`. Literal string → very likely to collide when rendered >1 time.
- **Detector:** not-yet-built. Candidate name: `duplicate-static-svg-id` or `svg-id-collision`.
- **Source:** real incident — team pre-rendered all navigation menu panels for SEO; icon SVGs with hardcoded IDs (`myGrad`, etc.) collided across dozens of instances. Spent a morning debugging before the root cause was found. Fix required per-instance ID namespacing.
- **Note:** the story also contains a meta-lesson ("be honest about why you're optimizing") — not a detector concern, but worth keeping in mind as we decide *what* we flag: some coupling exists for legitimate reasons, so findings should describe the pattern, not moralize about it.

## P7 — Module-scope function reference used as event-handler, caught by third-party instrumentation wrapper

- **Symptoms:** clicks / handlers silently stop firing. **Only in production.** Dev server, localhost, preview environments — all fine. No error logs. UI is "dead" — elements are there, events don't run.
- **Root cause:** the codebase uses a module-scope function (e.g. `function onClick(e) { ... }` at file top level) and passes it by reference into `addEventListener(..., onClick)` inside a setup function. The setup function is called multiple times (re-init, route change, re-hydration). In production, a third-party analytics / instrumentation layer wraps `addEventListener` and caches handler references internally — when it sees the same reference come in twice, it assumes it's already registered and skips calling through. Because the module-scope function's reference is stable across re-inits, the wrapper's cache thinks "already done" from the second call onward, and the handler stops firing. Dev environments don't have the wrapper, so the bug is invisible locally.
- **Fix:** move the handler *inside* the setup function so every re-init produces a fresh function reference. The wrapper sees a new reference and registers it.
- **Static signal:** a module-scope function declaration whose name is later passed (by identifier, not called) to `addEventListener` — especially inside a function that itself can be invoked multiple times (exported setup / init / hydrate functions, or called from an effect / route change handler). Noisier version: any module-scope function used as a callback passed to `addEventListener` anywhere.
- **Detector:** not-yet-built. Candidate name: `stable-handler-reference` or `module-scope-handler`.
- **Source:** real incident — prod-only UI deadness, hours of chasing ghosts (naming issue? race condition?), finally traced to the analytics wrapper's handler cache. Lesson captured by the team: **local correctness doesn't guarantee production success when third-party wrappers are in play.**

---

## Adding a new entry

When the product owner shares a new bug (narrative form, LinkedIn post,
Slack dump, memory of a bad week, postmortem) — append a new `P<N>`
entry without waiting to be asked. Follow the format above. Preserve
vivid original phrasing in Symptoms and Root cause.

If the pattern maps to an existing analyzer, update its Detector line
when the analyzer is extended to cover it. If it needs a new analyzer,
add a one-line entry to `BACKLOG.md` → `## Analyzers` pointing back to
the `P<N>` number.

Do **not** delete entries. Patterns don't expire; detectors may change
how they're covered, but the bug shape stays in the log.
