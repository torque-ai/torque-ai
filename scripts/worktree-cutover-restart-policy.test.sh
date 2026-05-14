#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/worktree-cutover-restart-policy.sh"

assert_restart_path() {
  local path="$1"
  if ! cutover_changed_path_requires_restart "$path"; then
    echo "Expected restart-required path: $path" >&2
    exit 1
  fi
}

assert_no_restart_path() {
  local path="$1"
  if cutover_changed_path_requires_restart "$path"; then
    echo "Expected no-restart path: $path" >&2
    exit 1
  fi
}

assert_restart_set() {
  local paths="$1"
  if ! cutover_changed_paths_require_restart <<< "$paths"; then
    echo "Expected restart-required path set:" >&2
    printf '%s\n' "$paths" >&2
    exit 1
  fi
}

assert_no_restart_set() {
  local paths="$1"
  if cutover_changed_paths_require_restart <<< "$paths"; then
    echo "Expected no-restart path set:" >&2
    printf '%s\n' "$paths" >&2
    exit 1
  fi
}

assert_no_restart_path "docs/safeguards.md"
assert_no_restart_path "server/docs/api/rest-api.md"
assert_no_restart_path "AGENTS.md"
assert_no_restart_path "CODEX.md"
assert_no_restart_path "GEMINI.md"
assert_no_restart_path "README.md"
assert_no_restart_path ".github/workflows/pre-push.yml"
assert_no_restart_path ".claude/commands/torque-status.md"
assert_no_restart_path "agents/task-reviewer.md"
assert_no_restart_path "skills/torque/SKILL.md"
assert_no_restart_path ".gitignore"

assert_restart_path "server/index.js"
assert_restart_path "server/package.json"
assert_restart_path "dashboard/server.js"
assert_restart_path "scripts/worktree-cutover.sh"
assert_restart_path "package.json"

assert_no_restart_set $'AGENTS.md\nCODEX.md\nGEMINI.md\ndocs/safeguards.md'
assert_no_restart_set $'.github/workflows/ci.yml\nREADME.md\nagents/task-reviewer.md'
assert_restart_set $'docs/safeguards.md\nserver/index.js'
assert_restart_set $'AGENTS.md\nscripts/worktree-cutover.sh'

echo "worktree-cutover restart policy tests passed"
