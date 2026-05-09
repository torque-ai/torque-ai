/**
 * Shared git test utilities — safe defaults for Windows.
 *
 * On Windows, vitest worker forks don't propagate signals to child processes.
 * Every `execFileSync('git', ...)` call can leave behind orphaned `git.exe`
 * processes if the worker exits while the call is in-flight, or if git spawns
 * helper subprocesses (GPG, credential helpers, editors).
 *
 * This module provides a `gitSync()` wrapper that applies safe defaults:
 *  - windowsHide: true      — no console window allocation
 *  - timeout: 30000          — prevent hangs without flaking under full-suite load
 *  - stdio: 'pipe'           — capture output, don't inherit terminal
 *  - env with GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0,
 *    GIT_CONFIG_NOSYSTEM=1   — prevent git from launching helpers
 *  - isolated git env/hooks  — prevent parent repo metadata from leaking into
 *    temp fixture repositories under the pre-push harness
 *  - --no-gpg-sign on commits — no GPG subprocess
 */

'use strict';

const childProcess = require('child_process');
// Use the real (unpatched) execFileSync — worker-setup.js patches the default
// to stub git calls, but tests in this module need actual git operations.
const execFileSync = childProcess._realExecFileSync || childProcess.execFileSync;
const path = require('path');
const fs = require('fs');
const os = require('os');

const EMPTY_GIT_HOOKS_DIR = path.join(os.tmpdir(), 'torque-test-empty-git-hooks');
try {
  fs.mkdirSync(EMPTY_GIT_HOOKS_DIR, { recursive: true });
} catch {
  // If the directory cannot be created, git will still receive a deterministic
  // hooksPath and fail loudly instead of running the parent checkout hooks.
}

const UNSAFE_GIT_ENV_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
]);

function stripInheritedGitState(env) {
  for (const key of Object.keys(env)) {
    if (
      UNSAFE_GIT_ENV_KEYS.has(key)
      || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

function createIsolatedGitEnv(overrides = {}, baseEnv = process.env) {
  const env = stripInheritedGitState({ ...baseEnv });
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
  }, overrides);
  return stripInheritedGitState(env);
}

function withIsolatedGitArgs(args) {
  return [
    '-c',
    `core.hooksPath=${EMPTY_GIT_HOOKS_DIR.replace(/\\/g, '/')}`,
    ...args,
  ];
}

function withRealGit(fn) {
  const previous = {
    execFileSync: childProcess.execFileSync,
    execFile: childProcess.execFile,
    spawnSync: childProcess.spawnSync,
  };
  if (childProcess._realExecFileSync) childProcess.execFileSync = childProcess._realExecFileSync;
  if (childProcess._realExecFile) childProcess.execFile = childProcess._realExecFile;
  if (childProcess._realSpawnSync) childProcess.spawnSync = childProcess._realSpawnSync;

  const restore = () => {
    childProcess.execFileSync = previous.execFileSync;
    childProcess.execFile = previous.execFile;
    childProcess.spawnSync = previous.spawnSync;
  };

  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/**
 * Safe environment variables for git in tests.
 * Merged with process.env so git still finds its executable.
 */
const GIT_TEST_ENV = {
  ...createIsolatedGitEnv(),
};

/** Default options for all git calls in tests. */
const GIT_SYNC_TIMEOUT_MS = 30000;
const GIT_DEFAULT_OPTS = {
  windowsHide: true,
  timeout: GIT_SYNC_TIMEOUT_MS,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: GIT_TEST_ENV,
  encoding: 'utf8',
};

/**
 * Run a git command with safe defaults.
 *
 * @param {string[]} args   - Git arguments, e.g. ['init'], ['add', '.']
 * @param {object}   [opts] - Override options (merged with defaults)
 * @returns {string}        - stdout (trimmed)
 */
function gitSync(args, opts = {}) {
  const merged = {
    ...GIT_DEFAULT_OPTS,
    ...opts,
    env: createIsolatedGitEnv(opts.env || {}),
  };
  return execFileSync('git', withIsolatedGitArgs(args), merged).toString().trim();
}

/**
 * Create a minimal git repo in a temp directory.
 * Returns the repo path. Caller is responsible for cleanup.
 *
 * @param {string} [prefix='torque-test-git'] - Temp dir prefix
 * @returns {string} Path to the repo root
 */
function createTestRepo(prefix = 'torque-test-git') {
  const repoDir = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(repoDir, { recursive: true });

  gitSync(['init'], { cwd: repoDir });
  gitSync(['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  gitSync(['config', 'user.name', 'Test'], { cwd: repoDir });

  return repoDir;
}

/**
 * Create a git repo with an initial commit (so HEAD exists).
 *
 * @param {string} [prefix='torque-test-git'] - Temp dir prefix
 * @returns {string} Path to the repo root
 */
function createTestRepoWithCommit(prefix = 'torque-test-git') {
  const repoDir = createTestRepo(prefix);
  fs.writeFileSync(path.join(repoDir, '.gitkeep'), '');
  gitSync(['add', '.'], { cwd: repoDir });
  gitSync(['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoDir });
  return repoDir;
}

/**
 * Commit a file in a test repo.
 *
 * @param {string} repoDir  - Path to git repo
 * @param {string} filename - Relative file path
 * @param {string} content  - File content
 * @param {string} [message] - Commit message
 */
function commitFile(repoDir, filename, content, message) {
  const fullPath = path.join(repoDir, filename);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  gitSync(['add', filename], { cwd: repoDir });
  gitSync(['commit', '-m', message || `add ${filename}`, '--no-gpg-sign'], { cwd: repoDir });
}

/**
 * Commit all changes in a test repo.
 *
 * @param {string} repoDir  - Path to git repo
 * @param {string} [message] - Commit message
 */
function commitAll(repoDir, message = 'commit') {
  gitSync(['add', '--all'], { cwd: repoDir });
  gitSync(['commit', '-m', message, '--no-gpg-sign'], { cwd: repoDir });
}

/**
 * Clean up a test repo directory.
 *
 * @param {string} dir - Directory to remove
 */
function cleanupRepo(dir) {
  if (!dir) return;
  try {
    // Prune worktrees first to release locks
    try {
      gitSync(['worktree', 'prune'], { cwd: dir, timeout: 5000 });
    } catch { /* ok — may not be a git repo */ }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

module.exports = {
  gitSync,
  createTestRepo,
  createTestRepoWithCommit,
  commitFile,
  commitAll,
  cleanupRepo,
  withRealGit,
  GIT_TEST_ENV,
  GIT_DEFAULT_OPTS,
  createIsolatedGitEnv,
  withIsolatedGitArgs,
  EMPTY_GIT_HOOKS_DIR,
};
