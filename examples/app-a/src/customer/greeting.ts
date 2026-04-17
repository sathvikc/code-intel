// app-a/src/customer/greeting.ts
//
// Renders a customer-specific greeting.
//
// BUG: `customerType` is captured at module load time — the first time
// this file is imported — and never refreshed. If the 'ct' cookie flips
// mid-session (login, impersonation), `renderGreeting` keeps returning
// the greeting for the ORIGINAL customer type because the captured
// `customerType` constant was frozen at import.
//
// The fix is trivial: call `getCustomerType()` inside `renderGreeting`.
// The bug is silent because:
//   - TypeScript compiles fine (it's a valid top-level const).
//   - Unit tests pass because each test imports the module fresh.
//   - Production breaks because the ES-module import cache keeps the
//     snapshot alive for the entire page session.
//
// Analyzer should flag: module-scope `const X = f()` where `f` reaches
// a dynamic runtime source (here, `document.cookie` via getCustomerType).

import { getCustomerType } from './detect';

const customerType = getCustomerType();

export function renderGreeting(): string {
  switch (customerType) {
    case 'retail':   return 'Welcome back!';
    case 'business': return 'Welcome to the business portal.';
    default:         return 'Hello.';
  }
}
