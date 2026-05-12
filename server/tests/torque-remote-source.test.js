'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TORQUE_REMOTE_PATH = path.join(REPO_ROOT, 'bin', 'torque-remote');

function readTorqueRemote() {
  return fs.readFileSync(TORQUE_REMOTE_PATH, 'utf8');
}

function resolveBashForFunctionTests() {
  for (const candidate of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'bash';
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
    expect(src).toContain('Remote sync lock unavailable — falling back to local execution instead of risking remote worktree contamination');
    expect(src).toContain('record_fallback "sync_lock_timeout"');
    expect(src).toContain('if ! acquire_any_remote_lane "$LANE_COUNT" "$EXPLICIT_LANE"; then');
    expect(src).not.toContain('acquire_any_remote_lane "$LANE_COUNT" "$EXPLICIT_LANE" || true');
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
    expect(src).toContain('compute_lane_lock_dir()');
    expect(src).toContain('printf \'%s\\\\.torque-remote-lanes\\\\.locks\\\\lane-%s\\n\' "$parent" "$index"');
    expect(src).not.toContain('REMOTE_SYNC_LOCK_DIR="$EFFECTIVE_REMOTE_PROJECT_PATH\\\\.torque-remote-sync.lock"');
  });

  it('supports an ignored infrastructure-host credential file for project-local remote credentials', () => {
    const src = readTorqueRemote();
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    const hostGitignore = fs.readFileSync(path.join(REPO_ROOT, 'infrastructure', 'hosts', '.gitignore'), 'utf8');
    const docs = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'torque-remote.md'), 'utf8');

    expect(src).toContain('PROJECT_INFRA_LOCAL="$PROJECT_ROOT/infrastructure/hosts/torque-remote.local.json"');
    expect(src).toContain('apply_local_config_file "$PROJECT_INFRA_LOCAL" "project-infrastructure" 1');
    expect(src).toContain('project_infra_local=');
    expect(gitignore).toContain('infrastructure/hosts/*.local.json');
    expect(gitignore).toContain('infrastructure/hosts/**/*.local.json');
    expect(hostGitignore).toContain('*.local.json');
    expect(hostGitignore).toContain('**/*.local.json');
    expect(fs.existsSync(path.join(REPO_ROOT, 'infrastructure', 'hosts', 'torque-remote.local.json.example'))).toBe(true);
    expect(docs).toContain('<project>/infrastructure/hosts/torque-remote.local.json');
  });

  it('records sync lock ownership and reaps stale locks (same-host PID-dead OR cross-host TTL)', () => {
    const src = readTorqueRemote();
    expect(src).toContain('REMOTE_LANE_LOCK_OWNER_FILE="owner.env"');
    expect(src).toContain('write_remote_lane_lock_owner()');
    expect(src).toContain('read_remote_lane_lock_owner()');
    expect(src).toContain('remote_lane_lock_is_stale()');
    expect(src).toContain('remote_lane_lock_check_owner_block()');
    // Same-host PID-dead branch.
    expect(src).toContain('host_field="$(owner_field "$owner" host | tr');
    expect(src).toContain('pid_field="$(owner_field "$owner" pid)"');
    expect(src).toContain('"$host_field" == "$local_host"');
    expect(src).toContain('kill -0 "$pid_field"');
    // TTL-based cross-host reap (batch-2 #2).
    expect(src).toContain('TORQUE_REMOTE_SYNC_LOCK_STALE_TTL_SECS:-14400');
    expect(src).toContain('exceeded TTL');
    // Reap command shape — lock release now routes through adapter.
    // The adapter itself still emits rmdir /s /q on Windows (via $lock_dir).
    expect(src).toContain('remote_lock_release "$REMOTE_LANE_LOCK_DIR"');
    expect(src).toContain('rmdir /s /q \\"$lock_dir\\"');
    // Direct inline rmdir against $REMOTE_LANE_LOCK_DIR is gone — adapter owns it.
    expect(src).not.toContain('rmdir /s /q \\"$REMOTE_LANE_LOCK_DIR\\"');
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

// Shared helper: extract all build_remote_sync_command* function definitions
// from the source (dispatcher + _windows + _linux) so all three can be
// sourced together in each bash invocation.
//
// Each function block: starts at `^build_remote_sync_command...() {` (column 0)
// and ends at the next `^}` line. We collect all matches and join them.
function extractSyncFunctions(src) {
  const pattern = /^(build_remote_sync_command\S*\(\)\s*\{[\s\S]*?\n\})/gm;
  const fns = [];
  let m;
  while ((m = pattern.exec(src)) !== null) {
    fns.push(m[1]);
  }
  if (fns.length === 0) {
    throw new Error('No build_remote_sync_command functions found in torque-remote source');
  }
  return fns.join('\n');
}

describe('build_remote_sync_command runtime invariants — REMOTE_OS=windows', () => {
  // Source all three build_remote_sync_command function definitions and invoke
  // the dispatcher with REMOTE_OS=windows. This is the unit test that closes
  // torque-remote.md open question #7; existing Windows invariants are preserved.
  function buildSyncCommand({ effPath, fetchCmd, syncCheckout, syncRef, bootstrap = '' }) {
    const src = readTorqueRemote();
    const fnDefs = extractSyncFunctions(src);
    // warn() is used by the dispatcher on unknown REMOTE_OS — define a stub.
    const preamble = `warn() { echo "[warn] $*" >&2; }\nREMOTE_OS=windows\n`;
    const stdout = execFileSync(resolveBashForFunctionTests(), ['-c',
      `${preamble}${fnDefs}; build_remote_sync_command "$1" "$2" "$3" "$4" "$5"`,
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

describe('build_remote_sync_command runtime invariants — REMOTE_OS=linux', () => {
  // Source all three function definitions and invoke the dispatcher with
  // REMOTE_OS=linux. Pins the POSIX shape invariants for the Linux variant.
  function buildSyncCommand({ effPath, fetchCmd, syncCheckout, syncRef, bootstrap = '' }) {
    const src = readTorqueRemote();
    const fnDefs = extractSyncFunctions(src);
    const preamble = `warn() { echo "[warn] $*" >&2; }\nREMOTE_OS=linux\n`;
    const stdout = execFileSync(resolveBashForFunctionTests(), ['-c',
      `${preamble}${fnDefs}; build_remote_sync_command "$1" "$2" "$3" "$4" "$5"`,
      '_', effPath, fetchCmd, syncCheckout, syncRef, bootstrap], { encoding: 'utf8' });
    return stdout;
  }

  const fixture = {
    effPath: '/c/trt/torque-public',
    fetchCmd: 'git fetch --prune origin +refs/heads/main:refs/remotes/origin/main',
    syncCheckout: 'git checkout --force --detach origin/main',
    syncRef: 'origin/main',
    bootstrap: '',
  };

  it('uses POSIX [ -f ] tests, not CMD if exist', () => {
    const cmd = buildSyncCommand(fixture);
    expect(cmd).toMatch(/\[ -f /);
    expect(cmd).not.toContain('if not exist');
    expect(cmd).not.toContain('if exist');
  });

  it('uses git clean -fd (NOT -fdx) so node_modules is preserved across syncs', () => {
    const cmd = buildSyncCommand(fixture);
    expect(cmd).toMatch(/git clean -fd(\s|$|\|)/);
    expect(cmd).not.toMatch(/git clean -[a-z]*x/);
  });

  it('emits drift detection with exit 99', () => {
    const cmd = buildSyncCommand(fixture);
    expect(cmd).toContain('exit 99');
    expect(cmd).toContain('drift after reset');
  });

  it('chains fetch → checkout → reset in that exact order', () => {
    const cmd = buildSyncCommand(fixture);
    const fetchIdx = cmd.indexOf('git fetch');
    const checkoutIdx = cmd.indexOf('git checkout');
    const resetIdx = cmd.indexOf('git reset');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeGreaterThan(fetchIdx);
    expect(resetIdx).toBeGreaterThan(checkoutIdx);
  });

  it('chains commands with POSIX && (not CMD ^ escapes)', () => {
    const cmd = buildSyncCommand(fixture);
    expect(cmd).toContain('&&');
    // No CMD-style ^&^& escaping in the POSIX variant.
    expect(cmd).not.toContain('^&^&');
  });

  it('uses cd without /d flag (Linux cd does not accept /d)', () => {
    const cmd = buildSyncCommand(fixture);
    expect(cmd).not.toContain('cd /d');
    expect(cmd).toMatch(/cd "[^"]+"/);
  });

  it('honors a non-empty SYNC_BOOTSTRAP prefix', () => {
    const cmd = buildSyncCommand({
      ...fixture,
      bootstrap: 'BOOTSTRAP_PREFIX_HERE && ',
    });
    expect(cmd.startsWith('BOOTSTRAP_PREFIX_HERE && cd ')).toBe(true);
  });
});

describe('build_remote_sync_command — OS branch dispatch', () => {
  function buildSyncCommandWithOS({ os, effPath, fetchCmd, syncCheckout, syncRef, bootstrap = '' }) {
    const src = readTorqueRemote();
    const fnDefs = extractSyncFunctions(src);
    const preamble = `warn() { echo "[warn] $*" >&2; }\nREMOTE_OS=${os}\n`;
    const stdout = execFileSync(resolveBashForFunctionTests(), ['-c',
      `${preamble}${fnDefs}; build_remote_sync_command "$1" "$2" "$3" "$4" "$5"`,
      '_', effPath, fetchCmd, syncCheckout, syncRef, bootstrap], { encoding: 'utf8' });
    return stdout;
  }

  it('emits different command shapes for linux vs windows given the same inputs', () => {
    const args = {
      effPath: '/some/path',
      fetchCmd: 'git fetch --prune origin +refs/heads/main:refs/remotes/origin/main',
      syncCheckout: 'git checkout --force --detach origin/main',
      syncRef: 'origin/main',
    };
    const linuxCmd = buildSyncCommandWithOS({ os: 'linux', ...args });
    const windowsCmd = buildSyncCommandWithOS({ os: 'windows', ...args });
    expect(linuxCmd).not.toBe(windowsCmd);
    // Linux: POSIX; Windows: CMD
    expect(linuxCmd).toMatch(/\[ -f /);
    expect(windowsCmd).toContain('if exist');
  });
});

// Helper: extract validate_remote_config_drift and its dependencies (info/warn/die)
// from the source and return as a sourcing preamble for bash invocations.
function extractDriftValidator(src) {
  const fnPattern = /^(validate_remote_config_drift\(\)\s*\{[\s\S]*?\n\})/m;
  const m = fnPattern.exec(src);
  if (!m) {
    throw new Error('validate_remote_config_drift not found in torque-remote source');
  }
  const stubs = [
    'info()  { :; }',
    'warn()  { echo "[warn] $*" >&2; }',
    'die()   { echo "[die] $*" >&2; exit 1; }',
  ].join('\n');
  return `${stubs}\n${m[1]}`;
}

describe('validate_remote_config_drift runtime invariants', () => {
  // Each test sources only the validator function (plus stubs) to confirm
  // exit behaviour under synthetic REMOTE_OS / REMOTE_TEST_WORKTREE_ROOT values.

  function runDriftValidator({ remoteOs, worktreeRoot }) {
    const src = readTorqueRemote();
    const fnDefs = extractDriftValidator(src);
    const script = `${fnDefs}\nREMOTE_OS=${remoteOs}\nREMOTE_TEST_WORKTREE_ROOT=${worktreeRoot}\nvalidate_remote_config_drift\necho PASSED`;
    try {
      const stdout = execFileSync(resolveBashForFunctionTests(), ['-c', script], { encoding: 'utf8' });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (err) {
      return { exitCode: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  }

  it('source invariant: validate_remote_config_drift is defined in torque-remote', () => {
    const src = readTorqueRemote();
    expect(src).toMatch(/^validate_remote_config_drift\(\)\s*\{/m);
  });

  it('exits 78 when remote_os=linux but worktree root is a Windows drive letter path', () => {
    const result = runDriftValidator({ remoteOs: 'linux', worktreeRoot: "'C:\\\\trt'" });
    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('remote_test_worktree_root looks Windows');
    expect(result.stderr).toContain('POSIX path');
    expect(result.stdout).not.toContain('PASSED');
  });

  it('exits 78 when remote_os=windows but worktree root is a POSIX absolute path', () => {
    const result = runDriftValidator({ remoteOs: 'windows', worktreeRoot: '/srv/trt' });
    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('remote_test_worktree_root looks POSIX');
    expect(result.stderr).toContain('Windows path');
    expect(result.stdout).not.toContain('PASSED');
  });

  it('passes when remote_os=linux and worktree root is a POSIX path', () => {
    const result = runDriftValidator({ remoteOs: 'linux', worktreeRoot: '/srv/trt' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASSED');
  });

  it('passes when remote_os=windows and worktree root is a Windows drive-letter path', () => {
    const result = runDriftValidator({ remoteOs: 'windows', worktreeRoot: "'C:\\\\trt'" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASSED');
  });

  it('passes when REMOTE_TEST_WORKTREE_ROOT is empty (no root configured yet)', () => {
    const result = runDriftValidator({ remoteOs: 'linux', worktreeRoot: "''" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASSED');
  });
});
