#!/usr/bin/env bash
# stop-torque.sh — Reliably stop all TORQUE server processes on Windows (Git Bash)
#
# Strategy (in order):
#   1. HTTP graceful shutdown via /api/shutdown (cleanest)
#   2. PID file kill (if HTTP fails)
#   3. wmic process scan (nuclear fallback)
#   4. Orphan cleanup — kill stale bash/tail/node from previous starts
#
# The start command `nohup bash -c 'tail -f /dev/null | node .../index.js'`
# creates 3 processes: bash (wrapper), tail (stdin feeder), node (server).
# Killing only node leaves bash+tail orphaned because tail never gets SIGPIPE
# (it never writes). Step 4 cleans these up.
#
# Usage: bash stop-torque.sh [--force]

# Best-effort script — don't abort on errors. Process cleanup commands
# routinely return non-zero (process already exited, no matches, etc).
set +e

API_PORT="${TORQUE_API_PORT:-3457}"
PID_FILE="${TORQUE_PID_FILE:-${TORQUE_DATA_DIR:-$HOME/.local/share/torque}/torque.pid}"
FORCE="${1:-}"

log() { echo "[stop-torque] $*"; }

# ── Step 1: Graceful HTTP shutdown ──
try_http_shutdown() {
  log "Attempting graceful shutdown via http://127.0.0.1:${API_PORT}/api/shutdown ..."
  if response=$(curl -s --max-time 5 -X POST \
    -H "Content-Type: application/json" \
    -d '{"reason":"stop-torque.sh"}' \
    "http://127.0.0.1:${API_PORT}/api/shutdown" 2>/dev/null); then
    if echo "$response" | grep -q "shutting_down"; then
      log "Graceful shutdown accepted. Waiting for process to exit..."
      # Wait up to 10 seconds for process to exit
      for i in $(seq 1 20); do
        if ! curl -s --max-time 1 "http://127.0.0.1:${API_PORT}/livez" >/dev/null 2>&1; then
          log "Server stopped successfully."
          # Clean up stale PID file if it wasn't removed
          rm -f "$PID_FILE" 2>/dev/null || true
          return 0
        fi
        sleep 0.5
      done
      log "Server still responding after 10s — falling through to PID kill."
      return 1
    fi
  fi
  log "HTTP shutdown failed (server may not be running)."
  return 1
}

read_pid_from_file() {
  # Supports both legacy raw PID and current JSON record format:
  # {"pid":123,...}
  local raw
  local compact
  local pid

  if ! raw="$(cat "$PID_FILE" 2>/dev/null)"; then
    return 1
  fi

  compact="$(printf '%s' "$raw" | tr -d '\r\n' | tr -d '[:space:]')"

  # Legacy: file contains only PID number
  if [[ "$compact" =~ ^[0-9]+$ ]]; then
    echo "$compact"
    return 0
  fi

  # New format: JSON object with pid field
  pid="$(printf '%s' "$compact" | sed -n 's/.*"pid":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')"
  if [[ -n "$pid" ]]; then
    echo "$pid"
    return 0
  fi

  return 1
}

# ── Step 2: Kill via PID file ──
try_pid_kill() {
  if [ ! -f "$PID_FILE" ]; then
    log "No PID file at $PID_FILE"
    return 1
  fi

  local pid
  pid="$(read_pid_from_file || true)"
  if [ -z "$pid" ]; then
    log "PID file is empty or in unknown format."
    rm -f "$PID_FILE" 2>/dev/null || true
    return 1
  fi

  log "Found PID $pid in $PID_FILE"

  # Check if process is actually running (Windows-compatible)
  if ! tasklist.exe //FI "PID eq $pid" //NH 2>/dev/null | grep -q "$pid"; then
    log "PID $pid is not running (stale PID file)."
    rm -f "$PID_FILE" 2>/dev/null || true
    return 1
  fi

  # Use taskkill /T for tree kill — kills bash wrapper + tail + node together
  log "Killing process tree rooted at PID $pid ..."
  taskkill.exe //F //T //PID "$pid" 2>/dev/null || true
  sleep 1

  # Verify it's gone
  if ! tasklist.exe //FI "PID eq $pid" //NH 2>/dev/null | grep -q "$pid"; then
    log "Process $pid terminated."
    rm -f "$PID_FILE" 2>/dev/null || true
    return 0
  fi

  log "PID $pid still alive after taskkill."
  return 1
}

# ── Step 3: Nuclear fallback — find and kill all TORQUE node.exe processes ──
try_ps_kill() {
  log "Scanning for TORQUE node.exe processes ..."

  local killed=0
  # Use wmic to find node.exe processes with torque/server/index.js in command line
  while IFS= read -r line; do
    # Match lines containing our server path (case-insensitive)
    if ! echo "$line" | grep -qi "torque[/\\\\]server[/\\\\]index\.js"; then
      continue
    fi

    # Extract PID from wmic CSV: ...,ParentProcessId,ProcessId
    local pid
    pid=$(echo "$line" | sed 's/.*,//' | tr -d '[:space:]')
    if [ -z "$pid" ] || ! echo "$pid" | grep -Eq '^[0-9]+$'; then
      continue
    fi

    log "Found TORQUE process: PID $pid — killing tree ..."
    taskkill.exe //F //T //PID "$pid" 2>/dev/null || true
    killed=$((killed + 1))
  done < <(wmic process where "name='node.exe'" get processid,commandline /format:csv 2>/dev/null || true)

  if [ "$killed" -gt 0 ]; then
    log "Terminated $killed TORQUE node process(es) and their trees."
    rm -f "$PID_FILE" 2>/dev/null || true
    return 0
  fi

  log "No TORQUE node processes found."
  return 1
}

# ── Step 4: Clean up orphaned bash/tail from previous TORQUE starts ──
# The start command `bash -c 'tail -f /dev/null | node ...'` creates
# bash + tail processes. When node exits, tail never gets SIGPIPE (it
# never writes), so both survive as orphans.
cleanup_orphaned_wrappers() {
  local killed=0

  # Kill orphaned "tail -f /dev/null" processes (only TORQUE uses this pattern)
  wmic process where "name='tail.exe'" get processid,commandline /format:csv 2>/dev/null | while IFS= read -r line; do
    echo "$line" | grep -q "tail.*-f.*/dev/null" || continue
    local pid
    pid=$(echo "$line" | sed 's/.*,//' | tr -d '[:space:]')
    if [ -n "$pid" ] && echo "$pid" | grep -Eq '^[0-9]+$'; then
      taskkill.exe //F //PID "$pid" 2>/dev/null
      killed=$((killed + 1))
    fi
  done

  # Kill orphaned bash wrappers running "tail -f /dev/null | node"
  wmic process where "name='bash.exe'" get processid,commandline /format:csv 2>/dev/null | while IFS= read -r line; do
    echo "$line" | grep -q "tail -f /dev/null.*node" || continue
    local pid
    pid=$(echo "$line" | sed 's/.*,//' | tr -d '[:space:]')
    if [ -n "$pid" ] && echo "$pid" | grep -Eq '^[0-9]+$'; then
      taskkill.exe //F //PID "$pid" 2>/dev/null
      killed=$((killed + 1))
    fi
  done

  # NOTE: Do NOT clean up "stop-torque" bash processes here.
  # The grep matches the calling shell (e.g. Claude Code's bash),
  # which kills the parent and aborts the script mid-execution.

  if [ "$killed" -gt 0 ]; then
    log "Cleaned up $killed orphaned wrapper process(es)."
  fi
  return 0
}

# ── Main ──

if [ "$FORCE" = "--force" ]; then
  log "Force mode: skipping graceful shutdown."
  try_pid_kill || try_ps_kill || log "No TORQUE processes to kill."
  cleanup_orphaned_wrappers || true
  exit 0
fi

try_http_shutdown || try_pid_kill || try_ps_kill || log "TORQUE does not appear to be running."
cleanup_orphaned_wrappers || true
exit 0
