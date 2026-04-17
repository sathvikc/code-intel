# 01 — Auth token shared via `localStorage`

## Pattern

Two files, no import edge, coupled by a string key:

- `src/login.ts` writes `localStorage.setItem('auth.token', token)`
- `src/api-client.ts` reads `localStorage.getItem('auth.token')`

If someone renames the key in one file, the other breaks silently at
runtime. An AI reviewer looking at `login.ts` in isolation has no way to
know `api-client.ts` depends on the literal string `'auth.token'`.

## Why it's a bug

Static analysis (TS, ESLint, import graph) cannot surface this coupling.
The files share no type, no import, no export. Only the string literal
links them.

## Expected output

Running `shared-state` on `app/` should produce one finding with two
occurrences — a `write` in `login.ts` and a `read` in `api-client.ts`,
both grouped under the key `auth.token`.

## Run it

```bash
node src/cli.js shared-state examples/01-web-storage-auth-token/app --pretty
```
