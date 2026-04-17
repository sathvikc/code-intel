// login.ts — signs in and stashes the auth token.
//
// Couples implicitly with api-client.ts via the 'auth.token' key. No import
// links the two files; renaming the string here breaks the api client
// silently at runtime.

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  const { token } = await res.json();
  localStorage.setItem('auth.token', token);
}

export function logout(): void {
  localStorage.removeItem('auth.token');
}
