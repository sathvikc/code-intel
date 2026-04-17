// api-client.ts — wraps fetch with the auth header.
//
// Reads 'auth.token' out of localStorage, coupling to login.ts. Neither
// file imports the other; only the string key links them.

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('auth.token');
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
