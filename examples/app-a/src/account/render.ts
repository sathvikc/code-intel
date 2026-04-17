// app-a/src/account/render.ts
//
// Renders tier-aware copy for the landing surface.
//
// BUG: `accountTier` is captured at module load time — the first time
// this file is imported — and never refreshed. If the 'tier' cookie flips
// mid-session (role switch, admin context change, login / logout),
// `renderAccountCopy` keeps returning the copy for the ORIGINAL tier
// because the captured `accountTier` constant was frozen at import.
//
// The fix is trivial: call `getAccountTier()` inside `renderAccountCopy`.
// The bug is silent because:
//   - TypeScript compiles fine (it's a valid top-level const).
//   - Unit tests pass because each test imports the module fresh.
//   - Production breaks because the ES-module import cache keeps the
//     snapshot alive for the entire page session.
//
// Analyzer should flag: module-scope `const X = f()` where `f` reaches
// a dynamic runtime source (here, `document.cookie` via getAccountTier).

import { getAccountTier } from './detect';

const accountTier = getAccountTier();

export function renderAccountCopy(): string {
  switch (accountTier) {
    case 'free': return 'Welcome back!';
    case 'pro':  return 'Welcome to the Pro workspace.';
    default:     return 'Hello.';
  }
}
