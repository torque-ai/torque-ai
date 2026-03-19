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
