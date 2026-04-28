// Production code: reads a feature flag
export function isFlagEnabled(name: string): boolean {
  const raw = localStorage.getItem('flags');
  if (!raw) return false;
  return JSON.parse(raw)[name] === true;
}
