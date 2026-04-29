'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TORQUE_REMOTE_PATH = path.join(REPO_ROOT, 'bin', 'torque-remote');

function readTorqueRemote() {
  return fs.readFileSync(TORQUE_REMOTE_PATH, 'utf8');
}

describe('torque-remote source invariants', () => {
  it('fetches the selected branch ref explicitly before remote checkout', () => {
    const src = readTorqueRemote();
    expect(src).toContain('FETCH_COMMAND="git fetch --prune origin +refs/heads/$SYNC_BRANCH:refs/remotes/origin/$SYNC_BRANCH"');
    expect(src).toContain('&& $FETCH_COMMAND && $SYNC_CHECKOUT && git reset --hard $SYNC_REF');
  });

  it('captures ssh sync status before grep filtering can mask failures', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/grep -v 'Unable to persist credentials\\\|credential store\\\|aka\.ms\/gcm' \|\| true\)\n\s+sync_status="\$\{PIPESTATUS\[0\]\}"/);
    expect(src).not.toContain('|| sync_status="${PIPESTATUS[0]}"');
  });

  it('passes an expected sha into runner guard instead of resolving ephemeral refs later', () => {
    const src = readTorqueRemote();
    expect(src).toContain('EXPECTED_SYNC_SHA="$(git ls-remote --heads origin "$SYNC_BRANCH"');
    expect(src).toContain('EXPECTED_SYNC_SHA=$(shell_quote "$EXPECTED_SYNC_SHA")');
    expect(src).toContain('EXPECTED_HEAD_SHA="\\$EXPECTED_SYNC_SHA"');
    expect(src).not.toContain('EXPECTED_HEAD_SHA=$(git rev-parse "$SYNC_REF"');
  });

  it('does not proceed with uncoordinated remote sync after lock timeout', () => {
    const src = readTorqueRemote();
    expect(src).toContain('TORQUE_REMOTE_SYNC_LOCK_TIMEOUT_SECS:-1800');
    expect(src).toContain('refusing remote sync to avoid worktree contamination');
    expect(src).toContain('Remote sync lock unavailable — falling back to local execution instead of risking remote worktree contamination');
    expect(src).toContain('if ! acquire_remote_sync_lock; then');
    expect(src).not.toContain('acquire_remote_sync_lock || true');
    expect(src).not.toContain('proceeding without serialization');
  });

  it('wraps the worktree-bootstrap if-not-exist in outer parens so the && chain survives when .git already exists', () => {
    // Without outer parens, CMD's `if X (block) && rest` form silently
    // skips `rest` whenever the if-condition is false (i.e., on every
    // sync after the worktree's first creation). The bare form looks
    // correct, exits 0, prints nothing, and leaves the remote worktree
    // HEAD at whatever it was before — which the runner.sh exit-98
    // guard then misattributes to a "concurrent torque-remote session
    // clobbered the checkout" instead of the real cause: the bootstrap
    // silently skipped its own sync. Reproduced live 2026-04-29.
    const src = readTorqueRemote();
    expect(src).toContain('SYNC_BOOTSTRAP="(if not exist \\"$EFFECTIVE_REMOTE_PROJECT_PATH\\\\.git\\"');
    expect(src).not.toMatch(/^\s*SYNC_BOOTSTRAP="if not exist /m);
  });

  it('puts the remote sync lock at a sibling path so git clean -fd cannot remove it mid-run', () => {
    // The sync chain runs `git clean -fd` after reset, which removes any
    // untracked dir under the worktree — including a lock dir placed at
    // "$WORKTREE/.torque-remote-sync.lock". When that lock self-clobbers,
    // a concurrent torque-remote can acquire it mid-run and reset HEAD
    // between this script's sync and runner.sh, surfacing as a phantom
    // "concurrent torque-remote session clobbered the checkout" in the
    // exit-98 guard. Sibling path keeps the lock outside any git operation
    // scoped to the worktree. Reproduced live 2026-04-29.
    const src = readTorqueRemote();
    expect(src).toContain('REMOTE_SYNC_LOCK_DIR="${EFFECTIVE_REMOTE_PROJECT_PATH}.torque-remote-sync.lock"');
    expect(src).not.toContain('REMOTE_SYNC_LOCK_DIR="$EFFECTIVE_REMOTE_PROJECT_PATH\\\\.torque-remote-sync.lock"');
  });
});
