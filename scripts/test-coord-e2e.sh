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
# Use a unique per-run SUITE label so Phase 2 warm-hit can't replay a
# previous scenario's cached result. The serialization observation
# requires both sessions to actually run their inner command; warm-hit
# replay would short-circuit them in <5s and defeat the test. We can't
# vary --branch easily because torque-remote validates that the ref
# exists on origin; suite is part of the cache key + lock identity, so
# a unique label gives us a fresh slot per run with no origin push.
SERIALIZE_SUITE="gate-serialize-$(date +%s)"
echo
echo "── Scenario A: two parallel sessions serialize ───────────────"
echo "[e2e] Scenario A using unique suite: $SERIALIZE_SUITE"
OUT1=$(mktemp)
OUT2=$(mktemp)
start=$(date +%s)
(time torque-remote --suite "$SERIALIZE_SUITE" --branch "$REF" bash -c "echo 'session A' && sleep 30") > "$OUT1" 2>&1 &
PID1=$!
sleep 2
(time torque-remote --suite "$SERIALIZE_SUITE" --branch "$REF" bash -c "echo 'session B' && sleep 30") > "$OUT2" 2>&1 &
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
# Unique per-run SUITE so the first invocation reliably populates a fresh
# result instead of (possibly) warm-hitting a stale prior run, and the
# second invocation reliably hits THAT result rather than any other.
# (Same rationale as Scenario A: --branch validation makes per-run refs
# awkward, so we vary suite instead.)
WARMHIT_SUITE="gate-warmhit-$(date +%s)"
echo
echo "── Scenario B: warm-hit replay ──────────────────────────────"
echo "[e2e] Scenario B using unique suite: $WARMHIT_SUITE"
OUT3=$(mktemp)
OUT4=$(mktemp)
torque-remote --suite "$WARMHIT_SUITE" --branch "$REF" bash -c "echo 'POPULATING' && sleep 5" > "$OUT3" 2>&1
start=$(date +%s)
torque-remote --suite "$WARMHIT_SUITE" --branch "$REF" bash -c "echo 'SHOULD-NOT-PRINT'" > "$OUT4" 2>&1
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

# ─── Scenario C: cross-machine serialization ──────────────────────────────
# Simulates two dev-box sessions both pointed at the workstation daemon via
# ssh. The first acquire wins; the second waits and acquires after the first
# releases. Skipped when no remote config is present (CI / dev-box without
# workstation access).
echo
echo "── Scenario C: cross-machine acquire/release via ssh ────────"
if [ ! -f "$HOME/.torque-remote.local.json" ]; then
  echo "[e2e] Scenario C SKIPPED: no ~/.torque-remote.local.json present"
else
  # Force ssh-mode for the client by pre-exporting the env vars from the
  # config file — same logic the wrapper uses, just inline so the test is
  # self-contained.
  export TORQUE_COORD_REMOTE_HOST=$(node -e 'process.stdout.write(require(process.env.HOME + "/.torque-remote.local.json").host)')
  export TORQUE_COORD_REMOTE_USER=$(node -e 'process.stdout.write(require(process.env.HOME + "/.torque-remote.local.json").user)')
  CROSSMACHINE_SUITE="gate-crossmachine-$(date +%s)"
  echo "[e2e] Scenario C using suite: $CROSSMACHINE_SUITE"
  ACQ_OUT_A=$(mktemp)
  ACQ_OUT_B=$(mktemp)
  # First acquire — should succeed immediately.
  # Use "cmd && ok=0 || ok=$?" pattern so set -euo pipefail does not fire
  # on the non-zero exit codes we intentionally check (e.g. 3 = 202 wait).
  bin/torque-coord-client acquire \
    --project torque-public --sha "$(git rev-parse HEAD)" --suite "$CROSSMACHINE_SUITE" \
    --host "devbox-a" --pid 11111 --user tester > "$ACQ_OUT_A" 2>&1 && status_a=0 || status_a=$?
  if [ "$status_a" -ne 0 ]; then
    echo "[e2e] Scenario C FAIL: first ssh acquire returned $status_a"
    cat "$ACQ_OUT_A"
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  lock_id_a=$(node -e 'try { process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).lock_id) || ""); } catch(_) {}' "$ACQ_OUT_A")
  if [ -z "$lock_id_a" ]; then
    echo "[e2e] Scenario C FAIL: first acquire returned no lock_id"
    cat "$ACQ_OUT_A"
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  # Second acquire — same project/sha/suite, should return 202 wait (exit 3).
  bin/torque-coord-client acquire \
    --project torque-public --sha "$(git rev-parse HEAD)" --suite "$CROSSMACHINE_SUITE" \
    --host "devbox-b" --pid 22222 --user tester > "$ACQ_OUT_B" 2>&1 && status_b=0 || status_b=$?
  if [ "$status_b" -ne 3 ]; then
    echo "[e2e] Scenario C FAIL: second ssh acquire expected exit 3 (wait), got $status_b"
    cat "$ACQ_OUT_B"
    bin/torque-coord-client release --lock-id "$lock_id_a" --exit 0 --status passed >/dev/null 2>&1 || true
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  # Release first; second can now acquire.
  bin/torque-coord-client release --lock-id "$lock_id_a" --exit 0 --status passed >/dev/null 2>&1 || true
  bin/torque-coord-client acquire \
    --project torque-public --sha "$(git rev-parse HEAD)" --suite "$CROSSMACHINE_SUITE" \
    --host "devbox-b" --pid 22222 --user tester > "$ACQ_OUT_B" 2>&1 && status_b2=0 || status_b2=$?
  lock_id_b=$(node -e 'try { process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).lock_id) || ""); } catch(_) {}' "$ACQ_OUT_B")
  if [ "$status_b2" -ne 0 ] || [ -z "$lock_id_b" ]; then
    echo "[e2e] Scenario C FAIL: second acquire after release returned $status_b2 (no lock_id)"
    cat "$ACQ_OUT_B"
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  bin/torque-coord-client release --lock-id "$lock_id_b" --exit 0 --status passed >/dev/null 2>&1 || true
  echo "[e2e] Scenario C PASS: cross-machine serialization observed via ssh-mode."
  rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
fi

echo
echo "[e2e] All scenarios PASS."
