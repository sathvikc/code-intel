// Native DOM events (regression fixture for dogfood review §2.7).
//
// These are wire-ups to built-in browser events. Two files both listening
// to `'resize'` is NOT coupling — it's two independent window-event
// handlers. The `shared-events` detector must drop listen-only
// occurrences whose channel name is a known native event, to prevent the
// noise class observed in the dogfood review (11 `resize` listeners
// surfaced as a coupling finding).
//
// The pre-existing `notifier.ts` in this folder still dispatches
// `profile:changed`, which IS a CustomEvent channel and continues to
// emit a finding paired with `examples/app-b/src/events/`.

export function installLifecycleHandlers(): void {
  window.addEventListener('resize', () => {});
  window.addEventListener('scroll', () => {});
  window.addEventListener('popstate', () => {});
  window.addEventListener('message', () => {});
  window.addEventListener('visibilitychange', () => {});
}
