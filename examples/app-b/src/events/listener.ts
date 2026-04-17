// listener.ts — app-b listens for profile changes from whoever publishes them.
//
// Couples implicitly with app-a/src/notifier.ts via the 'profile:changed'
// CustomEvent name. No shared imports.

type ProfileChangedDetail = { id: string; fields: Record<string, unknown> };

export function subscribeToProfileChanges(handler: (d: ProfileChangedDetail) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ProfileChangedDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener('profile:changed', listener);
  return () => window.removeEventListener('profile:changed', listener);
}
