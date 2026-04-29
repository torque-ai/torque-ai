'use strict';

// Behavioral guard tests for bin/torque-remote-guard. Spawns the bash
// script via stdin and asserts exit codes for each scenario:
// - exit 0 = allow (Claude's Bash command proceeds)
// - exit 2 = block (Claude is told to use torque-remote)
//
// Each test runs in an isolated temp dir containing `.git/` (so the
// guard's find_project_root walks up and stops there) plus a project-
// scoped `.torque-remote.json` that enables interception.
//
// Skipped on platforms without `bash` available (the guard is itself a
// bash script, so a missing `bash` rules out running it at all).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// On the Windows remote, bare `bash` on PATH resolves to WSL's bash (matches
// the existing feedback_test_remote_wsl_bash_trap pattern) — its path-space
// is the WSL VM's, so /c/trt/... or C:/trt/... both miss the host's actual
// filesystem and the script load fails with exit 127. Pin Git Bash via its
// short-name path (matching what bin/torque-remote uses internally). On
// Linux/macOS, fall back to plain `bash`.
const GIT_BASH_WIN = 'C:\\progra~1\\Git\\bin\\bash.exe';
const BASH_BIN = process.platform === 'win32' && fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? GIT_BASH_WIN
  : 'bash';

// Git Bash needs MinGW-style absolute paths (/c/foo/bar) for argv-passed
// script paths; Linux/macOS use POSIX paths from path.resolve directly.
const GUARD_RAW = path.resolve(__dirname, '..', '..', 'bin', 'torque-remote-guard');
const GUARD = GUARD_RAW
  .replace(/\\/g, '/')
  .replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const BASH_PROBE = spawnSync(BASH_BIN, ['--version'], { encoding: 'utf8' });
const BASH_AVAILABLE = BASH_PROBE.status === 0;

const SKIP = !BASH_AVAILABLE || !fs.existsSync(GUARD_RAW);

// Use describe.skipIf when bash or the guard isn't reachable; the test
// file should still load cleanly so the suite reports an explicit skip.
const maybe = SKIP ? describe.skip : describe;

function runGuard(command, cwd) {
  return spawnSync(BASH_BIN, [GUARD], {
    cwd,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    timeout: 10000,
  });
}

function setupRepo(transport, interceptCommands) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-remote-guard-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(
    path.join(dir, '.torque-remote.json'),
    JSON.stringify({ transport, intercept_commands: interceptCommands })
  );
  return dir;
}

maybe('torque-remote-guard', () => {
  let repo;

  beforeEach(() => {
    repo = setupRepo('ssh', ['vitest', 'jest', 'pytest', 'dotnet test', 'dotnet build', 'npm test']);
  });

  afterEach(() => {
    // Windows holds file handles briefly after subprocess exit (Defender/AV
    // scans the .torque-remote.json we just wrote); rmSync intermittently
    // hits EPERM. The temp dir is unique per test under os.tmpdir() and the
    // OS sweeps it eventually, so swallow the cleanup error rather than
    // failing the test on it.
    if (repo) {
      try { fs.rmSync(repo, { recursive: true, force: true }); }
      catch { /* tolerated — see comment above */ }
    }
  });

  describe('git -C <path> subcommand parsing (regression for false-positive blocks)', () => {
    it('allows `git -C /repo commit -m "fix vitest"`', () => {
      const r = runGuard('git -C /tmp/repo commit -m "fix vitest"', repo);
      expect(r.status).toBe(0);
    });

    it('allows `git -C /repo log --grep vitest`', () => {
      const r = runGuard('git -C /tmp/repo log --grep vitest', repo);
      expect(r.status).toBe(0);
    });

    it('allows `git -c user.name=foo commit -m "dotnet test fix"`', () => {
      const r = runGuard('git -c user.name=foo commit -m "dotnet test fix"', repo);
      expect(r.status).toBe(0);
    });

    it('allows `git --git-dir=/path/.git commit -m "msg vitest"`', () => {
      const r = runGuard('git --git-dir=/tmp/.git commit -m "msg vitest"', repo);
      expect(r.status).toBe(0);
    });

    it('allows `git --no-pager log --grep vitest`', () => {
      const r = runGuard('git --no-pager log --grep vitest', repo);
      expect(r.status).toBe(0);
    });

    it('allows `git -C /a -c x=y --no-pager commit -m "vitest fix"`', () => {
      const r = runGuard('git -C /a -c x=y --no-pager commit -m "vitest fix"', repo);
      expect(r.status).toBe(0);
    });
  });

  describe('plain git subcommands (no pre-subcommand options)', () => {
    it('allows `git commit -m "fix vitest"`', () => {
      const r = runGuard('git commit -m "fix vitest"', repo);
      expect(r.status).toBe(0);
    });

    it('allows `git log --grep vitest`', () => {
      const r = runGuard('git log --grep vitest', repo);
      expect(r.status).toBe(0);
    });

    it('allows `git show HEAD~3` even though no intercept pattern matches', () => {
      const r = runGuard('git show HEAD~3', repo);
      expect(r.status).toBe(0);
    });
  });

  describe('genuine intercept-command blocks (regression that the fix did not over-skip)', () => {
    it('blocks `vitest run foo.test.js`', () => {
      const r = runGuard('vitest run foo.test.js', repo);
      expect(r.status).toBe(2);
    });

    it('blocks `npx vitest run`', () => {
      const r = runGuard('npx vitest run', repo);
      expect(r.status).toBe(2);
    });

    it('blocks `dotnet test path/to/foo.csproj`', () => {
      const r = runGuard('dotnet test path/to/foo.csproj', repo);
      expect(r.status).toBe(2);
    });

    it('blocks `node node_modules/vitest/vitest.mjs run` (path-component bypass form)', () => {
      const r = runGuard('node node_modules/vitest/vitest.mjs run', repo);
      expect(r.status).toBe(2);
    });
  });

  describe('local transport', () => {
    it('allows everything when transport=local', () => {
      const localRepo = setupRepo('local', ['vitest']);
      try {
        const r = runGuard('vitest run', localRepo);
        expect(r.status).toBe(0);
      } finally {
        try { fs.rmSync(localRepo, { recursive: true, force: true }); }
        catch { /* tolerated — see afterEach comment */ }
      }
    });
  });

  describe('curl exception (no payload-content scan)', () => {
    it('allows `curl -d "{\\"q\\":\\"vitest\\"}" https://api.example.com`', () => {
      const r = runGuard('curl -d \'{"q":"vitest"}\' https://api.example.com', repo);
      expect(r.status).toBe(0);
    });
  });
});
