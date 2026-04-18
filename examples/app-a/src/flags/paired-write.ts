// Paired-key write cluster (P10 fixture; regression for meganav dogfood §2.2).
//
// `app.flags` stores the feature-flag payload; `app.flags.ts` stores the
// timestamp readers use to decide whether the cache is still fresh. The
// two keys are a pair by convention — any writer that touches one
// without the other silently breaks the TTL check and makes readers
// serve stale payload. The language does not enforce "these keys
// travel together"; only the clustering inside `cacheFlags` records
// the intent.
//
// The `paired-keys` detector must emit ONE finding on this file listing
// both keys. `cacheFlagsMissingTs` is the regression target — it only
// writes the payload, so it must NOT form a cluster on its own.

export function cacheFlags(flags: Record<string, unknown>): void {
  sessionStorage.setItem('app.flags', JSON.stringify(flags));
  sessionStorage.setItem('app.flags.ts', String(Date.now()));
}

export function cacheFlagsMissingTs(flags: Record<string, unknown>): void {
  // The IXP-bug shape: writer forgot the timestamp sibling.
  sessionStorage.setItem('app.flags', JSON.stringify(flags));
}

export function unrelatedWrite(value: string): void {
  sessionStorage.setItem('other.key', value);
}
