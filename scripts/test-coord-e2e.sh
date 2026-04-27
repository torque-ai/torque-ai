#!/usr/bin/env bash
# torque-coord end-to-end smoke test.
#
# Scenario A (Phase 1 — serialization):
#   Two `torque-remote --suite gate` invocations in parallel. The second
#   observes the first as the holder, waits, and re-acquires after.
#   Total wallclock should be ~2x single-session.
#
# Scenario B (Phase 2 — warm-hit replay):
#   Run one session to populate the result store, then a second session
#   with the same --branch. The second should consume the cached result
#   without invoking the inner command.

set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-HEAD}"
echo "[e2e] Target ref: $REF"

# ─── Scenario A: serialization ────────────────────────────────────────────
echo
echo "── Scenario A: two parallel sessions serialize ───────────────"
OUT1=$(mktemp)
OUT2=$(mktemp)
start=$(date +%s)
(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session A' && sleep 30") > "$OUT1" 2>&1 &
PID1=$!
sleep 2
(time torque-remote --suite gate --branch "$REF" bash -c "echo 'session B' && sleep 30") > "$OUT2" 2>&1 &
PID2=$!
wait $PID1
wait $PID2
end=$(date +%s)
duration=$((end - start))
echo "[e2e] Scenario A wallclock: ${duration}s (expected ~60s if serialized, ~30s if parallel)"
if [[ $duration -lt 50 ]]; then
  echo "[e2e] Scenario A FAIL: sessions appear to have run in parallel"
  rm -f "$OUT1" "$OUT2"
  exit 1
fi
echo "[e2e] Scenario A PASS: serialization observed."
rm -f "$OUT1" "$OUT2"

# ─── Scenario B: warm-hit replay ──────────────────────────────────────────
echo
echo "── Scenario B: warm-hit replay ──────────────────────────────"
OUT3=$(mktemp)
OUT4=$(mktemp)
torque-remote --suite gate --branch "$REF" bash -c "echo 'POPULATING' && sleep 5" > "$OUT3" 2>&1
start=$(date +%s)
torque-remote --suite gate --branch "$REF" bash -c "echo 'SHOULD-NOT-PRINT'" > "$OUT4" 2>&1
end=$(date +%s)
hit_duration=$((end - start))
echo "[e2e] Scenario B replay wallclock: ${hit_duration}s (expected <5s for replay; sync skipped)"
echo
echo "── Replay output ────────────────────────────────────────────"
cat "$OUT4"

if grep -q 'SHOULD-NOT-PRINT' "$OUT4"; then
  echo "[e2e] Scenario B FAIL: inner command ran instead of replay"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi
if ! grep -q 'POPULATING' "$OUT4"; then
  echo "[e2e] Scenario B FAIL: cached output not replayed"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi
if ! grep -q '\[torque-coord\] cache hit' "$OUT4"; then
  echo "[e2e] Scenario B FAIL: no cache-hit log line"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi
if [[ $hit_duration -gt 10 ]]; then
  echo "[e2e] Scenario B FAIL: replay took ${hit_duration}s (>10s suggests sync still ran)"
  rm -f "$OUT3" "$OUT4"
  exit 1
fi

echo "[e2e] Scenario B PASS: warm-hit replay observed."
rm -f "$OUT3" "$OUT4"

echo
echo "[e2e] All scenarios PASS."
