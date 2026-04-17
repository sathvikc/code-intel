// notifier.ts — app-a publishes user updates on the window event bus.
//
// Couples implicitly with app-b/src/listener.ts via the 'user:updated'
// CustomEvent name. No shared imports; the apps ship independently and
// meet only at runtime in the browser.

export interface UserDelta {
  id: string;
  fields: Record<string, unknown>;
}

export function notifyUserUpdated(delta: UserDelta): void {
  window.dispatchEvent(new CustomEvent('user:updated', { detail: delta }));
}
