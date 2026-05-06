#!/usr/bin/env bash
# test-torque-watchdog.sh — smoke test for torque-watchdog.sh
#
# Exercises decision logic via --dry-run with synthetic PID files in a
# scratch tmpdir. Does not spawn TORQUE, does not touch ~/.torque/.
#
# Exit code: 0 on all-pass, 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG="${SCRIPT_DIR}/torque-watchdog.sh"

if [[ ! -x "$WATCHDOG" ]]; then
  chmod +x "$WATCHDOG" 2>/dev/null || true
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [[ -n "${ALIVE_PID:-}" ]] && kill "$ALIVE_PID" 2>/dev/null || true' EXIT

PID_FILE="$TMP/torque.pid"
LOCK_FILE="$TMP/torque.lock"
LOG_FILE="$TMP/watchdog.log"

export TORQUE_PID_FILE="$PID_FILE"
export TORQUE_LOCK_FILE="$LOCK_FILE"
export TORQUE_WATCHDOG_LOG="$LOG_FILE"
export TORQUE_WATCHDOG_STALE_S=60

PASS=0
FAIL=0

run_case() {
  local desc="$1" expected_exit="$2"; shift 2
  local actual_exit=0
  set +e
  bash "$WATCHDOG" "$@" --dry-run
  actual_exit=$?
  set -e
  if [[ "$actual_exit" == "$expected_exit" ]]; then
    printf '  PASS  %s (exit=%s)\n' "$desc" "$actual_exit"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s — expected exit=%s, got=%s\n' "$desc" "$expected_exit" "$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

assert_log_contains() {
  local desc="$1" needle="$2"
  if grep -qF "$needle" "$LOG_FILE" 2>/dev/null; then
    printf '  PASS  %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s — log missing %q\n' "$desc" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

write_pid_record() {
  local pid="$1" hb="$2"
  printf '{"pid":%s,"startedAt":"2026-05-06T00:00:00Z","heartbeatAt":"%s"}\n' "$pid" "$hb" > "$PID_FILE"
}

# Spawn a long-lived benign process for "PID alive" cases
sleep 600 &
ALIVE_PID=$!
disown "$ALIVE_PID" 2>/dev/null || true

# A PID very unlikely to be in use — picked from above the OS dynamic range
# but not so high it overflows. Worst case we hit a real process; the test
# will misbehave but won't damage anything.
DEAD_PID=2147480000

echo "Case 1: no PID file → exit 0 (no TORQUE expected)"
rm -f "$PID_FILE"
run_case "no-pid-file" 0

echo "Case 2: PID file with empty content → exit 0 (skip)"
: > "$PID_FILE"
run_case "empty-pid-file" 0

echo "Case 3: dead PID + stale heartbeat → silent death (exit 10)"
write_pid_record "$DEAD_PID" "2026-05-06T00:00:00.000Z"
: > "$LOG_FILE"
run_case "silent-death" 10
assert_log_contains "silent-death log line written" "ALERT: pid=$DEAD_PID dead"

echo "Case 4: dead PID + recent heartbeat → still silent death (PID liveness wins)"
NOW_HB=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
write_pid_record "$DEAD_PID" "$NOW_HB"
: > "$LOG_FILE"
run_case "dead-with-fresh-hb" 10

echo "Case 5: alive PID + fresh heartbeat → healthy (exit 0)"
NOW_HB=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
write_pid_record "$ALIVE_PID" "$NOW_HB"
: > "$LOG_FILE"
run_case "healthy" 0
if [[ -s "$LOG_FILE" ]]; then
  printf '  FAIL  healthy case wrote to log unexpectedly:\n'
  sed 's/^/        /' "$LOG_FILE"
  FAIL=$((FAIL + 1))
else
  printf '  PASS  healthy case wrote no log lines\n'
  PASS=$((PASS + 1))
fi

echo "Case 6: alive PID + stale heartbeat → alive-stale warn (exit 20)"
write_pid_record "$ALIVE_PID" "2026-05-06T00:00:00.000Z"
: > "$LOG_FILE"
run_case "alive-stale" 20
assert_log_contains "alive-stale WARN line written" "WARN: pid=$ALIVE_PID alive but heartbeat stale"

echo "Case 7: malformed JSON → exit 0 (skip + log)"
printf 'not json' > "$PID_FILE"
: > "$LOG_FILE"
run_case "malformed-no-pid" 0
assert_log_contains "malformed-pid skip logged" "no pid field and no lock fallback"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]]
