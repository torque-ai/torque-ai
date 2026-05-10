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
const { spawnSync } = require('child_process');

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
    expect(src).toMatch(/local_head_short="\$\(echo "\$local_head_sha" \| cut -c1-12\)"/);
    expect(src).toMatch(/staging_branch="pre-push-gate\/\$\{local_head_short\}-\$hook_run_id"/);
    expect(src).toMatch(/git\s+push\s+[^\n]*origin\s+"?\$(?:\{)?local_head_sha(?:\})?"?:refs\/heads\/\$(?:\{)?staging_branch/);
  });

  it('runs a local detached-worktree gate when remote staging is unavailable', () => {
    const src = readHook();
    expect(src).toMatch(/staging_ref_created=0/);
    expect(src).toMatch(/failed to stage HEAD at origin\/\$staging_branch; running the gate locally instead/);
    expect(src).not.toContain('aborting before tests');
    expect(src).toMatch(/prepare_local_gate_worktree\s*\(\)/);
    expect(src).toMatch(/git worktree add --force --detach "\$local_gate_worktree" "\$local_head_sha"/);
    expect(src).toMatch(/run_local_gate "\$remote_gate_cmd"/);
    expect(src).toMatch(/TORQUE_REMOTE_TRANSPORT=local TORQUE_REMOTE_PROJECT_PATH=\$worktree_q TORQUE_REMOTE_BASE_PROJECT_PATH=\$base_q bash -c \$gate_cmd_q/);
    expect(src).toMatch(/cleanup_local_gate_worktree\s*\|\| true/);
  });

  it('falls back locally when the remote gate exits before producing a gate marker', () => {
    const src = readHook();
    expect(src).toMatch(/Remote gate did not produce a gate-end marker; running the gate locally instead/);
    expect(src).toMatch(/if ! extract_gate_end_marker "\$RETRIED_OUTPUT" >\/dev\/null; then/);
    expect(src).toMatch(/Gate did not produce completion marker/);
  });

  it('invokes torque-remote with --branch $staging_branch and exercises selected gate phases', () => {
    const src = readHook();
    // Both suites (dashboard + server) must run against the staged ref,
    // not the local HEAD or origin/main. The current architecture runs
    // test phases and perf inside a single torque-remote SSH session (one
    // sync), so the --branch invocation appears once but the remote script
    // must reference dashboard, server, and perf commands.
    expect(src).toMatch(/run_with_flake_retry "Remote gate" "TORQUE_REMOTE_REQUIRE_REMOTE=1 \$TORQUE_REMOTE_CMD --suite \$GATE_COORD_SUITE --branch \$staging_branch/);
    expect(src).toMatch(/run_vitest_phase dashboard run/);
    expect(src).toMatch(/run_vitest_phase server run/);
    expect(src).toMatch(/cd\s+server\s+&&\s+node\s+perf\/run-perf\.js/);
  });

  it('runs the remote gate in a dedicated checkout suffix and bootstraps first-use deps', () => {
    const src = readHook();
    expect(src).toMatch(/remote_gate_worktree_suffix="\$\{PRE_PUSH_REMOTE_GATE_WORKTREE_SUFFIX--pre-push-gate\}"/);
    expect(src).toMatch(/TORQUE_REMOTE_TEST_WORKTREE_SUFFIX="\$remote_gate_worktree_suffix"/);
    expect(src).toMatch(/PRE_PUSH_REMOTE_GATE_WORKTREE_SUFFIX contains unsafe characters/);
    expect(src).toMatch(/ensure_node_modules\s*\(\)/);
    expect(src).toMatch(/local phase="\\\$1"/);
    expect(src).toMatch(/local dir="\\\$2"/);
    expect(src).toMatch(/local dir="\\\$1"/);
    expect(src).toMatch(/local modules_dir="\\\$1"/);
    expect(src).toMatch(/modules_dir="\\\$\(cd "\\\$modules_dir" && pwd -P\)"/);
    expect(src).toMatch(/run_vitest_phase\s*\(\)/);
    expect(src).toMatch(/node_modules\/vitest\/vitest\.mjs/);
    expect(src).toMatch(/ensure_node_modules dash dashboard/);
    expect(src).toMatch(/ensure_node_modules serv server/);
    expect(src).toMatch(/\[\\\$phase\] \[setup\]/);
    expect(src).toContain('timeout ${PHASE_TIMEOUT_SECS} bash -c');
    expect(src).not.toContain('timeout ${PHASE_TIMEOUT_SECS} bash -lc');
    expect(src).toMatch(/gate_now_ms\s*\(\)/);
    expect(src).toMatch(/elapsed_ms\s*\(\)/);
    expect(src).toMatch(/\[gate-timing\] remote_start_ms=/);
    expect(src).toMatch(/\[gate-timing\] setup_ms=/);
    expect(src).toMatch(/\[gate-timing\] dash_ms=/);
    expect(src).toMatch(/\[gate-timing\] serv_ms=/);
    expect(src).toMatch(/\[gate-timing\] perf_ms=/);
    expect(src).toMatch(/\[gate-timing\] total_ms=/);
    expect(src).toMatch(/dependency_tree_ok\s*\(\)/);
    expect(src).toMatch(/better-sqlite3/);
    expect(src).toMatch(/web-tree-sitter/);
    expect(src).toMatch(/tree-sitter-wasms/);
    expect(src).toMatch(/timeout 20 mv/);
    expect(src).toMatch(/invalid dependency tree/);
    expect(src).toMatch(/reuse_base_node_modules\s*\(\)/);
    expect(src).toMatch(/TORQUE_REMOTE_BASE_PROJECT_PATH/);
    expect(src).not.toMatch(/mklink \/J/);
    expect(src).not.toMatch(/New-Item -ItemType Junction/);
    expect(src).toMatch(/mklink \/D/);
    expect(src).toMatch(/New-Item -ItemType SymbolicLink/);
    expect(src).toMatch(/could not create a safe symlink for \\\$dir\/node_modules quickly/);
    expect(src).toMatch(/using \\\$dir dependencies from safe base symlink/);
    expect(src).toMatch(/could not verify \\\$dir dependencies through safe base symlink/);
    expect(src).toMatch(/npm install --no-audit --no-fund --prefer-offline/);
    expect(src).toMatch(/dependencies still invalid after install/);
    expect(src).toMatch(/run_vitest_phase dashboard run/);
    expect(src).toMatch(/run_vitest_phase server run/);
  });

  it('runs dashboard and server sequentially when the gate falls back locally', () => {
    const src = readHook();
    expect(src).toMatch(/is_local_gate_transport\s*\(\)/);
    expect(src).toContain('case "\\${TORQUE_REMOTE_TRANSPORT:-ssh}" in');
    expect(src).toContain('[gate] local transport detected; running dashboard/server phases sequentially');
    expect(src).toMatch(/if is_local_gate_transport; then[\s\S]*run_dashboard_phase[\s\S]*run_server_phase[\s\S]*else[\s\S]*run_dashboard_phase &[\s\S]*run_server_phase &/);
  });

  it('labels expected fixture stderr while preserving timing markers', () => {
    const src = readHook();
    expect(src).toMatch(/is_expected_gate_fixture_line\s*\(\)/);
    expect(src).toMatch(/is_expected_gate_cmd_fixture_line\s*\(\)/);
    expect(src).toMatch(/strip_gate_progress_prefix\s*\(\)/);
    expect(src).toMatch(/prefix_gate_phase_output\s*\(\)/);
    expect(src).toContain('[expected-test-output]');
    expect(src).toContain('"fatal: not a git repository (or any of the parent directories): .git")');
    expect(src).toContain('"\'Get-Content\' is not recognized as an internal or external command,")');
    expect(src).toContain('Dashboard API error: Invalid JSON body');
    expect(src).toContain('[ "\\$normalized_line" = "operable program or batch file." ]');
    expect(src).toMatch(/"\[gate-timing\]"\*\)[\s\S]*printf '%s\\n'/);
    expect(src).toMatch(/run_dashboard_phase\s*\(\)[\s\S]*prefix_gate_phase_output dash/);
    expect(src).toMatch(/run_server_phase\s*\(\)[\s\S]*prefix_gate_phase_output serv/);
    expect(src).toMatch(/run_dashboard_phase &/);
    expect(src).toMatch(/run_server_phase &/);
    expect(src).toMatch(/\} 2>&1 \| prefix_gate_phase_output perf/);
  });

  it('classifies live gate fixture noise with vitest dots and CRLF endings', () => {
    const bashCheck = spawnSync('bash', ['--version'], { encoding: 'utf8' });
    if (bashCheck.error || bashCheck.status !== 0) return;

    const src = readHook();
    const start = src.indexOf('strip_gate_progress_prefix() {');
    const end = src.indexOf('# Sweep stale torque-* test temp dirs', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const helperBlock = src.slice(start, end).replace(/\\\$/g, '$');
    const script = `${helperBlock}
printf '[gate-timing] dash_ms=1 exit=0\\n' | prefix_gate_phase_output serv
printf '%b' "\\302\\267\\302\\267'Get-Content' is not recognized as an internal or external command,\\r\\n\\302\\267\\302\\267operable program or batch file.\\r\\n" | prefix_gate_phase_output serv
printf '%b' "\\302\\267\\302\\267err msg\\302\\267\\302\\267\\n" | prefix_gate_phase_output serv
printf '%b' "\\302\\267\\302\\267hint:\\r\\n" | prefix_gate_phase_output serv
printf '%b' "\\302\\267\\302\\267real failure line\\302\\267\\302\\267\\n" | prefix_gate_phase_output serv
`;

    const result = spawnSync('bash', ['-s'], { encoding: 'utf8', input: script });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[gate-timing] dash_ms=1 exit=0');
    expect(result.stdout).toContain("[serv] [expected-test-output] 'Get-Content' is not recognized as an internal or external command,");
    expect(result.stdout).toContain('[serv] [expected-test-output] operable program or batch file.');
    expect(result.stdout).toContain('[serv] [expected-test-output] err msg');
    expect(result.stdout).toContain('[serv] [expected-test-output] hint:');
    expect(result.stdout).toContain('real failure line');
    expect(result.stdout).not.toContain('[expected-test-output] real failure line');
  });

  it('passes a plan-specific gate suite to torque-remote so coord serializes and caches correctly', () => {
    const src = readHook();
    // The suite name includes the conservative gate plan hash. Without it,
    // a warm result from a docs-only or affected-test run could be replayed
    // for a later full-gate override against the same commit.
    expect(src).toMatch(/GATE_COORD_SUITE/);
    expect(src).toMatch(/\$TORQUE_REMOTE_CMD --suite \$GATE_COORD_SUITE --branch \$staging_branch/);
    expect(src).not.toMatch(/PERF_OUT=\$\("\$TORQUE_REMOTE_BIN" --suite gate/);
  });

  it('prefers the repo-local bin directory before invoking torque-remote', () => {
    const src = readHook();
    expect(src).toMatch(/REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/);
    expect(src).toMatch(/unset \$\(git rev-parse --local-env-vars\)/);
    expect(src).toMatch(/cd "\$REPO_ROOT"/);
    expect(src).toMatch(/PATH="\$REPO_ROOT\/bin:\$PATH"/);
    expect(src).toMatch(/export PATH/);
    expect(src).toMatch(/TORQUE_REMOTE_BIN="\$REPO_ROOT\/bin\/torque-remote"/);
    expect(src).toMatch(/TORQUE_REMOTE_CMD="\$\(printf '%q' "\$TORQUE_REMOTE_BIN"\)"/);
    expect(src).toMatch(/run_with_flake_retry "Remote gate" "TORQUE_REMOTE_REQUIRE_REMOTE=1 \$TORQUE_REMOTE_CMD --suite \$GATE_COORD_SUITE/);
    expect(src).toContain('Pre-push owns the local fallback path so the gate runs once.');
  });

  it('uses a conservative changed-file gate planner before remote execution', () => {
    const src = readHook();
    expect(src).toMatch(/scripts\/pre-push-gate-plan\.js/);
    expect(src).toMatch(/Gate phases: dashboard=\$GATE_RUN_DASHBOARD server=\$GATE_RUN_SERVER perf=\$GATE_RUN_PERF audit=\$GATE_RUN_AUDIT/);
    expect(src).toMatch(/PRE_PUSH_FORCE_FULL/);
    expect(src).toMatch(/Heavy remote gate skipped by gate plan/);
  });

  it('serializes main gates with the shared coordination lock and cleans up on EXIT', () => {
    const src = readHook();
    expect(src).toMatch(/DEFAULT_COORD_LOCK_HELPER="\$\{REPO_ROOT\}\/scripts\/repo-coordination-lock\.sh"/);
    expect(src).toMatch(/COORD_LOCK_HELPER="\$\{TORQUE_COORD_LOCK_HELPER:-\$DEFAULT_COORD_LOCK_HELPER\}"/);
    expect(src).toMatch(/COORD_LOCK_HELPER="\$DEFAULT_COORD_LOCK_HELPER"/);
    expect(src).toMatch(/source "\$COORD_LOCK_HELPER"/);
    expect(src).toMatch(/repo_coord_lock_acquire "main" "pre-push main gate:/);
    expect(src).toMatch(/pre_push_cleanup\s*\(\)/);
    expect(src).toMatch(/delete_staging_ref \|\| true/);
    expect(src).toMatch(/REPO_COORD_LOCK_FORCE_RELEASE=1 repo_coord_lock_release \|\| true/);
    expect(src).toMatch(/trap pre_push_cleanup EXIT/);
    expect(src).toMatch(/cleanup_abandoned_staging_refs "\$local_head_short"/);
    expect(src).toMatch(/git_cleanup_timeout\s+ls-remote\s+--heads\s+origin\s+'pre-push-gate\/\*'/);
    expect(src).toMatch(/PRE_PUSH_STAGING_REF_STALE_SECS:-7200/);
    expect(src).toMatch(/Cleaning abandoned staging ref origin\/\$branch/);
    expect(src).not.toMatch(/trap\s+'delete_staging_ref'\s+EXIT/);
    expect(src).toMatch(/git_cleanup_timeout\s*\(\)/);
    expect(src).toMatch(/PRE_PUSH_STAGING_CLEANUP_TIMEOUT_SECS:-30/);
    expect(src).toMatch(/git_cleanup_timeout\s+push\s+[^\n]*--delete\s+"?\$(?:\{)?staging_branch/);
    expect(src).toMatch(/git_cleanup_timeout\s+ls-remote\s+--exit-code\s+--heads\s+origin\s+"\$staging_branch"/);
    expect(src).toMatch(/git_cleanup_timeout\s+push\s+--no-verify\s+--quiet\s+origin\s+":refs\/heads\/\$staging_branch"/);
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
    expect(src).toMatch(/\brun_with_flake_retry_streaming\s*\(\)/);
  });

  it('parses the final anchored gate-end marker instead of grepping all captured output', () => {
    const src = readHook();
    const helper = src.match(/extract_gate_end_marker\s*\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(helper).toContain('"[gate-end] dash_exit="*) marker="$line" ;;');
    expect(helper).toContain('parse_gate_end_exits "$marker" >/dev/null');
    expect(src).toMatch(/\bgate_marker_value\s*\(\)/);
    expect(src).toMatch(/\bparse_gate_end_exits\s*\(\)/);
    expect(src).toMatch(/gate_exits=\$\(parse_gate_end_exits "\$gate_end_marker"\)/);
    expect(src).not.toContain('BASH_REMATCH');
    expect(src).not.toMatch(/\[\[ "\$gate_end_marker" =~/);
    expect(src).toMatch(/gate_end_marker=\$\(extract_gate_end_marker "\$combined_output"\)/);
    expect(src).not.toMatch(/echo "\$combined_output" \| grep -qE '\\\[gate-end\\\] dash_exit=\[0-9\]'/);
  });

  it('executes gate-end marker parsing without bash regex captures', () => {
    const bashCheck = spawnSync('bash', ['--version'], { encoding: 'utf8' });
    if (bashCheck.error || bashCheck.status !== 0) return;

    const src = readHook();
    const start = src.indexOf('gate_marker_value() {');
    const end = src.indexOf('# Per-phase timeout caps pathological SSH stalls.', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const helperBlock = src.slice(start, end);
    const script = `${helperBlock}
set -euo pipefail
marker=$(extract_gate_end_marker $'noise\\n[gate-end] dash_exit=0 serv_exit=12 perf_exit=3\\r\\n')
[ "$marker" = "[gate-end] dash_exit=0 serv_exit=12 perf_exit=3" ]
exits=$(parse_gate_end_exits "$marker")
[ "$exits" = "0 12 3" ]
if extract_gate_end_marker $'[gate-end] dash_exit=0 serv_exit=x perf_exit=0' >/dev/null; then
  exit 12
fi
if ! gate_marker_has_failure $'[gate-end] dash_exit=0 serv_exit=12 perf_exit=0'; then
  exit 13
fi
if gate_marker_has_failure $'[gate-end] dash_exit=0 serv_exit=0 perf_exit=0'; then
  exit 14
fi
`;

    const result = spawnSync('bash', ['-s'], { encoding: 'utf8', input: script });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('bounds the pre-push output streamer after the remote gate command exits', () => {
    const src = readHook();
    const helper = src.match(/run_with_flake_retry_inner\s*\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(helper).toMatch(/tail -f --pid="\$cmd_pid" "\$tmp" &/);
    expect(helper).toMatch(/kill "\$tail_pid" 2>\/dev\/null \|\| true/);
    expect(helper).toMatch(/wait "\$tail_pid" 2>\/dev\/null \|\| true/);
  });

  it('uses synchronous streaming capture for direct local gates', () => {
    const src = readHook();
    const helper = src.match(/run_with_flake_retry_inner_streaming\s*\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(helper).toMatch(/eval "\$cmd" 2>&1 \| tee "\$tmp"/);
    expect(helper).toContain('RETRIED_EXIT="$cmd_status"');
    expect(src).toMatch(/run_with_flake_retry_with_runner "\$1" "\$2" run_with_flake_retry_inner_streaming/);
    expect(src).toMatch(/run_with_flake_retry_streaming "Local gate"/);
    expect(src).toContain('Local gates must not use the SSH tail-by-pid capture wrapper.');
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

  it('sets the per-phase timeout default high enough for the current server suite', () => {
    // Default lifted from 600s → 1800s on 2026-04-29 after the
    // factory-coordination batch grew the server suite past 600s. Symptom:
    // [gate-end] dash_exit=0 serv_exit=1 with no vitest summary, output cut
    // mid-test — `timeout` killed vitest before the heredoc's `echo $?`
    // could write SERV_EXIT_FILE, so the missing-file fallback wrote "1".
    // Don't drop below 1800 without measuring; suite duration is monotonic
    // upward as features land, and a too-tight default produces a
    // failure shape that masquerades as a real test regression.
    const src = readHook();
    expect(src).toMatch(/PRE_PUSH_PHASE_TIMEOUT_SECS:-1800/);
    expect(src).not.toMatch(/PRE_PUSH_PHASE_TIMEOUT_SECS:-600/);
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

  it('keys coord cache by resolved commit sha instead of the ephemeral staging branch name', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/resolve_coord_sha\s*\(\)/);
    expect(src).toMatch(/TORQUE_REMOTE_COORD_SHA/);
    expect(src).toMatch(/git\s+ls-remote\s+--heads\s+origin\s+"\$BRANCH_OVERRIDE"/);
    expect(src).toMatch(/COORD_SHA="\$\(resolve_coord_sha\)"/);
  });

  it('supports a validated per-invocation test worktree suffix', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/TORQUE_REMOTE_TEST_WORKTREE_SUFFIX/);
    expect(src).toMatch(/\^\[a-zA-Z0-9_\.-\]\+\$/);
    expect(src).toMatch(/REMOTE_TEST_WORKTREE_SUFFIX="\$TORQUE_REMOTE_TEST_WORKTREE_SUFFIX"/);
    expect(src).toMatch(/BASE_EFFECTIVE_REMOTE_PROJECT_PATH="\$EFFECTIVE_REMOTE_PROJECT_PATH"/);
    expect(src).toMatch(/EFFECTIVE_REMOTE_PROJECT_PATH="\$\{EFFECTIVE_REMOTE_PROJECT_PATH\}\$\{REMOTE_TEST_WORKTREE_SUFFIX\}"/);
    expect(src).toMatch(/TORQUE_REMOTE_BASE_PROJECT_PATH=\$\(shell_quote "\$BASE_EFFECTIVE_REMOTE_PROJECT_PATH"\)/);
    expect(src).toMatch(/export TORQUE_REMOTE_BASE_PROJECT_PATH/);
    expect(src).toContain('export TORQUE_REMOTE_TRANSPORT="local"');
    expect(src).toContain('TORQUE_REMOTE_TRANSPORT="ssh"');
    expect(src).toContain('export TORQUE_REMOTE_TRANSPORT');
  });

  it('bounds torque-remote output streamers after local or ssh commands exit', () => {
    const src = readTorqueRemote();
    const killCount = (src.match(/kill "\$tail_pid" 2>\/dev\/null \|\| true/g) || []).length;
    expect(killCount).toBeGreaterThanOrEqual(2);
    expect(src).toContain('scp -q "${SSH_OPTS[@]}" "$LOCAL_STATE_BUNDLE"');
    expect(src).toContain('EncodedCommand');
    expect(src).not.toContain('tar -xf - -C \\$d');
    expect(src).toContain('bash "$SCRIPT_DIR/runner.sh" >"$out" 2>&1 </dev/null &');
    expect(src).toContain('tail -n +1 -f "$out" &');
    expect(src).toContain('rm -rf "$SCRIPT_DIR" >/dev/null 2>&1 </dev/null &');
    expect(src).toContain('Windows OpenSSH + Git Bash can leave stdin');
  });

  it('materializes long bash -c payloads before local fallback execution', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/materialize_local_bash_c_command\s*\(\)/);
    expect(src).toMatch(/TORQUE_REMOTE_LOCAL_BASH_C_SCRIPT_THRESHOLD:-2000/);
    expect(src).toContain('printf \'%s\\n\' "$payload" > "$LOCAL_COMMAND_SCRIPT"');
    expect(src).toContain('LOCAL_COMMAND_ARGS=(bash "$LOCAL_COMMAND_SCRIPT")');
    expect(src).toMatch(/run_local_command_in_root\s*\(\)\s*\{[\s\S]*materialize_local_bash_c_command[\s\S]*"\$\{LOCAL_COMMAND_ARGS\[@\]\}"/);
    expect(src).toMatch(/run_ssh_fallback_locally\s*\(\)\s*\{[\s\S]*prepare_local_execution_root[\s\S]*run_local_command_in_root/);
    expect(src).toMatch(/local\)[\s\S]*prepare_local_execution_root[\s\S]*run_local_command_in_root/);
    expect(src).toMatch(/cleanup_materialized_local_command\s*\(\)/);
  });

  it('runs --branch local fallback in a detached temporary worktree', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/prepare_local_execution_root\s*\(\)/);
    expect(src).toContain('git -C "$PROJECT_ROOT" fetch --prune origin "+refs/heads/$BRANCH_OVERRIDE:refs/remotes/origin/$BRANCH_OVERRIDE"');
    expect(src).toContain('git -C "$PROJECT_ROOT" worktree add --force --detach "$worktree_path" "$sync_ref"');
    expect(src).toContain('git -C "$PROJECT_ROOT" worktree remove --force "$path"');
    expect(src).toContain('export TORQUE_REMOTE_PROJECT_PATH="$execution_root"');
    expect(src).toContain('export TORQUE_REMOTE_BASE_PROJECT_PATH="$PROJECT_ROOT"');
  });

  it('unlinks local fallback dependency symlinks before removing the worktree', () => {
    const src = readTorqueRemote();
    const unlinkCall = src.indexOf('unlink_local_fallback_dependency_links "$path"');
    const worktreeRemove = src.indexOf('git -C "$PROJECT_ROOT" worktree remove --force "$path"');
    expect(src).toMatch(/unlink_local_fallback_dependency_links\s*\(\)/);
    expect(src).toContain('"$path/server/node_modules" "$path/dashboard/node_modules"');
    expect(src).toMatch(/\[\[ -L "\$dependency_link" \]\]/);
    expect(src).toContain('Remove-Item -LiteralPath $p -Force');
    expect(unlinkCall).toBeGreaterThanOrEqual(0);
    expect(worktreeRemove).toBeGreaterThan(unlinkCall);
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

  it('documents --install/--no-install usage and defaults installs on', () => {
    // Default flipped to install-on so worktrees are immediately usable for
    // tests/builds; opt-out with --no-install for docs-only worktrees.
    // See CLAUDE.md "During Development" section.
    const src = readCreate();
    expect(src).toMatch(/Usage: scripts\/worktree-create\.sh <feature-name> \[--install\|--no-install\]/);
    expect(src).toMatch(/INSTALL_DEPS="true"/);
    expect(src).toMatch(/--no-install/);
  });

  it('runs install when INSTALL_DEPS is true (default) and skips otherwise', () => {
    const src = readCreate();
    expect(src).toMatch(/install_worktree_dependencies\s*\(\)/);
    expect(src).toMatch(/if \[\[ "\$INSTALL_DEPS" == "true" \]\]; then[\s\S]*install_worktree_dependencies "\$WORKTREE_DIR"/);
  });
});
