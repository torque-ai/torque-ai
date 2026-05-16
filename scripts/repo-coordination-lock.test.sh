#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/repo-coordination-lock.sh"

TMP_ROOT="$(mktemp -d)"
cleanup() {
  repo_coord_lock_release >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

export REPO_ROOT="$TMP_ROOT/repo"
export TORQUE_COORD_LOCK_ROOT="$TMP_ROOT/locks"
export TORQUE_COORD_LOCK_WAIT_SECS=0
export TORQUE_COORD_LOCK_POLL_SECS=1
export TORQUE_COORD_LOCK_NOTICE_SECS=1
mkdir -p "$REPO_ROOT"

assert_dir_exists() {
  if [ ! -d "$1" ]; then
    echo "Expected directory to exist: $1" >&2
    exit 1
  fi
}

assert_dir_missing() {
  if [ -d "$1" ]; then
    echo "Expected directory to be absent: $1" >&2
    exit 1
  fi
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -qE "$pattern" "$file"; then
    echo "Expected $file to contain pattern: $pattern" >&2
    echo "--- $file ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local pattern="$2"
  if grep -qE "$pattern" "$file"; then
    echo "Expected $file not to contain pattern: $pattern" >&2
    echo "--- $file ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

repo_coord_lock_acquire main "primary test" > "$TMP_ROOT/primary.out"
LOCK_DIR="$TORQUE_COORD_LOCK_DIR"
LOCK_TOKEN="$TORQUE_COORD_LOCK_TOKEN"
assert_dir_exists "$LOCK_DIR"
assert_contains "$LOCK_DIR/owner.env" '^purpose=primary test$'
cat > "$LOCK_DIR/heartbeat.env" <<EOF
updated_at_epoch=$(date +%s)
phase=server
detail=running tests
output_bytes=12345
output_age_seconds=7
artifact_file=$TMP_ROOT/pre-push-artifact.txt
EOF
repo_coord_lock_status main > "$TMP_ROOT/heartbeat-status.out" 2>&1 || true
assert_contains "$TMP_ROOT/heartbeat-status.out" 'phase=server'
assert_contains "$TMP_ROOT/heartbeat-status.out" 'heartbeat_age='
assert_contains "$TMP_ROOT/heartbeat-status.out" 'output_age=7s'
assert_contains "$TMP_ROOT/heartbeat-status.out" 'output_bytes=12345'
assert_contains "$TMP_ROOT/heartbeat-status.out" 'detail=running tests'
assert_contains "$TMP_ROOT/heartbeat-status.out" "artifact=$TMP_ROOT/pre-push-artifact.txt"

set +e
bash -c '
  set -euo pipefail
  source "$1"
  export REPO_ROOT="$2"
  export TORQUE_COORD_LOCK_ROOT="$3"
  export TORQUE_COORD_LOCK_WAIT_SECS=0
  unset TORQUE_COORD_LOCK_DIR TORQUE_COORD_LOCK_TOKEN TORQUE_COORD_LOCK_NAME TORQUE_COORD_LOCK_OWNER_BASHPID
  repo_coord_lock_acquire main "blocked contender"
' bash "$SCRIPT_DIR/repo-coordination-lock.sh" "$REPO_ROOT" "$TORQUE_COORD_LOCK_ROOT" > "$TMP_ROOT/contender.out" 2>&1
contender_rc=$?
set -e
if [ "$contender_rc" -eq 0 ]; then
  echo "Expected contender acquisition to fail while primary lock is held" >&2
  exit 1
fi
assert_contains "$TMP_ROOT/contender.out" 'Timed out waiting for main lease'

bash -c '
  set -euo pipefail
  source "$1"
  repo_coord_lock_acquire main "reentrant child" > "$2"
  repo_coord_lock_release >> "$2"
' bash "$SCRIPT_DIR/repo-coordination-lock.sh" "$TMP_ROOT/reentrant.out"
assert_contains "$TMP_ROOT/reentrant.out" 'Reusing main lease'
assert_dir_exists "$LOCK_DIR"
if [ "$(cat "$LOCK_DIR/token")" != "$LOCK_TOKEN" ]; then
  echo "Reentrant child changed the parent lock token" >&2
  exit 1
fi

ISOLATED_LOCK_ROOT="$TMP_ROOT/isolated-gate-locks"
bash -c '
  set -euo pipefail
  source "$1"
  export REPO_ROOT="$2"
  export TORQUE_COORD_LOCK_ROOT="$3"
  unset TORQUE_COORD_LOCK_DIR TORQUE_COORD_LOCK_TOKEN TORQUE_COORD_LOCK_NAME TORQUE_COORD_LOCK_OWNER_BASHPID
  unset REPO_COORD_LOCK_DIR REPO_COORD_LOCK_TOKEN REPO_COORD_LOCK_NAME REPO_COORD_LOCK_REUSED REPO_COORD_LOCK_OWNER_BASHPID REPO_COORD_LOCK_FORCE_RELEASE
  repo_coord_lock_acquire main "isolated gate child" > "$4"
  repo_coord_lock_release >> "$4"
' bash "$SCRIPT_DIR/repo-coordination-lock.sh" "$REPO_ROOT" "$ISOLATED_LOCK_ROOT" "$TMP_ROOT/isolated-gate.out"
assert_contains "$TMP_ROOT/isolated-gate.out" 'Acquired main lease for isolated gate child'
assert_contains "$TMP_ROOT/isolated-gate.out" 'Released lease'
assert_dir_exists "$LOCK_DIR"
if [ "$(cat "$LOCK_DIR/token")" != "$LOCK_TOKEN" ]; then
  echo "Isolated gate child changed the parent lock token" >&2
  exit 1
fi
assert_dir_missing "$ISOLATED_LOCK_ROOT/main.lock"

bash -c '
  set -euo pipefail
  source "$1"
  export REPO_COORD_LOCK_DIR="$2"
  export REPO_COORD_LOCK_TOKEN="$3"
  export REPO_COORD_LOCK_OWNER_BASHPID=999999
  export REPO_COORD_LOCK_FORCE_RELEASE=1
  repo_coord_lock_release > "$4"
' bash "$SCRIPT_DIR/repo-coordination-lock.sh" "$LOCK_DIR" "$LOCK_TOKEN" "$TMP_ROOT/force-release.out"
assert_dir_missing "$LOCK_DIR"

repo_coord_lock_acquire main "primary after force release" > "$TMP_ROOT/primary-after-force.out"
LOCK_DIR="$TORQUE_COORD_LOCK_DIR"
LOCK_TOKEN="$TORQUE_COORD_LOCK_TOKEN"
assert_dir_exists "$LOCK_DIR"

repo_coord_lock_release > "$TMP_ROOT/release.out"
assert_dir_missing "$LOCK_DIR"

DEAD_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$DEAD_LOCK"
cat > "$DEAD_LOCK/owner.env" <<EOF
lock_name=main
purpose=dead same-host test
pid=999999999
host=$(hostname 2>/dev/null || echo unknown)
started_at=2099-01-01T00:00:00Z
started_at_epoch=4070908800
EOF
printf 'dead-token\n' > "$DEAD_LOCK/token"

export TORQUE_COORD_LOCK_STALE_SECS=7200
repo_coord_lock_acquire main "dead-owner takeover" > "$TMP_ROOT/dead-owner.out"
assert_contains "$TMP_ROOT/dead-owner.out" 'Reaping dead same-host lock'
assert_contains "$TORQUE_COORD_LOCK_DIR/owner.env" '^purpose=dead-owner takeover$'
repo_coord_lock_release > "$TMP_ROOT/dead-owner-release.out"

DEAD_STATUS_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$DEAD_STATUS_LOCK"
cat > "$DEAD_STATUS_LOCK/owner.env" <<EOF
lock_name=main
purpose=dead same-host status test
pid=999999997
host=$(hostname 2>/dev/null || echo unknown)
started_at=2099-01-01T00:00:00Z
started_at_epoch=4070908800
EOF
printf 'dead-status-token\n' > "$DEAD_STATUS_LOCK/token"

export TORQUE_COORD_LOCK_STALE_SECS=7200
repo_coord_lock_status main > "$TMP_ROOT/dead-status.out"
assert_contains "$TMP_ROOT/dead-status.out" 'Reaping dead same-host lock'
assert_contains "$TMP_ROOT/dead-status.out" 'main lease is free'
assert_dir_missing "$DEAD_STATUS_LOCK"

WINDOWS_DEAD_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$WINDOWS_DEAD_LOCK"
cat > "$WINDOWS_DEAD_LOCK/owner.env" <<EOF
lock_name=main
purpose=windows dead same-host test
pid=999999998
host=$(hostname 2>/dev/null || echo unknown)
started_at=2099-01-01T00:00:00Z
started_at_epoch=4070908800
EOF
printf 'windows-dead-token\n' > "$WINDOWS_DEAD_LOCK/token"
FAKE_BIN="$TMP_ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/powershell.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG"
exit 1
EOF
chmod +x "$FAKE_BIN/powershell.exe"

(
  export PATH="$FAKE_BIN:$PATH"
  export TORQUE_COORD_LOCK_UNAME="MINGW64_NT-10.0"
  export TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG="$TMP_ROOT/fake-powershell.log"
  repo_coord_lock_acquire main "windows dead-owner takeover" > "$TMP_ROOT/windows-dead-owner.out"
  repo_coord_lock_release > "$TMP_ROOT/windows-dead-owner-release.out"
)
assert_contains "$TMP_ROOT/windows-dead-owner.out" 'Reaping dead same-host lock'
assert_contains "$TMP_ROOT/windows-dead-owner.out" 'windows dead same-host test'
assert_contains "$TMP_ROOT/fake-powershell.log" 'Get-Process -Id 999999998'

WINDOWS_STORED_PID_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$WINDOWS_STORED_PID_LOCK"
cat > "$WINDOWS_STORED_PID_LOCK/owner.env" <<EOF
lock_name=main
purpose=windows stored pid test
pid=12345
windows_pid=424242
host=$(hostname 2>/dev/null || echo unknown)
started_at=2099-01-01T00:00:00Z
started_at_epoch=4070908800
EOF
printf 'windows-stored-pid-token\n' > "$WINDOWS_STORED_PID_LOCK/token"
: > "$TMP_ROOT/fake-powershell-stored.log"

(
  export PATH="$FAKE_BIN:$PATH"
  export TORQUE_COORD_LOCK_UNAME="MINGW64_NT-10.0"
  export TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG="$TMP_ROOT/fake-powershell-stored.log"
  repo_coord_lock_acquire main "windows stored-pid takeover" > "$TMP_ROOT/windows-stored-pid.out"
  repo_coord_lock_release > "$TMP_ROOT/windows-stored-pid-release.out"
)
assert_contains "$TMP_ROOT/windows-stored-pid.out" 'Reaping dead same-host lock'
assert_contains "$TMP_ROOT/windows-stored-pid.out" 'windows_pid=424242'
assert_contains "$TMP_ROOT/fake-powershell-stored.log" 'Get-Process -Id 424242'
assert_not_contains "$TMP_ROOT/fake-powershell-stored.log" 'Get-Process -Id 12345'

WINDOWS_MAPPED_PID_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$WINDOWS_MAPPED_PID_LOCK"
cat > "$WINDOWS_MAPPED_PID_LOCK/owner.env" <<EOF
lock_name=main
purpose=windows mapped pid test
pid=13579
host=$(hostname 2>/dev/null || echo unknown)
started_at=2099-01-01T00:00:00Z
started_at_epoch=4070908800
EOF
printf 'windows-mapped-pid-token\n' > "$WINDOWS_MAPPED_PID_LOCK/token"
cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-W" ]; then
  cat <<'PSOUT'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
    13579       1   13579      55555  pty0      197609 00:00:00 /usr/bin/bash
PSOUT
  exit 0
fi
exit 1
EOF
chmod +x "$FAKE_BIN/ps"
: > "$TMP_ROOT/fake-powershell-mapped.log"

(
  export PATH="$FAKE_BIN:$PATH"
  export TORQUE_COORD_LOCK_UNAME="MINGW64_NT-10.0"
  export TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG="$TMP_ROOT/fake-powershell-mapped.log"
  repo_coord_lock_acquire main "windows mapped-pid takeover" > "$TMP_ROOT/windows-mapped-pid.out"
  repo_coord_lock_release > "$TMP_ROOT/windows-mapped-pid-release.out"
)
assert_contains "$TMP_ROOT/windows-mapped-pid.out" 'Reaping dead same-host lock'
assert_contains "$TMP_ROOT/fake-powershell-mapped.log" 'Get-Process -Id 55555'
assert_not_contains "$TMP_ROOT/fake-powershell-mapped.log" 'Get-Process -Id 13579'

WINDOWS_LIVE_MAPPED_PID_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$WINDOWS_LIVE_MAPPED_PID_LOCK"
cat > "$WINDOWS_LIVE_MAPPED_PID_LOCK/owner.env" <<EOF
lock_name=main
purpose=windows live mapped pid test
pid=24680
host=$(hostname 2>/dev/null || echo unknown)
started_at=2099-01-01T00:00:00Z
started_at_epoch=4070908800
EOF
printf 'windows-live-mapped-pid-token\n' > "$WINDOWS_LIVE_MAPPED_PID_LOCK/token"
cat > "$FAKE_BIN/ps" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-W" ]; then
  cat <<'PSOUT'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
    24680       1   24680      66666  pty0      197609 00:00:00 /usr/bin/bash
PSOUT
  exit 0
fi
exit 1
EOF
cat > "$FAKE_BIN/powershell.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG"
case "$*" in
  *"Get-Process -Id 66666"*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/ps" "$FAKE_BIN/powershell.exe"
: > "$TMP_ROOT/fake-powershell-live-mapped.log"

set +e
(
  export PATH="$FAKE_BIN:$PATH"
  export TORQUE_COORD_LOCK_UNAME="MINGW64_NT-10.0"
  export TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG="$TMP_ROOT/fake-powershell-live-mapped.log"
  repo_coord_lock_acquire main "windows live mapped-pid blocked" > "$TMP_ROOT/windows-live-mapped-pid.out" 2>&1
)
live_mapped_rc=$?
set -e
if [ "$live_mapped_rc" -eq 0 ]; then
  echo "Expected live mapped Windows PID to block acquisition" >&2
  exit 1
fi
assert_contains "$TMP_ROOT/windows-live-mapped-pid.out" 'Timed out waiting for main lease'
assert_contains "$TMP_ROOT/fake-powershell-live-mapped.log" 'Get-Process -Id 66666'
assert_not_contains "$TMP_ROOT/windows-live-mapped-pid.out" 'Reaping dead same-host lock'
assert_dir_exists "$WINDOWS_LIVE_MAPPED_PID_LOCK"
rm -rf "$WINDOWS_LIVE_MAPPED_PID_LOCK"

WINDOWS_PID_FROM_NON_WINDOWS_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$WINDOWS_PID_FROM_NON_WINDOWS_LOCK"
cat > "$WINDOWS_PID_FROM_NON_WINDOWS_LOCK/owner.env" <<EOF
lock_name=main
purpose=windows pid from non-windows shell test
pid=35791
windows_pid=77777
host=$(hostname 2>/dev/null || echo unknown)
started_at=2099-01-01T00:00:00Z
started_at_epoch=4070908800
EOF
printf 'windows-pid-from-non-windows-token\n' > "$WINDOWS_PID_FROM_NON_WINDOWS_LOCK/token"
cat > "$FAKE_BIN/powershell.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG"
case "$*" in
  *"Get-Process -Id 77777"*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/powershell.exe"
: > "$TMP_ROOT/fake-powershell-non-windows.log"

set +e
(
  export PATH="$FAKE_BIN:$PATH"
  export TORQUE_COORD_LOCK_UNAME="Linux"
  export TORQUE_COORD_LOCK_FAKE_POWERSHELL_LOG="$TMP_ROOT/fake-powershell-non-windows.log"
  repo_coord_lock_acquire main "windows pid from non-windows shell blocked" > "$TMP_ROOT/windows-pid-from-non-windows.out" 2>&1
)
non_windows_pid_rc=$?
set -e
if [ "$non_windows_pid_rc" -eq 0 ]; then
  echo "Expected live stored Windows PID to block acquisition from non-Windows shell" >&2
  exit 1
fi
assert_contains "$TMP_ROOT/windows-pid-from-non-windows.out" 'Timed out waiting for main lease'
assert_contains "$TMP_ROOT/fake-powershell-non-windows.log" 'Get-Process -Id 77777'
assert_not_contains "$TMP_ROOT/windows-pid-from-non-windows.out" 'Reaping dead same-host lock'
assert_dir_exists "$WINDOWS_PID_FROM_NON_WINDOWS_LOCK"
rm -rf "$WINDOWS_PID_FROM_NON_WINDOWS_LOCK"

STALE_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$STALE_LOCK"
cat > "$STALE_LOCK/owner.env" <<EOF
lock_name=main
purpose=stale test
pid=1
host=test
started_at=1970-01-01T00:00:00Z
started_at_epoch=1
EOF
printf 'stale-token\n' > "$STALE_LOCK/token"

export TORQUE_COORD_LOCK_STALE_SECS=1
repo_coord_lock_acquire main "stale takeover" > "$TMP_ROOT/stale.out"
assert_contains "$TMP_ROOT/stale.out" 'Reaping stale lock'
assert_contains "$TORQUE_COORD_LOCK_DIR/owner.env" '^purpose=stale takeover$'
repo_coord_lock_release > "$TMP_ROOT/stale-release.out"

STALE_STATUS_LOCK="$TORQUE_COORD_LOCK_ROOT/main.lock"
mkdir -p "$STALE_STATUS_LOCK"
cat > "$STALE_STATUS_LOCK/owner.env" <<EOF
lock_name=main
purpose=stale status test
pid=1
host=test
started_at=1970-01-01T00:00:00Z
started_at_epoch=1
EOF
printf 'stale-status-token\n' > "$STALE_STATUS_LOCK/token"

export TORQUE_COORD_LOCK_STALE_SECS=1
repo_coord_lock_status main > "$TMP_ROOT/stale-status.out"
assert_contains "$TMP_ROOT/stale-status.out" 'Reaping stale lock'
assert_contains "$TMP_ROOT/stale-status.out" 'main lease is free'
assert_dir_missing "$STALE_STATUS_LOCK"

echo "repo-coordination-lock tests passed"
