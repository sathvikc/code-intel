// login.ts — signs in and stashes the auth token.
//
// Couples implicitly with api-client.ts via the 'app.session' key. No import
// links the two files; renaming the string here breaks the api client
// silently at runtime.

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  const { token } = await res.json();
  localStorage.setItem('app.session', token);
}

export function logout(): void {
  localStorage.removeItem('app.session');
}
