// Framework storage key allowlist fixture.
//
// Reads and writes framework-owned keys like __next and NEXT_LOCALE.
// Thanks to the allowlist, these should NOT emit shared-state findings,
// even though app-b also touches them.

export function updateRouterCache() {
  localStorage.setItem('__next', JSON.stringify({ path: '/' }));
  const locale = localStorage.getItem('NEXT_LOCALE');
}
