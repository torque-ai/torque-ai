'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TORQUE_REMOTE_PATH = path.join(REPO_ROOT, 'bin', 'torque-remote');

function readTorqueRemote() {
  return fs.readFileSync(TORQUE_REMOTE_PATH, 'utf8');
}

// Source-only invariants — assert on the shape of bin/torque-remote without
// running it. Runtime invariants for build_remote_sync_command are exercised
// in a separate `describe` block below by sourcing the script in bash and
// invoking the function with synthetic inputs.

describe('torque-remote source invariants', () => {
  it('fetches the selected branch ref explicitly before remote checkout', () => {
    const src = readTorqueRemote();
    expect(src).toContain('FETCH_COMMAND="git fetch --prune origin +refs/heads/$SYNC_BRANCH:refs/remotes/origin/$SYNC_BRANCH"');
    // The assembled command (built by build_remote_sync_command) must chain
    // fetch → checkout → reset in that order.
    expect(src).toContain('${fetch_cmd} && ${sync_checkout} && git reset --hard ${sync_ref}');
  });

  it('captures ssh sync status before grep filtering can mask failures', () => {
    const src = readTorqueRemote();
    // After the run_with_timeout wrap (batch-2 #3), the sync pipeline lives
    // inside `_torque_remote_sync_pipeline`; SSH's exit status comes from
    // PIPESTATUS[0] inside the function, then sync_status=$? captures the
    // wrapped function's exit. The invariant: tee/grep must not mask SSH
    // failures.
    expect(src).toMatch(/_torque_remote_sync_pipeline\(\)\s*\{[\s\S]*?ssh "\$\{SSH_OPTS\[@\]\}" "\$SSH_USER@\$SSH_HOST"[\s\S]*?\| \(grep -v 'Unable to persist credentials\\\|credential store\\\|aka\.ms\/gcm' \|\| true\)\s*\n\s+return "\$\{PIPESTATUS\[0\]\}"/);
    expect(src).toMatch(/run_with_timeout "\$sync_timeout_secs" _torque_remote_sync_pipeline\s*\n\s+sync_status=\$\?/);
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

  it('records sync lock ownership and reaps stale locks (same-host PID-dead OR cross-host TTL)', () => {
    const src = readTorqueRemote();
    expect(src).toContain('REMOTE_SYNC_LOCK_OWNER_FILE="owner.env"');
    expect(src).toContain('write_remote_sync_lock_owner()');
    expect(src).toContain('read_remote_sync_lock_owner()');
    expect(src).toContain('remote_sync_lock_is_stale()');
    expect(src).toContain('remote_sync_lock_check_owner_block()');
    // Same-host PID-dead branch.
    expect(src).toContain('owner_host="$(owner_field "$owner" host | tr');
    expect(src).toContain('owner_pid="$(owner_field "$owner" pid)"');
    expect(src).toContain('"$owner_host" == "$local_host"');
    expect(src).toContain('kill -0 "$owner_pid"');
    // TTL-based cross-host reap (batch-2 #2).
    expect(src).toContain('TORQUE_REMOTE_SYNC_LOCK_TTL_SECS:-14400');
    expect(src).toContain('exceeded TTL');
    // Reap command shape.
    expect(src).toContain('rmdir /s /q \\"$REMOTE_SYNC_LOCK_DIR\\"');
    expect(src).not.toContain('rmdir "$REMOTE_SYNC_LOCK_DIR"');
  });

  it('strips trailing whitespace from owner.env field values so the host check matches', () => {
    // CMD's `echo X>file` writes a trailing space before the newline,
    // so owner.env values read back with a literal trailing space.
    // Without stripping, the owner_host == local_host comparison in
    // remote_sync_lock_is_stale always fails and the auto-reap path
    // never fires for crashed sessions. Verified live 2026-04-29 via
    // certutil hex dump of a CMD-echoed file: the bytes were
    // `<value>\\x20\\x0D\\x0A`.
    const src = readTorqueRemote();
    expect(src).toMatch(/owner_field\s*\(\)\s*\{[\s\S]*?sed 's\/\[\[:space:\]\]\*\$\/\/'/);
  });

  it('exposes build_remote_sync_command as a discrete helper so the assembled CMD line can be unit-tested', () => {
    // Until 2026-05-07, the sync command was built inline as a single
    // long string with `${VAR}` interpolation. Two regressions hit
    // production undetected: (a) `git clean -fdx` (the -x flag wiped
    // node_modules every sync), (b) bare `if not exist X (block)` without
    // outer parens swallowed the trailing `&& chain` for 3 days. Both
    // would have been caught by a unit test against the assembled string.
    // Closes torque-remote.md open question #7.
    const src = readTorqueRemote();
    expect(src).toMatch(/^build_remote_sync_command\(\)\s*\{/m);
  });
});

describe('build_remote_sync_command runtime invariants', () => {
  // Source the bash script and invoke build_remote_sync_command with synthetic
  // inputs so the actual assembled string can be asserted against. This is
  // the unit test that closes torque-remote.md open question #7.
  function buildSyncCommand({ effPath, fetchCmd, syncCheckout, syncRef, bootstrap = '' }) {
    // Source the function out of the real script. To avoid running the
    // script's main flow, define dummy `trap_chain_add` etc. before sourcing.
    // Simplest: extract just the function definition via a sed range and
    // source that.
    const src = readTorqueRemote();
    const startMatch = src.match(/^build_remote_sync_command\(\)\s*\{[\s\S]*?\n\}/m);
    if (!startMatch) {
      throw new Error('build_remote_sync_command not found in torque-remote source');
    }
    const stdout = execFileSync('bash', ['-c', `${startMatch[0]}; build_remote_sync_command "$1" "$2" "$3" "$4" "$5"`,
      '_', effPath, fetchCmd, syncCheckout, syncRef, bootstrap], { encoding: 'utf8' });
    return stdout;
  }

  const fixture = {
    effPath: 'C:\\trt\\torque-public',
    fetchCmd: 'git fetch --prune origin +refs/heads/main:refs/remotes/origin/main',
    syncCheckout: 'git checkout --force --detach origin/main',
    syncRef: 'origin/main',
    bootstrap: '',
  };

  it('uses git clean -fd (NOT -fdx) so node_modules is preserved across syncs', () => {
    // 2026-04-27 regression: -fdx wiped node_modules every sync, costing
    // ~15s per cutover under Defender re-scan + forced operators to
    // re-`npm install` between every sync.
    const cmd = buildSyncCommand(fixture);
    expect(cmd).toContain('git clean -fd');
    expect(cmd).not.toMatch(/git clean -[a-z]*x/);
  });

  it('emits drift detection with exit 99', () => {
    const cmd = buildSyncCommand(fixture);
    expect(cmd).toContain('git diff --quiet HEAD');
    expect(cmd).toContain('exit 99');
    expect(cmd).toContain('drift after reset');
  });

  it('chains fetch → checkout → reset in that exact order with && between', () => {
    const cmd = buildSyncCommand(fixture);
    const fetchIdx = cmd.indexOf(fixture.fetchCmd);
    const checkoutIdx = cmd.indexOf(fixture.syncCheckout);
    const resetIdx = cmd.indexOf(`git reset --hard ${fixture.syncRef}`);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(checkoutIdx).toBeGreaterThan(fetchIdx);
    expect(resetIdx).toBeGreaterThan(checkoutIdx);
    expect(cmd).toContain(`${fixture.fetchCmd} && ${fixture.syncCheckout} && git reset --hard ${fixture.syncRef}`);
  });

  it('wraps every if-not-exist block in outer parens so the && chain survives a false condition', () => {
    // 2026-04-29 regression: a bare `if X (block) && rest` form had CMD
    // skip `rest` when X was false. The fix was to wrap the if in an
    // additional set of parens. ALL if-not-exist blocks in the assembled
    // command must follow the `(if not exist ...)` shape — count the
    // occurrences of the outer-paren pattern and ensure no bare ones
    // exist.
    const cmd = buildSyncCommand(fixture);
    // The npm-install hints (3 of them) all use this shape.
    const wrappedHints = cmd.match(/\(if exist [^)]+if not exist [^)]+echo[^)]+\)/g) || [];
    expect(wrappedHints.length).toBe(3);
    // Negative: there should be no `&& if exist` (un-wrapped) anywhere
    // outside the parenthesized wrappers.
    expect(cmd).not.toMatch(/&&\s+if (?:not )?exist /);
  });

  it('escapes nested && inside echo strings as ^&^&', () => {
    // The npm-install hint for server/dashboard echoes `cd subdir && npm install`.
    // Inside the SSH-CMD line, the literal `&&` must be escaped `^&^&` so
    // CMD doesn't interpret it as a command separator.
    const cmd = buildSyncCommand(fixture);
    expect(cmd).toContain('cd server ^&^& npm install');
    expect(cmd).toContain('cd dashboard ^&^& npm install');
  });

  it('honors a non-empty SYNC_BOOTSTRAP prefix when a worktree path differs from the project path', () => {
    const cmd = buildSyncCommand({
      ...fixture,
      bootstrap: 'BOOTSTRAP_PREFIX_HERE && ',
    });
    expect(cmd.startsWith('BOOTSTRAP_PREFIX_HERE && cd ')).toBe(true);
  });

  it('cd-s into the effective remote project path before any git operation', () => {
    const cmd = buildSyncCommand(fixture);
    const cdIdx = cmd.indexOf(`cd "${fixture.effPath}"`);
    const fetchIdx = cmd.indexOf(fixture.fetchCmd);
    expect(cdIdx).toBeGreaterThan(-1);
    expect(cdIdx).toBeLessThan(fetchIdx);
  });
});
