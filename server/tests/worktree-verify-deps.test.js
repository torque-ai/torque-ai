import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  prepareWorktreeVerifyDependencies,
  _internalForTests,
} = require('../utils/worktree-verify-deps');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-worktree-deps-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFile(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('worktree verify dependency preparation', () => {
  it('links incomplete package node_modules from the main checkout for managed worktrees', () => {
    const repoRoot = makeTempDir();
    const worktreeRoot = path.join(repoRoot, '.worktrees', 'feat-example');
    const sourceNodeModules = path.join(repoRoot, 'server', 'node_modules');
    const targetNodeModules = path.join(worktreeRoot, 'server', 'node_modules');
    const logger = { info: vi.fn(), warn: vi.fn() };

    writeJson(path.join(repoRoot, 'server', 'package.json'), {
      devDependencies: {
        vitest: '^3.0.0',
        jsdom: '^25.0.0',
      },
    });
    writeJson(path.join(worktreeRoot, 'server', 'package.json'), {
      devDependencies: {
        vitest: '^3.0.0',
        jsdom: '^25.0.0',
      },
    });
    writeFile(path.join(sourceNodeModules, 'vitest', 'package.json'), '{}');
    writeFile(path.join(sourceNodeModules, 'jsdom', 'package.json'), '{}');
    writeFile(path.join(targetNodeModules, 'vitest', 'package.json'), '{}');

    const result = prepareWorktreeVerifyDependencies(worktreeRoot, logger);

    expect(result.prepared).toBe(true);
    expect(result.worktreeRoot).toBe(path.resolve(worktreeRoot));
    expect(result.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageDir: 'server', action: 'linked' }),
    ]));
    expect(fs.existsSync(path.join(targetNodeModules, 'jsdom', 'package.json'))).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'factory worktree verify: linked shared node_modules',
      expect.objectContaining({
        worktree_path: path.resolve(worktreeRoot),
        packages: expect.arrayContaining(['server']),
      })
    );
  });

  it('repairs missing package bin shims before reusing linked node_modules', () => {
    const repoRoot = makeTempDir();
    const worktreeRoot = path.join(repoRoot, '.worktrees', 'feat-example');
    const sourceNodeModules = path.join(repoRoot, 'server', 'node_modules');
    const targetNodeModules = path.join(worktreeRoot, 'server', 'node_modules');

    writeJson(path.join(repoRoot, 'server', 'package.json'), {
      devDependencies: {
        vitest: '^4.0.0',
      },
    });
    writeJson(path.join(worktreeRoot, 'server', 'package.json'), {
      devDependencies: {
        vitest: '^4.0.0',
      },
    });
    writeJson(path.join(sourceNodeModules, 'vitest', 'package.json'), {
      name: 'vitest',
      bin: {
        vitest: './vitest.mjs',
      },
    });
    writeFile(path.join(sourceNodeModules, 'vitest', 'vitest.mjs'), '#!/usr/bin/env node\n');
    writeJson(path.join(targetNodeModules, 'vitest', 'package.json'), {
      name: 'vitest',
      bin: {
        vitest: './vitest.mjs',
      },
    });
    writeFile(path.join(targetNodeModules, 'vitest', 'vitest.mjs'), '#!/usr/bin/env node\n');

    const result = prepareWorktreeVerifyDependencies(worktreeRoot);
    const shimName = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';

    expect(result.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageDir: 'server', action: 'linked' }),
    ]));
    expect(fs.existsSync(path.join(sourceNodeModules, '.bin', shimName))).toBe(true);
    expect(fs.existsSync(path.join(targetNodeModules, '.bin', shimName))).toBe(true);
    expect(_internalForTests.packageBinsUsable(targetNodeModules, 'vitest')).toBe(true);
  });

  it('does nothing outside managed worktrees', () => {
    const projectRoot = makeTempDir();

    const result = prepareWorktreeVerifyDependencies(projectRoot);

    expect(result).toEqual({
      prepared: false,
      reason: 'not_managed_worktree',
      packages: [],
    });
  });

  it('refuses unsafe node_modules removal paths', () => {
    const repoRoot = makeTempDir();
    const outsideNodeModules = path.join(repoRoot, 'node_modules');
    fs.mkdirSync(outsideNodeModules, { recursive: true });

    expect(() => _internalForTests.removeTargetNodeModules(
      outsideNodeModules,
      path.join(repoRoot, '.worktrees', 'feat-example'),
    )).toThrow(/refusing to remove unsafe node_modules path/);
  });
});
