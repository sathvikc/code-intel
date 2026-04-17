// app-a/src/customer/detect.ts
//
// Detects customer type from the 'ct' cookie. Dynamic source —
// document.cookie can change during the session (login, impersonation,
// logout, admin tool mutation). Every call to getCustomerType returns
// the CURRENT value.
//
// Safe to use inside request handlers, render paths, event callbacks —
// anywhere the result is consumed immediately. NOT safe to capture at
// module scope (see customer/greeting.ts for the buggy capture).

export function getCustomerType(): 'retail' | 'business' | 'unknown' {
  const match = document.cookie.match(/(?:^|; )ct=([^;]+)/);
  const value = match ? decodeURIComponent(match[1]) : '';
  if (value === 'retail' || value === 'business') return value;
  return 'unknown';
}
