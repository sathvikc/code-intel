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

## P12 — Structural drift on loose-typed shared objects

- **Symptoms:** a URL comes back as `"undefinedundefined"`. An API payload has a field that's always blank. A config-driven UI renders with missing labels. TypeScript compiled fine, no runtime error — the code just silently reads nothing and downstream logic treats `undefined` as a valid empty value.
- **Root cause:** a config object declared in one file with a known key set (e.g. `{ foo_host, foo_path }`) is consumed in another file using the wrong property names (`cfg.host`, `cfg.path`). The type is too loose — `Record<string, string>`, `any`, or a type-asserted `as SomeInterface` — so TS accepts every key. In-memory property-name drift, no serialization boundary involved: a TS-invisible contract mismatch across files.
- **Static signal:**
  - **Write side:** module-scope object literal or exported `const` with a fixed set of string keys.
  - **Read side:** property reads on that identifier — `cfg.X`, `cfg['X']`, `const { X } = cfg` — in any file that imports the declaration.
  - **Disagreement check:** reader property name is not in the declared key set.
- **What this will NOT catch in v1:** objects built incrementally (`cfg[k] = v` in a loop); objects merged at runtime (`{ ...base, ...override }`); dynamic property access (`cfg[someVar]`).
- **Relation to P9:** P9 is cross-file shape drift across a serialization boundary. P12 is the same drift *without* serialization — the object never leaves memory. Same coupling-key idea (object identifier), different reason the type system misses it.
- **Detector:** not-yet-built. Candidate name: `structural-drift` or `loose-typed-object-drift`. Should reuse `shape-drift`'s AST machinery.
- **Source:** real production fix. A config object declared with prefixed keys was consumed in another file under the unprefixed names; result was `"undefinedundefined"` concatenated into an outbound URL. TypeScript let it through because the config's type was a loose record.

## P13 — Lifecycle cleanup drift (listener / timer / observer leaks)

- **Symptoms:** memory grows with every navigation. Old event handlers fire on unmounted components. Intervals keep running after the user leaves the page. Observers report on DOM nodes that no longer exist. In long-lived SPAs, things just get weirder the longer the tab stays open.
- **Root cause:** a `setup()` / hook / lifecycle method registers something — `addEventListener`, `setInterval`, `setTimeout`, `new IntersectionObserver(...)`, `new MutationObserver(...)`, `new ResizeObserver(...)`, `new WebSocket(...)`, `new EventSource(...)`, `MediaQueryList.addListener`, `fetch(..., { signal })` — and returns without a matching teardown. The cleanup either never existed, or was written against a different function reference (`removeEventListener` with a fresh arrow → silently does nothing).
- **Static signal (tiered):**
  - **Classic pair missing.** A registration with no reachable matching teardown in the same cleanup scope.
  - **`AbortSignal` path recognised.** A registration passed `{ signal: ctrl.signal }` paired with a reachable `ctrl.abort()` in a cleanup return / `onUnmount` / enclosing teardown counts as cleanup. Modern codebases (React 18+, TanStack Query) use this exclusively; the detector MUST recognise it or produce 100% false positives.
  - **`abort()` never reachable.** A `new AbortController()` whose `.signal` is handed to ≥1 API, but no `.abort()` call is reachable via the containing function's cleanup return, an enclosing `onUnmount` / `onDestroy`, or a bound teardown. Emit as a dedicated kind: `abort-never-called`.
  - **Handler-identity mismatch.** `addEventListener('x', () => ...)` paired with `removeEventListener('x', () => ...)` — both anonymous → cannot be the same reference → silent no-op. High-confidence bug. Softer tier: identifier-vs-identifier mismatch (medium confidence). Same-identifier = happy path.
- **Relation to P10:** P10 is paired-writes of two storage keys in one function body. P13 is paired register-teardown in one lifecycle scope. Same detector shape, different domain.
- **Detector:** not-yet-built. Candidate name: `lifecycle-cleanup-drift`. Covers the register/teardown catalogue: `add/removeEventListener`, `set/clearInterval`, `set/clearTimeout`, observer-family `.observe()` / `.disconnect()`, `new WebSocket(…)` / `.close()`, `new EventSource(…)` / `.close()`, `MediaQueryList` listener pairs, `AbortController` / `.abort()`.
- **Source:** known highest-frequency class of memory leak in long-lived SPAs, documented across the React / Vue / Svelte / Angular ecosystems for a decade. No existing static detector covers all register/teardown pairs uniformly — ESLint's `react-hooks/exhaustive-deps` catches a fraction by accident; no universal JS tool does it natively.

## P14 — Side-effect at module-import time

- **Symptoms:** duplicate network calls on page load. Hydration mismatches where server and client evidently ran the module with different results. Intervals / timers that can't be cleared because no one captured the returned id. State in `localStorage` / the DOM that was set before the user ever interacted with the page.
- **Root cause:** a module has top-level code that performs work at import time — a `fetch()`, a `localStorage.setItem(...)`, a `setInterval(...)`, a `document.body.classList.add(...)`, a `new EventSource(...)`. Because modules are evaluated once at first import, and module evaluation is **not** a lifecycle hook, this work runs at build time during SSR, again at hydration, again on every HMR reload — with no single owner responsible for cleanup or idempotency.
- **Static signal:** module-top-level statements (not inside any function body, class method, IIFE, or conditional block) that call: `fetch` / `XMLHttpRequest`, `localStorage.*` / `sessionStorage.*`, `document.*` write ops, `window.*` assignments, `setInterval` / `setTimeout`, `new EventSource(...)` / `new WebSocket(...)`, browser-global side effects.
- **Relation to P5:** P5 is a *read* at module scope frozen into a `const`. P14 is a *write* or *effect* at module scope that fires at load time. Same scope-walking infrastructure, different verdict.
- **Detector:** not-yet-built. Candidate name: `side-effect-at-import`. Reuses `stale-captures` walker.
- **Source:** research — documented SSR / Astro / Next.js pitfall; partial coverage exists in `eslint-plugin-import` (`no-side-effects-in-initialization`) but catches a narrower set and doesn't cross frameworks. Logged here so the shape is captured alongside P5's extended catalogue.

## P15 — Singleton-across-requests (SSR multi-tenancy leak)

- **Symptoms:** user A's data leaks into user B's session. Auth tokens from one request appear in another's response. A "memoized" value that was correct for the first request becomes permanent for everyone. Catastrophic in effect; only manifests under real concurrent load, so single-user dev testing looks clean.
- **Root cause:** a Node.js module has `let cache = {}` (or `let ` / `var `) at top level. A request handler — a Next.js API route, an Astro endpoint, an Express middleware, a NestJS controller — reads from or writes to that cache. Node caches modules across requests; the variable persists for the lifetime of the worker process. What the author intended as request-local state is actually process-global. One user's session data sits in memory when the next user's request lands.
- **Static signal:**
  - **Mutable module-scope state:** `let` / `var` declarations at module top level, assigned-to or mutated (via indexed write, `.push`, `Object.assign`) inside any function reachable from a known request handler.
  - **Request handler entry points (framework-specific):** `pages/api/**/*`, `src/pages/api/**/*`, `app/**/route.ts` with exported `GET` / `POST` / etc., `*.astro` endpoints, Express `app.get` / `app.post` / `router.use` handlers, NestJS controllers decorated with `@Get` / `@Post` / etc.
  - **Import-graph reachability:** the mutation site reaches at least one entry point (already computable via the reverse import graph).
- **Severity:** critical when it fires. Highest-blast-radius class of bug in the catalogue: a silent data leak between users that no test catches without a concurrency fixture.
- **Relation to P5:** P5 is read-once module capture of a dynamic source (per-process staleness). P15 is write-many module state in a per-request entry context (per-process cross-request leakage). Different direction, same scope awareness.
- **Detector:** not-yet-built. Candidate name: `shared-request-state` or `cross-request-singleton`. Entry-point detection is framework-specific; depends on the framework-context config already on `BACKLOG.md` (see Q3).
- **Source:** known SSR-framework incident class. Documented in Next.js, Remix, and Astro issue trackers. No JS/TS static detector covers it (SonarCloud has a Java-specific pattern). A real enough class to have led to public post-mortems and data-leak disclosures at multiple SSR-deployed apps.

## P16 — Discriminated-union drift

- **Symptoms:** a new action type is added to an event bus / reducer / state machine, but one handler silently skips it. Nothing crashes; the default branch (if any) quietly swallows the unknown case. Users report the new action "not doing anything" in one particular view.
- **Root cause:** a string-literal union type (`type Action = 'create' | 'update' | 'delete'`) or const-as array (`const ACTIONS = ['create', 'update', 'delete'] as const`) is exhaustively handled in a `switch` or `if`-chain somewhere. Someone extends the union with a new member but forgets the consumer. TypeScript catches exhaustiveness only if the consumer uses `assertNever(x)` in the default branch — a discipline that's easy to skip.
- **Static signal:**
  - **Declaration side:** `type X = 'a' | 'b' | 'c'`, `type X = typeof X[number]` over a `const X = [...] as const`, or `enum X { ... }` with a known set of string-literal members.
  - **Consumer side:** `switch(v)` / `if (v === 'a') ... else if (v === 'b') ...` on values typed as `X`, extracted to the set of case-arms.
  - **Disagreement:** case-arm set is not a superset of union members.
- **Caveats:**
  - Real-world unions extend, alias, and merge across files; a purely syntactic resolver (per D5) will see a subset of declarations.
  - TypeScript's `--strict` + `assertNever()` already solves this fully; the detector's value is in codebases that skip the crutch.
- **Detector:** not-yet-built. Candidate name: `discriminated-union-drift`. Feasibility depends on whether union resolution can stay syntactic (D5) — if it needs `TypeChecker`, defers to a later phase.
- **Source:** research — well-known TS ecosystem hazard, surfaced repeatedly in React / Redux / XState discussions. Priority tempered by the fact that the fix (`assertNever`) is a one-line addition and the primary audience is teams that haven't adopted it.

## P17 — Stateful regex at shared scope

- **Symptoms:** a call to `re.test(x)` returns `true`. Called again with the *same* string, it returns `false`. Validation inexplicably passes then fails on repeat attempts. Inputs that should never match do match if the user triggers the validation twice.
- **Root cause:** the regex was declared once at module or class scope with the `/g` or `/y` flag: `const RE = /\S+@\S+/g`. `.test()` and `.exec()` on a global regex advance `lastIndex` after each match and return `false` on the first call following a match. The regex instance is shared across every call site and every invocation, so `lastIndex` carries between unrelated callers.
- **Static signal:** a `const X = /.../flags` or `new RegExp(src, flags)` declaration at module / class scope where `flags` contains `g` or `y`, AND the same identifier `X` is used with `.test()` or `.exec()` at ≥2 call sites (or ≥1 call site inside a function that's likely invoked multiple times).
- **Detector:** not-yet-built. Candidate name: `stateful-shared-regex`. Dead simple AST pattern.
- **Source:** documented JavaScript footgun — "You Don't Know JS" regex chapter, MDN's RegExp reference warnings, repeated questions on Stack Overflow. Niche but extremely precise when it fires; no false-positive risk worth mentioning.

## P18 — SSR-unsafe module reads (browser-only APIs on the server)

- **Symptoms:** SSR build crashes with `ReferenceError: navigator is not defined`. Or worse — the developer added a `typeof window !== 'undefined'` guard that evaluates to `false` on the server, freezes `undefined` into a module-scope constant, and every client render thereafter silently reads the server's `undefined` value instead of the browser's real one.
- **Root cause:** a module has a top-level read of a browser-only API — `navigator.*`, `matchMedia(...)`, `IntersectionObserver`, `performance.*` (partially), `indexedDB`, `caches`, `crypto.subtle`, `XMLHttpRequest`, `URL.createObjectURL`. Node's server runtime doesn't have any of these. If the read is unguarded → build crash. If guarded with `typeof window !== 'undefined'` but cached into a `const` → permanent stale value (the bad variant; same mechanism as P5).
- **Static signal:** extend `stale-captures`' source catalogue with the full browser-only API set. Emit at warning severity; escalate to critical if the module is reached from a known SSR entry file (requires framework-context config).
- **Relation to P5 and P11:** P5 is the general scope machinery; P18 is the SSR-specific source catalogue extension. P11 is the downstream symptom (hydration mismatch) when a stale-captured browser value renders differently on server vs. client. Deliver P18 as a catalogue extension, not a separate detector.
- **Detector:** planned — extend `stale-captures` catalogue. Critical-tier escalation depends on framework-context config (see Q3).
- **Source:** research — documented in every SSR framework's hydration-mismatch / server-safety guide. `eslint-plugin-ssr-friendly` covers some; not universal.

## P19 — Environment variable schema drift

- **Symptoms:** a feature silently stops working after an env-variable rename. An API call returns 401 in one environment. A flag reads as falsy in production even though the `.env` says `true`. No build error, no type error.
- **Root cause:** code references `process.env.STRIPE_API_KEY`; someone renames the variable in `.env.example` / the deployment schema to `STRIPE_SECRET_KEY`. The code path still compiles — `process.env.X` is typed as `string | undefined`. Runtime: `undefined`, and whatever downstream logic treats it as "no key provided" fires silently.
- **Static signal:** collect every `process.env.X` / `import.meta.env.X` reference across scanned files; parse `.env.example`, `.env.local`, `zod` / `envsafe` / `@t3-oss/env-core` schemas if present. Flag references with no matching declaration, or declarations with zero references. Naturally cross-file.
- **Detector:** not-yet-built. Candidate name: `env-var-drift`.
- **Source:** research — well-known deploy-time hazard. Ecosystem has opt-in runtime solutions (`t3-env`, `envsafe`, `znv`); static detection has no universal story.

## P20 — Cross-file storage `.clear()` cascade

- **Symptoms:** hitting a "Reset preferences" button logs the user out. A component's "clear my filters" action wipes an unrelated feature's cached data. Impossible-to-reproduce support tickets because the trigger is on one page, the breakage on another.
- **Root cause:** one component calls `localStorage.clear()` / `sessionStorage.clear()` / `cookies.reset()` to reset its own state. The storage bucket is process-wide, not component-scoped — every other file that reads from the same bucket loses its data too. The author of the `.clear()` call didn't know other features lived in the same bucket.
- **Static signal:** detect `localStorage.clear()` / `sessionStorage.clear()` calls. Cross-reference against the full set of keys any other file writes to the same bucket (already enumerated by `shared-state-web-storage`). Emit a finding listing the keys that would be inadvertently wiped.
- **Detector:** not-yet-built. Candidate name: `storage-clear-cascade`. Piggybacks on `shared-state-web-storage`'s bucket enumeration.
- **Source:** research / experience — this bug has a long tail in any app that evolved past one feature team. No existing static tool catches it.

## P21 — Lost-`this` in callback passing

- **Symptoms:** a class method passed as an event handler runs but `this` is `undefined` (strict mode) or points at the event target (classic mode). State reads crash or silently return garbage.
- **Root cause:** `button.addEventListener('click', obj.handler)` — the `obj.handler` reference is extracted from the method's original object context; when the browser invokes the callback it does so with a different `this` binding. Old / class-based / Web Components code is the usual host; modern React functional components usually avoid this by composing arrows.
- **Static signal:** a method reference passed directly as a callback (`addEventListener('x', obj.method)`, `[].map(obj.method)`, `setTimeout(obj.method, ...)`, `fn(obj.method)`), where `obj.method`'s body references `this`, and the call site doesn't wrap in `.bind(this)` or an arrow.
- **Detector:** not-yet-built. Candidate name: `lost-this-callback`. Requires a light intra-class / intra-object method body walk.
- **Source:** documented JavaScript hazard since the language existed. TypeScript's `strictBindCallApply` catches some instances, not all; JS-only codebases get no help. Priority tempered by arrows + bind increasingly being the default.

## P22 — Event dispatch via variable-aliased `CustomEvent`

- **Symptoms:** an event listener that *should* be firing is silently quiet. The graph looks like a listener with no dispatcher, a dispatcher with no listener — an orphan channel, only it isn't. Tracing by hand reveals the dispatch is definitely there, just not on the shape the detector recognises.
- **Root cause:** the current static signal for a dispatch on channel `'X'` requires the name to be a literal inline argument: `dispatchEvent(new CustomEvent('X', ...))`. Real code routinely constructs the event into a variable first, then dispatches:
  ```ts
  const forwarded = evt instanceof CustomEvent
    ? new CustomEvent('X', { bubbles: true, detail: evt.detail })
    : new Event('X', { bubbles: true });
  dispatchEvent(forwarded);
  ```
  The literal `'X'` is visible; the dispatch is visible; but because they aren't in the same call, the aggregated view misses the dispatch occurrence.
- **Static signal:** when `dispatchEvent(X)` is invoked with an identifier `X`, look back in the same function scope for `const X = new CustomEvent('literal', ...)` or `new Event('literal', ...)` (or a conditionally-assigned `let` with literals in each branch). Record the dispatch against each literal found.
- **What this will NOT catch in v1:** alias chains >1 hop (`const a = new CustomEvent('X'); const b = a; dispatch(b)`); cross-function dispatches (construct in helper, dispatch in caller); `switch` branches reassigning the same binding — v1 covers the `if`/ternary shape only.
- **Detector:** planned — `shared-events` v2 extension. Shares alias-follow infrastructure with shape-drift's alias-chain (same walker, different consumer).
- **Source:** dogfood on a real codebase — a cross-team legacy-bridge pattern where the forwarded `CustomEvent` was always constructed into a local variable before dispatch. Every such dispatch was invisible to the detector despite the literal name being on the line above.

## P23 — Cross-host event bridging

- **Symptoms:** a channel has listeners in file A and dispatchers in file B, but the origination is on a completely different host (a specific DOM element, a web component, a shadow root). The "coupling" looks accidental from outside — in fact, the channel is deliberately relayed from one host to another by an intermediate file whose job is exactly that.
- **Root cause:** for legacy-bridging or micro-frontend reasons, code installs a listener on host `H1` and, inside the handler body, re-dispatches the same channel on host `H2` — typically `element.addEventListener('X', evt => { window.dispatchEvent(new CustomEvent('X', ...)); })`. Downstream consumers only listen on `H2`. The bridge is the architectural glue that makes the channel single-subscriber from the consumer's view while the producer retains its legacy host. Nothing in the code says "bridge" — it's a compound pattern only visible when both the listen and the re-dispatch are considered together.
- **Static signal:** find every `<host1>.addEventListener('X', handler)`. Analyse `handler`'s body (directly or via the P22 alias-follow). If it contains a dispatch of the same event name `'X'` to a different host `<host2>`, emit a new occurrence kind `bridge` with `{ fromHost, toHost, channel, file, line }`. Render the bridge as a single node with two edges in the `trace` graph — from the `fromHost` hub, to the `toHost` hub — instead of two disconnected occurrences.
- **What this will NOT catch in v1:** bridges routed through a helper function (needs intra-file call-graph); bridges that rename the event (`listen('old'), dispatch('new')`) — emit as a `rename-bridge` sub-kind, still valuable even though technically two channels; bridges gated by business conditions (`if (flag) { dispatch(...) }`) — still emit; surface the condition in the snippet.
- **Relation to P2:** P2 is same-channel coupling between producer and consumer. P23 is *bridge-detection* — the compound pattern that makes P2 possible when producer and consumer live on different hosts.
- **Detector:** not-yet-built. Candidate name: `event-bridge`. Architecturally distinctive — no other static JS/TS tool models this pattern.
- **Source:** dogfood on a real codebase — a nav widget that listens on a legacy DOM element and re-dispatches on `window` so downstream consumers only need one listener. The current detector showed the listen and the dispatch as two unrelated occurrences on different hosts; the architectural intent was invisible.

## P24 — Element-scoped event listener candidates

- **Symptoms:** the events graph shows zero in-repo listeners for a channel that clearly has in-repo dispatchers — or the reverse. Tracing by hand reveals listeners on specific DOM elements (`el.addEventListener('X', ...)`), Web Components, or shadow roots that the detector deliberately ignores because it only recognises `window` / `globalThis` / `self` hosts.
- **Root cause:** design choice — element-scoped events are not guaranteed to couple with window-scoped listeners (no bubbling across shadow DOM, no bubbling without `{ bubbles: true }`, etc.). Treating them as first-class coupling would produce false positives. But treating them as invisible produces false negatives on the common case where element-scoped dispatch is deliberately bridged to `window` (see P23).
- **Static signal:** detect `<receiver>.addEventListener('X', handler)` where the receiver is not `window` / `globalThis` / `self`. Emit at low confidence with `host: "element"` (or the receiver's identifier if resolvable) and a candidate-link to any same-name window-scoped channel in the same project, explicitly flagged as "may or may not couple via bubbling/bridge".
- **What this will NOT catch in v1:** truly-scoped element listeners (not bubbling) — produces noise; user suppresses; listeners on detached DOM nodes (constructed, never mounted); shadow-DOM bounds — bubbling stops at the shadow root and should be surfaced separately.
- **Relation to P23:** P23 absorbs the common case (element listener whose handler dispatches to `window`). P24 surfaces the *remaining* element-scoped listeners once P23 has taken its share. Should ship *after* P23 so bridge absorption is already in place.
- **Detector:** not-yet-built. Candidate name: `element-scoped-listener`. Emitted at low confidence; secondary candidate-link uses same-channel matching against window-scoped listeners.
- **Source:** dogfood on a real codebase — the same nav case that motivated P22 and P23. Element-scoped listeners were truly invisible; surfacing them at low confidence would have given a reviewer the missing piece to reason about bridging without forcing the detector to claim a hard coupling.

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
