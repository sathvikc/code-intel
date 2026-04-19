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

## P3 — Classic-script global-binding collision across non-module scripts

- **Symptoms:** intermittent, environment-dependent behavior. The later-loaded script silently overwrites an identically-named global from an earlier one. Sometimes a deploy order change is enough to invert the bug.
- **Root cause:** two unrelated `.js` files (loaded as classic scripts, not ES modules) each declare a top-level `function X(...)` or `var X = ...`. Both become properties of `window`.
- **Static signal:** same name declared at top-level in ≥2 non-module source files; or explicit `window.X = ...` / `globalThis.X = ...` writes colliding with those.
- **Detector:** built — `shared-globals` (`src/shared-state-globals.js`).
- **Source:** real incident — two independently-authored classic scripts each defined the same top-level helper function at the same name; the cookie-parsing logic silently flipped depending on load order.

## P4 — SSR-injected value vs CSR-cached value with shape drift

- **Symptoms:** feature flags appear stale or wrong-shaped after a deploy; CSR code path reads yesterday's serialized structure; SSR and CSR give different answers for the same key.
- **Root cause:** the SSR inline script writes storage key `K` with shape `S1`; the CSR loader caches key `K` with shape `S2` and a TTL. Same key, two writers, two shapes. When the CSR cache is fresh it serves the stale shape.
- **Static signal:** same storage key written by ≥2 sources with structurally different right-hand-side expressions. Bonus: at least one of those writers is an SSR/inline context (server-rendered inline `<script>` blocks, `__NEXT_DATA__`-style hydration payloads, framework-specific inline script directives).
- **Detector:** partial — `shared-state` surfaces the coupling; `shape-drift` (v1, storage channel) now catches the literal-shape vs literal-shape mismatch case. The SSR-inline-script opaque-writer case is still a v2 problem (writer's RHS is an identifier, not an object literal, so v1 can't see its shape).
- **Source:** real incident — an SSR-framework inline script and a CSR hydration path both wrote the same `sessionStorage` key in incompatible shapes.

## P5 — Stale module-scope capture of a dynamic source

- **Symptoms:** some module-local "constant" doesn't reflect mid-session changes — cookie flipped, storage updated by another script, flag toggled — but consumers keep reading the frozen value and misbehaving.
- **Root cause:** a `const / let / var` at module scope was initialized from a dynamic source (`document.cookie`, `sessionStorage.getItem`, `navigator.*`, `fetch(...)`, or a wrapper function that touches any of these). The value is captured once at module load and never re-read.
- **Static signal:** module-scope variable declaration whose initializer expression tree contains either a direct dynamic API call/read or a call to a function whose body does. Cross-file reader detection works by function name.
- **Detector:** built — `stale-captures` (`src/stale-module-capture.js`).
- **Source:** real incident — a module-scope `const` initialised from a helper that read `document.cookie`; session-context changes (login, role switch, admin tooling that swaps the active session) silently left the module reading the pre-change value for the rest of the page lifetime.

## P6 — Duplicate hard-coded IDs in inline SVG components rendered many times

- **Symptoms:** visual corruption in pages where an icon/component is rendered multiple times. Gradients render as solid colors, filters disappear, masks fill with wrong content. Only happens in pages with pre-rendering, SSR-of-many-instances, long repeating lists, or nav panels rendered for every tab up front.
- **Root cause:** the component contains an inline `<svg>` with a `<defs>` block declaring `<linearGradient id="icon-fx">` (or `<mask>`, `<filter>`, `<clipPath>`, etc.) and later references it via `fill="url(#icon-fx)"`. **SVG IDs are global to the document, not scoped to the component.** When the component is rendered N times, there are N elements with the same ID in the DOM. Browsers resolve `url(#icon-fx)` to the *first* one — every copy after the first renders against a definition that may not match, or whose parent was removed. Deleting the ID breaks the reference entirely; the fix is programmatic ID namespacing per instance.
- **Static signal:** a component source file contains an inline `<svg>` with an element carrying a `id="<static-string>"` attribute AND another element in the same SVG referencing `url(#<same-static-string>)`. Literal string → will collide on every repeated render.
- **Detector:** built — `duplicate-static-svg-id` (`src/duplicate-static-svg-id.js`). Per D10, emits only when multi-render is demonstrable: in-file loop, caller-loop via the reverse import graph, same-component duplicate, or cross-component duplicate. A lone component with a static id and no visible multi-render stays silent.
- **Source:** real incident — a team pre-rendered all navigation panels up front; icon SVGs with hardcoded IDs (`icon-fx` and similar) collided across dozens of instances. Spent a morning debugging before the root cause was found. Fix required per-instance ID namespacing.
- **Note:** the story also carries a meta-lesson — the original optimization was pitched for one benefit but kept for another. Not a detector concern, but worth remembering as we decide *what* we flag: some patterns exist for legitimate reasons, so findings should describe the pattern, not moralize about it.

## P7 — Module-scope function reference used as event-handler, caught by third-party instrumentation wrapper

- **Symptoms:** clicks / handlers silently stop firing. **Only in production.** Dev server, localhost, preview environments — all fine. No error logs. UI is "dead" — elements are there, events don't run.
- **Root cause:** the codebase uses a module-scope function (e.g. `function onClick(e) { ... }` at file top level) and passes it by reference into `addEventListener(..., onClick)` inside a setup function. The setup function is called multiple times (re-init, route change, re-hydration). In production, a third-party analytics / instrumentation layer wraps `addEventListener` and caches handler references internally — when it sees the same reference come in twice, it assumes it's already registered and skips calling through. Because the module-scope function's reference is stable across re-inits, the wrapper's cache thinks "already done" from the second call onward, and the handler stops firing. Dev environments don't have the wrapper, so the bug is invisible locally.
- **Fix:** move the handler *inside* the setup function so every re-init produces a fresh function reference. The wrapper sees a new reference and registers it.
- **Static signal:** a module-scope function declaration whose name is later passed (by identifier, not called) to `addEventListener` — especially inside a function that itself can be invoked multiple times (exported setup / init / hydrate functions, or called from an effect / route change handler). Noisier version: any module-scope function used as a callback passed to `addEventListener` anywhere.
- **Detector:** not-yet-built. Candidate name: `stable-handler-reference` or `module-scope-handler`.
- **Source:** real incident — prod-only UI deadness, hours of chasing ghosts (naming issue? race condition?), finally traced to the analytics wrapper's handler cache. Lesson captured by the team: **what works locally can silently fail in production when third-party layers change the runtime meaning of otherwise-correct code.**

## P8 — Proxy-wrapped built-in global swallows third-party writes

- **Symptoms:** a page breaks in production after the integration of a third-party library that attaches properties directly to a standard browser global (e.g. `window.history.someLibKey = ...`). The third party's state appears lost, reads come back `undefined`, or the library silently fails to initialize. Dev / localhost / previous builds all fine.
- **Root cause:** the application replaced a built-in platform global — typically `window.history`, but also `fetch`, `XMLHttpRequest`, `localStorage`, `document.cookie` descriptor — wholesale with a `Proxy` wrapper to intercept specific methods (e.g. hook `pushState` / `replaceState` for SPA navigation detection). Known methods are forwarded correctly. But when a third-party library later writes a *new, arbitrary* property to the proxy, that write goes to the proxy target or gets intercepted by the `set` trap in a way the library's later reads don't expect. The result: keys the library attaches are unreachable, and the library misbehaves. The app author had no way to know a third-party would later assume it could decorate `window.history` — and no way to test for it in dev.
- **Fix:** prefer monkey-patching *specific methods* over wholesale `Proxy` replacement of a platform global — e.g. save the original `history.pushState` reference, assign a wrapper function in its place, and leave the rest of the object untouched. If a Proxy is unavoidable, use a fully transparent `Reflect.*`-based handler that keeps `target` as the single source of truth for property storage.
- **Static signal:** source contains an assignment replacing a platform global with a `new Proxy(...)` — `window.history = new Proxy(window.history, ...)`, `window.fetch = new Proxy(...)`, `globalThis.localStorage = new Proxy(...)`, etc. Also: any assignment `<platformHost>.<platformProp> = new Proxy(...)` where the host is a known browser global. The static check doesn't know whether the Proxy handlers are transparent — so this is recall-first / code-smell territory: flag any such replacement, let a reviewer decide.
- **Detector:** not-yet-built. Candidate name: `proxied-platform-global` or `global-proxy-replacement`. Likely noisier than P1–P5 — intentionally. Classify as a code smell, not a guaranteed bug. The alternative is no detection at all.
- **Source:** real incident — a per-route UI feature needed to react to SPA navigation (on for some routes, off for others). On page-reload routes this worked fine. On SPA routes the author had no `pushState` / `replaceState` hook, so wrapped `window.history` in a Proxy to capture navigation. Shipped fine. Later in production, a third-party library began attaching its own keys to `window.history`; those keys were effectively lost through the proxy, breaking the page.
- **Note:** flagged by the product owner together with P7 as "these are runtime, not static — but still log it, maybe like how SonarQube does code smells, because no existing tool will report these." That framing is now reflected in `VISION.md` as a third category of engine scope: *runtime bugs with a static signature.*

## P9 — Shape drift across a shared cross-file channel

- **Symptoms:** one file writes a value; another file reads it expecting a different shape. Reads come back `undefined`, crash on property access, silently use stale field names, or misinterpret values. The two files compile, lint, and type-check fine; the divergence is invisible until runtime — often only on specific user flows where the changed field is actually read. Canonical example: writer stored `{ name }`, refactored to `{ firstName, lastName }`; every reader that depended on `user.name` silently got `undefined`. The refactor PR was clean, types were green, tests passed, broken in prod.
- **Root cause:** one side of a cross-file contract changes shape (field split, renamed, nested, removed, type-changed) without the other side updating in lockstep. The channel — `localStorage` / `sessionStorage` value, cookie body, `CustomEvent.detail`, URL param blob, any string-keyed shared state — is **opaque to the type system** because it crosses a `JSON.stringify` / `JSON.parse` / storage boundary that TypeScript doesn't propagate through. Even in fully-typed codebases, `storage.getItem(k)` returns `string | null`; the shape contract lives in the code, not the types.
- **Static signal (tractable slice, recall-first):**
  - **Write side:** an object literal inside a known serialisation / dispatch wrapper. Extract the top-level key set.
    - `localStorage.setItem(k, JSON.stringify({ a, b, c }))` → write shape `{a, b, c}` on key `k`.
    - `document.cookie = k + '=' + JSON.stringify({ ... })` → write shape on cookie `k`.
    - `dispatchEvent(new CustomEvent(n, { detail: { ... } }))` → write shape on channel `n`.
  - **Read side:** property access or destructuring on the parsed value. Extract the access set.
    - `JSON.parse(localStorage.getItem(k)).firstName` → read shape `{firstName}` on key `k`.
    - `const { name, age } = JSON.parse(...)` → read shape `{name, age}`.
  - **Disagreement check:** for each channel (key, event name, etc.) where both sides were detected, flag if the reader accesses a field the writer never writes, or if the writer writes a field no reader accesses (weaker signal, but surfaces dead shape).
- **What this will NOT catch in v1 (recall gaps, logged honestly — per D2 we ship the slice anyway):**
  - Shapes that flow through helper functions or many reassignments — cross-function shape propagation without type info is hard.
  - Object-spread writes `JSON.stringify({ ...prev, x })` where `prev` is resolved cross-file.
  - Dynamic property reads `result[key]`.
  - Nested-field changes — v1 is top-level keys only. `user.address.street` → `user.addressLine1` is a v2 problem.
  - Writes whose RHS is an opaque variable sourced from an API response the analyzer can't see.
  - Wrapper modules: `storage.set('user', data)` where the literal shape was lost in a helper (see Q2).
- **Detector:** built (v1, storage channel) — `shape-drift` (`src/shape-drift.js`). v1 definition: emit a `shape-drift` finding per `(storage, key)` channel where BOTH sides have at least one literal shape observation AND the aggregated write-shape disagrees with the read-shape. Write side is `setItem(literalKey, JSON.stringify(<objectLiteral>))`; read side is `JSON.parse(storage.getItem(literalKey))` consumed via direct property access, destructuring, or a variable binding that is later property-accessed in the same scope. Tolerant of `… || '{}'` / `… ?? '{}'` / `…!` / parens. Additive to `shared-state` — the coupling finding remains; the shape-drift finding is layered on top to make the broken *contract* (not just the coupling) visible.
- **Source:** generalised by the product owner from the specific case "writer stored `{ name }`, refactored to `{ firstName, lastName }`, readers across the codebase broke silently." Applies to any cross-file channel, not just storage.
- **Note:** deliberately syntactic (D5). The TypeScript type system does not see across `JSON.parse` / storage / cookie / event boundaries, even in fully-typed codebases. A realistic shape-drift detector must derive shape summaries from the source code itself, not from types. This is also why no existing tool catches this — they either stop at the type layer, or they don't look at shapes at all.

## P10 — Paired-key drift across co-located writes

- **Symptoms:** a cache becomes stale in a way no single writer can explain. Readers see fresh data in one field and outdated data in another. Cache invalidation logic says "if the timestamp sibling is recent, reuse"; a writer updates the payload key but forgets the timestamp key, so later readers treat stale payload as fresh. Production-only in feel because the bug needs a specific interleaving of writes and reads to surface.
- **Root cause:** two or more storage keys are designed to travel as a *pair* (`foo` + `foo-ts`, `flags` + `flags-version`, `cache` + `cache-etag`), but the language gives no way to express "these keys are always written together." The intent lives in one function where both `setItem` calls appear back-to-back; it doesn't live in the storage contract. Any subsequent writer who only touches one of the keys silently breaks the invariant.
- **Static signal:** two or more `sessionStorage.setItem()` / `localStorage.setItem()` calls to **distinct literal keys** within the same function body, within a small window (≈5 statements) of each other — a co-located paired-write cluster. Once the cluster is recognised, any *other* writer of just one of those keys elsewhere in the codebase is a lead: "this function writes `foo` without `foo-ts`, but elsewhere these keys are written together."
- **Relation to P4:** P4 is *one* key with two writers in different shapes (SSR script writes `{a}`, CSR loader writes `{b}`). P10 is *two* keys that should be written together but aren't, by the same or different writers. Both surface as stale reads, but the static signal and the fix are different.
- **Detector:** built — `paired-keys` (`src/paired-keys.js`). v1 definition: emit a `paired-keys` finding per co-write cluster (one function body, ≥2 distinct literal keys, ≤5 statements apart), listing the full key set. Additive to `shared-state` — the per-key coupling findings stay as they are; the paired-keys finding is layered on top.
- **Source:** real incident — a large production codebase paired `app.flags` (the flag payload) with `app.flags.ts` (the timestamp used for TTL comparison). A writer updated the payload but didn't touch the timestamp; readers saw the old timestamp, decided the cache was fresh, and served stale flags. Called the "paired-key cache bug" in an earlier dogfood review (§2.2).

---

## P11 — Hydration mismatch from SSR-time reads of browser-only or time-varying sources

- **Symptoms:** React console warning *"Text content does not match server-rendered HTML"* or *"Hydration failed because the initial UI does not match what was rendered on the server."* The mismatch can render visibly (wrong text, missing nodes, a momentary flash of the server tree before it's replaced) or degrade silently — hydration aborts on a subtree and React falls back to full client render, leaving later `useEffect`s to fire in the wrong order. Intermittent in production: the mismatch may only fire for users whose clock, locale, timezone, or browser fingerprint differs from the server's.
- **Root cause:** a component's render path reads a source whose value differs between the SSR execution and the CSR hydration. Canonical source buckets:
  - **Browser-only globals** — `window.*`, `document.*`, `navigator.*`, `localStorage.*`, `sessionStorage.*`. The server doesn't have these; guard branches (`typeof window !== 'undefined'`) evaluate differently and the two trees diverge.
  - **Time-varying primitives** — `Date.now()`, `new Date()` (no args), `Math.random()`, `performance.now()`. The server renders at wall-clock `T0`; the client hydrates at `T1 > T0`.
  - **Client-only state reads** — IndexedDB, a third-party SDK's in-memory state, client-only cache that's empty on the server.
- **Static signal:** a JSX component file (function body or module scope of a file whose export is a component) contains a direct read of one of the above sources in the render path — not gated by `useEffect` / `useLayoutEffect`, not inside a client-only component boundary (`'use client'` *and* no server-component importer). Extra lift from the import graph: if the component is reachable from a server-rendered entry (Next.js `page.tsx`, Remix route, SvelteKit `+page.server.ts`, etc.), the mismatch is demonstrable rather than speculative — aligns with D10's describe-don't-predict rule.
- **Relation to P5 (stale-module-capture):** P5 flags module-scope `const X = dynamic()` bindings frozen at load time. P11 flags render-path reads that execute on both server and client with different results. They intersect at *"module-scope `const X = window.foo` in a component file imported by SSR"* — where P5 already fires but labels only the staleness angle. P11 would layer the hydration-mismatch angle on top, potentially as the same detector with different confidence-reason text, keyed off whether the file is reachable from an SSR entry.
- **Detector:** not-yet-built. Candidate name: `hydration-unsafe-read` or `ssr-unsafe-render`. Likely depends on **framework-context config** (already in `BACKLOG.md`) to know which entry files are server-rendered; without that, a conservative v1 rule would be *"flag the read if it lives in a `.tsx` file that exports a component and is neither marked `'use client'` nor gated by a lifecycle hook."*
- **Source:** **Not a lived incident on this team — surfaced via web research during the 2026-04-19 planning review.** Cited here so the signal doesn't get lost; detector priority should not be treated as equivalent to P1–P10 until a real incident confirms the shape on a codebase we own. Evidence trail:
  - Next.js's own `react-hydration-error` docs page, which enumerates these exact causes verbatim — <https://nextjs.org/docs/messages/react-hydration-error>
  - High-volume Stack Overflow question on the React 18 manifestation — <https://stackoverflow.com/questions/71706064/react-18-hydration-failed-because-the-initial-ui-does-not-match-what-was-render>
  - Next.js GitHub discussion showing a production-shape case (third-party browser extension injecting DOM) — <https://github.com/vercel/next.js/discussions/72035>
  - Community guide walking through the fix landscape — <https://www.flowql.com/en/blog/guides/nextjs-hydration-failed-guide/>
- **Note:** upgrade the `Source` line from *"web research"* to *"real incident"* when the pattern bites in a codebase we actually work on. The pattern log format is append-only, so the upgrade is an edit to this entry rather than a new `P<N>`.

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
