#!/usr/bin/env bash
# Canonical commit flow:
#   1. Validate commit message (Angular convention)
#   2. Run tests
#   3. Bump package.json version based on commit type
#   4. Stage package.json
#   5. Create the commit
#
# Usage: ./scripts/commit.sh "feat(engine): add shared-state analyzer"

set -euo pipefail

if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
  cat >&2 <<'USAGE'
Usage: scripts/commit.sh "<type>(<scope>)?!?: <subject>"

Types:     feat, fix, perf, refactor, docs, style, test, build, ci, chore, revert
Bumps:     BREAKING → major · feat → minor · docs/chore → none
           everything else → patch

Examples:
  scripts/commit.sh "feat: add shared-state analyzer"
  scripts/commit.sh "fix(cli): handle missing tsconfig"
  scripts/commit.sh "feat!: change JSON schema v2"
USAGE
  exit 1
fi

MSG="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

# 1. Validate (dry-run: don't write package.json yet)
if ! node -e "
  import('./scripts/version-bump.js').then(({ determineBump }) => {
    const r = determineBump(process.argv[1]);
    if (r.error) { console.error(r.error); process.exit(1); }
    console.error(\`bump: \${r.type} → \${r.bump}\`);
  });
" "$MSG"; then
  exit 1
fi

# 2. Run tests
echo "Running tests..."
npm test --silent

# 3. Bump version (writes package.json only when bump is non-trivial)
BUMP_INFO=$(node scripts/version-bump.js "$MSG")
echo "Version: $BUMP_INFO"

# 4. Stage package.json only when version actually changed.
#    `docs` and `chore` commits leave package.json untouched and must
#    not stage it; otherwise the commit would carry no-op file changes.
if ! grep -q '"bump":"none"' <<<"$BUMP_INFO"; then
  git add package.json
fi

# 5. Commit (includes anything already staged by the user)
git commit -m "$MSG"
