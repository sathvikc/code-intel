// app-b/src/cookies/get-cookie.js
//
// Classic-script cookie helper in app-b. Intentionally a *different*
// implementation from app-a's: returns raw (non-URI-decoded) value, and
// returns '' instead of null on miss. If this script loads after app-a's,
// `window.parseCookie` is silently overwritten; app-a's callers that
// expected decoded values / null-on-miss silently break.
//
// Analyzer should flag: two definitions of a global binding named
// `parseCookie` across projects.

function parseCookie(name) {
  var parts = document.cookie.split(';');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].trim().split('=');
    if (kv[0] === name) return kv[1] || '';
  }
  return '';
}
