// Pure version-bump logic for Angular-style commit messages.
//
// Mapping:
//   - BREAKING CHANGE footer OR `<type>!:`   → major
//   - feat                                    → minor
//   - fix, perf, refactor, docs, style,       → patch
//     test, build, ci, chore, revert
//
// Every valid commit bumps the version. Invalid messages return an error.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const VALID_TYPES = [
  'feat', 'fix', 'perf', 'refactor',
  'docs', 'style', 'test',
  'build', 'ci', 'chore', 'revert',
];

const HEADER_RE = new RegExp(
  `^(${VALID_TYPES.join('|')})(\\([^)\\r\\n]+\\))?(!)?: .+`,
);
const BREAKING_FOOTER_RE = /^BREAKING CHANGE:/m;

export function determineBump(message) {
  if (typeof message !== 'string' || message.trim() === '') {
    return { error: 'Commit message is empty.' };
  }
  const header = message.split('\n', 1)[0];
  const match = header.match(HEADER_RE);
  if (!match) {
    return {
      error:
        'Invalid commit message. Expected Angular convention:\n' +
        '  <type>(<optional-scope>)?!?: <subject>\n' +
        `Types: ${VALID_TYPES.join(', ')}`,
    };
  }
  const [, type, , bang] = match;
  if (bang || BREAKING_FOOTER_RE.test(message)) {
    return { bump: 'major', type, breaking: true };
  }
  if (type === 'feat') return { bump: 'minor', type, breaking: false };
  return { bump: 'patch', type, breaking: false };
}

export function applyBump(version, bump) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  const [maj, min, pat] = parts;
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Unknown bump: ${bump}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const msg = process.argv[2];
  const result = determineBump(msg);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  const pkgPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'package.json',
  );
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const from = pkg.version;
  const to = applyBump(from, result.bump);
  pkg.version = to;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(
    JSON.stringify({ type: result.type, bump: result.bump, from, to }),
  );
}
