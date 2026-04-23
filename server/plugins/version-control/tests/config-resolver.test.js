'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfigResolver } = require('../config-resolver');

describe('version-control config resolver', () => {
  let tempRoot;
  let homeDir;
  let repoDir;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-vc-config-'));
    homeDir = path.join(tempRoot, 'home');
    repoDir = path.join(tempRoot, 'repo');

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns built-in defaults when no global config exists', () => {
    const resolver = createConfigResolver();

    expect(resolver.getGlobalDefaults()).toEqual({
      branch_policy: {
        protected_branches: ['main', 'master'],
        branch_prefix: ['feat/', 'fix/', 'chore/', 'refactor/', 'test/', 'docs/'],
        policy_modes: {
          protected_branches: 'block',
          branch_naming: 'warn',
        },
      },
      commit_policy: {
        format: 'conventional',
      },
      worktree: {
        dir: '.worktrees',
        stale_threshold_days: 7,
      },
      merge: {
        strategy: 'merge',
        require_before_merge: [],
        policy_modes: {
          required_checks: 'block',
          merge_strategy: 'warn',
        },
      },
      protected_branches: ['main', 'master'],
      branch_prefix: ['feat/', 'fix/', 'chore/', 'refactor/', 'test/', 'docs/'],
      merge_strategy: 'merge',
      require_before_merge: [],
      stale_threshold_days: 7,
      commit_format: 'conventional',
      worktree_dir: '.worktrees',
      policy_modes: {
        protected_branches: 'block',
        branch_naming: 'warn',
        required_checks: 'block',
        merge_strategy: 'warn',
      },
    });
  });

  it('deep-merges repo overrides on top of global defaults', () => {
    fs.mkdirSync(path.join(homeDir, '.torque'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.torque', 'vc-defaults.json'),
      JSON.stringify({
        branch_policy: {
          protected_branches: ['main'],
          branch_prefix: ['feature/'],
        },
        merge: {
          require_before_merge: ['npm test'],
        },
        worktree: {
          stale_threshold_days: 14,
        },
      }, null, 2),
      'utf8',
    );

    fs.writeFileSync(
      path.join(repoDir, '.torque-vc.json'),
      JSON.stringify({
        branch_policy: {
          branch_prefix: ['bugfix/'],
        },
        commit_policy: {
          format: 'detailed',
        },
        merge_strategy: 'squash',
      }, null, 2),
      'utf8',
    );

    const resolver = createConfigResolver();
    const effective = resolver.getEffectiveConfig(repoDir);

    expect(effective.branch_policy.protected_branches).toEqual(['main']);
    expect(effective.branch_policy.branch_prefix).toEqual(['bugfix/']);
    expect(effective.merge.require_before_merge).toEqual(['npm test']);
    expect(effective.worktree.stale_threshold_days).toBe(14);
    expect(effective.commit_policy.format).toBe('detailed');
    expect(effective.merge.strategy).toBe('squash');
    expect(effective.branch_prefix).toEqual(['bugfix/']);
    expect(effective.merge_strategy).toBe('squash');
  });

  it('caches by repo path until invalidateCache is called', () => {
    fs.writeFileSync(
      path.join(repoDir, '.torque-vc.json'),
      JSON.stringify({
        worktree: {
          stale_threshold_days: 5,
        },
      }, null, 2),
      'utf8',
    );

    const resolver = createConfigResolver();
    const first = resolver.getEffectiveConfig(repoDir);
    expect(first.worktree.stale_threshold_days).toBe(5);

    fs.writeFileSync(
      path.join(repoDir, '.torque-vc.json'),
      JSON.stringify({
        worktree: {
          stale_threshold_days: 30,
        },
      }, null, 2),
      'utf8',
    );

    const cached = resolver.getEffectiveConfig(repoDir);
    expect(cached.worktree.stale_threshold_days).toBe(5);
    expect(resolver.cache.has(path.resolve(repoDir))).toBe(true);

    expect(resolver.invalidateCache(repoDir)).toBe(true);

    const refreshed = resolver.getEffectiveConfig(repoDir);
    expect(refreshed.worktree.stale_threshold_days).toBe(30);
  });

  it('handles malformed JSON by falling back to defaults', () => {
    fs.mkdirSync(path.join(homeDir, '.torque'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.torque', 'vc-defaults.json'), '{not json', 'utf8');

    const resolverWithBadGlobal = createConfigResolver();
    const badGlobalDefaults = resolverWithBadGlobal.getGlobalDefaults();
    expect(badGlobalDefaults.branch_policy.protected_branches).toEqual(['main', 'master']);
    expect(badGlobalDefaults.merge.strategy).toBe('merge');

    fs.writeFileSync(
      path.join(homeDir, '.torque', 'vc-defaults.json'),
      JSON.stringify({
        worktree: {
          stale_threshold_days: 12,
        },
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(repoDir, '.torque-vc.json'), '{still not json', 'utf8');

    const resolverWithBadRepo = createConfigResolver();
    const effective = resolverWithBadRepo.getEffectiveConfig(repoDir);

    expect(effective.worktree.stale_threshold_days).toBe(12);
    expect(effective.branch_policy.protected_branches).toEqual(['main', 'master']);
  });
});
