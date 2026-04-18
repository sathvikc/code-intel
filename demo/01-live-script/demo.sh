#!/usr/bin/env bash
#
# demo.sh — code-intel live demo.
#
# Walks through four bug scenarios against the examples/ fixtures,
# contrasts with what `grep` / `rg` would find, and ends with the
# unified impact report.
#
# Usage:
#   ./demo.sh          auto-play (pause ~2s per step)
#   ./demo.sh -i       interactive (press Enter between steps)
#   ./demo.sh -f       fast (no pauses; smoke test)

set -euo pipefail

# Resolve repo root regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

MODE="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    -i|--interactive) MODE="interactive" ;;
    -f|--fast)        MODE="fast" ;;
    -h|--help)
      sed -n '3,13p' "$0"; exit 0 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2 ;;
  esac
  shift
done

# ---------- output helpers ----------

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  BOLD="$(tput bold)"; DIM="$(tput dim)"
  RED="$(tput setaf 1)"; GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"; BLUE="$(tput setaf 4)"
  CYAN="$(tput setaf 6)"; RESET="$(tput sgr0)"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; RESET=""
fi

# ripgrep is preferred; fall back to grep so the demo does not die if
# the presenter's machine does not have rg installed. We restrict to
# source files (.js, .ts, .tsx) so demo greps don't surface README
# noise.
if command -v rg >/dev/null 2>&1; then
  SEARCH() { rg --no-heading --line-number --color never --type-add 'src:*.{js,ts,tsx}' --type src "$@"; }
else
  SEARCH() { grep -rn --color=never --include='*.js' --include='*.ts' --include='*.tsx' "$@"; }
fi

pause() {
  local seconds="${1:-2}"
  case "$MODE" in
    interactive)
      echo
      printf "  %s[press Enter to continue]%s " "$DIM" "$RESET"
      read -r _
      echo ;;
    auto)
      sleep "$seconds" ;;
    fast)
      : ;;
  esac
}

banner() {
  echo
  echo "${BOLD}${BLUE}============================================================${RESET}"
  echo "${BOLD}${BLUE} $1${RESET}"
  echo "${BOLD}${BLUE}============================================================${RESET}"
  echo
}

sub() {
  echo
  echo "${BOLD}${CYAN}--- $1${RESET}"
  echo
}

narrate() {
  echo "${DIM}$1${RESET}"
  echo
}

# ---------- opening ----------

banner "code-intel  —  live demo"
narrate "Static analyzer for implicit-coupling bugs in JS/TS codebases."
narrate "Finds cross-file coupling that lint, type-check, and grep miss."
narrate "We will walk through four real bug shapes, ending with a PR-style report."
pause 3

# ---------- scenario 1: classic-script global overwrite ----------

banner "Scenario 1 of 4  —  Classic-script global overwrite"

narrate "App A and App B each ship a classic-script cookie parser."
narrate "Both define a top-level 'function parseCookie()'."
narrate "Whichever loads second silently overwrites the other on 'window'."
pause

sub "App A  —  examples/app-a/src/cookies/get-cookie.js"
cat examples/app-a/src/cookies/get-cookie.js
pause 3

sub "App B  —  examples/app-b/src/cookies/get-cookie.js"
cat examples/app-b/src/cookies/get-cookie.js
pause 3

sub "What \`rg\` / \`grep\` shows"
SEARCH "function parseCookie" examples/ || true
pause 2
narrate "Grep sees two definitions. It has no idea whether they will collide."
narrate "The difference between 'safe module scope' and 'classic-script global'"
narrate "is a structural property of the file, not a line-level match."
pause

sub "What code-intel finds"
node src/cli.js shared-globals examples/app-a examples/app-b --pretty 2>/dev/null \
  | node -e "
    const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    for (const f of r.findings) {
      console.log('  ${BOLD}${RED}shared-global-binding${RESET}:', f.name);
      console.log('    occurrences:');
      for (const o of f.occurrences) {
        console.log('      -', o.project + ':' + o.file + ':' + o.line, '(' + o.op + ')');
      }
    }
  "
pause 3
narrate "Both files are classic scripts (no import/export). The detector knows"
narrate "that classic-script top-level declarations become globals, and that"
narrate "two of them will collide. High confidence — this WILL overwrite."
pause

# ---------- scenario 2: cross-project CustomEvent contract ----------

banner "Scenario 2 of 4  —  Cross-project CustomEvent contract"

narrate "App A dispatches a 'profile:changed' event with { id, fields }."
narrate "App B listens for it and pulls fields off the detail."
narrate "Nothing in the type system connects the two sides."
pause

sub "App A dispatcher  —  examples/app-a/src/events/notifier.ts"
cat examples/app-a/src/events/notifier.ts
pause 3

sub "App B listener  —  examples/app-b/src/events/listener.ts"
cat examples/app-b/src/events/listener.ts
pause 3

sub "What \`rg\` shows"
SEARCH "profile:changed" examples/ || true
pause 2
narrate "Grep finds the channel name. It does not tell you the dispatcher and"
narrate "listener have an implicit contract on the event's detail payload."
pause

sub "What code-intel finds"
node src/cli.js shared-events examples/app-a examples/app-b --pretty 2>/dev/null \
  | node -e "
    const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    for (const f of r.findings) {
      if (f.channel !== 'profile:changed') continue;
      console.log('  ${BOLD}${RED}shared-event-channel${RESET}:', JSON.stringify(f.channel));
      const ops = {};
      for (const o of f.occurrences) (ops[o.op] ??= []).push(o.project + ':' + o.file + ':' + o.line);
      for (const [op, sites] of Object.entries(ops)) console.log('    ' + op + ':', sites.join(', '));
    }
  "
pause 3
narrate "Dispatcher in one project, listener in another. High confidence —"
narrate "any change to the event.detail shape on one side breaks the other."
pause

# ---------- scenario 3: paired-keys / IXP bug ----------

banner "Scenario 3 of 4  —  The IXP paired-key cache bug"

narrate "A cache stores two keys that must travel together:"
narrate "  'app.flags'     — the payload"
narrate "  'app.flags.ts'  — the timestamp used for TTL"
narrate "If another writer touches only the payload, readers see stale flags."
pause

sub "examples/app-a/src/flags/paired-write.ts"
cat examples/app-a/src/flags/paired-write.ts
pause 4

sub "What \`rg\` shows"
SEARCH "setItem\\('app\\.flags" examples/ || true
pause 2
narrate "Grep shows three writers. It CANNOT tell you the first two are a"
narrate "cluster inside one function body and the third breaks the pair."
pause

sub "What code-intel finds"
node src/cli.js paired-keys examples/app-a examples/app-b --pretty 2>/dev/null \
  | node -e "
    const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    for (const f of r.findings) {
      console.log('  ${BOLD}${YELLOW}paired-keys${RESET}:', f.storage, '[' + f.keys.map(k => JSON.stringify(k)).join(', ') + ']');
      console.log('    in:', f.occurrences[0].project + ':' + f.occurrences[0].file);
      console.log('    lines:', f.occurrences.map(o => o.line).join(', '));
    }
  "
pause 3
narrate "Extracted automatically from the source: these two keys are paired."
narrate "Every future writer of either key can now be checked against this fact."
pause

# ---------- scenario 4: stale module-scope capture ----------

banner "Scenario 4 of 4  —  Stale module-scope capture (SPA-contextual)"

narrate "Someone writes 'const accountTier = getAccountTier()' at module scope."
narrate "It looks fine. TypeScript is happy. Tests pass."
narrate "In SPAs, modules persist — that value is frozen forever."
pause

sub "examples/app-a/src/account/detect.ts"
cat examples/app-a/src/account/detect.ts
pause 3

sub "examples/app-a/src/account/render.ts"
cat examples/app-a/src/account/render.ts
pause 4

sub "What code-intel finds"
node src/cli.js stale-captures examples/app-a --pretty 2>/dev/null \
  | node -e "
    const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    for (const f of r.findings) {
      console.log('  ${BOLD}${YELLOW}stale-module-capture${RESET}:', f.name, '(via', f.capturedVia + ')');
      for (const o of f.occurrences) {
        console.log('    at:', o.project + ':' + o.file + ':' + o.line);
      }
    }
  "
pause 3
narrate "This is where 'confidence: medium' matters. The finding is flagged,"
narrate "but the reason string (visible in impact output) names the runtime"
narrate "contexts where it bites (SPA, SSR client bundle, workers) and where"
narrate "it is lower-risk (classic MPAs with full page reloads). The reviewer"
narrate "decides in 5 seconds whether to act."
pause

# ---------- closing: unified impact report ----------

banner "Closing  —  the unified PR-style report"

narrate "This is what a reviewer (or an AI) actually sees on a PR."
narrate "Every finding carries severity + confidence + a one-paragraph reason."
pause 2

node src/cli.js impact examples/app-a examples/app-b --markdown 2>/dev/null

banner "Demo complete"
narrate "4 bug scenarios, 1 unified report, about 1 second of analysis time."
narrate "Read demo/03-bug-gallery/README.md for the story-first version of all five patterns."
