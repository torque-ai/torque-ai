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

repo_coord_lock_release > "$TMP_ROOT/release.out"
assert_dir_missing "$LOCK_DIR"

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
