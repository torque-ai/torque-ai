import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const path = require('path');
const { probeStaleness } = require('../factory/stale-probe');
const { gitSync, createTestRepo, cleanupRepo } = require('./git-test-utils');

// The vitest worker-setup stubs sync child_process calls so stray git.exe
// processes can't orphan on Windows. Tests that need real git MUST use
// gitSync() from git-test-utils.js — it calls the unpatched sync variant.
//
// The stale-probe's defaultGitRunner uses the async variant of the git
// wrapper, which worker-setup.js does NOT patch, so production code runs
// real git in tests without any test-side shim.

describe('stale-probe against a real git repo', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTestRepo('stale-probe-git');
  });

  afterEach(() => {
    cleanupRepo(tmpDir);
  });

  it('detects zero commits since scan when no commits happened after scan time', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    gitSync(['add', 'foo.js'], { cwd: tmpDir });
    gitSync(['commit', '--no-gpg-sign', '-m', 'initial'], { cwd: tmpDir });

    const scanTime = new Date(Date.now() + 1000).toISOString();
    const item = {
      id: 1,
      source: 'scout',
      created_at: scanTime,
      origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' },
    };

    const result = await probeStaleness(item, { projectPath: tmpDir });
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('no_commits_since_scan');
  });

  it('detects minor churn (1-4 commits) since scan', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v1');
    gitSync(['add', 'foo.js'], { cwd: tmpDir });
    gitSync(['commit', '--no-gpg-sign', '-m', 'initial'], { cwd: tmpDir });

    const scanTime = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v2');
    gitSync(['commit', '--no-gpg-sign', '-am', 'v2'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'v3');
    gitSync(['commit', '--no-gpg-sign', '-am', 'v3'], { cwd: tmpDir });

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
    gitSync(['add', 'foo.js'], { cwd: tmpDir });
    gitSync(['commit', '--no-gpg-sign', '-m', 'initial'], { cwd: tmpDir });

    const scanTime = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(tmpDir, 'foo.js'), `v${i + 2}`);
      gitSync(['commit', '--no-gpg-sign', '-am', `v${i + 2}`], { cwd: tmpDir });
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
