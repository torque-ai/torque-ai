'use strict';

// Unit tests for .claude/hooks/block-main-edit.js — the PreToolUse hook that
// blocks Edit/Write/NotebookEdit on the torque-public main worktree.
//
// Strategy: spawn a small "runner" Node.js script that patches
// child_process.execFileSync in-process before evaluating the hook logic.
// The runner reads MOCK_GIT_* env-vars and the hook's stdin payload, then
// replays the hook's stdout. This is fully cross-platform (no PATH/shim
// issues on Windows).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_SCRIPT = path.resolve(
  __dirname, '..', '..', '.claude', 'hooks', 'block-main-edit.js',
);

let tmpDir;
let runnerPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-main-edit-test-'));

  // Build a runner that monkeypatches execFileSync, then evals the hook.
  runnerPath = path.join(tmpDir, 'run-hook.js');
  fs.writeFileSync(runnerPath, `
'use strict';
const childProcess = require('child_process');
const origExecFileSync = childProcess.execFileSync;

// Patch execFileSync to intercept 'git' calls.
childProcess.execFileSync = function patchedExecFileSync(file, args, opts) {
  if (file === 'git') {
    const exitCode = parseInt(process.env.MOCK_GIT_EXIT_CODE || '0', 10);
    if (exitCode !== 0) {
      const err = new Error('mock git failure');
      err.status = exitCode;
      throw err;
    }
    const joined = args.join(' ');
    let result = '';
    if (joined.includes('--show-toplevel'))    result = process.env.MOCK_GIT_TOPLEVEL || '';
    else if (joined.includes('--absolute-git-dir')) result = process.env.MOCK_GIT_DIR || '';
    else if (joined.includes('--git-common-dir'))   result = process.env.MOCK_GIT_COMMON_DIR || '';
    else if (joined.includes('--abbrev-ref'))        result = process.env.MOCK_GIT_BRANCH || '';
    return result + '\\n';  // git outputs a trailing newline; .trim() in hook strips it
  }
  return origExecFileSync.call(this, file, args, opts);
};

// Now run the actual hook script. It reads stdin → processes → writes stdout.
require(process.env.HOOK_SCRIPT_PATH);
`, 'utf8');
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ok */ }
});

/**
 * Run the hook with the given stdin payload and env overrides.
 * Returns { stdout, stderr, status }.
 */
function runHook(stdinPayload, envOverrides = {}) {
  const input = typeof stdinPayload === 'string'
    ? stdinPayload
    : JSON.stringify(stdinPayload);

  const result = spawnSync(process.execPath, [runnerPath], {
    input,
    env: {
      ...process.env,
      HOOK_SCRIPT_PATH: HOOK_SCRIPT,
      ...envOverrides,
    },
    timeout: 10_000,
    encoding: 'utf8',
  });

  return {
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    status: result.status,
  };
}

function parseHookOutput(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// ── Helpers that build common env configs ──

function mainWorktreeEnv() {
  // git-dir === common-dir → main worktree
  return {
    MOCK_GIT_TOPLEVEL: '/fake/torque-public',
    MOCK_GIT_DIR: '/fake/torque-public/.git',
    MOCK_GIT_COMMON_DIR: '/fake/torque-public/.git',
    MOCK_GIT_BRANCH: 'main',
    MOCK_GIT_EXIT_CODE: '0',
  };
}

function featureWorktreeEnv() {
  // git-dir !== common-dir → linked (feature) worktree
  return {
    MOCK_GIT_TOPLEVEL: '/fake/torque-public/.worktrees/feat-foo',
    MOCK_GIT_DIR: '/fake/torque-public/.worktrees/feat-foo/.git',
    MOCK_GIT_COMMON_DIR: '/fake/torque-public/.git',
    MOCK_GIT_BRANCH: 'feat/foo',
    MOCK_GIT_EXIT_CODE: '0',
  };
}

function nonTorqueRepoEnv() {
  return {
    MOCK_GIT_TOPLEVEL: '/fake/some-other-project',
    MOCK_GIT_DIR: '/fake/some-other-project/.git',
    MOCK_GIT_COMMON_DIR: '/fake/some-other-project/.git',
    MOCK_GIT_BRANCH: 'main',
    MOCK_GIT_EXIT_CODE: '0',
  };
}

function gitFailureEnv() {
  return {
    MOCK_GIT_EXIT_CODE: '128',
  };
}

// ── Tests ──

describe('block-main-edit PreToolUse hook', () => {
  // ── 1. Blocks Edit on main worktree ──
  it('blocks Edit on main worktree of torque-public', () => {
    const env = { ...mainWorktreeEnv(), TORQUE_ALLOW_MAIN_EDIT: '' };
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/fake/torque-public/server/index.js' },
    };

    const { stdout } = runHook(payload, env);
    const output = parseHookOutput(stdout);

    expect(output).not.toBeNull();
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      'torque-public main edit blocked',
    );
  });

  // ── 2. Blocks Write on main worktree ──
  it('blocks Write on main worktree of torque-public', () => {
    const env = { ...mainWorktreeEnv(), TORQUE_ALLOW_MAIN_EDIT: '' };
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: '/fake/torque-public/README.md' },
    };

    const { stdout } = runHook(payload, env);
    const output = parseHookOutput(stdout);

    expect(output).not.toBeNull();
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // ── 3. Blocks NotebookEdit on main worktree ──
  it('blocks NotebookEdit on main worktree of torque-public', () => {
    const env = { ...mainWorktreeEnv(), TORQUE_ALLOW_MAIN_EDIT: '' };
    const payload = {
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/fake/torque-public/notebooks/analysis.ipynb' },
    };

    const { stdout } = runHook(payload, env);
    const output = parseHookOutput(stdout);

    expect(output).not.toBeNull();
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // ── 4. Allows Edit in feature worktree ──
  it('allows Edit in a feature worktree (gitDir !== commonDir)', () => {
    const env = { ...featureWorktreeEnv(), TORQUE_ALLOW_MAIN_EDIT: '' };
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/fake/torque-public/.worktrees/feat-foo/server/index.js' },
    };

    const { stdout } = runHook(payload, env);
    const output = parseHookOutput(stdout);
    expect(output).toBeNull();
  });

  // ── 5. Allows when TORQUE_ALLOW_MAIN_EDIT=1 ──
  it('allows Edit on main worktree when TORQUE_ALLOW_MAIN_EDIT=1', () => {
    const env = { ...mainWorktreeEnv(), TORQUE_ALLOW_MAIN_EDIT: '1' };
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/fake/torque-public/server/index.js' },
    };

    const { stdout } = runHook(payload, env);
    const output = parseHookOutput(stdout);
    expect(output).toBeNull();
  });

  // ── 6. Allows when no file_path or notebook_path in payload ──
  // The hook early-returns when neither file_path nor notebook_path is
  // present. This is the effective "non-edit tool" path — Read, Grep, etc.
  // do not carry file_path in their tool_input for hook purposes.
  it('allows payload with no file_path or notebook_path (non-edit tool path)', () => {
    const env = { ...mainWorktreeEnv(), TORQUE_ALLOW_MAIN_EDIT: '' };
    const payload = {
      tool_name: 'Read',
      tool_input: { some_other_key: '/fake/path' },
    };

    const { stdout } = runHook(payload, env);
    const output = parseHookOutput(stdout);
    expect(output).toBeNull();
  });

  // ── 7. Allows when repo is not torque-public ──
  it('allows Edit when the repo is not torque-public', () => {
    const env = { ...nonTorqueRepoEnv(), TORQUE_ALLOW_MAIN_EDIT: '' };
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/fake/some-other-project/src/main.js' },
    };

    const { stdout } = runHook(payload, env);
    const output = parseHookOutput(stdout);
    expect(output).toBeNull();
  });

  // ── 8. Handles git command failure gracefully (fail-open) ──
  it('does not crash and defaults to approve when git commands fail', () => {
    const env = { ...gitFailureEnv(), TORQUE_ALLOW_MAIN_EDIT: '' };
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/fake/torque-public/server/index.js' },
    };

    const { stdout, status } = runHook(payload, env);
    expect(status).toBe(0);
    const output = parseHookOutput(stdout);
    expect(output).toBeNull();
  });
});
