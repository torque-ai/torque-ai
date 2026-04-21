import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { probeStaleness } = require('../factory/stale-probe');

function git(cwd, args) {
  childProcess.execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: 'pipe',
  });
}

describe('stale-probe against a real git repo', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-probe-git-'));
    // Resolve any symlinks (macOS /private, Windows short-path). Without
    // this, `git init` creates .git at the resolved path but the tests
    // later pass the un-resolved path to probeStaleness, and git log's
    // cwd can't find the repo.
    tmpDir = fs.realpathSync(tmpDir);
    git(tmpDir, ['init']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects zero commits since scan when no commits happened after scan time', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    git(tmpDir, ['add', 'foo.js']);
    git(tmpDir, ['commit', '-m', 'initial']);

    const scanTime = new Date(Date.now() + 1000).toISOString();
    const item = {
      id: 1,
      source: 'scout',
      created_at: scanTime,
      origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' },
    };

    // eslint-disable-next-line no-console
    console.error('[probe-debug]', { tmpDir, gitExists: fs.existsSync(path.join(tmpDir, '.git')) });
    const result = await probeStaleness(item, { projectPath: tmpDir });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('no_commits_since_scan');
  });

  it('detects minor churn (1-4 commits) since scan', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    git(tmpDir, ['add', 'foo.js']);
    git(tmpDir, ['commit', '-m', 'initial']);

    const scanTime = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v2');
    git(tmpDir, ['commit', '-am', 'v2']);
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v3');
    git(tmpDir, ['commit', '-am', 'v3']);

    const item = {
      id: 1,
      source: 'scout',
      created_at: scanTime,
      origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' },
    };

    const result = await probeStaleness(item, { projectPath: tmpDir });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('minor_churn_probably_valid');
    expect(result.commits_since_scan).toBe(2);
  });

  it('detects substantial churn (>= threshold commits) as stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    git(tmpDir, ['add', 'foo.js']);
    git(tmpDir, ['commit', '-m', 'initial']);

    const scanTime = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(tmpDir, 'foo.js'), `v${i + 2}`);
      git(tmpDir, ['commit', '-am', `v${i + 2}`]);
    }

    const item = {
      id: 1,
      source: 'scout',
      created_at: scanTime,
      origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' },
    };

    const result = await probeStaleness(item, { projectPath: tmpDir });
    expect(result.stale).toBe(true);
    expect(result.reason).toBe('substantial_churn');
    expect(result.commits_since_scan).toBe(6);
  });
});
