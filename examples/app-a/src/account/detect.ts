// app-a/src/account/detect.ts
//
// Detects the account tier from the 'tier' cookie. Dynamic source —
// document.cookie can change during the session (login, logout, role
// switch, admin tooling that swaps session context). Every call to
// getAccountTier returns the CURRENT value.
//
// Safe to use inside request handlers, render paths, event callbacks —
// anywhere the result is consumed immediately. NOT safe to capture at
// module scope (see account/render.ts for the buggy capture).

export function getAccountTier(): 'free' | 'pro' | 'unknown' {
  const match = document.cookie.match(/(?:^|; )tier=([^;]+)/);
  const value = match ? decodeURIComponent(match[1]) : '';
  if (value === 'free' || value === 'pro') return value;
  return 'unknown';
}
