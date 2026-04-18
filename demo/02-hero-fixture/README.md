# `02-hero-fixture/` — the believable 2-team mini-app

A narrative-first tour of the `examples/` fixtures framed as a real SaaS
product. Same source code as `examples/app-a/` and `examples/app-b/`;
this folder adds the architectural story so the fixtures stop looking
like "toys" and start looking like "a codebase that could be yours."

> The source files are not duplicated into this folder. Duplicating
> would risk drift, and the fixtures are already tested. Instead, every
> file reference below links into `examples/`. Treat this document as
> the read-me for the fictional product that `examples/` is pretending
> to be.

## The product

**AcmeDash** — a B2B analytics SaaS. Two teams ship the surface:

- **Team Alpha** (lives under `examples/app-a/`) owns the main app
  shell: sign-in, the account / pricing pages, and the feature-flag
  infrastructure that the rest of the company reads from.
- **Team Bravo** (lives under `examples/app-b/`) ships a support-chat
  widget that loads on every public page, including Team Alpha's.
  It is bundled separately, deployed on a different cadence, and
  talks to the rest of the page through the browser — `window`
  globals and `CustomEvent`s. There is no build-time dependency
  between the two apps.

This is the classic "two repos, one page" shape every multi-team web
platform ends up with. The bugs that bite in this shape are the ones
code-intel was built to find.

## Architecture at a glance

```
┌─── Team Alpha  (examples/app-a/) ────────────────────────────────┐
│                                                                   │
│   src/auth/                                                       │
│     login.ts          writes localStorage['app.session']          │
│     api-client.ts      reads localStorage['app.session']          │
│                                                                   │
│   src/flags/                                                      │
│     ssr-inject.ts      writes sessionStorage['app.runtime-config']│
│     csr-loader.ts      reads and writes ^^^ with a different shape│
│     paired-write.ts    writes ['app.flags', 'app.flags.ts'] pair  │
│                                                                   │
│   src/account/                                                    │
│     detect.ts          cookie-based tier lookup (dynamic)         │
│     render.ts          captures tier at module load (stale bug)   │
│                                                                   │
│   src/cookies/                                                    │
│     get-cookie.js      classic-script parseCookie() (global)      │
│                                                                   │
│   src/events/                                                     │
│     notifier.ts        dispatches 'profile:changed' ─────┐        │
│     native-events.ts   listens to resize/scroll (noise-regression) │
│                                                          │        │
│   src/globals/                                           │        │
│     self-assign.js     same-file window writes (noise-regression)  │
│                                                          │        │
└──────────────────────────────────────────────────────────│────────┘
                                                           │
                                         window event bus  │
                                         implicit contract │
                                                           ▼
┌─── Team Bravo  (examples/app-b/) ────────────────────────────────┐
│                                                                   │
│   src/events/                                                     │
│     listener.ts        listens for 'profile:changed' ◀────────────┘
│                                                                   │
│   src/cookies/                                                    │
│     get-cookie.js      classic-script parseCookie()                │
│                        (collides with Team Alpha's)               │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

Every arrow that *does not correspond to an `import`* in the source is a
place code-intel is looking. That is the whole product: find the arrows
the bundler cannot see.

## The planted bugs, in product terms

Each of these corresponds to a real production shape. None of them
involve a syntax error, a type error, or a lint warning in any file.

### 1. `app.session` token drift

**What Team Alpha built:** the sign-in flow (`login.ts`) persists an
auth token under `localStorage['app.session']`. The API client
(`api-client.ts`) reads the same key and stamps the `Authorization`
header on every outbound request.

**The planted bug:** the two files share the key only via a string
literal. Renaming it in one file (e.g. a PR that switches to JWT-style
keys prefixed with `auth.*`) silently breaks every API call in the
app. Grep can find both sides; nothing connects them at build time.

**Files:**
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/auth/login.ts:13`
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/auth/api-client.ts:7`

**Detector:** `shared-state-web-storage` / `shared-storage-key`.
**Confidence:** `high` — cross-file write + read, literal key.

### 2. SSR/CSR feature-flag shape drift

**What Team Alpha built:** an SSR inline script (`ssr-inject.ts`)
seeds `sessionStorage['app.runtime-config']` with the raw flags
payload so the page has flags before JS bundles load. A separate CSR
loader (`csr-loader.ts`) caches flags under the **same key** but
wraps them in a TTL envelope `{ value, fetchedAt }`.

**The planted bug:** the two writers disagree on the payload shape.
The CSR loader tries to read `.fetchedAt` on an SSR-written raw
payload and falls through to a refetch; subsequent SSR writes clobber
the CSR cache envelope. Feature flags flicker across navigations.

**Files:**
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/ssr-inject.ts:19`
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/csr-loader.ts:28-44`

**Detector:** `shared-state-web-storage` / `shared-storage-key`.
**Confidence:** `high` — same-project coupling, two writers and a
reader, literal key. The `confidenceReason` names this as "the
canonical shared-state shape."

### 3. The IXP paired-key bug — `app.flags` + `app.flags.ts`

**What Team Alpha built:** `paired-write.ts` caches the flag payload
under `'app.flags'` and the TTL timestamp under `'app.flags.ts'`.
Readers decide whether to refetch by comparing the timestamp.

**The planted bug:** the two keys are a *design pair* — they must
travel together — but the pair invariant lives only inside the
function body where both `setItem` calls happen. A future writer
anywhere in the codebase that touches only one of them breaks the
invariant. Readers see a fresh ts and stale payload; cache never
refreshes.

**Files:**
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/paired-write.ts:15-18` (the paired cluster)
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/flags/paired-write.ts:20-23` (the regression shape — writer that breaks the pair)

**Detector:** `paired-keys`.
**Confidence:** `medium` — cluster is certain; "bug" claim depends on
whether another writer violates the pair (v2 of the detector will
correlate across files; v1 emits the cluster as a design artifact).

### 4. Cross-team `profile:changed` CustomEvent

**What the two teams agreed to (in a meeting nobody remembers):**
Team Alpha publishes a `profile:changed` `CustomEvent` on the
window bus when the user's profile updates; Team Bravo's chat widget
listens so it can update the avatar/name inline.

**The planted bug:** the payload shape is a local `interface` in
each app. They agree today. Team Alpha refactors to a nested payload
(`{ user: { id }, subscription: { plan } }` instead of
`{ id, fields }`). Team Alpha's tests pass. Team Bravo's widget
renders blank the moment the event fires — no exception, just
`undefined` reads — because their listener reaches for the old shape.

**Files:**
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/events/notifier.ts:12-14`
- `@/Users/sc/Documents/workspace/code-intel/examples/app-b/src/events/listener.ts:8-15`

**Detector:** `shared-state-events` / `shared-event-channel`.
**Confidence:** `high` — literal channel, cross-project, dispatch
AND listen both present.

### 5. Classic-script `parseCookie` overwrite

**What each team independently did:** shipped a classic-script
cookie parser named `parseCookie(name)`. Team Alpha's is lenient
and returns URL-decoded values; Team Bravo's is strict and drops
malformed pairs.

**The planted bug:** both are loaded as plain `<script>` tags on
the same marketing page. Whichever script loads second wins
`window.parseCookie`. On pages where the CDN order differs from
dev, the login flow that expects decoding silently gets the
un-decoded parser — cookies with URL-encoded characters look wrong.

**Files:**
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/cookies/get-cookie.js:14-17`
- `@/Users/sc/Documents/workspace/code-intel/examples/app-b/src/cookies/get-cookie.js:12-19`

**Detector:** `shared-state-globals` / `shared-global-binding`.
**Confidence:** `high` — classic-script top-level `function`, cross-project.

### 6. Stale module-scope tier capture (SPA-only)

**What Team Alpha built:** `render.ts` shows tier-specific copy on
the account page. It reads the tier from a cookie at module load.

**The planted bug:** ES-module caching means `accountTier` is frozen
at first import. When the user upgrades mid-session, the copy stays
on the old tier until full page reload. In AcmeDash's SPA shell, that
is "until the user signs out and back in."

**Files:**
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/account/detect.ts:12-17` (the dynamic source)
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/account/render.ts:21-31` (the stale capture)

**Detector:** `stale-module-capture`.
**Confidence:** `medium` — the reason string names the runtime
contexts where this bites and where it is lower-risk. This is the
PSE-question pattern: "is it actually a bug, or just noise?" — the
tool answers both, on the same finding.

### And two "must NOT emit" regressions

These are fixtures that *should stay silent*. They are in the fixture
set specifically to guard against previously-shipped false positives.

- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/globals/self-assign.js`
  — a single file writing to the same `window.X` several times. Real
  production code does this. Earlier versions of the analyzer flagged
  it as a self-collision. Now it is correctly silent.
- `@/Users/sc/Documents/workspace/code-intel/examples/app-a/src/events/native-events.ts`
  — a listener for `resize` / `scroll` / `popstate` / `message`. Those
  are native DOM events; listen-only native-event usage is browser
  wire-up, not coupling. Earlier versions flagged them; now silent.

Both are tested by the detector test suites as "emits zero findings"
regressions.

## Running the analysis against this "product"

From the repo root:

```bash
# Per-detector output (JSON)
node src/cli.js shared-state    examples/app-a examples/app-b --pretty
node src/cli.js shared-events   examples/app-a examples/app-b --pretty
node src/cli.js shared-globals  examples/app-a examples/app-b --pretty
node src/cli.js stale-captures  examples/app-a examples/app-b --pretty
node src/cli.js paired-keys     examples/app-a examples/app-b --pretty

# Unified PR-style markdown report (this is the demo artifact)
node src/cli.js impact examples/app-a examples/app-b --markdown
```

Expected output: **9 findings** — 2 critical, 7 warning — covering all
six planted bug shapes plus a few intra-file couplings the detectors
correctly emit at lower confidence. Every finding carries the
`confidence` + `confidenceReason` fields that answer "how do I know
this is real?" without the reviewer having to dig.

## Why this fixture works as a demo

- **It is multi-team by construction.** Not "here's a single file with
  a bug" but "here are two codebases that meet only in the browser."
  Nobody in the room will dismiss this as synthetic — this is the
  shape of every web platform past a certain size.
- **Every bug has a product-level consequence** (sign-in breaks, flags
  flicker, widget goes blank, tier copy is wrong). Easy to narrate,
  impossible to dismiss as abstract.
- **The fixture includes regressions for false positives the tool
  previously shipped.** That demonstrates the team takes noise
  seriously and kills it fast when dogfood surfaces it. This is a
  credibility argument; every PSE will notice it.

## When to show this

- **Paired with the live script.** Use this README as the opening
  frame (30 seconds, show the architecture diagram), then run the
  live demo against the same fixtures.
- **On its own, async.** Suitable for Slack-shareable "have a read"
  context-setting before a deeper conversation.
- **As the closing artifact on a slide deck.** One screenshot of the
  architecture diagram plus the finding count is a full summary slide.
