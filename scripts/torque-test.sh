#!/usr/bin/env bash
# torque-test.sh — Route test execution to the configured test station.
# Usage: torque-test.sh [command...]
#   Positional arguments override verify_command from config.
#   If no args given, verify_command from .torque-test.json is used.
#
# Config files (relative to project root — one directory up from this script):
#   .torque-test.json       — shared config, committed to repo
#   .torque-test.local.json — local secrets (host, user, key_path), gitignored
#
# Transports:
#   local — run command directly in the project root
#   ssh   — SSH to configured host and run command there

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SHARED_CONFIG="$PROJECT_ROOT/.torque-test.json"
LOCAL_CONFIG="$PROJECT_ROOT/.torque-test.local.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() {
  echo "[torque-test] ERROR: $*" >&2
  exit 1
}

warn() {
  echo "[torque-test] WARNING: $*" >&2
}

# Parse a JSON field from a file using jq.
# Returns empty string if field is null or missing.
json_get() {
  local file="$1"
  local field="$2"
  jq -r "$field // empty" "$file" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Verify jq is available
# ---------------------------------------------------------------------------
if ! command -v jq &>/dev/null; then
  die "jq is required but not found in PATH"
fi

# ---------------------------------------------------------------------------
# Load shared config
# ---------------------------------------------------------------------------
TRANSPORT=""
VERIFY_COMMAND=""
TIMEOUT_SECONDS="120"
SYNC_BEFORE_RUN="false"

if [[ ! -f "$SHARED_CONFIG" ]]; then
  warn "No .torque-test.json found — running command locally"
  TRANSPORT="local"
else
  # Validate JSON
  if ! jq empty "$SHARED_CONFIG" 2>/dev/null; then
    die ".torque-test.json contains invalid JSON"
  fi

  TRANSPORT="$(json_get "$SHARED_CONFIG" '.transport')"
  VERIFY_COMMAND="$(json_get "$SHARED_CONFIG" '.verify_command')"
  TIMEOUT_SECONDS="$(json_get "$SHARED_CONFIG" '.timeout_seconds')"
  SYNC_BEFORE_RUN="$(json_get "$SHARED_CONFIG" '.sync_before_run')"

  # Defaults
  [[ -z "$TRANSPORT" ]]         && TRANSPORT="local"
  [[ -z "$TIMEOUT_SECONDS" ]]   && TIMEOUT_SECONDS="120"
  [[ -z "$SYNC_BEFORE_RUN" ]]   && SYNC_BEFORE_RUN="false"
fi

# ---------------------------------------------------------------------------
# Load local config (optional — required for SSH)
# ---------------------------------------------------------------------------
SSH_HOST=""
SSH_USER=""
SSH_PROJECT_PATH=""
SSH_KEY_PATH=""

if [[ -f "$LOCAL_CONFIG" ]]; then
  if ! jq empty "$LOCAL_CONFIG" 2>/dev/null; then
    die ".torque-test.local.json contains invalid JSON"
  fi

  SSH_HOST="$(json_get "$LOCAL_CONFIG" '.host')"
  SSH_USER="$(json_get "$LOCAL_CONFIG" '.user')"
  SSH_PROJECT_PATH="$(json_get "$LOCAL_CONFIG" '.project_path')"
  SSH_KEY_PATH="$(json_get "$LOCAL_CONFIG" '.key_path')"

  # Local config may also override transport/verify_command
  local_transport="$(json_get "$LOCAL_CONFIG" '.transport')"
  local_verify="$(json_get "$LOCAL_CONFIG" '.verify_command')"
  local_timeout="$(json_get "$LOCAL_CONFIG" '.timeout_seconds')"
  local_sync="$(json_get "$LOCAL_CONFIG" '.sync_before_run')"

  [[ -n "$local_transport" ]] && TRANSPORT="$local_transport"
  [[ -n "$local_verify" ]]    && VERIFY_COMMAND="$local_verify"
  [[ -n "$local_timeout" ]]   && TIMEOUT_SECONDS="$local_timeout"
  [[ -n "$local_sync" ]]      && SYNC_BEFORE_RUN="$local_sync"
fi

# ---------------------------------------------------------------------------
# Positional arguments override verify_command
# ---------------------------------------------------------------------------
if [[ $# -gt 0 ]]; then
  VERIFY_COMMAND="$*"
fi

if [[ -z "$VERIFY_COMMAND" ]]; then
  die "No verify_command specified (set in .torque-test.json or pass as arguments)"
fi

# ---------------------------------------------------------------------------
# Execute
# ---------------------------------------------------------------------------

case "$TRANSPORT" in

  local)
    echo "[torque-test] Running locally: $VERIFY_COMMAND"
    cd "$PROJECT_ROOT"
    set +e
    timeout "$TIMEOUT_SECONDS" bash -c "$VERIFY_COMMAND"
    exit_code=$?
    set -e
    if [[ $exit_code -eq 124 ]]; then
      echo "[torque-test] ERROR: Command timed out after ${TIMEOUT_SECONDS}s" >&2
    fi
    exit $exit_code
    ;;

  ssh)
    # Validate required local config fields
    if [[ ! -f "$LOCAL_CONFIG" ]]; then
      die "SSH transport requires .torque-test.local.json with host, user, and project_path"
    fi
    [[ -z "$SSH_HOST" ]]         && die "SSH transport requires 'host' in .torque-test.local.json"
    [[ -z "$SSH_USER" ]]         && die "SSH transport requires 'user' in .torque-test.local.json"
    [[ -z "$SSH_PROJECT_PATH" ]] && die "SSH transport requires 'project_path' in .torque-test.local.json"

    # Build SSH options
    SSH_OPTS=(-o ConnectTimeout=10 -o BatchMode=yes)
    if [[ -n "$SSH_KEY_PATH" ]]; then
      SSH_OPTS+=(-i "$SSH_KEY_PATH")
    fi

    # Build remote command (use double quotes — CMD on Windows doesn't support single quotes)
    REMOTE_CMD="cd \"$SSH_PROJECT_PATH\""
    if [[ "$SYNC_BEFORE_RUN" == "true" ]]; then
      REMOTE_CMD="$REMOTE_CMD && git pull --quiet"
    fi
    REMOTE_CMD="$REMOTE_CMD && $VERIFY_COMMAND"

    echo "[torque-test] Running on $SSH_USER@$SSH_HOST: $VERIFY_COMMAND"

    set +e
    timeout "$TIMEOUT_SECONDS" ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "$REMOTE_CMD"
    exit_code=$?
    set -e
    if [[ $exit_code -eq 124 ]]; then
      echo "[torque-test] ERROR: Command timed out after ${TIMEOUT_SECONDS}s" >&2
    fi
    exit $exit_code
    ;;

  *)
    die "Unknown transport '$TRANSPORT'. Valid values: local, ssh"
    ;;

esac
