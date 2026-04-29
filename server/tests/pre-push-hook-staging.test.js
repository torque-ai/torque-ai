'use strict';

// Regression guard for the pre-push hook's staging-branch design.
//
// The hook was rewritten 2026-04-21 so that the main-branch gate stages
// the local HEAD on a disposable `pre-push-gate/<sha>` ref instead of
// pushing to origin/main up-front. The previous "push-first, test, roll
// back on failure" pattern produced a confusing `[remote rejected]` tail
// on every successful push (CAS mismatch between outer `git push`'s
// expected_sha and the post-hook remote state) and a non-zero exit code
// that broke scripts doing `git push && …`.
//
// These assertions are purely source-level so they run in a millisecond
// and catch regressions from anyone who reaches for the old rollback
// pattern without reading this comment.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'scripts', 'pre-push-hook');

function readHook() {
  return fs.readFileSync(HOOK_PATH, 'utf8');
}

function readTorqueRemote() {
  return fs.readFileSync(path.join(REPO_ROOT, 'bin', 'torque-remote'), 'utf8');
}

describe('pre-push-hook staging-branch invariants', () => {
  it('does not push HEAD directly to refs/heads/main for the gate', () => {
    const src = readHook();
    // Old pattern: `git push --no-verify origin HEAD:refs/heads/main` before
    // tests ran. That line is the root cause of the CAS-mismatch tail.
    expect(src).not.toMatch(/git\s+push\s+(?:--no-verify\s+)?origin\s+HEAD:refs\/heads\/main\b/);
  });

  it('does not define a rollback_origin_main helper', () => {
    const src = readHook();
    // The rollback helper existed only because the hook was mutating
    // origin/main pre-test. With staging, there is nothing to roll back.
    expect(src).not.toMatch(/\brollback_origin_main\b/);
  });

  it('does not force-push previous_sha back onto origin/main on failure', () => {
    const src = readHook();
    expect(src).not.toMatch(/--force\s+origin\s+"?\$(?:\{)?previous_sha(?:\})?"?:refs\/heads\/main/);
  });

  it('stages HEAD on a pre-push-gate/<sha> branch', () => {
    const src = readHook();
    expect(src).toMatch(/staging_branch="pre-push-gate\//);
    expect(src).toMatch(/hook_run_id="\$\(date \+%s 2>\/dev\/null \|\| echo time\)-\$\$"/);
    expect(src).toMatch(/staging_branch="pre-push-gate\/\$\(echo "\$local_head_sha" \| cut -c1-12\)-\$hook_run_id"/);
    expect(src).toMatch(/git\s+push\s+[^\n]*origin\s+"?\$(?:\{)?local_head_sha(?:\})?"?:refs\/heads\/\$(?:\{)?staging_branch/);
  });

  it('invokes torque-remote with --branch $staging_branch and exercises both suites', () => {
    const src = readHook();
    // Both suites (dashboard + server) must run against the staged ref,
    // not the local HEAD or origin/main. The current architecture runs
    // both phases inside a single torque-remote SSH session (one sync,
    // parallel jobs), so the --branch invocation appears once but the
    // remote script must reference both `cd dashboard` and `cd server`.
    expect(src).toMatch(/run_with_flake_retry "Test gate" "\$TORQUE_REMOTE_CMD --suite gate --branch \$staging_branch/);
    expect(src).toMatch(/cd\s+dashboard\s+&&\s+npx\s+vitest\s+run/);
    expect(src).toMatch(/cd\s+server\s+&&\s+npx\s+vitest\s+run/);
  });

  it('passes --suite gate to torque-remote so coord serializes the gate', () => {
    const src = readHook();
    // The unified parallel gate (test + perf inside one torque-remote SSH
    // session, see "Three phases run inside ONE torque-remote SSH session")
    // must opt into coord coordination via --suite gate. Without it,
    // torque-remote defaults to "custom" and skips the daemon — so two
    // concurrent main pushes would race on the workstation as before.
    expect(src).toMatch(/\$TORQUE_REMOTE_CMD --suite gate --branch \$staging_branch/);
    expect(src).toMatch(/"\$TORQUE_REMOTE_BIN" --suite gate --branch "\$staging_branch"/);
  });

  it('prefers the repo-local bin directory before invoking torque-remote', () => {
    const src = readHook();
    expect(src).toMatch(/REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/);
    expect(src).toMatch(/PATH="\$REPO_ROOT\/bin:\$PATH"/);
    expect(src).toMatch(/export PATH/);
    expect(src).toMatch(/TORQUE_REMOTE_BIN="\$REPO_ROOT\/bin\/torque-remote"/);
    expect(src).toMatch(/TORQUE_REMOTE_CMD="\$\(printf '%q' "\$TORQUE_REMOTE_BIN"\)"/);
    expect(src).toMatch(/run_with_flake_retry "Test gate" "\$TORQUE_REMOTE_CMD --suite gate/);
    expect(src).toMatch(/PERF_OUT=\$\("\$TORQUE_REMOTE_BIN" --suite gate/);
  });

  it('installs an EXIT trap that deletes the staging ref', () => {
    const src = readHook();
    expect(src).toMatch(/trap\s+'delete_staging_ref'\s+EXIT/);
    expect(src).toMatch(/git\s+push\s+[^\n]*--delete\s+"?\$(?:\{)?staging_branch/);
  });

  it('exits 1 on test failure with a clear "origin/main is unchanged" message', () => {
    const src = readHook();
    expect(src).toMatch(/origin\/main is unchanged/);
  });

  it('preserves the file-load flake retry + vitest-failure-detection helpers', () => {
    const src = readHook();
    // These helpers are the load-bearing parts of the gate. The staging
    // rewrite only changes WHERE tests run, not WHAT counts as a failure.
    expect(src).toMatch(/\btests_have_failures\s*\(\)/);
    expect(src).toMatch(/\bis_file_load_only_flake\s*\(\)/);
    expect(src).toMatch(/\brun_with_flake_retry\s*\(\)/);
  });

  it('blocks instead of retrying when torque-remote detects concurrent worktree contamination', () => {
    const src = readHook();
    expect(src).toMatch(/\bis_remote_worktree_contamination\s*\(\)/);
    expect(src).toMatch(/remote worktree contamination detected/);
    expect(src).toMatch(/concurrent torque-remote session likely clobbered the checkout/);
    expect(src).toMatch(/blocking this push/);
    expect(src).toMatch(/RETRIED_EXIT=98/);
    expect(src).not.toMatch(/PRE_PUSH_REMOTE_CONTAMINATION_RETRY_DELAY_SECS/);
  });

  it('strips ANSI codes before matching vitest summary lines', () => {
    const src = readHook();
    // vitest emits ANSI colors under --reporter=dot, making the `^` anchor
    // miss lines that start with ESC [ … m. 2026-04-21 observed a
    // "Test Files 5 failed" run silently fall through to BLOCKED without
    // the retry ever firing, because is_file_load_only_flake didn't see
    // the plain-text "Test Files" prefix. Guard that strip_ansi is wired
    // into both failure predicates.
    expect(src).toMatch(/\bstrip_ansi\s*\(\)/);
    // Both helpers must pipe through strip_ansi before grep — otherwise
    // the match regex fails on the ESC prefix.
    const failuresHelper = src.match(/tests_have_failures\s*\(\)\s*\{[\s\S]*?\n\}/);
    const flakeHelper = src.match(/is_file_load_only_flake\s*\(\)\s*\{[\s\S]*?\n\}/);
    expect(failuresHelper?.[0]).toMatch(/strip_ansi/);
    expect(flakeHelper?.[0]).toMatch(/strip_ansi/);
  });
});

describe('torque-remote staging branch validation', () => {
  it('accepts --branch refs that exist on origin before a local remote-tracking ref is fetched', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/git\s+rev-parse\s+--verify\s+"origin\/\$BRANCH_OVERRIDE"/);
    expect(src).toMatch(/git\s+ls-remote\s+--exit-code\s+--heads\s+origin\s+"\$BRANCH_OVERRIDE"/);
    expect(src).toMatch(/Branch '\$BRANCH_OVERRIDE' does not exist on origin/);
  });

  it('rejects unsafe --branch values before interpolating them into remote shell commands', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/\[\[\s+!\s+"\$BRANCH_OVERRIDE"\s+=~\s+\^\[a-zA-Z0-9_\.\/-\]\+\$\s+\]\]/);
    expect(src).toMatch(/Branch '\$BRANCH_OVERRIDE' contains unsafe characters/);
  });
});

describe('install-git-hooks.sh installer', () => {
  const installerPath = path.join(REPO_ROOT, 'scripts', 'install-git-hooks.sh');

  it('exists and is executable', () => {
    expect(fs.existsSync(installerPath)).toBe(true);
    const stat = fs.statSync(installerPath);
    // On Windows NTFS the exec bit isn't meaningful, so the stronger check
    // is that the file exists and is referenced from worktree-create.sh.
    // Node cannot reliably check POSIX mode on Windows — rely on the
    // wiring assertion below.
    expect(stat.isFile()).toBe(true);
  });

  it('uses --git-common-dir so it works from worktrees', () => {
    const src = fs.readFileSync(installerPath, 'utf8');
    expect(src).toMatch(/git\s+rev-parse\s+--git-common-dir/);
  });

  it('is idempotent (only copies when content differs)', () => {
    const src = fs.readFileSync(installerPath, 'utf8');
    // The cmp -s check is the idempotency guard — without it, every
    // worktree-create would report "installed pre-push" regardless of
    // whether anything changed.
    expect(src).toMatch(/cmp\s+-s\s+"\$src"\s+"\$dst"/);
  });

  it('is invoked by worktree-create.sh so new worktrees pick up hook updates', () => {
    const createSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'worktree-create.sh'),
      'utf8',
    );
    expect(createSrc).toMatch(/install-git-hooks\.sh/);
  });
});

describe('worktree-create dependency bootstrap', () => {
  const createPath = path.join(REPO_ROOT, 'scripts', 'worktree-create.sh');

  function readCreate() {
    return fs.readFileSync(createPath, 'utf8');
  }

  it('documents optional --install usage and defaults installs off', () => {
    const src = readCreate();
    expect(src).toMatch(/Usage: scripts\/worktree-create\.sh <feature-name> \[--install\]/);
    expect(src).toMatch(/INSTALL_DEPS="false"/);
    expect(src).toMatch(/Skipping dependency installs \(default\)/);
  });

  it('gates npm installs behind the --install flag', () => {
    const src = readCreate();
    expect(src).toMatch(/install_worktree_dependencies\s*\(\)/);
    expect(src).toMatch(/if \[\[ "\$INSTALL_DEPS" == "true" \]\]; then[\s\S]*install_worktree_dependencies "\$WORKTREE_DIR"/);
  });
});
