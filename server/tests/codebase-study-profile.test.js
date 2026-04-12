'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProfileManager } = require('../integrations/codebase-study/profile');

const GIT_TEST_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Study Profile Test',
  GIT_AUTHOR_EMAIL: 'study-profile@example.com',
  GIT_COMMITTER_NAME: 'Study Profile Test',
  GIT_COMMITTER_EMAIL: 'study-profile@example.com',
};

function runGit(cwd, args) {
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    env: GIT_TEST_ENV,
  }).trim();
}

function writeRepoFile(repoDir, relativePath, content) {
  const fullPath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function createRepo(files) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-study-profile-'));
  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.email', 'study-profile@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Study Profile Test']);
  Object.entries(files).forEach(([relativePath, content]) => {
    writeRepoFile(repoDir, relativePath, content);
  });
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'initial', '--no-gpg-sign']);
  return repoDir;
}

describe('codebase-study profile module', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = createRepo({
      'package.json': JSON.stringify({
        name: 'study-profile-fixture',
        description: 'Fixture repo for codebase-study profile coverage.',
      }, null, 2) + '\n',
      'src/index.js': [
        'module.exports = {',
        '  boot() {',
        '    return true;',
        '  },',
        '};',
        '',
      ].join('\n'),
    });
  });

  afterEach(() => {
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      repoDir = null;
    }
  });

  it('resolves a saved repo-local override on the next profile lookup', async () => {
    const manager = createProfileManager({ db: {} });
    await manager.saveOverride(repoDir, {
      version: 1,
      base_profile_id: 'generic-javascript-repo',
      label: 'Fixture overrides',
      subsystem_priority: {
        runtime: 50,
      },
      flow_guidance: {
        bootstrap: {
          invariants: ['Boot stays deterministic.'],
        },
      },
    });

    const resolved = manager.resolveProfile({
      repoMetadata: {
        name: 'study-profile-fixture',
        package_json: {
          name: 'study-profile-fixture',
        },
      },
      trackedFiles: ['src/index.js'],
      workingDirectory: repoDir,
    });

    expect(resolved).toEqual(expect.objectContaining({
      id: 'generic-javascript-repo',
      base_profile_id: 'generic-javascript-repo',
      label: 'Fixture overrides',
      override_applied: true,
      override_repo_path: 'docs/architecture/study-profile.override.json',
      subsystem_priority: expect.objectContaining({
        runtime: 50,
      }),
      flow_guidance: expect.objectContaining({
        bootstrap: expect.objectContaining({
          invariants: ['Boot stays deterministic.'],
        }),
      }),
    }));
  });

  it('persists overrides across manager instances', async () => {
    const manager = createProfileManager({ db: {} });
    await manager.saveOverride(repoDir, {
      version: 1,
      base_profile_id: 'generic-javascript-repo',
      label: 'Persisted fixture override',
      subsystem_priority: {
        runtime: 75,
      },
    });

    const freshManager = createProfileManager({ db: {} });
    const status = await freshManager.getOverrideStatus(repoDir);

    expect(status).toEqual(expect.objectContaining({
      working_directory: repoDir,
      repo_path: 'docs/architecture/study-profile.override.json',
      exists: true,
      active: true,
      override: expect.objectContaining({
        label: 'Persisted fixture override',
        subsystem_priority: {
          runtime: 75,
        },
      }),
    }));
    expect(status.raw_override).toContain('"label": "Persisted fixture override"');
    expect(status.study_profile).toEqual(expect.objectContaining({
      id: 'generic-javascript-repo',
      override_applied: true,
      override_repo_path: 'docs/architecture/study-profile.override.json',
    }));
  });

  it('reports empty status before save and populated status after save', async () => {
    const manager = createProfileManager({ db: {} });

    const beforeSave = await manager.getOverrideStatus(repoDir);

    expect(beforeSave).toEqual(expect.objectContaining({
      working_directory: repoDir,
      repo_path: 'docs/architecture/study-profile.override.json',
      exists: false,
      active: false,
      raw_override: null,
      override: null,
      template: expect.objectContaining({
        base_profile_id: 'generic-javascript-repo',
      }),
    }));
    expect(beforeSave.study_profile).toEqual(expect.objectContaining({
      id: 'generic-javascript-repo',
      override_applied: false,
      framework_detection: expect.objectContaining({
        archetype: expect.any(String),
        confidence: expect.any(String),
      }),
    }));

    const afterSave = await manager.saveOverride(repoDir, {
      version: 1,
      base_profile_id: 'generic-javascript-repo',
      subsystem_priority: {
        runtime: 60,
      },
    });

    expect(afterSave).toEqual(expect.objectContaining({
      working_directory: repoDir,
      repo_path: 'docs/architecture/study-profile.override.json',
      exists: true,
      active: true,
      override: expect.objectContaining({
        subsystem_priority: {
          runtime: 60,
        },
      }),
    }));
    expect(afterSave.raw_override).toContain('"runtime": 60');
    expect(afterSave.study_profile).toEqual(expect.objectContaining({
      id: 'generic-javascript-repo',
      override_applied: true,
      override_repo_path: 'docs/architecture/study-profile.override.json',
    }));
  });
});
