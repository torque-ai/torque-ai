#!/usr/bin/env bash
# torque-watchdog.sh — detect and recover from silent TORQUE death.
#
# The crash auto-restart fix (b0ea85ab) handles uncaughtException — the
# process can self-revive when its own handlers fire. But a silent death
# (OS kill, OOM, segfault, external SIGKILL, Windows process termination)
# bypasses the in-process handler entirely. TORQUE dies and stays dead.
#
# Detection signal: TORQUE writes ~/.torque/torque.pid every 10s with a
# heartbeatAt timestamp. If pid is dead AND no clean shutdown happened,
# we have a silent death.
#
# Recovery: relaunch via the documented nohup command from CLAUDE.md.
# All actions log to ~/.torque/watchdog.log so operators can review.
#
# Triggered by an external scheduler (Windows Scheduled Task on this
# machine; cron / systemd timer elsewhere). One-shot per invocation —
# the scheduler owns cadence, not this script.
#
# Flags:
#   --dry-run  Detect but do not relaunch. Exit codes encode the verdict:
#              0=healthy/no-action, 10=silent-death-detected, 20=alive-stale
#              Used by the smoke test to verify decision logic without
#              spawning a real TORQUE process.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) printf 'Unknown flag: %s\n' "$arg" >&2; exit 64 ;;
  esac
done

PID_FILE="${TORQUE_PID_FILE:-${HOME}/.torque/torque.pid}"
LOCK_FILE="${TORQUE_LOCK_FILE:-${HOME}/.torque/torque.lock}"
LOG_FILE="${TORQUE_WATCHDOG_LOG:-${HOME}/.torque/watchdog.log}"
TORQUE_DIR="${TORQUE_DIR:-${HOME}/Projects/torque-public}"
SERVER="${TORQUE_SERVER_ENTRY:-${TORQUE_DIR}/server/index.js}"
TORQUE_LOG="${TORQUE_LOG_FILE:-${HOME}/.torque/torque.log}"
SSE_URL="${TORQUE_SSE_URL:-http://127.0.0.1:3458/sse}"
HEARTBEAT_STALE_SECONDS="${TORQUE_WATCHDOG_STALE_S:-90}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"
}

if [[ ! -f "$PID_FILE" ]]; then
  exit 0
fi

RECORD=$(cat "$PID_FILE" 2>/dev/null || true)
if [[ -z "$RECORD" ]]; then
  log "PID file empty/unreadable; skipping"
  exit 0
fi

PID=$(printf '%s' "$RECORD" | grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1 || true)
HB=$(printf '%s' "$RECORD" | sed -nE 's/.*"heartbeatAt"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' || true)

if [[ -z "${PID:-}" ]]; then
  if [[ -f "$LOCK_FILE" ]]; then
    PID=$(cat "$LOCK_FILE" 2>/dev/null | tr -d '[:space:]' || true)
  fi
fi

if [[ -z "${PID:-}" ]]; then
  log "PID file has no pid field and no lock fallback; skipping"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  if [[ -n "${HB:-}" ]]; then
    HB_EPOCH=$(date -u -d "$HB" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date -u +%s)
    AGE=$((NOW_EPOCH - HB_EPOCH))
    if (( AGE > HEARTBEAT_STALE_SECONDS )); then
      log "WARN: pid=$PID alive but heartbeat stale age=${AGE}s threshold=${HEARTBEAT_STALE_SECONDS}s; not restarting (process alive — operator decides)"
      [[ "$DRY_RUN" == "1" ]] && exit 20
    fi
  fi
  exit 0
fi

log "ALERT: pid=$PID dead, last heartbeat=${HB:-unknown}; silent-death detected, restarting"

if [[ "$DRY_RUN" == "1" ]]; then
  exit 10
fi

rm -f "$PID_FILE" "$LOCK_FILE" || true

if [[ ! -f "$SERVER" ]]; then
  log "ERROR: server entry not found at $SERVER; cannot restart"
  exit 1
fi

nohup node "$SERVER" >> "$TORQUE_LOG" 2>&1 &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true
log "spawned new TORQUE pid=$NEW_PID; probing SSE in 5s"

sleep 5
if command -v curl >/dev/null 2>&1 && curl -s --max-time 3 "$SSE_URL" >/dev/null 2>&1; then
  log "OK: TORQUE pid=$NEW_PID responding on $SSE_URL"
else
  log "WARN: TORQUE pid=$NEW_PID spawned but $SSE_URL probe failed; check $TORQUE_LOG"
fi
