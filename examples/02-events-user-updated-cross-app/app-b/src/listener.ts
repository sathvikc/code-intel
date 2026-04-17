// listener.ts — app-b listens for user updates from whoever publishes them.
//
// Couples implicitly with app-a/src/notifier.ts via the 'user:updated'
// CustomEvent name. No shared imports.

type UserUpdatedDetail = { id: string; fields: Record<string, unknown> };

export function subscribeToUserUpdates(handler: (d: UserUpdatedDetail) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<UserUpdatedDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener('user:updated', listener);
  return () => window.removeEventListener('user:updated', listener);
}
