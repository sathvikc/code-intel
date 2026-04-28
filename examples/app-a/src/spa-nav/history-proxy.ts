// SPA navigation hook — wraps history.pushState / replaceState to fire
// a synthetic event whenever route changes happen client-side.
//
// IMPLEMENTATION NOTE: this file demonstrates the canonical P8 / D22
// bug pattern. A third-party library that later writes
// `window.history.someLibKey = ...` can have its writes silently
// swallowed if the Proxy's set trap doesn't forward via Reflect.set.
// Prefer monkey-patching pushState / replaceState directly when
// possible.

const NAV_EVENT = 'spa:navigate';

window.history = new Proxy(window.history, {
  get(target, prop, receiver) {
    if (prop === 'pushState' || prop === 'replaceState') {
      return function patched(...args: unknown[]) {
        const result = (target[prop] as Function).apply(target, args);
        window.dispatchEvent(new CustomEvent(NAV_EVENT, { detail: { prop } }));
        return result;
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});

export {};
