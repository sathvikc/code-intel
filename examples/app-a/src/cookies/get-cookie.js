// app-a/src/cookies/get-cookie.js
//
// Classic-script cookie helper. Loaded via <script src="cookies.js"></script>
// — no ES modules. Top-level `function parseCookie(...)` becomes a window
// property (`window.parseCookie`). Collides with
// app-b/src/cookies/get-cookie.js if both scripts end up on the same page
// and one loads after the other.
//
// Real production bug: each team shipped their own helper. Later loader
// silently overwrote the earlier one, callers expecting the earlier
// behavior broke at runtime. No import graph, no bundler, no linter sees
// this because it's cross-script coupling on the window object.

function parseCookie(name) {
  var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
