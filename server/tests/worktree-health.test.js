import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkWorktreeGitHealth } = require('../factory/worktree-health');
const { createIsolatedGitEnv, withIsolatedGitArgs, withRealGit } = require('./git-test-utils');

const realSpawnSync = childProcess._realSpawnSync || childProcess.spawnSync;
const GIT_ENV = createIsolatedGitEnv();

function git(repo, args) {
  const result = realSpawnSync('git', withIsolatedGitArgs(args), {
    cwd: repo,
    windowsHide: true,
    timeout: 10000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

describe('worktree-health', () => {
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('accepts a usable git worktree root', async () => {
    const repo = makeTempDir('torque-worktree-health-repo-');
    git(repo, ['init']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'ok\n');

    const health = await withRealGit(() => checkWorktreeGitHealth(repo, { env: GIT_ENV }));

    expect(health).toMatchObject({ ok: true, reason: null });
  });

  it('rejects a nested directory inside a repository', async () => {
    const repo = makeTempDir('torque-worktree-health-nested-');
    git(repo, ['init']);
    const nested = path.join(repo, 'server');
    fs.mkdirSync(nested);

    const health = await withRealGit(() => checkWorktreeGitHealth(nested, { env: GIT_ENV }));

    expect(health.ok).toBe(false);
    expect(health.reason).toBe('not_worktree_root');
  });

  it('rejects a directory whose .git file points at missing worktree metadata', async () => {
    const worktree = makeTempDir('torque-worktree-health-broken-');
    const missingGitDir = path.join(path.dirname(worktree), 'missing-worktree-metadata');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${missingGitDir}\n`);

    const health = await withRealGit(() => checkWorktreeGitHealth(worktree, { env: GIT_ENV }));

    expect(health.ok).toBe(false);
    expect(health.reason).toBe('git_probe_failed');
    expect(health.error).toMatch(/not a git repository|not a gitdir|no such file|invalid gitfile/i);
  });
});
