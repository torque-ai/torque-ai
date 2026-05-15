import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'scripts', 'pre-push-hook');
const LOCK_HELPER = path.join(REPO_ROOT, 'scripts', 'repo-coordination-lock.sh');

// Test fixture: spawn bash with a driver script that extracts the two
// pre-push-hook helpers we care about, points at a temp artifact root,
// runs the follower-ride check, and emits its exit code on stdout.
//
// We extract via sed rather than copy-pasting the function body so the
// test follows the implementation when it moves. The sed range patterns
// match the start `<name>() {` and the closing `}` at column 0.
function runFollowerCheck(opts) {
  const {
    artifactRoot,
    localHeadShort,
    localHeadSha,
    trustWindow = '1800',
    repoRootDir,
  } = opts;

  const driver = `
set -uo pipefail
export REPO_ROOT='${repoRootDir.replace(/'/g, "'\\''")}'
export PRE_PUSH_GATE_ARTIFACT_ROOT='${artifactRoot.replace(/'/g, "'\\''")}'
export PRE_PUSH_PASS_TRUST_WINDOW_SECS='${trustWindow}'
local_head_short='${localHeadShort}'
local_head_sha='${localHeadSha}'

# Load the coordination-lock helper for repo_coord_lock_read_field
source '${LOCK_HELPER.replace(/'/g, "'\\''")}'

# Pull the two functions we exercise out of pre-push-hook. The function
# closing brace is at column 0 so the sed range is unambiguous.
eval "$(sed -n '/^pre_push_git_common_dir() {$/,/^}$/p' '${HOOK_PATH.replace(/'/g, "'\\''")}')"
eval "$(sed -n '/^pre_push_follower_ride_passed_artifact() {$/,/^}$/p' '${HOOK_PATH.replace(/'/g, "'\\''")}')"

pre_push_follower_ride_passed_artifact
printf 'rc=%d\\n' $?
`;

  return spawnSync('bash', ['-c', driver], { encoding: 'utf8' });
}

// Build a minimal passed-status artifact file matching the format
// pre_push_write_gate_artifact emits. Only the fields the follower-check
// reads need to be present; the rest are blank.
function writeArtifact(artifactPath, fields) {
  const lines = [
    'pre_push_gate_artifact_version=1',
    `status=${fields.status ?? 'passed'}`,
    `exit_code=${fields.exit_code ?? '0'}`,
    `created_at=${fields.created_at ?? new Date().toISOString()}`,
    `created_at_epoch=${fields.created_at_epoch ?? Math.floor(Date.now() / 1000)}`,
    `updated_at=${fields.updated_at ?? new Date().toISOString()}`,
    `updated_at_epoch=${fields.updated_at_epoch ?? Math.floor(Date.now() / 1000)}`,
    `head_sha=${fields.head_sha ?? ''}`,
    `head_short=${fields.head_short ?? ''}`,
    '',
    '[output-tail]',
  ];
  fs.writeFileSync(artifactPath, lines.join('\n'));
}

// Create a minimal git repo with one commit so `git rev-parse HEAD` returns
// a deterministic SHA. We don't need the gate to actually run — just the
// follower-ride function's HEAD lookup.
function makeFixtureRepo(dir) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout.trim();
  };
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '--quiet', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@example.com']);
  run('git', ['config', 'user.name', 'Test']);
  run('git', ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  run('git', ['add', 'README.md']);
  run('git', ['commit', '--quiet', '--no-verify', '-m', 'init']);
  return run('git', ['rev-parse', 'HEAD']);
}

describe('pre-push gate coordination — follower-ride-passed-artifact', () => {
  let tmpDir, repoDir, artifactRoot, headSha, headShort;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-gate-coord-'));
    repoDir = path.join(tmpDir, 'repo');
    headSha = makeFixtureRepo(repoDir);
    headShort = headSha.slice(0, 12);
    artifactRoot = path.join(tmpDir, 'artifacts');
    fs.mkdirSync(artifactRoot, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rides a fresh passed artifact for the current HEAD (rc=0)', () => {
    writeArtifact(
      path.join(artifactRoot, `${headShort}-20260515T000000Z-1.txt`),
      { status: 'passed', exit_code: '0', head_sha: headSha, head_short: headShort },
    );
    const result = runFollowerCheck({
      artifactRoot,
      localHeadShort: headShort,
      localHeadSha: headSha,
      repoRootDir: repoDir,
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/Concurrent gate already passed for /);
    expect(result.stdout).toMatch(/rc=0/);
  });

  it('rejects a stale passed artifact older than the trust window (rc=1)', () => {
    const staleEpoch = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    writeArtifact(
      path.join(artifactRoot, `${headShort}-stale-1.txt`),
      {
        status: 'passed',
        exit_code: '0',
        head_sha: headSha,
        head_short: headShort,
        created_at_epoch: String(staleEpoch),
      },
    );
    const result = runFollowerCheck({
      artifactRoot,
      localHeadShort: headShort,
      localHeadSha: headSha,
      trustWindow: '1800', // 30min — staleEpoch is older
      repoRootDir: repoDir,
    });
    expect(result.stdout).not.toMatch(/Concurrent gate already passed/);
    expect(result.stdout).toMatch(/rc=1/);
  });

  it('rejects an artifact whose head_sha differs from current HEAD (rc=1)', () => {
    writeArtifact(
      path.join(artifactRoot, `${headShort}-wrong-sha-1.txt`),
      {
        status: 'passed',
        exit_code: '0',
        head_sha: '0000000000000000000000000000000000000000',
        head_short: headShort,
      },
    );
    const result = runFollowerCheck({
      artifactRoot,
      localHeadShort: headShort,
      localHeadSha: headSha,
      repoRootDir: repoDir,
    });
    expect(result.stdout).not.toMatch(/Concurrent gate already passed/);
    expect(result.stdout).toMatch(/rc=1/);
  });

  it('rejects an artifact whose status is failed even if exit_code says 0 (rc=1)', () => {
    writeArtifact(
      path.join(artifactRoot, `${headShort}-failed-1.txt`),
      {
        status: 'failed',
        exit_code: '0',
        head_sha: headSha,
        head_short: headShort,
      },
    );
    const result = runFollowerCheck({
      artifactRoot,
      localHeadShort: headShort,
      localHeadSha: headSha,
      repoRootDir: repoDir,
    });
    expect(result.stdout).not.toMatch(/Concurrent gate already passed/);
    expect(result.stdout).toMatch(/rc=1/);
  });

  it('skips the ride path entirely when PRE_PUSH_PASS_TRUST_WINDOW_SECS=0 (rc=1)', () => {
    // Even with a fresh, valid passed artifact, trust_window=0 must disable
    // the ride path — used by ops to force-skip the optimization without
    // editing the script.
    writeArtifact(
      path.join(artifactRoot, `${headShort}-disabled-1.txt`),
      { status: 'passed', exit_code: '0', head_sha: headSha, head_short: headShort },
    );
    const result = runFollowerCheck({
      artifactRoot,
      localHeadShort: headShort,
      localHeadSha: headSha,
      trustWindow: '0',
      repoRootDir: repoDir,
    });
    expect(result.stdout).not.toMatch(/Concurrent gate already passed/);
    expect(result.stdout).toMatch(/rc=1/);
  });

  it('returns rc=1 when no artifact for this short SHA exists', () => {
    // artifactRoot exists but has no files matching local_head_short.
    const result = runFollowerCheck({
      artifactRoot,
      localHeadShort: headShort,
      localHeadSha: headSha,
      repoRootDir: repoDir,
    });
    expect(result.stdout).not.toMatch(/Concurrent gate already passed/);
    expect(result.stdout).toMatch(/rc=1/);
  });

  it('picks the newest artifact when multiple exist for the same short SHA', () => {
    // Older artifact: failed. Newer artifact: passed. Function should ride
    // the newer one because mtime-newest is what cleanup-trap writes last.
    const olderPath = path.join(artifactRoot, `${headShort}-older-1.txt`);
    const newerPath = path.join(artifactRoot, `${headShort}-newer-2.txt`);
    writeArtifact(olderPath, {
      status: 'failed', exit_code: '1', head_sha: headSha, head_short: headShort,
    });
    // Force older to be older-by-mtime (default writes are within the same
    // second on fast filesystems).
    const oneHourAgo = (Date.now() - 3600_000) / 1000;
    fs.utimesSync(olderPath, oneHourAgo, oneHourAgo);
    writeArtifact(newerPath, {
      status: 'passed', exit_code: '0', head_sha: headSha, head_short: headShort,
    });
    const result = runFollowerCheck({
      artifactRoot,
      localHeadShort: headShort,
      localHeadSha: headSha,
      repoRootDir: repoDir,
    });
    expect(result.stdout).toMatch(/Concurrent gate already passed/);
    expect(result.stdout).toMatch(/rc=0/);
  });
});
