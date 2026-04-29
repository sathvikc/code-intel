// Framework storage key allowlist fixture.
//
// Reads and writes framework-owned keys like __next and NEXT_LOCALE.
// Thanks to the allowlist, these should NOT emit shared-state findings,
// even though app-a also touches them.

export function readRouterCache() {
  const nextData = JSON.parse(localStorage.getItem('__next') || '{}');
  localStorage.setItem('NEXT_LOCALE', 'en-US');
}
