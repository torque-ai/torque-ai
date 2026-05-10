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

repo_coord_lock_acquire main "primary test" > "$TMP_ROOT/primary.out"
LOCK_DIR="$TORQUE_COORD_LOCK_DIR"
LOCK_TOKEN="$TORQUE_COORD_LOCK_TOKEN"
assert_dir_exists "$LOCK_DIR"
assert_contains "$LOCK_DIR/owner.env" '^purpose=primary test$'

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

echo "repo-coordination-lock tests passed"
