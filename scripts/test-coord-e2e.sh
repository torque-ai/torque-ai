#!/usr/bin/env bash
# torque-coord end-to-end smoke test.
#
# Runs two `torque-remote --suite gate` invocations in parallel. The second
# one should observe the first as the holder, wait, and re-acquire after
# it finishes. Total wallclock should be roughly 2x the first run's
# duration (Phase 1 — no result sharing yet).

set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-HEAD}"
echo "[e2e] Target ref: $REF"

OUT1=$(mktemp)
OUT2=$(mktemp)

start=$(date +%s)

(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session A' && sleep 30") \
  > "$OUT1" 2>&1 &
PID1=$!

sleep 2

(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session B' && sleep 30") \
  > "$OUT2" 2>&1 &
PID2=$!

wait $PID1
wait $PID2

end=$(date +%s)
duration=$((end - start))

echo "[e2e] Total wallclock: ${duration}s (expected ~60s if serialized, ~30s if parallel)"
echo
echo "── Session A ────────────────────────────────────────────"
cat "$OUT1"
echo
echo "── Session B ────────────────────────────────────────────"
cat "$OUT2"

rm -f "$OUT1" "$OUT2"

if [[ $duration -lt 50 ]]; then
  echo "[e2e] FAIL: sessions appear to have run in parallel (no serialization)"
  exit 1
fi

echo "[e2e] PASS: serialization observed."
