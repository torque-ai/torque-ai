#!/usr/bin/env bash
# Test helper invoked by Vitest tests for bin/torque-remote.
# Usage: _torque-remote-test-runner.sh <function-name> <remote-os> [args...]
# Sources bin/torque-remote in test mode, sets $REMOTE_OS, invokes the
# named function with passed args, and prints the result to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TORQUE_REMOTE="$REPO_ROOT/bin/torque-remote"

if [[ ! -f "$TORQUE_REMOTE" ]]; then
  echo "ERROR: torque-remote not found at $TORQUE_REMOTE" >&2
  exit 2
fi

func_name="$1"
# Issue 2: reject empty function name early with a clean exit code
if [[ -z "${func_name:-}" ]]; then
  echo "ERROR: function name (arg 1) must not be empty" >&2
  exit 64
fi
remote_os="$2"
shift 2

export TORQUE_REMOTE_TEST_MODE=1
export TORQUE_REMOTE_EMIT_ONLY=1
export REMOTE_OS="$remote_os"
export SSH_HOST="test-host"
export SSH_USER="test-user"
# Issue 3: bash arrays cannot be exported; plain assignment is correct
SSH_OPTS=()

# Special dispatcher: classify_and_print sets REMOTE_OS via the classifier
# and then echoes the result. Used by probe tests.
classify_and_print() {
  classify_remote_os "$1"
  echo "$REMOTE_OS"
}

# Check that a function is defined; print its first line of definition.
# Issue 1: `declare -f X` exits 1 when X is undefined, which kills the script
# under `set -e`. Piping to `head` makes `set -e` check only head's exit code
# (always 0 on empty input), so a missing function produces empty output
# instead of crashing.
declare_and_print() {
  # `declare -f X` exits 1 if X is undefined. With `set -o pipefail` the
  # pipeline inherits that non-zero exit even though `head` exits 0 on empty
  # input. The `|| true` absorbs the non-zero so the script does not crash
  # under `set -e`; a missing function produces empty stdout, not an abort.
  declare -f "$1" 2>/dev/null | head -1 || true
}

# shellcheck source=/dev/null
source "$TORQUE_REMOTE"

# Invoke the function
"$func_name" "$@"
