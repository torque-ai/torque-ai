'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRAPPER_PATH = path.join(REPO_ROOT, 'bin', 'torque-push');
const PS_SHIM_PATH = path.join(REPO_ROOT, 'bin', 'torque-push-shim.ps1');
const CMD_SHIM_PATH = path.join(REPO_ROOT, 'bin', 'torque-push.cmd');
const GIT_BASH_PATH = path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
const BASH_EXECUTABLE = process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)
  ? GIT_BASH_PATH
  : 'bash';

const LOCAL_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function toBashPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
}

function makeFakeGitEnv(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-push-test-'));
  const repo = path.join(root, 'repo');
  const fakeBin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  const gitPath = path.join(fakeBin, process.platform === 'win32' ? 'git.cmd' : 'git');
  const bashGitPath = path.join(fakeBin, 'git');
  const fakeGit = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"

if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  printf '%s\\n' "$FAKE_REPO"
  exit 0
fi
if [ "$1" = "symbolic-ref" ]; then
  printf '%s\\n' "$FAKE_BRANCH"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then
  printf '%s\\n' "$FAKE_UPSTREAM"
  exit 0
fi
if [ "$1" = "rev-parse" ]; then
  case "$2" in
    *'^{commit}')
      printf '%s\\n' "$FAKE_LOCAL_SHA"
      exit 0
      ;;
  esac
fi
if [ "$1" = "ls-remote" ]; then
  if [ -f "$FAKE_STATE/push-called" ]; then
    printf '%s\\trefs/heads/main\\n' "$FAKE_REMOTE_AFTER"
  else
    printf '%s\\trefs/heads/main\\n' "$FAKE_REMOTE_BEFORE"
  fi
  exit 0
fi
if [ "$1" = "push" ]; then
  touch "$FAKE_STATE/push-called"
  if [ -n "$FAKE_PUSH_STDOUT" ]; then printf '%s\\n' "$FAKE_PUSH_STDOUT"; fi
  if [ -n "$FAKE_PUSH_STDERR" ]; then printf '%s\\n' "$FAKE_PUSH_STDERR" >&2; fi
  exit "$FAKE_PUSH_EXIT"
fi

printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 64
`;
  fs.writeFileSync(bashGitPath, fakeGit, { mode: 0o755 });
  if (process.platform === 'win32') {
    fs.writeFileSync(gitPath, `@echo off\r\nbash "%~dp0git" %*\r\n`, { mode: 0o755 });
  }

  const env = {
    ...process.env,
    FAKE_BIN: toBashPath(fakeBin),
    FAKE_REPO: toBashPath(repo),
    FAKE_STATE: toBashPath(state),
    FAKE_GIT_LOG: toBashPath(path.join(state, 'git.log')),
    FAKE_BRANCH: options.branch || 'main',
    FAKE_UPSTREAM: options.upstream || 'origin/main',
    FAKE_LOCAL_SHA: options.localSha || LOCAL_SHA,
    FAKE_REMOTE_BEFORE: options.remoteBefore || OLD_SHA,
    FAKE_REMOTE_AFTER: options.remoteAfter || options.remoteBefore || OLD_SHA,
    FAKE_PUSH_EXIT: String(options.pushExit ?? 0),
    FAKE_PUSH_STDOUT: options.pushStdout || '',
    FAKE_PUSH_STDERR: options.pushStderr || '',
  };

  return {
    root,
    repo,
    fakeBin,
    env,
    logPath: env.FAKE_GIT_LOG,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runWrapper(fake, args = []) {
  return spawnSync(BASH_EXECUTABLE, [
    '-lc',
    'PATH="$FAKE_BIN:$PATH"; export PATH; "$TORQUE_PUSH_WRAPPER" "$@"',
    'torque-push-test',
    ...args,
  ], {
    cwd: fake.repo,
    env: {
      ...fake.env,
      TORQUE_PUSH_WRAPPER: toBashPath(WRAPPER_PATH),
    },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function runPowerShellShim(fake, args = []) {
  const pathEnv = `${fake.env.FAKE_BIN}:${process.env.PATH || process.env.Path || ''}`;
  return spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PS_SHIM_PATH,
    ...args,
  ], {
    cwd: fake.repo,
    env: {
      ...fake.env,
      GIT_BASH: BASH_EXECUTABLE,
      TORQUE_PUSH_BASH_PATH_PREFIX: fake.env.FAKE_BIN,
      Path: pathEnv,
      PATH: pathEnv,
    },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
}

function runCmdShim(fake, args = []) {
  const pathEnv = `${fake.env.FAKE_BIN}:${process.env.PATH || process.env.Path || ''}`;
  return spawnSync('cmd.exe', [
    '/d',
    '/c',
    CMD_SHIM_PATH,
    ...args,
  ], {
    cwd: fake.repo,
    env: {
      ...fake.env,
      GIT_BASH: BASH_EXECUTABLE,
      TORQUE_PUSH_BASH_PATH_PREFIX: fake.env.FAKE_BIN,
      Path: pathEnv,
      PATH: pathEnv,
    },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
}

describe('torque-push wrapper', () => {
  it('is installed by the user-bin refresh path', () => {
    const installUserbin = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install-userbin.sh'), 'utf8');
    expect(installUserbin).toContain('"torque-push"');
    expect(installUserbin).toContain('"torque-push.cmd"');
    expect(installUserbin).toContain('"torque-push-shim.ps1"');
  });

  it('ships a command-discoverable Windows launcher for the PowerShell shim', () => {
    const launcher = fs.readFileSync(CMD_SHIM_PATH, 'utf8');
    expect(launcher).toContain('torque-push-shim.ps1');
    expect(launcher).toContain('-ExecutionPolicy Bypass');
    expect(launcher).toContain('exit /b %ERRORLEVEL%');
  });

  it('skips raw git push when origin/main is already at local HEAD', () => {
    const fake = makeFakeGitEnv({ remoteBefore: LOCAL_SHA, pushStdout: 'unexpected push' });
    try {
      const result = runWrapper(fake);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('origin/main already at');
      expect(result.stdout).not.toContain('unexpected push');
    } finally {
      fake.cleanup();
    }
  });

  it('treats a concurrent same-SHA remote update as successful after raw push reports CAS failure', () => {
    const fake = makeFakeGitEnv({
      remoteBefore: OLD_SHA,
      remoteAfter: LOCAL_SHA,
      pushExit: 1,
      pushStderr: " ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main')",
    });
    try {
      const result = runWrapper(fake);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('cannot lock ref');
      expect(result.stdout).toContain('treating as success');
    } finally {
      fake.cleanup();
    }
  });

  it('passes non-main pushes through to git unchanged', () => {
    const fake = makeFakeGitEnv({
      branch: 'feature',
      upstream: 'origin/feature',
      pushStdout: 'feature push ok',
    });
    try {
      const result = runWrapper(fake, ['origin', 'feature']);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('feature push ok');
    } finally {
      fake.cleanup();
    }
  });

  const psIt = process.platform === 'win32' ? it : it.skip;
  psIt('PowerShell shim delegates to the guarded Bash wrapper and preserves success', () => {
    const fake = makeFakeGitEnv({ remoteBefore: LOCAL_SHA, pushStdout: 'unexpected push' });
    try {
      const result = runPowerShellShim(fake);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('origin/main already at');
      expect(result.stdout).not.toContain('unexpected push');
    } finally {
      fake.cleanup();
    }
  });

  psIt('Windows command launcher delegates to PowerShell shim and preserves success', () => {
    const fake = makeFakeGitEnv({ remoteBefore: LOCAL_SHA, pushStdout: 'unexpected push' });
    try {
      const result = runCmdShim(fake);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('origin/main already at');
      expect(result.stdout).not.toContain('unexpected push');
    } finally {
      fake.cleanup();
    }
  });
});
