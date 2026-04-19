#!/usr/bin/env bash
# stop-torque.sh — Reliably stop all TORQUE server processes on Windows (Git Bash)
#
# Strategy (in order):
#   1. HTTP graceful shutdown via /api/shutdown (cleanest)
#   2. Verify lingering TORQUE node processes by command line
#   3. PID file kill (if graceful shutdown leaves anything behind)
#   4. wmic process scan (nuclear fallback)
#   5. Orphan cleanup — kill stale bash/tail/node from previous starts
#
# The start command `nohup bash -c 'tail -f /dev/null | node .../index.js'`
# creates 3 processes: bash (wrapper), tail (stdin feeder), node (server).
# Killing only node leaves bash+tail orphaned because tail never gets SIGPIPE
# (it never writes). Step 5 cleans these up.
#
# Usage: bash stop-torque.sh [--force] [--verify]

# Best-effort script — don't abort on errors. Process cleanup commands
# routinely return non-zero (process already exited, no matches, etc).
set +e

API_PORT="${TORQUE_API_PORT:-3457}"
PID_FILE="${TORQUE_PID_FILE:-${TORQUE_DATA_DIR:-$HOME/.torque}/torque.pid}"
FORCE=0
VERIFY_ONLY=0
TORQUE_NODE_PIDS=()

log() { echo "[stop-torque] $*"; }

is_windows() {
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*) return 0 ;;
  esac

  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
  esac

  return 1
}

resolve_command() {
  local candidate
  for candidate in "$@"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

WMIC_BIN="$(resolve_command wmic.exe wmic || true)"
TASKKILL_BIN="$(resolve_command taskkill.exe taskkill || true)"
TASKLIST_BIN="$(resolve_command tasklist.exe tasklist || true)"
POWERSHELL_BIN="$(resolve_command powershell.exe powershell pwsh.exe pwsh || true)"

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --force)
        FORCE=1
        ;;
      --verify)
        VERIFY_ONLY=1
        ;;
      *)
        log "Unknown flag: $arg"
        log "Usage: bash stop-torque.sh [--force] [--verify]"
        exit 1
        ;;
    esac
  done

  if [ "$FORCE" -eq 1 ] && [ "$VERIFY_ONLY" -eq 1 ]; then
    log "--force and --verify cannot be used together."
    exit 1
  fi
}

is_pid_running() {
  local pid="$1"

  if [ -z "$pid" ]; then
    return 1
  fi

  if is_windows; then
    if [ -z "$TASKLIST_BIN" ]; then
      return 1
    fi
    "$TASKLIST_BIN" //FI "PID eq $pid" //NH 2>/dev/null | grep -Eq "[[:space:]]$pid([[:space:]]|$)"
    return $?
  fi

  kill -0 "$pid" 2>/dev/null
}

is_node_pid() {
  local pid="$1"

  if [ -z "$pid" ]; then
    return 1
  fi

  if is_windows; then
    if [ -z "$TASKLIST_BIN" ]; then
      return 1
    fi
    "$TASKLIST_BIN" //FI "PID eq $pid" //FI "IMAGENAME eq node.exe" //NH 2>/dev/null | grep -qi "^node\.exe"
    return $?
  fi

  ps -p "$pid" -o comm= 2>/dev/null | grep -qi '^node$'
}

append_unique_pid() {
  local pid="$1"
  local existing

  if [ -z "$pid" ]; then
    return 0
  fi

  for existing in "${TORQUE_NODE_PIDS[@]}"; do
    if [ "$existing" = "$pid" ]; then
      return 0
    fi
  done

  TORQUE_NODE_PIDS+=("$pid")
}

load_torque_node_pids() {
  TORQUE_NODE_PIDS=()
  local line
  local pid
  local cmdline

  if is_windows; then
    # Prefer PowerShell — wmic's `CommandLine like '%...%'` is broken on
    # Windows 11 (returns "Invalid query" even with valid syntax).
    # Get-CimInstance Win32_Process is reliable across Windows 10/11.
    if [ -n "$POWERSHELL_BIN" ]; then
      while IFS= read -r line; do
        pid="${line%$'\r'}"
        pid="$(printf '%s' "$pid" | tr -d '[:space:]')"
        if [ -n "$pid" ] && printf '%s' "$pid" | grep -Eq '^[0-9]+$'; then
          append_unique_pid "$pid"
        fi
      done < <("$POWERSHELL_BIN" -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*server*index.js*' } | Select-Object -ExpandProperty ProcessId" 2>/dev/null || true)

      return 0
    fi

    if [ -z "$WMIC_BIN" ]; then
      log "Neither powershell nor wmic are available; skipping command-line verification."
      return 1
    fi

    while IFS= read -r line; do
      line="${line%$'\r'}"
      case "$line" in
        ProcessId=*)
          pid="${line#ProcessId=}"
          pid="$(printf '%s' "$pid" | tr -d '[:space:]')"
          if [ -n "$pid" ] && printf '%s' "$pid" | grep -Eq '^[0-9]+$' && is_node_pid "$pid"; then
            append_unique_pid "$pid"
          fi
          ;;
      esac
    # wmic LIKE '%server/index.js%' misses backslash paths on Windows where
    # command lines render as 'server\index.js'. '%server%index.js%' matches
    # either separator; is_node_pid above still filters to node.exe only.
    done < <("$WMIC_BIN" process where "CommandLine like '%server%index.js%'" get ProcessId /value 2>/dev/null || true)

    return 0
  fi

  if ! command -v ps >/dev/null 2>&1; then
    log "ps is not available; skipping command-line verification."
    return 1
  fi

  while IFS= read -r line; do
    pid="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*([0-9]+)[[:space:]]+.*/\1/')"
    cmdline="${line#"$pid"}"
    case "$cmdline" in
      *node*server/index.js*)
        append_unique_pid "$pid"
        ;;
    esac
  done < <(ps -eo pid=,args= 2>/dev/null || true)

  return 0
}

kill_pid_force() {
  local pid="$1"

  if [ -z "$pid" ]; then
    return 1
  fi

  if is_windows; then
    if [ -z "$TASKKILL_BIN" ]; then
      return 1
    fi
    "$TASKKILL_BIN" //F //PID "$pid" 2>/dev/null
    return $?
  fi

  kill -KILL "$pid" 2>/dev/null
}

kill_pid_tree() {
  local pid="$1"

  if [ -z "$pid" ]; then
    return 1
  fi

  if is_windows; then
    if [ -z "$TASKKILL_BIN" ]; then
      return 1
    fi
    "$TASKKILL_BIN" //F //T //PID "$pid" 2>/dev/null
    return $?
  fi

  kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  kill -KILL "$pid" 2>/dev/null
}

cleanup_stale_pid_file() {
  local pid

  if [ ! -f "$PID_FILE" ]; then
    return 0
  fi

  pid="$(read_pid_from_file || true)"
  if [ -z "$pid" ] || ! is_pid_running "$pid"; then
    rm -f "$PID_FILE" 2>/dev/null || true
    log "Removed stale PID file: $PID_FILE"
  fi
}

verify_running_instances() {
  if ! load_torque_node_pids; then
    return 2
  fi

  if [ "${#TORQUE_NODE_PIDS[@]}" -eq 0 ]; then
    log "No running TORQUE server instances found."
    return 1
  fi

  log "Running TORQUE server instance(s): ${TORQUE_NODE_PIDS[*]}"
  return 0
}

verify_and_kill_lingering_nodes() {
  local pid

  if ! load_torque_node_pids; then
    return 1
  fi

  if [ "${#TORQUE_NODE_PIDS[@]}" -eq 0 ]; then
    log "No lingering TORQUE node processes found."
    return 1
  fi

  log "Found lingering TORQUE node process(es): ${TORQUE_NODE_PIDS[*]}"
  for pid in "${TORQUE_NODE_PIDS[@]}"; do
    log "Force killing lingering TORQUE node PID $pid ..."
    kill_pid_force "$pid" || true
  done

  sleep 1
  cleanup_stale_pid_file

  if load_torque_node_pids && [ "${#TORQUE_NODE_PIDS[@]}" -eq 0 ]; then
    log "Lingering TORQUE node processes terminated."
    return 0
  fi

  return 1
}

# ── Step 1: Graceful HTTP shutdown ──
# By default, the server's /api/shutdown endpoint refuses when the pipeline
# has in-flight work (running/queued/pending/blocked tasks). This script
# issues a non-force shutdown so that refusal is honored — operators should
# drain via await_restart first, then call this script.
#
# Passing --force on the command line DOES drive a force-shutdown (used
# by worktree-cutover.sh only after its own drain step, and by emergency
# operator recovery). Force still has a governance-layer check behind it:
# the no-force-restart rule at server/governance/hooks.js blocks even
# force:true when tasks are running unless operator_override:true is set.
try_http_shutdown() {
  local body
  if [ "$FORCE" -eq 1 ]; then
    body='{"reason":"stop-torque.sh --force","force":true,"operator_override":true}'
    log "Attempting force shutdown via http://127.0.0.1:${API_PORT}/api/shutdown (operator override acknowledged)..."
  else
    body='{"reason":"stop-torque.sh"}'
    log "Attempting graceful shutdown via http://127.0.0.1:${API_PORT}/api/shutdown (requires drained pipeline)..."
  fi
  if response=$(curl -s --max-time 5 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Requested-With: XMLHttpRequest" \
    -d "$body" \
    "http://127.0.0.1:${API_PORT}/api/shutdown" 2>/dev/null); then
    if echo "$response" | grep -q "shutting_down"; then
      log "Shutdown accepted. Waiting for process to exit..."
      # Wait up to 10 seconds for process to exit
      local i=1
      while [ "$i" -le 20 ]; do
        if ! curl -s --max-time 1 "http://127.0.0.1:${API_PORT}/livez" >/dev/null 2>&1; then
          log "Server stopped successfully."
          return 0
        fi
        sleep 0.5
        i=$((i + 1))
      done
      log "Server still responding after 10s — falling through to PID kill."
      return 1
    fi
    # 409 with a task-count error means the pipeline is busy. Echo the server's
    # reply so the operator sees exactly what's in flight.
    if echo "$response" | grep -q "Shutdown blocked"; then
      log "Shutdown refused: pipeline is not empty. Drain via await_restart first, or re-run with --force."
      log "Server response: $response"
      return 1
    fi
    if echo "$response" | grep -q "Governance blocked"; then
      log "Shutdown refused by governance: $response"
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

# ── Step 3: Kill via PID file ──
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

  # Check if process is actually running
  if ! is_pid_running "$pid"; then
    log "PID $pid is not running (stale PID file)."
    rm -f "$PID_FILE" 2>/dev/null || true
    return 1
  fi

  # Use taskkill /T for tree kill — kills bash wrapper + tail + node together
  log "Killing process tree rooted at PID $pid ..."
  kill_pid_tree "$pid" || true
  sleep 1

  # Verify it's gone
  if ! is_pid_running "$pid"; then
    log "Process $pid terminated."
    cleanup_stale_pid_file
    return 0
  fi

  log "PID $pid still alive after taskkill."
  return 1
}

# ── Step 4: Nuclear fallback — find and kill all TORQUE node.exe processes ──
try_ps_kill() {
  log "Scanning for TORQUE node.exe processes ..."

  if ! load_torque_node_pids; then
    log "Unable to scan for TORQUE node processes."
    return 1
  fi

  local pid
  local killed=0
  for pid in "${TORQUE_NODE_PIDS[@]}"; do
    log "Found TORQUE process: PID $pid — killing tree ..."
    kill_pid_tree "$pid" || true
    killed=$((killed + 1))
  done

  if [ "$killed" -gt 0 ]; then
    log "Terminated $killed TORQUE node process(es) and their trees."
    cleanup_stale_pid_file
    return 0
  fi

  log "No TORQUE node processes found."
  return 1
}

# ── Step 5: Clean up orphaned bash/tail from previous TORQUE starts ──
# The start command `bash -c 'tail -f /dev/null | node ...'` creates
# bash + tail processes. When node exits, tail never gets SIGPIPE (it
# never writes), so both survive as orphans.
cleanup_orphaned_wrappers() {
  local killed=0

  if ! is_windows || [ -z "$WMIC_BIN" ] || [ -z "$TASKKILL_BIN" ]; then
    return 0
  fi

  # Kill orphaned "tail -f /dev/null" processes (only TORQUE uses this pattern)
  while IFS= read -r line; do
    echo "$line" | grep -q "tail.*-f.*/dev/null" || continue
    local pid
    pid=$(echo "$line" | sed 's/.*,//' | tr -d '[:space:]')
    if [ -n "$pid" ] && echo "$pid" | grep -Eq '^[0-9]+$'; then
      "$TASKKILL_BIN" //F //PID "$pid" 2>/dev/null
      killed=$((killed + 1))
    fi
  done < <("$WMIC_BIN" process where "name='tail.exe'" get processid,commandline /format:csv 2>/dev/null || true)

  # Kill orphaned bash wrappers running "tail -f /dev/null | node"
  while IFS= read -r line; do
    echo "$line" | grep -q "tail -f /dev/null.*node" || continue
    local pid
    pid=$(echo "$line" | sed 's/.*,//' | tr -d '[:space:]')
    if [ -n "$pid" ] && echo "$pid" | grep -Eq '^[0-9]+$'; then
      "$TASKKILL_BIN" //F //PID "$pid" 2>/dev/null
      killed=$((killed + 1))
    fi
  done < <("$WMIC_BIN" process where "name='bash.exe'" get processid,commandline /format:csv 2>/dev/null || true)

  # NOTE: Do NOT clean up "stop-torque" bash processes here.
  # The grep matches the calling shell (e.g. Claude Code's bash),
  # which kills the parent and aborts the script mid-execution.

  if [ "$killed" -gt 0 ]; then
    log "Cleaned up $killed orphaned wrapper process(es)."
  fi
  return 0
}

# ── Main ──

parse_args "$@"

if [ "$VERIFY_ONLY" -eq 1 ]; then
  verify_running_instances
  case $? in
    0) exit 1 ;;
    1) exit 0 ;;
    *) exit 2 ;;
  esac
fi

if [ "$FORCE" -eq 1 ]; then
  log "Force mode: skipping graceful shutdown."
  try_pid_kill || try_ps_kill || log "No TORQUE processes to kill."
  cleanup_orphaned_wrappers || true
  cleanup_stale_pid_file || true
  exit 0
fi

try_http_shutdown || true
log "Waiting 2s for clean shutdown before force-kill verification ..."
sleep 2
verify_and_kill_lingering_nodes || true

if load_torque_node_pids && [ "${#TORQUE_NODE_PIDS[@]}" -eq 0 ]; then
  cleanup_orphaned_wrappers || true
  cleanup_stale_pid_file || true
  exit 0
fi

try_pid_kill || try_ps_kill || log "TORQUE does not appear to be running."
cleanup_orphaned_wrappers || true
cleanup_stale_pid_file || true
exit 0
