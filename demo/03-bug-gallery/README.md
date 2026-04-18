# The Bug Gallery

Five real bug shapes that have shipped to production. For each one:
how it bites, what the symptom looks like, and what code-intel finds
that `grep`, ESLint, TypeScript, and IDE workspace search do not.

This document is **read-by-itself-able**. You can hand it to a staff
engineer and have a conversation. No live demo required.

Every code citation below points at a **real file in this repo** under
`examples/app-a/` or `examples/app-b/` — not invented snippets. Every
"code-intel emits" block is the **actual output** from running
`node src/cli.js impact examples/app-a examples/app-b --markdown`.

---

## The pitch, in one paragraph

Modern JS codebases — especially ones with multiple teams, shared CDN
scripts, or a split between SSR and SPA — have a class of bugs that do
not live at a single line. They live in the *relationship* between
lines in different files. A writer in File A puts `{ userId }` into
`localStorage`; a reader in File B pulls it out expecting `{ id }`.
No compiler sees across the storage boundary. No linter understands
the contract. A PR reviewer reading only the diff cannot know the
other half exists. These bugs do not show up in local dev — they show
up in production, usually after a refactor, usually under a deadline.
code-intel's job is to make those relationships *visible*, with enough
context that a reviewer can decide whether to act in five seconds.

---

## How to read each entry

- **The scenario** — the setup. What two engineers on two teams did.
  None of them wrote a bug; each piece is correct in isolation.
- **The symptom** — what production looks like when the bug fires.
- **The code** — the real files from this repo, cited by path and line.
- **What `grep` would show** — the raw text match every engineer does
  as a first instinct.
- **Why that is not enough** — the specific reason workspace search
  cannot answer the actual question.
- **What code-intel emits** — the real finding, with its confidence
  and the `confidenceReason` paragraph that tells you whether to act.

---

# 1. The classic-script global overwrite (`shared-global-binding`, P3)

**The one nothing else catches.** Grep can find the definitions; nothing
else can tell you they will collide.

## The scenario

App A and App B both ship a cookie-parsing helper as a classic script
(no ES modules, loaded with a plain `<script src="...">` tag). Both
name it `parseCookie()`. Both work fine in isolation. On any page where
both scripts load, **whichever script executes second silently
overwrites the first on `window.parseCookie`** — with no error, no
warning, no sign anything happened.

App A's parser URI-decodes and returns `null` on miss. App B's parser
returns the raw value and returns `''` on miss. Depending on CDN load
order (which is not the same as the dev environment), one team's
callers break in production on the pages that happen to also include
the other team's script.

## The symptom

Team A's login flow breaks for ~5% of users — specifically users whose
cookies contain URL-encoded characters App A's parser expects to
decode. Team A's tests pass. Their helper works fine in isolation. The
bug only manifests on pages where both scripts happen to load together.

## The code

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/cookies/get-cookie.js:14-17
function parseCookie(name) {
  var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
```

```@/Users/sc/Documents/workspace/code-intel/examples/app-b/src/cookies/get-cookie.js:12-19
function parseCookie(name) {
  var parts = document.cookie.split(';');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].trim().split('=');
    if (kv[0] === name) return kv[1] || '';
  }
  return '';
}
```

## What `grep` would show

```
$ rg "function parseCookie"
examples/app-a/src/cookies/get-cookie.js:14:function parseCookie(name) {
examples/app-b/src/cookies/get-cookie.js:12:function parseCookie(name) {
```

Two definitions in two files. A reviewer could see this — **if** they
knew to grep for it. Nobody does, because from each team's side, their
file defines *their* `parseCookie`. Why would you grep for a global
you think you own?

## Why that is not enough

Grep shows "two functions with the same name" but critically **cannot
distinguish**:

- a **module-scoped** `function parseCookie()` in a `.ts` file with
  `import`/`export` — safe, scoped to that module;
- a **classic-script top-level** `function parseCookie()` in a `.js`
  file with no `import`/`export` at all — this becomes `window.parseCookie`
  at runtime and will be silently overwritten by the next script to
  declare it.

The difference is syntactic (does the file have any `import`/`export`
anywhere?) and grep does not compute it. IDE workspace search does not
compute it. TypeScript does not warn across classic-script boundaries.
ESLint's `no-redeclare` rule does not work across files.

## What code-intel emits

```
- shared-global-binding:parseCookie   `high confidence`  — Global name 'parseCookie' declared by 2 files across 2 projects
  > Global name 'parseCookie' is declared or assigned by 2 files. At
  > runtime, whichever script loads last silently overwrites the earlier
  > definition. The browser gives no warning; TypeScript and ESLint do
  > not see across classic-script boundaries. The coupling is certain;
  > the only question is which definition wins in your production load order.

  Project         File                               Line  Op
  example-app-a   src/cookies/get-cookie.js          14    declare
  example-app-b   src/cookies/get-cookie.js          12    declare
```

The tool knows **both files are classic scripts** (no `import`/`export`).
It knows a top-level `function parseCookie()` in a classic script **is**
a global binding. And it does NOT emit this finding for
module-style `.ts` files — those don't collide. That filter is the
whole point.

## Why `confidence: high`

- Both files are syntactically classic scripts (the analyzer checks).
- The detector already filters out same-file self-assignment
  (fixed against a real false positive from an earlier dogfood review;
  see `§2.6` in `src/shared-state-globals.js`).
- The coupling is certain: both names *are* top-level; the browser
  *will* pick one as `window.parseCookie` at runtime.

---

# 2. The SSR/CSR feature-flag drift (`shared-storage-key`, P4)

## The scenario

App A renders the initial page server-side. An inline `<script>` tag
in the head seeds `sessionStorage['app.runtime-config']` with the raw
flags object — so the client has flags before any bundle loads.

Six months later, someone on the same team ships a CSR cache loader.
It also writes `app.runtime-config` — but shaped as
`{ value, fetchedAt }` (a 15-minute TTL envelope). Different payload,
same key. On the next page load, the SSR inline script seeds raw
flags, the CSR loader reads them back as if they were a TTL envelope,
`.fetchedAt` is undefined, and the loader refreshes unnecessarily (or
crashes, depending on the branch).

## The symptom

Feature flags flicker in and out across navigations. `.fetchedAt` is
`undefined` when the SSR script ran last; TTL check returns `NaN`;
branch behaves nondeterministically. Users refresh once, works for a
minute, flickers again.

## The code

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/ssr-inject.ts:15-20
export function applySsrInjectedFlags(): void {
  // On the server, __SSR_FLAGS_PAYLOAD__ is serialised from the API
  // response. On the client, this function stands in for the inline
  // script that runs before hydration.
  sessionStorage.setItem('app.runtime-config', __SSR_FLAGS_PAYLOAD__);
}
```

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/csr-loader.ts:28-44
export async function loadFeatureFlags(): Promise<Record<string, unknown>> {
  const raw = sessionStorage.getItem('app.runtime-config');
  if (raw) {
    try {
      const cached: CachedFlags = JSON.parse(raw);
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.value;
      }
    } catch {
      // Stale payload shape (e.g. SSR-injected raw flags) — fall through.
    }
  }
  const res = await fetch('/api/feature-flags');
  const value = (await res.json()) as Record<string, unknown>;
  sessionStorage.setItem('app.runtime-config', JSON.stringify({ value, fetchedAt: Date.now() } satisfies CachedFlags));
  return value;
}
```

## What `grep` would show

Three hits for `app.runtime-config` across two files. A reviewer reading
the CSR loader PR, if they are diligent, greps and finds the SSR
script. They now have to open both files, reason about execution
order (SSR runs first, then CSR), compare the JSON shapes on each
side, and realise they do not match.

## Why that is not enough

The bug is not the string — it is the **shape contract between the
two writers and the one reader**. Grep returns strings. This bug lives
in a relationship the reviewer has to reconstruct from multiple AST
sites. One team can refactor their side (e.g. the SSR format changes
to add a `version` field) without ever opening the other team's code.

## What code-intel emits

```
- shared-storage-key:app.runtime-config   `high confidence`  — sessionStorage key 'app.runtime-config' is touched by 2 files
  > Literal key 'app.runtime-config' is written in one file and read in
  > another within the same project. This is the canonical shared-state
  > shape: the writer's data contract is implicitly consumed by the
  > reader with no compiler enforcement. Refactors on either side break
  > the other silently.

  Project         File                             Line  Op
  example-app-a   src/flags/csr-loader.ts          29    read
  example-app-a   src/flags/csr-loader.ts          42    write
  example-app-a   src/flags/ssr-inject.ts          19    write
```

Reviewer sees: *two writers, one reader, same key, different files*.
The next click is into the two writer sites to compare shapes. The
mismatch surfaces immediately.

## Why `confidence: high`

- The key is a **literal string** (not computed), so occurrence
  grouping is exact.
- Both **write and read** operations are present in the occurrence
  list — the coupling is two-sided, not a one-legged false positive.
- Writer and reader are in **different files**, so the bug's blast
  radius is real.

---

# 3. The paired-key cache bug — paired-key drift (`paired-keys`, P10)

**The single most unique signal code-intel produces.** No other tool in
our evaluation surfaced a paired-write cluster from raw code. This is
the one that makes senior engineers lean forward.

## The scenario

A feature-flag cache stores **two keys that must travel together**:

- `sessionStorage['app.flags']` — the flag payload.
- `sessionStorage['app.flags.ts']` — the timestamp, used by a TTL check:
  *"if this is older than 60s, refetch."*

One function, `cacheFlags()`, writes both. The convention — that these
two keys are a pair — lives **entirely inside that function body**.
The storage API has no way to express "these keys are atomic."

Later, someone adds a new writer elsewhere (not in the fixture; this
is the shape of the bug-introducing PR) that updates *only* the
payload because "we're just refreshing data, not invalidating." They
grep for `app.flags`, find the existing writer, copy the shape of the
`setItem` call, and ship.

## The symptom

Users see stale feature flags for up to 60 seconds — or up to an hour
— even though the refresh path ran. The TTL check reads a "recent"
timestamp and skips the real refetch. Production-only; impossible to
reproduce locally because local dev always cold-starts.

## The code

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/paired-write.ts:15-18
export function cacheFlags(flags: Record<string, unknown>): void {
  sessionStorage.setItem('app.flags', JSON.stringify(flags));
  sessionStorage.setItem('app.flags.ts', String(Date.now()));
}
```

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/paired-write.ts:20-23
export function cacheFlagsMissingTs(flags: Record<string, unknown>): void {
  // The paired-key cache bug shape: writer forgot the timestamp sibling.
  sessionStorage.setItem('app.flags', JSON.stringify(flags));
}
```

## What `grep` would show

```
$ rg "setItem\('app\.flags" --type ts
src/flags/paired-write.ts:16:  sessionStorage.setItem('app.flags', ...
src/flags/paired-write.ts:17:  sessionStorage.setItem('app.flags.ts', ...
src/flags/paired-write.ts:22:  sessionStorage.setItem('app.flags', ...
```

Grep shows three writers. It has **no way** to tell you:

- the first two are *paired inside a single function body* — the
  design says they go together;
- the third writer touches only half the pair and is the bug.

## Why that is not enough

Reading the three hits, a reviewer has to *infer* the pairing from the
visual adjacency in the first function. Senior reviewers catch this.
Junior reviewers miss it. AI reviewers (tested) miss it too, because
they do not reason about cluster-membership as a first-class concept.

## What code-intel emits

```
- paired-keys:sessionStorage:app.flags+app.flags.ts@... `medium confidence`
   — sessionStorage paired-write cluster: ['app.flags', 'app.flags.ts']
     — all callers should update together
  > Paired-write cluster: sessionStorage keys ['app.flags', 'app.flags.ts']
  > are written together inside a single function. The cluster itself is
  > a factual observation, not a bug claim — the bug materializes when
  > another writer elsewhere in the codebase touches only some of these
  > keys, breaking the pair. v1 of the detector finds the cluster but
  > does not correlate across files; v2 is on the backlog. Until then,
  > treat this as "these keys must travel together" and audit every
  > writer of each key to ensure the full set is updated.

  Project         File                             Line  Op
  example-app-a   src/flags/paired-write.ts        16    write
  example-app-a   src/flags/paired-write.ts        17    write
```

The `paired-keys` finding is **a design artifact, extracted
automatically from the source code.** Every subsequent PR that touches
one of these keys can now run against the fact that they are paired.

## Why `confidence: medium` — and why this is the right call

The cluster itself is *certain* — these two keys are *written together*
in `cacheFlags`. What the tool **cannot yet prove** is whether another
writer in another file violates the pair. That is v2 of the detector
(cross-file correlation); the backlog entry is public in `BACKLOG.md`.

The `confidenceReason` says this out loud — "factual observation, not
a bug claim" — so the reviewer knows exactly what to do with it and
is not mis-led into thinking the tool has proven a bug it has not.

---

# 4. The cross-project CustomEvent contract (`shared-event-channel`, P2)

## The scenario

App A dispatches a `profile:changed` CustomEvent with
`detail: { id, fields }` when the user updates their profile. App B,
loaded on the same page (think: a navigation widget, a support chat, a
price-display sidebar), listens for `profile:changed` to refresh its
view. Neither app imports the other; they communicate purely through
`window.dispatchEvent` / `window.addEventListener`.

Six months in, App A refactors: the event payload changes shape or a
field is renamed. App A's tests pass. The reviewer sees only App A's
diff.

## The symptom

App B's widget renders empty after profile updates. It reads a field
on `event.detail` that is now `undefined`. No exception — the widget
just goes blank. Only reproduces on pages where both apps load.

## The code

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/events/notifier.ts:7-14
export interface ProfileDelta {
  id: string;
  fields: Record<string, unknown>;
}

export function notifyProfileChanged(delta: ProfileDelta): void {
  window.dispatchEvent(new CustomEvent('profile:changed', { detail: delta }));
}
```

```@/Users/sc/Documents/workspace/code-intel/examples/app-b/src/events/listener.ts:6-15
type ProfileChangedDetail = { id: string; fields: Record<string, unknown> };

export function subscribeToProfileChanges(handler: (d: ProfileChangedDetail) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ProfileChangedDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener('profile:changed', listener);
  return () => window.removeEventListener('profile:changed', listener);
}
```

Both sides declare an interface for `ProfileDelta` / `ProfileChangedDetail`.
They are not the same interface — they are **two independent copies**
that happen to agree today. TypeScript does nothing to enforce their
consistency because the event bus is an `any`-typed channel.

## What `grep` would show

```
$ rg "profile:changed"
examples/app-a/src/events/notifier.ts:13:    new CustomEvent('profile:changed', ...)
examples/app-b/src/events/listener.ts:13:  window.addEventListener('profile:changed', ...)
examples/app-b/src/events/listener.ts:14:  return () => window.removeEventListener('profile:changed', ...);
```

Three hits. A reviewer on App A's refactor PR sees the listener exists
"somewhere" but has to open the file, read the handler, and reconstruct
the detail-shape contract — *which App B pulls from `e.detail`, not from
a shared type*.

## Why that is not enough

`event.detail` is typed `any` in the DOM lib. Even in fully-typed
codebases, the event bus is an `any`-shaped channel. `grep` finds the
channel name; no amount of grep finds the **shape contract** the
dispatcher and listener agreed on in some un-recorded meeting.

## What code-intel emits

```
- shared-event-channel:profile:changed   `high confidence`  — CustomEvent channel 'profile:changed' used by 2 files across 2 projects
  > CustomEvent channel 'profile:changed' is used across 2 projects.
  > The dispatcher and listener have an implicit contract on the event's
  > `detail` payload — shape drift on one side breaks the other silently,
  > and the event bus has no type system to catch it.

  Project         File                                     Line  Op
  example-app-a   src/events/notifier.ts                   13    dispatch
  example-app-b   src/events/listener.ts                   13    listen
  example-app-b   src/events/listener.ts                   14    unlisten
```

Reviewer reading App A's refactor PR now has a structured answer to
the question "is anyone listening to this event with an assumption
about its shape?" — *yes, App B, here's the file*. They open it,
compare shapes, decide.

## Why `confidence: high`

- Channel name is a **string literal** on both sides.
- Dispatch **and** listen are both present in the occurrence list —
  this is a two-sided coupling, not a noisy one-legged listener with
  no visible dispatcher.
- The coupling is **cross-project** — two separate package roots, so
  this is not an implementation detail of a single team.

The detector also **deliberately drops listen-only native DOM events**
(`resize`, `scroll`, `popstate`, `message`, etc.) — those are browser
wire-up, not coupling, and shipping them would be noise. See
`NATIVE_DOM_EVENTS` in `src/shared-state-events.js` and the §2.7
regression test.

---

# 5. The stale module-scope capture (`stale-module-capture`, P5)

**The most context-dependent pattern** — and therefore the one where
the `confidence` + `confidenceReason` story really matters. Read this
one if you want to understand how the tool deals with "well, it's a
bug *sometimes*."

## The scenario

Someone writes, at the top of `render.ts`:

```ts
const accountTier = getAccountTier();  // reads a cookie
```

It looks clean. It passes code review. Every call site reads
`accountTier` and branches on it. But in ES modules (and every runtime
JS loader, practically), **modules evaluate once per process.** The
value of `accountTier` is captured at first import and never
recomputed.

In an SPA, that "once" is the lifetime of the browser tab. The user
upgrades mid-session. `accountTier` is still `'free'` until full
page reload. The paywall keeps firing. Support tickets start arriving.

## Important caveat (this is what a careful reviewer will ask about)

This pattern is **not a bug in every runtime model**. It matters in:

- **Single-page apps** (React Router, Vue Router, Svelte navigation) —
  modules persist for the tab's lifetime.
- **SSR apps' *client* bundle** after hydration (Next.js / Remix
  client navigations) — same as SPA.
- **Web workers / service workers** — modules live for the worker's
  lifetime, potentially days.
- **Long-running Node services** — module-scope captures of config or
  env at import never refresh.
- **SSR *server* bundles** — module-scope per-request state *leaks
  across requests*. Different shape, same root cause.

It is mostly harmless in:

- **Classic multi-page apps** with full page reloads on every
  navigation.
- **CLI tools** that run once and exit.
- **Static-site builds**.

Because it depends on runtime model, the detector emits
`confidence: medium` and **spells out the context in the reason
string**. A reviewer on an MPA reads the reason and moves on in 3
seconds. A reviewer on an SPA reads it and has a clear action item.

## The code

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/account/detect.ts:12-17
export function getAccountTier(): 'free' | 'pro' | 'unknown' {
  const match = document.cookie.match(/(?:^|; )tier=([^;]+)/);
  const value = match ? decodeURIComponent(match[1]) : '';
  if (value === 'free' || value === 'pro') return value;
  return 'unknown';
}
```

```@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/account/render.ts:21-31
import { getAccountTier } from './detect';

const accountTier = getAccountTier();

export function renderAccountCopy(): string {
  switch (accountTier) {
    case 'free': return 'Welcome back!';
    case 'pro':  return 'Welcome to the Pro workspace.';
    default:     return 'Hello.';
  }
}
```

## What `grep` would show

```
$ rg "getAccountTier"
src/account/detect.ts:12:export function getAccountTier(): 'free' | 'pro' | 'unknown' {
src/account/render.ts:21:import { getAccountTier } from './detect';
src/account/render.ts:23:const accountTier = getAccountTier();
```

Three hits. All correct. Nothing looks wrong.

## Why that is not enough

The bug is not in any single line. The bug is in the **relationship
between the module-scope `const` and the runtime model of the host
app**. Grep does not know what scope the `const` lives in. ESLint does
not (by default) flag module-scope reads of dynamic sources.
TypeScript certainly does not — the types are fine. You have to *know
the pattern exists* to find it, and that's exactly what code-intel
encodes for you.

## What code-intel emits

```
- stale-module-capture:accountTier   `medium confidence`  — 'accountTier' captures dynamic source at module scope (via getAccountTier)
  > Module-scope capture of a dynamic source (getAccountTier). This is
  > a bug in runtime models where modules persist across state changes:
  > single-page apps (React Router, Vue Router, Svelte navigation), SSR
  > client bundles after hydration, web and service workers, and long-
  > running Node services. It is lower-risk in classic multi-page apps
  > (full page reload on every navigation), static-site builds, and CLI
  > tools. Check how 'accountTier' is read — if any caller runs after
  > the captured value could have changed, the stale value will be
  > returned.

  Project         File                                     Line  Op
  example-app-a   src/account/render.ts                    23    (declare)
```

## Why `confidence: medium` — and why this is the honest call

A tool that marked this as "critical" in all contexts would ship noise.
A tool that did not emit it at all would miss the bug in the contexts
where it is serious. The honest answer is: **emit it, mark medium,
and explain the context in the reason so the reviewer can decide in
five seconds.**

That is the shape every code-intel finding takes.

---

# The take-away

The common thread across all five stories:

- Every bug is a **relationship across files**, not a lint at a
  single line.
- `grep`, IDE workspace search, ESLint, and TypeScript can find the
  strings involved; they cannot assemble the relationship.
- code-intel assembles the relationship as a first-class finding with
  a confidence and a reason, in about one second.

This is not a linter. This is **PR-report infrastructure** for a class
of bugs that ship to production because no existing tool sees them.

The demo ends with one question for the audience:

> "Which of these five shapes have you shipped to production?"

From every team we have showed this to, the answer is at least one.
Usually three.

---

## If you only remember one thing

The `confidence` + `confidenceReason` fields answer the reviewer's
question up front, on every finding:

> **"How do I know this is actually a bug and not noise?"**

The reason string names the runtime context, names the prior
false-positive classes the detector already filters out, and names
what v1 proves vs. what future versions will prove. The reviewer
decides in five seconds; that is the bar.
