// Self-assign scenario (regression fixture for meganav dogfood §2.6).
//
// Three explicit `window.X` writes live inside ONE file. This is intra-file
// code — initialization, mutation, reset — not cross-bundle coupling. The
// `shared-globals` detector must NOT emit a finding for this pattern.
//
// Pair with the real collision case in `examples/app-a/src/cookies/` and
// `examples/app-b/src/cookies/` (`parseCookie` in two classic scripts).

window.__appScrollLockOverlays = new Set();

function addOverlay(id) {
  window.__appScrollLockOverlays.add(id);
}

// Reset the set on page unload-ish events. Still the same file, same binding.
window.__appScrollLockOverlays = new Set();

function clearOverlays() {
  window.__appScrollLockOverlays = null;
}
