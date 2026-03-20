#!/usr/bin/env bash
# tests/scripts/claude-hooks.test.sh
# Self-contained bash tests for Claude Code hook scripts in hooks/
# Does NOT require TORQUE server — tests script logic with mocked API responses.

set -uo pipefail

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
ERRORS=()

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hooks" && pwd)"

pass() {
  echo "  PASS: $1"
  ((PASS++))
}

fail() {
  echo "  FAIL: $1"
  echo "        $2"
  ERRORS+=("$1: $2")
  ((FAIL++))
}

# ---------------------------------------------------------------------------
# guard-command tests
# ---------------------------------------------------------------------------
echo ""
echo "=== guard-command ==="

# Test 1: No config file — allow everything
echo "Test 1: no config file allows command"
TMPDIR1="$(mktemp -d)"
cd "$TMPDIR1"
OUTPUT=$(echo '{"tool_input":{"command":"npx vitest run"}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "no config file: exit 0"
else
  fail "no config file: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi
rm -rf "$TMPDIR1"

# Test 2: Config with transport=local — allow everything
echo "Test 2: transport=local allows command"
TMPDIR2="$(mktemp -d)"
mkdir -p "$TMPDIR2/.git"
cat > "$TMPDIR2/.torque-remote.json" <<'CONF'
{"version": 1, "transport": "local", "intercept_commands": ["vitest"]}
CONF
cd "$TMPDIR2"
OUTPUT=$(echo '{"tool_input":{"command":"npx vitest run"}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "transport=local: exit 0"
else
  fail "transport=local: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi
rm -rf "$TMPDIR2"

# Test 3: Config with transport=ssh, intercept vitest — block
echo "Test 3: intercepts vitest with ssh transport"
TMPDIR3="$(mktemp -d)"
mkdir -p "$TMPDIR3/.git"
cat > "$TMPDIR3/.torque-remote.json" <<'CONF'
{"version": 1, "transport": "ssh", "intercept_commands": ["vitest", "jest"]}
CONF
cd "$TMPDIR3"
OUTPUT=$(echo '{"tool_input":{"command":"npx vitest run tests/foo.test.js"}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  # Check if it returned a deny decision in JSON
  if echo "$OUTPUT" | grep -q '"permissionDecision".*"deny"'; then
    pass "vitest blocked: deny decision returned"
  else
    fail "vitest: expected deny decision in output" "$OUTPUT"
  fi
else
  fail "vitest: expected exit 0 with deny JSON, got exit $EXIT_CODE" "$OUTPUT"
fi
rm -rf "$TMPDIR3"

# Test 4: Non-intercepted command — allow
echo "Test 4: non-intercepted command allowed"
TMPDIR4="$(mktemp -d)"
mkdir -p "$TMPDIR4/.git"
cat > "$TMPDIR4/.torque-remote.json" <<'CONF'
{"version": 1, "transport": "ssh", "intercept_commands": ["vitest", "jest"]}
CONF
cd "$TMPDIR4"
OUTPUT=$(echo '{"tool_input":{"command":"git status"}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ] && ! echo "$OUTPUT" | grep -q '"permissionDecision".*"deny"'; then
  pass "git status: allowed"
else
  fail "git status: should be allowed" "$OUTPUT"
fi
rm -rf "$TMPDIR4"

# Test 5: Recursion guard — torque-remote as first token
echo "Test 5: torque-remote recursion guard"
TMPDIR5="$(mktemp -d)"
mkdir -p "$TMPDIR5/.git"
cat > "$TMPDIR5/.torque-remote.json" <<'CONF'
{"version": 1, "transport": "ssh", "intercept_commands": ["vitest"]}
CONF
cd "$TMPDIR5"
OUTPUT=$(echo '{"tool_input":{"command":"torque-remote npx vitest run"}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ] && ! echo "$OUTPUT" | grep -q '"permissionDecision".*"deny"'; then
  pass "torque-remote bypass: allowed"
else
  fail "torque-remote: should bypass guard" "$OUTPUT"
fi
rm -rf "$TMPDIR5"

# Test 6: Multi-word pattern matching (dotnet test)
echo "Test 6: multi-word pattern matching"
TMPDIR6="$(mktemp -d)"
mkdir -p "$TMPDIR6/.git"
cat > "$TMPDIR6/.torque-remote.json" <<'CONF'
{"version": 1, "transport": "ssh", "intercept_commands": ["dotnet test", "dotnet build"]}
CONF
cd "$TMPDIR6"
OUTPUT=$(echo '{"tool_input":{"command":"cd src && dotnet test MyProject.Tests"}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if echo "$OUTPUT" | grep -q '"permissionDecision".*"deny"'; then
  pass "dotnet test: blocked"
else
  fail "dotnet test: should be blocked" "$OUTPUT"
fi
rm -rf "$TMPDIR6"

# Test 7: Multi-word pattern does NOT match partial (dotnet test-utils)
echo "Test 7: multi-word pattern rejects partial match"
TMPDIR7="$(mktemp -d)"
mkdir -p "$TMPDIR7/.git"
cat > "$TMPDIR7/.torque-remote.json" <<'CONF'
{"version": 1, "transport": "ssh", "intercept_commands": ["dotnet test"]}
CONF
cd "$TMPDIR7"
OUTPUT=$(echo '{"tool_input":{"command":"dotnet test-utils run"}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ] && ! echo "$OUTPUT" | grep -q '"permissionDecision".*"deny"'; then
  pass "dotnet test-utils: allowed (not a match)"
else
  fail "dotnet test-utils: should NOT match 'dotnet test'" "$OUTPUT"
fi
rm -rf "$TMPDIR7"

# Test 8: Empty command — allow
echo "Test 8: empty command allowed"
OUTPUT=$(echo '{"tool_input":{"command":""}}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "empty command: exit 0"
else
  fail "empty command: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# Test 9: No tool_input — allow
echo "Test 9: missing tool_input allowed"
OUTPUT=$(echo '{}' | bash "$HOOKS_DIR/guard-command" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "missing input: exit 0"
else
  fail "missing input: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# ---------------------------------------------------------------------------
# check-pending-tasks tests
# ---------------------------------------------------------------------------
echo ""
echo "=== check-pending-tasks ==="

# Test 10: stop_hook_active=true — allow immediately (loop prevention)
echo "Test 10: stop_hook_active bypasses check"
OUTPUT=$(echo '{"stop_hook_active": true}' | bash "$HOOKS_DIR/check-pending-tasks" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "stop_hook_active: exit 0"
else
  fail "stop_hook_active: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# Test 11: TORQUE not reachable — allow (graceful degradation)
echo "Test 11: unreachable server allows stop"
# Override TORQUE_API to a port that's definitely not listening
OUTPUT=$(TORQUE_API="http://127.0.0.1:19999" bash -c '
  export TORQUE_API
  sed "s|http://127.0.0.1:3457|$TORQUE_API|" "'"$HOOKS_DIR/check-pending-tasks"'" > /tmp/check-pending-test.sh
  echo "{}" | bash /tmp/check-pending-test.sh
' 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "unreachable server: exit 0"
else
  fail "unreachable server: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# ---------------------------------------------------------------------------
# audit-mcp-call tests
# ---------------------------------------------------------------------------
echo ""
echo "=== audit-mcp-call ==="

# Test 12: Logs MCP tool call to file
echo "Test 12: writes audit log entry"
TEST_LOG_DIR="$(mktemp -d)"
OUTPUT=$(HOME="$TEST_LOG_DIR" bash -c '
  mkdir -p "$HOME/.torque/logs"
  echo "{\"tool_name\":\"mcp__torque__submit_task\",\"session_id\":\"test-session\",\"cwd\":\"/tmp\"}" | bash "'"$HOOKS_DIR/audit-mcp-call"'"
' 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  LOG_FILE="$TEST_LOG_DIR/.torque/logs/mcp-audit.jsonl"
  if [ -f "$LOG_FILE" ]; then
    CONTENT=$(cat "$LOG_FILE")
    if echo "$CONTENT" | grep -q "submit_task" && echo "$CONTENT" | grep -q "test-session"; then
      pass "audit log: entry written with tool name and session"
    else
      fail "audit log: missing expected fields" "$CONTENT"
    fi
  else
    fail "audit log: file not created" "Expected $LOG_FILE"
  fi
else
  fail "audit log: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi
rm -rf "$TEST_LOG_DIR"

# Test 13: Empty tool_name — no crash
echo "Test 13: empty tool name exits cleanly"
OUTPUT=$(echo '{}' | bash "$HOOKS_DIR/audit-mcp-call" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "empty tool_name: exit 0"
else
  fail "empty tool_name: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# ---------------------------------------------------------------------------
# notify-file-write tests
# ---------------------------------------------------------------------------
echo ""
echo "=== notify-file-write ==="

# Test 14: Empty file_path — exits cleanly
echo "Test 14: empty file_path exits cleanly"
OUTPUT=$(echo '{"tool_input":{}}' | bash "$HOOKS_DIR/notify-file-write" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "empty file_path: exit 0"
else
  fail "empty file_path: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# Test 15: With file_path — doesn't crash (server may or may not be reachable)
echo "Test 15: with file_path exits cleanly"
OUTPUT=$(echo '{"tool_input":{"file_path":"/tmp/test.ts"},"session_id":"test-123","tool_name":"Edit"}' | bash "$HOOKS_DIR/notify-file-write" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "with file_path: exit 0 (fire-and-forget)"
else
  fail "with file_path: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# ---------------------------------------------------------------------------
# session-start tests
# ---------------------------------------------------------------------------
echo ""
echo "=== session-start ==="

# Test 16: Outputs valid JSON
echo "Test 16: produces valid JSON output"
cd "$(mktemp -d)"
mkdir -p .git
OUTPUT=$(bash "$HOOKS_DIR/session-start" 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  if echo "$OUTPUT" | jq . >/dev/null 2>&1; then
    pass "session-start: valid JSON output"
  else
    fail "session-start: invalid JSON" "$OUTPUT"
  fi
else
  fail "session-start: expected exit 0, got $EXIT_CODE" "$OUTPUT"
fi

# Test 17: Contains TORQUE status text
echo "Test 17: contains TORQUE status"
if echo "$OUTPUT" | grep -qi "torque"; then
  pass "session-start: contains TORQUE reference"
else
  fail "session-start: should mention TORQUE" "$OUTPUT"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi

exit 0
