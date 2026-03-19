#!/usr/bin/env bash
# tests/scripts/torque-test.test.sh
# Self-contained bash tests for scripts/torque-test.sh
# Does NOT actually SSH anywhere.

set -uo pipefail

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
ERRORS=()

SCRIPT_UNDER_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/torque-test.sh"

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

# Create a temporary project directory containing a copy of the script.
# Returns the path in TMPDIR_VAR.
make_project() {
  local tmp
  tmp="$(mktemp -d)"
  # Place script inside a scripts/ subdirectory just like the real project
  mkdir -p "$tmp/scripts"
  cp "$SCRIPT_UNDER_TEST" "$tmp/scripts/torque-test.sh"
  chmod +x "$tmp/scripts/torque-test.sh"
  echo "$tmp"
}

run_test() {
  local project="$1"
  shift
  bash "$project/scripts/torque-test.sh" "$@"
}

# ---------------------------------------------------------------------------
# Test 1: Local transport — runs command directly
# ---------------------------------------------------------------------------
echo "Test 1: local transport runs command directly"
T1="$(make_project)"
cat > "$T1/.torque-test.json" <<'EOF'
{
  "transport": "local",
  "verify_command": "echo HELLO_LOCAL",
  "timeout_seconds": 30
}
EOF

output="$(run_test "$T1" 2>&1)"
exit_code=$?

if [[ $exit_code -eq 0 ]] && echo "$output" | grep -q "HELLO_LOCAL"; then
  pass "local transport executes verify_command and exits 0"
else
  fail "local transport executes verify_command and exits 0" "exit=$exit_code output='$output'"
fi
rm -rf "$T1"

# ---------------------------------------------------------------------------
# Test 2: Positional arguments override verify_command
# ---------------------------------------------------------------------------
echo "Test 2: positional args override verify_command"
T2="$(make_project)"
cat > "$T2/.torque-test.json" <<'EOF'
{
  "transport": "local",
  "verify_command": "echo SHOULD_NOT_APPEAR",
  "timeout_seconds": 30
}
EOF

output="$(run_test "$T2" echo OVERRIDE_ARGS 2>&1)"
exit_code=$?

if [[ $exit_code -eq 0 ]] && echo "$output" | grep -q "OVERRIDE_ARGS"; then
  pass "positional args replace verify_command"
else
  fail "positional args replace verify_command" "exit=$exit_code output='$output'"
fi

if ! echo "$output" | grep -q "SHOULD_NOT_APPEAR"; then
  pass "original verify_command is not executed when args provided"
else
  fail "original verify_command is not executed when args provided" "original command appeared in output"
fi
rm -rf "$T2"

# ---------------------------------------------------------------------------
# Test 3: Missing config runs locally with a warning
# ---------------------------------------------------------------------------
echo "Test 3: missing config runs locally with warning"
T3="$(make_project)"
# No .torque-test.json

output="$(run_test "$T3" echo NO_CONFIG_RUN 2>&1)"
exit_code=$?

if [[ $exit_code -eq 0 ]] && echo "$output" | grep -q "NO_CONFIG_RUN"; then
  pass "missing config still runs command"
else
  fail "missing config still runs command" "exit=$exit_code output='$output'"
fi

if echo "$output" | grep -qi "warning"; then
  pass "missing config prints a warning"
else
  fail "missing config prints a warning" "no warning in output='$output'"
fi
rm -rf "$T3"

# ---------------------------------------------------------------------------
# Test 4: SSH transport with missing .local.json produces clear error
# ---------------------------------------------------------------------------
echo "Test 4: SSH transport missing .local.json errors clearly"
T4="$(make_project)"
cat > "$T4/.torque-test.json" <<'EOF'
{
  "transport": "ssh",
  "verify_command": "echo should_not_run",
  "timeout_seconds": 30
}
EOF
# No .torque-test.local.json

output="$(run_test "$T4" 2>&1)"
exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  pass "SSH with missing .local.json exits non-zero"
else
  fail "SSH with missing .local.json exits non-zero" "exited 0 — should have failed"
fi

if echo "$output" | grep -qi "local.json\|local config"; then
  pass "SSH error message mentions .local.json"
else
  fail "SSH error message mentions .local.json" "output='$output'"
fi
rm -rf "$T4"

# ---------------------------------------------------------------------------
# Test 5: SSH transport with .local.json missing required fields errors
# ---------------------------------------------------------------------------
echo "Test 5: SSH transport .local.json missing host field errors"
T5="$(make_project)"
cat > "$T5/.torque-test.json" <<'EOF'
{
  "transport": "ssh",
  "verify_command": "echo should_not_run",
  "timeout_seconds": 30
}
EOF
cat > "$T5/.torque-test.local.json" <<'EOF'
{
  "user": "someuser",
  "project_path": "/remote/path"
}
EOF
# Missing "host"

output="$(run_test "$T5" 2>&1)"
exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  pass "SSH with missing host field exits non-zero"
else
  fail "SSH with missing host field exits non-zero" "exited 0"
fi

if echo "$output" | grep -qi "host"; then
  pass "error message mentions missing 'host'"
else
  fail "error message mentions missing 'host'" "output='$output'"
fi
rm -rf "$T5"

# ---------------------------------------------------------------------------
# Test 6: Unknown transport produces a clear error
# ---------------------------------------------------------------------------
echo "Test 6: unknown transport errors"
T6="$(make_project)"
cat > "$T6/.torque-test.json" <<'EOF'
{
  "transport": "ftp",
  "verify_command": "echo nope",
  "timeout_seconds": 30
}
EOF

output="$(run_test "$T6" 2>&1)"
exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  pass "unknown transport exits non-zero"
else
  fail "unknown transport exits non-zero" "exited 0"
fi

if echo "$output" | grep -qi "unknown transport\|unknown\|invalid"; then
  pass "unknown transport error message is descriptive"
else
  fail "unknown transport error message is descriptive" "output='$output'"
fi
rm -rf "$T6"

# ---------------------------------------------------------------------------
# Test 7: Invalid JSON in shared config exits with error
# ---------------------------------------------------------------------------
echo "Test 7: invalid JSON in shared config exits with error"
T7="$(make_project)"
printf '{ "transport": "local", broken json' > "$T7/.torque-test.json"

output="$(run_test "$T7" echo test 2>&1)"
exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  pass "invalid JSON in .torque-test.json exits non-zero"
else
  fail "invalid JSON in .torque-test.json exits non-zero" "exited 0"
fi
rm -rf "$T7"

# ---------------------------------------------------------------------------
# Test 8: Local transport — failing command propagates exit code
# ---------------------------------------------------------------------------
echo "Test 8: local transport propagates non-zero exit code"
T8="$(make_project)"
cat > "$T8/.torque-test.json" <<'EOF'
{
  "transport": "local",
  "verify_command": "exit 42",
  "timeout_seconds": 30
}
EOF

run_test "$T8" 2>/dev/null
exit_code=$?

if [[ $exit_code -eq 42 ]]; then
  pass "local transport propagates exit code 42"
else
  fail "local transport propagates exit code 42" "got exit_code=$exit_code"
fi
rm -rf "$T8"

# ---------------------------------------------------------------------------
# Test 9: No verify_command and no positional args exits with error
# ---------------------------------------------------------------------------
echo "Test 9: no verify_command and no args exits with error"
T9="$(make_project)"
cat > "$T9/.torque-test.json" <<'EOF'
{
  "transport": "local"
}
EOF

output="$(run_test "$T9" 2>&1)"
exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  pass "no verify_command exits non-zero"
else
  fail "no verify_command exits non-zero" "exited 0"
fi

if echo "$output" | grep -qi "verify_command\|no.*command\|command.*specified"; then
  pass "error message mentions verify_command"
else
  fail "error message mentions verify_command" "output='$output'"
fi
rm -rf "$T9"

# --- Guard hook tests ---

GUARD_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/torque-test-guard.sh"

# Helper: run the guard in a temp project directory with the given config and
# JSON payload piped on stdin. Sets GUARD_EXIT and GUARD_OUTPUT.
run_guard() {
  local project="$1"
  local payload="$2"
  GUARD_OUTPUT="$(printf '%s' "$payload" | bash "$project/scripts/torque-test-guard.sh" 2>&1)"
  GUARD_EXIT=$?
}

make_guard_project() {
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/scripts"
  cp "$GUARD_SCRIPT" "$tmp/scripts/torque-test-guard.sh"
  chmod +x "$tmp/scripts/torque-test-guard.sh"
  echo "$tmp"
}

# ---------------------------------------------------------------------------
# Guard Test 1: Direct npx vitest is blocked
# ---------------------------------------------------------------------------
echo "Guard Test 1: direct npx vitest run is blocked"
GT1="$(make_guard_project)"
cat > "$GT1/.torque-test.json" <<'EOF'
{ "transport": "ssh" }
EOF

run_guard "$GT1" '{"tool_input":{"command":"npx vitest run server/tests/foo.test.js"}}'

if [[ $GUARD_EXIT -eq 2 ]]; then
  pass "npx vitest exits 2 (blocked)"
else
  fail "npx vitest exits 2 (blocked)" "got exit=$GUARD_EXIT"
fi

if echo "$GUARD_OUTPUT" | grep -q "BLOCKED"; then
  pass "npx vitest output contains BLOCKED"
else
  fail "npx vitest output contains BLOCKED" "output='$GUARD_OUTPUT'"
fi
rm -rf "$GT1"

# ---------------------------------------------------------------------------
# Guard Test 2: Direct npx jest is blocked
# ---------------------------------------------------------------------------
echo "Guard Test 2: direct npx jest is blocked"
GT2="$(make_guard_project)"
cat > "$GT2/.torque-test.json" <<'EOF'
{ "transport": "ssh" }
EOF

run_guard "$GT2" '{"tool_input":{"command":"npx jest --verbose"}}'

if [[ $GUARD_EXIT -eq 2 ]]; then
  pass "npx jest exits 2 (blocked)"
else
  fail "npx jest exits 2 (blocked)" "got exit=$GUARD_EXIT"
fi
rm -rf "$GT2"

# ---------------------------------------------------------------------------
# Guard Test 3: npm test is blocked
# ---------------------------------------------------------------------------
echo "Guard Test 3: npm test is blocked"
GT3="$(make_guard_project)"
cat > "$GT3/.torque-test.json" <<'EOF'
{ "transport": "ssh" }
EOF

run_guard "$GT3" '{"tool_input":{"command":"npm test"}}'

if [[ $GUARD_EXIT -eq 2 ]]; then
  pass "npm test exits 2 (blocked)"
else
  fail "npm test exits 2 (blocked)" "got exit=$GUARD_EXIT"
fi
rm -rf "$GT3"

# ---------------------------------------------------------------------------
# Guard Test 4: Command routed through torque-test.sh is allowed
# ---------------------------------------------------------------------------
echo "Guard Test 4: ./scripts/torque-test.sh npx vitest run is allowed"
GT4="$(make_guard_project)"
cat > "$GT4/.torque-test.json" <<'EOF'
{ "transport": "ssh" }
EOF

run_guard "$GT4" '{"tool_input":{"command":"./scripts/torque-test.sh npx vitest run"}}'

if [[ $GUARD_EXIT -eq 0 ]]; then
  pass "torque-test.sh-prefixed command exits 0 (allowed)"
else
  fail "torque-test.sh-prefixed command exits 0 (allowed)" "got exit=$GUARD_EXIT output='$GUARD_OUTPUT'"
fi
rm -rf "$GT4"

# ---------------------------------------------------------------------------
# Guard Test 5: Non-test commands are allowed
# ---------------------------------------------------------------------------
echo "Guard Test 5: non-test commands are allowed"
GT5="$(make_guard_project)"
cat > "$GT5/.torque-test.json" <<'EOF'
{ "transport": "ssh" }
EOF

run_guard "$GT5" '{"tool_input":{"command":"git status"}}'
if [[ $GUARD_EXIT -eq 0 ]]; then
  pass "git status exits 0 (allowed)"
else
  fail "git status exits 0 (allowed)" "got exit=$GUARD_EXIT"
fi

run_guard "$GT5" '{"tool_input":{"command":"node --version"}}'
if [[ $GUARD_EXIT -eq 0 ]]; then
  pass "node --version exits 0 (allowed)"
else
  fail "node --version exits 0 (allowed)" "got exit=$GUARD_EXIT"
fi
rm -rf "$GT5"

# ---------------------------------------------------------------------------
# Guard Test 6: Local transport allows direct test commands
# ---------------------------------------------------------------------------
echo "Guard Test 6: local transport allows direct test commands"
GT6="$(make_guard_project)"
cat > "$GT6/.torque-test.json" <<'EOF'
{ "transport": "local" }
EOF

run_guard "$GT6" '{"tool_input":{"command":"npx vitest run"}}'

if [[ $GUARD_EXIT -eq 0 ]]; then
  pass "local transport allows npx vitest (exits 0)"
else
  fail "local transport allows npx vitest (exits 0)" "got exit=$GUARD_EXIT output='$GUARD_OUTPUT'"
fi
rm -rf "$GT6"

# ---------------------------------------------------------------------------
# Guard Test 7: No config file allows everything
# ---------------------------------------------------------------------------
echo "Guard Test 7: no config file allows everything"
GT7="$(make_guard_project)"
# No .torque-test.json

run_guard "$GT7" '{"tool_input":{"command":"npx vitest run"}}'

if [[ $GUARD_EXIT -eq 0 ]]; then
  pass "no config allows npx vitest (exits 0)"
else
  fail "no config allows npx vitest (exits 0)" "got exit=$GUARD_EXIT output='$GUARD_OUTPUT'"
fi
rm -rf "$GT7"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  echo "=============================="
  exit 1
fi
echo "=============================="
exit 0
