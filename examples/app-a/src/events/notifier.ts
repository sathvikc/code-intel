// notifier.ts — app-a publishes profile changes on the window event bus.
//
// Couples implicitly with app-b/src/listener.ts via the 'profile:changed'
// CustomEvent name. No shared imports; the apps ship independently and
// meet only at runtime in the browser.

export interface ProfileDelta {
  id: string;
  fields: Record<string, unknown>;
}

export function notifyProfileChanged(delta: ProfileDelta): void {
  window.dispatchEvent(new CustomEvent('profile:changed', { detail: delta }));
}
