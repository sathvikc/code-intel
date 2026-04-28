import { describe, it, expect, beforeEach } from 'vitest';
describe('flags integration', () => {
  beforeEach(() => {
    localStorage.setItem('flags', JSON.stringify({ featureA: true }));
  });
  it('reads featureA flag', () => {
    const raw = localStorage.getItem('flags');
    expect(JSON.parse(raw!)['featureA']).toBe(true);
  });
});
