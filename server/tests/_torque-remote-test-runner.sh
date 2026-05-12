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
remote_os="$2"
shift 2

export TORQUE_REMOTE_TEST_MODE=1
export TORQUE_REMOTE_EMIT_ONLY=1
export REMOTE_OS="$remote_os"
export SSH_HOST="test-host"
export SSH_USER="test-user"
export SSH_OPTS=()

# Special dispatcher: classify_and_print sets REMOTE_OS via the classifier
# and then echoes the result. Used by probe tests.
classify_and_print() {
  classify_remote_os "$1"
  echo "$REMOTE_OS"
}

# Check that a function is defined; print its first line of definition.
declare_and_print() {
  declare -f "$1" | head -1
}

# shellcheck source=/dev/null
source "$TORQUE_REMOTE"

# Invoke the function
"$func_name" "$@"
