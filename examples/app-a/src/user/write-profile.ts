// Writer for the shape-drift fixture (P9).
//
// Stores a user profile in localStorage under the key 'user.profile'
// with the shape { name, age }. A pre-refactor codebase; imagine this
// was the original implementation.
//
// The reader in `read-profile.ts` was refactored against a *different*
// shape — `{ firstName, lastName }` — after someone split `name` into
// first/last. The refactor PR was clean, types were green (both sides
// typed `CachedProfile` locally; there is no cross-file type propagation
// through `JSON.stringify` / `JSON.parse`), tests passed, prod broke.
//
// shape-drift must flag this cross-file channel:
//   writeShape: {age, name}   readShape: {firstName, lastName}
//   readOnlyKeys:  {firstName, lastName}  ← reader will see undefined
//   writeOnlyKeys: {age, name}            ← writer is storing dead fields

interface ProfilePayload {
  name: string;
  age: number;
}

export function saveProfile(profile: ProfilePayload): void {
  localStorage.setItem('user.profile', JSON.stringify({ name: profile.name, age: profile.age }));
}
