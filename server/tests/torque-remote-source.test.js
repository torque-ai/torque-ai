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
});
