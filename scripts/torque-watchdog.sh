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

# Windows-aware PID-alive check. `kill -0 <pid>` from MSYS bash returns
# non-zero for live Windows processes that weren't spawned by this bash
# session (the POSIX-emulation kill cannot probe foreign PIDs reliably).
# Without the fallback, the watchdog false-alarms every tick on Windows
# and respawns into EADDRINUSE storms — observed live 2026-05-14 with
# pid=28956 alive but watchdog spawning a new node every minute.
# Mirrors repo_coord_lock_pid_alive in scripts/repo-coordination-lock.sh.
pid_is_alive() {
  local probe_pid="$1"
  case "$probe_pid" in
    ''|*[!0-9]*|0) return 1 ;;
  esac
  if kill -0 "$probe_pid" 2>/dev/null; then
    return 0
  fi
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
      if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "if (Get-Process -Id $probe_pid -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >/dev/null 2>&1
        return $?
      fi
      if command -v tasklist.exe >/dev/null 2>&1; then
        tasklist.exe /FI "PID eq $probe_pid" /NH 2>/dev/null | grep -qE "[[:space:]]$probe_pid[[:space:]]"
        return $?
      fi
      ;;
  esac
  if command -v ps >/dev/null 2>&1; then
    ps -p "$probe_pid" >/dev/null 2>&1 && return 0
  fi
  return 1
}

if pid_is_alive "$PID"; then
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
