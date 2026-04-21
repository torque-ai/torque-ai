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
    expect(src).toMatch(/git\s+push\s+[^\n]*origin\s+"?\$(?:\{)?local_head_sha(?:\})?"?:refs\/heads\/\$(?:\{)?staging_branch/);
  });

  it('invokes torque-remote with --branch $staging_branch for both test suites', () => {
    const src = readHook();
    const matches = src.match(/torque-remote\s+--branch\s+\$(?:\{)?staging_branch/g) || [];
    // Two suites: dashboard + server. The hook must gate both on the
    // staged ref, not the local HEAD or origin/main.
    expect(matches.length).toBeGreaterThanOrEqual(2);
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
});
