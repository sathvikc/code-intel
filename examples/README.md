# Examples

Small, runnable reproductions of implicit-coupling patterns we've seen in
real codebases. Each example is a minimal scenario the analyzer should
detect, used for:

- **Dogfooding** — run the analyzer against them, check the output is useful
- **Regression** — if an analyzer change breaks an example's output, we see it
- **Discovery** — when the user encounters a new pattern in enterprise code,
  we add a stripped-down version here and see whether the analyzer catches
  it. If not, that's a bug or a backlog item (see `BACKLOG.md`).

## Layout

Each example lives in a numbered folder. Order is chronological, not
priority.

```
examples/
  README.md                              (this file)
  01-web-storage-auth-token/             single-project storage coupling
  02-events-user-updated-cross-app/      multi-project event coupling
  ...
```

Each folder has:

- A `README.md` — what the pattern is, why it's a bug, expected analyzer output
- One or more app directories with `package.json` + source files

## Running an example

From the repo root:

```bash
# single-project example
node src/cli.js shared-state examples/01-web-storage-auth-token/app --pretty

# multi-project example (each app is a separate project)
node src/cli.js shared-events examples/02-events-user-updated-cross-app/app-a examples/02-events-user-updated-cross-app/app-b --pretty
```

## Adding a new example

When you find a coupling pattern in real code:

1. Strip it to the smallest snippet that reproduces the pattern. Use
   fictional project / variable / key names; never ship real code here.
2. Create `examples/NN-short-slug/` with the next number.
3. Add a `README.md` that describes the pattern and what the analyzer
   should find.
4. Run the relevant analyzer and confirm the output is what you'd want an
   AI reviewer to see. If it isn't, that's a lead — file it in `BACKLOG.md`
   or `OPEN_QUESTIONS.md`, fix the analyzer, or both.
