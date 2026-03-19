#!/usr/bin/env bash
# scripts/torque-test-guard.sh
# Claude Code PreToolUse hook — blocks direct test runner invocations when a
# test station is configured. Receives JSON on stdin; exits 0 to allow, 2 to
# block.
#
# Hook protocol:
#   stdin:  { "tool_input": { "command": "..." } }
#   exit 0: allow the tool call
#   exit 2: block the tool call (stderr message is shown to the agent)

set -uo pipefail

# ---------------------------------------------------------------------------
# 1. Locate project root (one directory up from this script's directory)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/.torque-test.json"

# ---------------------------------------------------------------------------
# 2. If no config or transport is "local" → allow everything
# ---------------------------------------------------------------------------
if [[ ! -f "$CONFIG_FILE" ]]; then
  exit 0
fi

# Require jq to parse configs; if unavailable, allow
if ! command -v jq &>/dev/null; then
  exit 0
fi

transport="$(jq -r '.transport // "local"' "$CONFIG_FILE" 2>/dev/null)"
if [[ $? -ne 0 ]] || [[ "$transport" == "local" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Read the command from stdin JSON
# ---------------------------------------------------------------------------
stdin_json="$(cat)"

if [[ -z "$stdin_json" ]]; then
  exit 0
fi

command_str="$(printf '%s' "$stdin_json" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# If jq failed or no command field, allow
if [[ $? -ne 0 ]] || [[ -z "$command_str" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Check for test runner keywords (word-boundary aware)
#    Allow if the command already routes through torque-test
# ---------------------------------------------------------------------------

# If command already uses the torque-test script, allow it
if printf '%s' "$command_str" | grep -q 'torque-test'; then
  exit 0
fi

# Test runner patterns (word-boundary anchors where applicable)
BLOCKED=0

if printf '%s' "$command_str" | grep -qE '\bvitest\b'; then
  BLOCKED=1
elif printf '%s' "$command_str" | grep -qE '\bjest\b'; then
  BLOCKED=1
elif printf '%s' "$command_str" | grep -qE '\bmocha\b'; then
  BLOCKED=1
elif printf '%s' "$command_str" | grep -qE '\bpytest\b'; then
  BLOCKED=1
elif printf '%s' "$command_str" | grep -qE '\bnpm test\b'; then
  BLOCKED=1
elif printf '%s' "$command_str" | grep -qE '\bnpx test\b'; then
  BLOCKED=1
elif printf '%s' "$command_str" | grep -qE '\bnpm run test\b'; then
  BLOCKED=1
fi

if [[ $BLOCKED -eq 0 ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Block with a clear error message
# ---------------------------------------------------------------------------
cat >&2 <<EOF
BLOCKED: Direct test execution detected.

Your project has a test station configured (transport: $transport).
All tests must route through the test runner script.

Instead of:
  $command_str

Use:
  ./scripts/torque-test.sh $command_str

This ensures tests run on the configured test station, not locally.
EOF

exit 2
