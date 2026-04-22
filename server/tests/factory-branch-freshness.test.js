import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const branchFreshness = require('../factory/branch-freshness');

const realSpawnSync = childProcess._realSpawnSync || childProcess.spawnSync;

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function git(repo, args, options = {}) {
  const result = realSpawnSync('git', args, {
    cwd: repo,
    windowsHide: true,
    timeout: 10000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: GIT_ENV,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

function writeFile(repo, relativePath, content) {
  const fullPath = path.join(repo, ...relativePath.split(/[\\/]/));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function commitFile(repo, relativePath, content, message) {
  writeFile(repo, relativePath, content);
  git(repo, ['add', '--', relativePath.replace(/\\/g, '/')]);
  git(repo, ['commit', '--no-gpg-sign', '-m', message || `commit ${relativePath}`]);
}

function mockGitChild(stdout = '', stderr = '', code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

describe('branch-freshness git helpers', () => {
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup; Windows may briefly hold git pack handles.
      }
    }
  });

  function initRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-branch-freshness-'));
    tempDirs.push(repo);

    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@test.com']);
    git(repo, ['config', 'user.name', 'Test']);
    // Disable Windows autocrlf so fixture content stays byte-for-byte what the
    // tests write — otherwise Git converts LF→CRLF on checkout and the assertions
    // on file content and `git status --porcelain` see spurious modifications.
    git(repo, ['config', 'core.autocrlf', 'false']);
    git(repo, ['config', 'core.eol', 'lf']);
    writeFile(repo, '.gitkeep', '');
    git(repo, ['add', '.gitkeep']);
    git(repo, ['commit', '--no-gpg-sign', '-m', 'initial']);
    git(repo, ['branch', '-M', 'master']);

    return repo;
  }

  it('counts behind commits and filters stale-sensitive master changes since merge-base', async () => {
    const repo = initRepo();

    git(repo, ['checkout', '-b', 'feature']);
    commitFile(repo, 'src/feature.js', 'feature\n', 'feature work');
    git(repo, ['checkout', 'master']);
    commitFile(repo, 'tests/snapshots/Approvals/foo.txt', 'approved\n', 'approval update');
    commitFile(repo, 'tests/foo.baseline.json', '{}\n', 'baseline update');
    commitFile(repo, 'docs/readme.md', 'docs\n', 'docs update');

    await expect(branchFreshness.computeCommitsBehind(repo, 'feature', 'master')).resolves.toBe(3);
    const staleFiles = await branchFreshness.getMasterChangesSinceMergeBase(repo, 'feature', 'master');
    expect(staleFiles.sort()).toEqual([
      'tests/foo.baseline.json',
      'tests/snapshots/Approvals/foo.txt',
    ]);
  });

  it('treats a branch one commit behind as fresh with threshold 5', async () => {
    const repo = initRepo();

    git(repo, ['checkout', '-b', 'fresh']);
    git(repo, ['checkout', 'master']);
    commitFile(repo, 'src/master-1.js', 'one\n', 'master one');

    const result = await branchFreshness.checkBranchFreshness({
      worktreePath: repo,
      branch: 'fresh',
      baseRef: 'master',
      threshold: 5,
    });

    expect(result).toEqual({
      stale: false,
      reason: null,
      commitsBehind: 1,
      staleFiles: [],
    });
  });

  it('treats a branch ten commits behind as stale with commits_behind reason', async () => {
    const repo = initRepo();

    git(repo, ['checkout', '-b', 'old']);
    git(repo, ['checkout', 'master']);
    for (let i = 0; i < 10; i += 1) {
      commitFile(repo, `src/master-${i}.js`, `${i}\n`, `master ${i}`);
    }

    const result = await branchFreshness.checkBranchFreshness({
      worktreePath: repo,
      branch: 'old',
      baseRef: 'master',
      threshold: 5,
    });

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('commits_behind');
    expect(result.commitsBehind).toBe(10);
    expect(result.staleFiles).toEqual([]);
  });

  it('prioritizes stale-sensitive paths over commit threshold decisions', async () => {
    const repo = initRepo();

    git(repo, ['checkout', '-b', 'approval-sensitive']);
    git(repo, ['checkout', 'master']);
    commitFile(repo, 'tests/Approvals/foo.txt', 'approved\n', 'approval drift');

    const result = await branchFreshness.checkBranchFreshness({
      worktreePath: repo,
      branch: 'approval-sensitive',
      baseRef: 'master',
      threshold: 0,
    });

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('stale_sensitive_paths');
    expect(result.commitsBehind).toBe(1);
    expect(result.staleFiles).toEqual(['tests/Approvals/foo.txt']);
  });

  it('returns stale_sensitive_paths even when commitsBehind is zero', async () => {
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation((_cmd, args, options) => {
      expect(options).toEqual(expect.objectContaining({ windowsHide: true }));
      if (args[0] === 'rev-list') {
        return mockGitChild('0\n');
      }
      if (args[0] === 'merge-base') {
        return mockGitChild('abc123\n');
      }
      if (args[0] === 'diff') {
        return mockGitChild('tests/Approvals/foo.txt\n');
      }
      return mockGitChild('', 'unexpected git command', 1);
    });

    const result = await branchFreshness.checkBranchFreshness({
      worktreePath: 'C:/repo',
      branch: 'feature',
      baseRef: 'master',
      threshold: 5,
    });

    expect(result).toEqual({
      stale: true,
      reason: 'stale_sensitive_paths',
      commitsBehind: 0,
      staleFiles: ['tests/Approvals/foo.txt'],
    });
    expect(spawnSpy).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--count', 'feature..master'],
      expect.objectContaining({ cwd: 'C:/repo', windowsHide: true }),
    );
  });

  it('rebases cleanly when master and feature changed different files', async () => {
    const repo = initRepo();

    git(repo, ['checkout', '-b', 'feature-clean']);
    commitFile(repo, 'src/feature.js', 'feature\n', 'feature file');
    git(repo, ['checkout', 'master']);
    commitFile(repo, 'src/master.js', 'master\n', 'master file');
    git(repo, ['checkout', 'feature-clean']);

    const result = await branchFreshness.attemptRebase(repo, 'feature-clean', 'master');

    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(repo, 'src', 'master.js'), 'utf8')).toBe('master\n');
    expect(git(repo, ['rev-list', '--count', 'master..feature-clean']).stdout.trim()).toBe('1');
  });

  it('aborts and reports an error when rebase conflicts', async () => {
    const repo = initRepo();

    commitFile(repo, 'src/shared.txt', 'base\n', 'shared base');
    git(repo, ['checkout', '-b', 'feature-conflict']);
    commitFile(repo, 'src/shared.txt', 'feature\n', 'feature edit');
    git(repo, ['checkout', 'master']);
    commitFile(repo, 'src/shared.txt', 'master\n', 'master edit');
    git(repo, ['checkout', 'feature-conflict']);

    const result = await branchFreshness.attemptRebase(repo, 'feature-conflict', 'master');

    expect(result.ok).toBe(false);
    expect(result.error).toEqual(expect.any(String));
    expect(git(repo, ['status', '--porcelain']).stdout).toBe('');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()).toBe('feature-conflict');
    expect(fs.readFileSync(path.join(repo, 'src', 'shared.txt'), 'utf8')).toBe('feature\n');
  });
});
