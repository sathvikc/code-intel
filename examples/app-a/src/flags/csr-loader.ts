// app-a/src/flags/csr-loader.ts
//
// CSR feature-flag loader. Fetches flags from the API, caches the payload
// in sessionStorage under 'app.runtime-config' with a 15-minute TTL.
// Subsequent calls within the TTL short-circuit and return the cached
// value without hitting the API.
//
// Implicit coupling (bug): writes the SAME 'app.runtime-config' key as
// ssr-inject.ts — but with a DIFFERENT payload shape (this one wraps in
// {value, fetchedAt}; SSR writes the flags object directly). On a fresh
// page load, SSR writes the raw flags object first, then this loader
// runs, sees non-JSON-wrapper data under 'app.runtime-config', either crashes on
// `.fetchedAt` being undefined or refreshes unnecessarily; OR after the
// loader has run once, SSR's next page-load write stomps the cache
// envelope and the next reader sees raw flags where it expects a cache
// entry.
//
// The analyzer surfaces "two writers, one key." The reviewer (or AI)
// sees the shape mismatch by reading the two snippets.

const CACHE_TTL_MS = 15 * 60 * 1000;

interface CachedFlags {
  value: Record<string, unknown>;
  fetchedAt: number;
}

export async function loadFeatureFlags(): Promise<Record<string, unknown>> {
  const raw = sessionStorage.getItem('app.runtime-config');
  if (raw) {
    try {
      const cached: CachedFlags = JSON.parse(raw);
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.value;
      }
    } catch {
      // Stale payload shape (e.g. SSR-injected raw flags) — fall through.
    }
  }
  const res = await fetch('/api/feature-flags');
  const value = (await res.json()) as Record<string, unknown>;
  sessionStorage.setItem('app.runtime-config', JSON.stringify({ value, fetchedAt: Date.now() } satisfies CachedFlags));
  return value;
}
