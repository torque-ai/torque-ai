#!/usr/bin/env bash
# Manual integration smoke test for the Linux-remote pipeline.
# Run after setting up a fresh Linux remote in the operator's local config.
# This script does NOT run in CI — it requires a live remote.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Step 1: Confirm Linux remote configured ==="
remote_os=$(bin/torque-remote --print-remote-os 2>/dev/null)
if [[ "$remote_os" != "linux" ]]; then
  echo "FAIL: expected REMOTE_OS=linux but got '$remote_os'"
  echo "Hint: check ~/.torque-remote.local.json points at a Linux host, and pubkey auth works."
  exit 1
fi
echo "OK: REMOTE_OS=linux"

echo ""
echo "=== Step 2: torque-remote --status ==="
# Capture torque-remote's real exit code. Piping straight into `head` would
# (a) report head's exit, not torque-remote's, and (b) SIGPIPE-kill
# torque-remote early when --status prints more than 10 lines.
status_rc=0
status_out="$(bin/torque-remote --status 2>&1)" || status_rc=$?
printf '%s\n' "$status_out" | head -10
if [[ "$status_rc" -ne 0 ]]; then
  echo "FAIL: --status exited non-zero (exit $status_rc)"
  exit 1
fi
echo "OK: --status returned lane state"

echo ""
echo "=== Step 3: Round-trip a simple intercepted command ==="
# Capture torque-remote's real exit code before piping to tail. `cmd | tail`
# reports tail's exit (0), not torque-remote's — so a failed remote run would
# otherwise be reported as OK.
probe_rc=0
probe_out="$(bin/torque-remote npx vitest run server/tests/torque-remote-probe.test.js --reporter=default 2>&1)" || probe_rc=$?
printf '%s\n' "$probe_out" | tail -10
if [[ "$probe_rc" -eq 0 ]]; then
  echo "OK: vitest round-tripped through the pipeline"
else
  echo "FAIL: vitest invocation failed (exit $probe_rc) — remote unreachable or torque-remote bug"
  exit 1
fi

echo ""
echo "=== Step 4: Verify decision log entry ==="
decision_log="$HOME/.torque/torque-remote-decisions.jsonl"
if [[ ! -f "$decision_log" ]]; then
  echo "FAIL: decision log file does not exist at $decision_log"
  exit 1
fi
if tail -5 "$decision_log" | grep -q '"event":"remote_os_probe"'; then
  echo "OK: decision log entry present"
else
  echo "FAIL: no remote_os_probe entry in last 5 decision-log lines"
  echo "Last 5 lines of $decision_log:"
  tail -5 "$decision_log"
  exit 1
fi

echo ""
echo "=== Step 5: msbuild rejection ==="
# msbuild rejection fires from bin/torque-remote-guard. We invoke via direct
# bash to ensure the guard hook fires (rather than calling bin/torque-remote
# directly, which would bypass the guard).
if torque-remote msbuild fake.sln 2>&1 | grep -qi "msbuild is Windows-only"; then
  echo "OK: msbuild rejection fires"
else
  echo "FAIL: msbuild rejection did not fire"
  echo "Run torque-remote msbuild fake.sln to see actual output."
  exit 1
fi

echo ""
echo "=== Smoke test PASSED ==="
echo "All 5 checks succeeded. Linux remote integration is healthy."
