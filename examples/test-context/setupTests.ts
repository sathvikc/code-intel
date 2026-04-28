// Test-isolation plumbing — D21 exists to drop files like this from cross-file analysis.
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: class IntersectionObserver { observe() {} unobserve() {} disconnect() {} },
});
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (q: string) => ({ matches: false, media: q, addListener: () => {}, removeListener: () => {} }),
});
localStorage.setItem('flags', JSON.stringify({ featureA: false }));
