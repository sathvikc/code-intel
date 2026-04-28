import { vi, describe, it } from 'vitest';
describe('observeElement', () => {
  it('spies on IntersectionObserver', () => {
    const spy = vi.spyOn(window, 'IntersectionObserver' as any);
    // production function call would go here
    spy.mockRestore();
  });
});
