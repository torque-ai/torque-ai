#!/usr/bin/env bash
# Shared repo-state lease for operations that mutate main/worktree state.
#
# This intentionally lives under the git common dir by default so every
# worktree for the repository observes the same lock. Use
# TORQUE_COORD_LOCK_ROOT in tests or unusual deployments.
set -euo pipefail

repo_coord_lock_repo_root() {
  if [ -n "${REPO_ROOT:-}" ]; then
    printf '%s\n' "$REPO_ROOT"
    return 0
  fi
  git rev-parse --show-toplevel
}

repo_coord_lock_root() {
  if [ -n "${TORQUE_COORD_LOCK_ROOT:-}" ]; then
    printf '%s\n' "$TORQUE_COORD_LOCK_ROOT"
    return 0
  fi

  local repo_root common_dir
  repo_root="$(repo_coord_lock_repo_root)"
  common_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
  case "$common_dir" in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;;
    *) common_dir="$repo_root/$common_dir" ;;
  esac
  printf '%s/torque-coordination-locks\n' "$common_dir"
}

repo_coord_lock_sanitize_name() {
  local name="${1:-main}"
  printf '%s\n' "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g'
}

repo_coord_lock_path() {
  local name safe_name
  name="${1:-main}"
  safe_name="$(repo_coord_lock_sanitize_name "$name")"
  printf '%s/%s.lock\n' "$(repo_coord_lock_root)" "$safe_name"
}

repo_coord_lock_read_field() {
  local file="$1"
  local field="$2"
  sed -nE "s/^${field}=(.*)$/\\1/p" "$file" 2>/dev/null | head -1
}

repo_coord_lock_write_owner() {
  local lock_dir="$1"
  local lock_name="$2"
  local purpose="$3"
  local token="$4"
  local now_epoch now_iso host user repo_root
  now_epoch="$(date +%s)"
  now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  host="$(hostname 2>/dev/null || echo unknown)"
  user="${USER:-${USERNAME:-unknown}}"
  repo_root="$(repo_coord_lock_repo_root 2>/dev/null || echo unknown)"

  {
    printf 'lock_name=%s\n' "$lock_name"
    printf 'purpose=%s\n' "$purpose"
    printf 'pid=%s\n' "$$"
    printf 'ppid=%s\n' "${PPID:-unknown}"
    printf 'user=%s\n' "$user"
    printf 'host=%s\n' "$host"
    printf 'repo=%s\n' "$repo_root"
    printf 'cwd=%s\n' "$PWD"
    printf 'started_at=%s\n' "$now_iso"
    printf 'started_at_epoch=%s\n' "$now_epoch"
    printf 'stale_after_seconds=%s\n' "${TORQUE_COORD_LOCK_STALE_SECS:-7200}"
    printf 'command=%s\n' "$0"
  } > "$lock_dir/owner.env"
  printf '%s\n' "$token" > "$lock_dir/token"
}

repo_coord_lock_describe() {
  local lock_dir="$1"
  local owner_file="$lock_dir/owner.env"
  if [ ! -f "$owner_file" ]; then
    printf 'unknown owner at %s\n' "$lock_dir"
    return 0
  fi

  local purpose pid host started_at cwd
  purpose="$(repo_coord_lock_read_field "$owner_file" purpose)"
  pid="$(repo_coord_lock_read_field "$owner_file" pid)"
  host="$(repo_coord_lock_read_field "$owner_file" host)"
  started_at="$(repo_coord_lock_read_field "$owner_file" started_at)"
  cwd="$(repo_coord_lock_read_field "$owner_file" cwd)"
  printf 'purpose=%s pid=%s host=%s started_at=%s cwd=%s\n' \
    "${purpose:-unknown}" "${pid:-unknown}" "${host:-unknown}" "${started_at:-unknown}" "${cwd:-unknown}"
}

repo_coord_lock_age_seconds() {
  local lock_dir="$1"
  local owner_file="$lock_dir/owner.env"
  local now started_at
  now="$(date +%s)"
  started_at="$(repo_coord_lock_read_field "$owner_file" started_at_epoch)"
  if [ -z "$started_at" ]; then
    started_at="$(stat -c %Y "$lock_dir" 2>/dev/null || echo "$now")"
  fi
  case "$started_at" in
    ''|*[!0-9]*) printf '0\n' ;;
    *) printf '%s\n' "$((now - started_at))" ;;
  esac
}

repo_coord_lock_current_host() {
  hostname 2>/dev/null || echo unknown
}

repo_coord_lock_platform() {
  if [ -n "${TORQUE_COORD_LOCK_UNAME:-}" ]; then
    printf '%s\n' "$TORQUE_COORD_LOCK_UNAME"
    return 0
  fi
  uname -s 2>/dev/null || echo unknown
}

repo_coord_lock_windows_pid_alive() {
  local pid="$1"

  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "if (Get-Process -Id $pid -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >/dev/null 2>&1
    return $?
  fi
  if command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -Command "if (Get-Process -Id $pid -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >/dev/null 2>&1
    return $?
  fi
  if command -v tasklist.exe >/dev/null 2>&1; then
    tasklist.exe /FI "PID eq $pid" /NH 2>/dev/null | grep -qE "[[:space:]]$pid[[:space:]]"
    return $?
  fi

  return 2
}

repo_coord_lock_pid_alive() {
  local pid="$1" windows_status
  case "$pid" in
    ''|*[!0-9]*|0) return 1 ;;
  esac

  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  case "$(repo_coord_lock_platform)" in
    MINGW*|MSYS*|CYGWIN*)
      repo_coord_lock_windows_pid_alive "$pid"
      windows_status=$?
      case "$windows_status" in
        0) return 0 ;;
        1) return 1 ;;
      esac
      ;;
  esac

  if command -v ps >/dev/null 2>&1; then
    ps -p "$pid" >/dev/null 2>&1 && return 0
  fi

  return 1
}

repo_coord_lock_reap_if_dead_owner() {
  local lock_dir="$1"
  local owner_file="$lock_dir/owner.env"
  local owner_host owner_pid current_host

  if [ ! -f "$owner_file" ]; then
    return 1
  fi

  owner_host="$(repo_coord_lock_read_field "$owner_file" host)"
  owner_pid="$(repo_coord_lock_read_field "$owner_file" pid)"
  current_host="$(repo_coord_lock_current_host)"

  if [ -z "$owner_host" ] || [ "$owner_host" != "$current_host" ]; then
    return 1
  fi
  if repo_coord_lock_pid_alive "$owner_pid"; then
    return 1
  fi

  echo "[coord-lock] Reaping dead same-host lock: $(repo_coord_lock_describe "$lock_dir")"
  rm -rf "$lock_dir"
  return 0
}

repo_coord_lock_reap_if_stale() {
  local lock_dir="$1"
  local stale_secs="${TORQUE_COORD_LOCK_STALE_SECS:-7200}"
  local age

  case "$stale_secs" in
    ''|*[!0-9]*) stale_secs=7200 ;;
  esac
  if [ "$stale_secs" -le 0 ]; then
    return 1
  fi

  age="$(repo_coord_lock_age_seconds "$lock_dir")"
  if [ "$age" -lt "$stale_secs" ]; then
    return 1
  fi

  echo "[coord-lock] Reaping stale lock after ${age}s: $(repo_coord_lock_describe "$lock_dir")"
  rm -rf "$lock_dir"
  return 0
}

repo_coord_lock_acquire() {
  local lock_name="${1:-main}"
  local purpose="${2:-repo coordination}"
  local lock_dir lock_root token wait_secs poll_secs notice_secs deadline now next_notice current_bashpid

  lock_dir="$(repo_coord_lock_path "$lock_name")"
  lock_root="$(dirname "$lock_dir")"
  current_bashpid="${BASHPID:-$$}"

  if [ "${TORQUE_COORD_LOCK_DIR:-}" = "$lock_dir" ] && \
     [ -n "${TORQUE_COORD_LOCK_TOKEN:-}" ] && \
     [ "$(cat "$lock_dir/token" 2>/dev/null || true)" = "${TORQUE_COORD_LOCK_TOKEN:-}" ]; then
    REPO_COORD_LOCK_DIR="$lock_dir"
    REPO_COORD_LOCK_TOKEN="$TORQUE_COORD_LOCK_TOKEN"
    REPO_COORD_LOCK_OWNER_BASHPID="${TORQUE_COORD_LOCK_OWNER_BASHPID:-}"
    if [ "${TORQUE_COORD_LOCK_OWNER_BASHPID:-}" != "$current_bashpid" ]; then
      REPO_COORD_LOCK_REUSED=1
    fi
    echo "[coord-lock] Reusing ${lock_name} lease for ${purpose}"
    return 0
  fi

  wait_secs="${TORQUE_COORD_LOCK_WAIT_SECS:-7200}"
  poll_secs="${TORQUE_COORD_LOCK_POLL_SECS:-5}"
  notice_secs="${TORQUE_COORD_LOCK_NOTICE_SECS:-30}"
  case "$wait_secs" in ''|*[!0-9]*) wait_secs=7200 ;; esac
  case "$poll_secs" in ''|*[!0-9]*) poll_secs=5 ;; esac
  case "$notice_secs" in ''|*[!0-9]*) notice_secs=30 ;; esac

  mkdir -p "$lock_root"
  token="$(date +%s)-$$-${RANDOM:-0}"
  deadline=$(( $(date +%s) + wait_secs ))
  next_notice=0

  while true; do
    if mkdir "$lock_dir" 2>/dev/null; then
      repo_coord_lock_write_owner "$lock_dir" "$lock_name" "$purpose" "$token"
      REPO_COORD_LOCK_DIR="$lock_dir"
      REPO_COORD_LOCK_TOKEN="$token"
      REPO_COORD_LOCK_REUSED=0
      REPO_COORD_LOCK_OWNER_BASHPID="$current_bashpid"
      export TORQUE_COORD_LOCK_DIR="$lock_dir"
      export TORQUE_COORD_LOCK_TOKEN="$token"
      export TORQUE_COORD_LOCK_NAME="$lock_name"
      export TORQUE_COORD_LOCK_OWNER_BASHPID="$current_bashpid"
      echo "[coord-lock] Acquired ${lock_name} lease for ${purpose}"
      return 0
    fi

    if repo_coord_lock_reap_if_dead_owner "$lock_dir"; then
      continue
    fi
    if repo_coord_lock_reap_if_stale "$lock_dir"; then
      continue
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      echo "[coord-lock] Timed out waiting for ${lock_name} lease held by: $(repo_coord_lock_describe "$lock_dir")"
      return 75
    fi

    if [ "$now" -ge "$next_notice" ]; then
      echo "[coord-lock] Waiting for ${lock_name} lease held by: $(repo_coord_lock_describe "$lock_dir")"
      next_notice=$((now + notice_secs))
    fi
    sleep "$poll_secs"
  done
}

repo_coord_lock_release() {
  local lock_dir="${REPO_COORD_LOCK_DIR:-${TORQUE_COORD_LOCK_DIR:-}}"
  local token="${REPO_COORD_LOCK_TOKEN:-${TORQUE_COORD_LOCK_TOKEN:-}}"
  local owner_bashpid="${REPO_COORD_LOCK_OWNER_BASHPID:-${TORQUE_COORD_LOCK_OWNER_BASHPID:-}}"
  local current_bashpid="${BASHPID:-$$}"
  local force_release="${REPO_COORD_LOCK_FORCE_RELEASE:-${TORQUE_COORD_LOCK_FORCE_RELEASE:-0}}"

  if [ "${REPO_COORD_LOCK_REUSED:-0}" = "1" ]; then
    return 0
  fi
  if [ "$force_release" != "1" ] && [ -n "$owner_bashpid" ] && [ "$owner_bashpid" != "$current_bashpid" ]; then
    return 0
  fi
  if [ -z "$lock_dir" ] || [ -z "$token" ]; then
    return 0
  fi
  if [ "$(cat "$lock_dir/token" 2>/dev/null || true)" != "$token" ]; then
    echo "[coord-lock] Not releasing ${lock_dir}; token changed."
    return 0
  fi

  rm -rf "$lock_dir"
  unset REPO_COORD_LOCK_DIR REPO_COORD_LOCK_TOKEN REPO_COORD_LOCK_REUSED REPO_COORD_LOCK_OWNER_BASHPID
  unset TORQUE_COORD_LOCK_DIR TORQUE_COORD_LOCK_TOKEN TORQUE_COORD_LOCK_NAME TORQUE_COORD_LOCK_OWNER_BASHPID
  echo "[coord-lock] Released lease"
}

repo_coord_lock_status() {
  local lock_name="${1:-main}"
  local lock_dir
  lock_dir="$(repo_coord_lock_path "$lock_name")"
  if [ -d "$lock_dir" ]; then
    echo "[coord-lock] ${lock_name} lease held by: $(repo_coord_lock_describe "$lock_dir")"
    return 1
  fi
  echo "[coord-lock] ${lock_name} lease is free"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  command_name="${1:-status}"
  shift || true
  case "$command_name" in
    status)
      repo_coord_lock_status "${1:-main}"
      ;;
    acquire)
      lock_name="${1:-main}"
      purpose="${2:-manual}"
      repo_coord_lock_acquire "$lock_name" "$purpose"
      trap repo_coord_lock_release EXIT
      ;;
    *)
      echo "Usage: $0 [status [name]|acquire [name] [purpose]]" >&2
      exit 2
      ;;
  esac
fi
