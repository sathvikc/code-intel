# 02 — `user:updated` event across two apps

## Pattern

Two separate apps (no shared imports, possibly different repos in
production) coupled by a `window` CustomEvent name:

- `app-a/src/notifier.ts` dispatches `new CustomEvent('user:updated', …)`
- `app-b/src/listener.ts` subscribes with `addEventListener('user:updated', …)`

When `app-a` is deployed on the same page as `app-b` (common in
micro-frontend / module-federation setups), the browser event bus couples
them. Rename the string in `app-a` and `app-b`'s handler silently never
fires.

## Why it's a bug

Cross-application implicit coupling that no import graph, TypeScript
compiler, or linter will catch. Each app's CI passes independently. The
failure only surfaces at runtime, on the composite page.

## Expected output

Running `shared-events` with both app directories as separate project
roots should produce one finding for channel `'user:updated'` with two
occurrences:

- `op: 'dispatch'`, `project: 'app-a'`, `detectedVia: 'custom-event'`
- `op: 'listen'`,   `project: 'app-b'`, `detectedVia: 'event-listener'`

The `projects` field in the result distinguishes which occurrence came
from which app — the cross-project signal.

## Run it

```bash
node src/cli.js shared-events \
  examples/02-events-user-updated-cross-app/app-a \
  examples/02-events-user-updated-cross-app/app-b \
  --pretty
```
