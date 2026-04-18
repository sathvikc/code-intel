// Reader for the shape-drift fixture (P9).
//
// Reads the user profile from localStorage['user.profile'] and accesses
// `firstName` and `lastName` on the parsed value. The writer in
// `write-profile.ts` stores `{ name, age }` instead — classic post-
// refactor drift: the writer was left on the old shape.
//
// The `||'{}'` fallback is realistic — readers usually guard against a
// null from an unpopulated storage slot. shape-drift unwraps it.

interface CachedProfile {
  firstName: string;
  lastName: string;
}

export function renderGreeting(): string {
  const cached: CachedProfile = JSON.parse(localStorage.getItem('user.profile') || '{}');
  return `Hello, ${cached.firstName} ${cached.lastName}`;
}
