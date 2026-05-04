'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { shouldUseDetachedPath } = require('../providers/execute-cli');
const serverConfig = require('../config');

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-detach-f-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function tmpNonRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'torque-detach-f-nonrepo-'));
}

describe('shouldUseDetachedPath — Phase F dispatch routing', () => {
  const ORIG_FLAG = process.env.TORQUE_DETACHED_SUBPROCESSES;
  const cleanupDirs = [];
  let serverConfigGetSpy;

  beforeEach(() => {
    delete process.env.TORQUE_DETACHED_SUBPROCESSES;
    // Default the cli_worktree_isolation read to '0' (off); individual
    // tests rebind the spy to flip it on.
    serverConfigGetSpy = vi.spyOn(serverConfig, 'get').mockImplementation((key) => {
      if (key === 'cli_worktree_isolation') return '0';
      return null;
    });
  });

  afterEach(() => {
    serverConfigGetSpy.mockRestore();
  });

  afterAll(() => {
    if (ORIG_FLAG === undefined) delete process.env.TORQUE_DETACHED_SUBPROCESSES;
    else process.env.TORQUE_DETACHED_SUBPROCESSES = ORIG_FLAG;
    for (const dir of cleanupDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function setWorktreeIsolation(value) {
    serverConfigGetSpy.mockImplementation((key) => {
      if (key === 'cli_worktree_isolation') return value;
      return null;
    });
  }

  it('returns false when TORQUE_DETACHED_SUBPROCESSES is unset (flag off — default)', () => {
    expect(shouldUseDetachedPath({ provider: 'codex', task: {} })).toBe(false);
    expect(shouldUseDetachedPath({ provider: 'codex-spark', task: {} })).toBe(false);
    expect(shouldUseDetachedPath({ provider: 'claude-cli', task: {} })).toBe(false);
  });

  describe('with TORQUE_DETACHED_SUBPROCESSES=1', () => {
    beforeEach(() => { process.env.TORQUE_DETACHED_SUBPROCESSES = '1'; });

    it('routes codex to the detached path', () => {
      expect(shouldUseDetachedPath({ provider: 'codex', task: {} })).toBe(true);
    });

    it('routes codex-spark to the detached path', () => {
      expect(shouldUseDetachedPath({ provider: 'codex-spark', task: {} })).toBe(true);
    });

    it('routes claude-cli to the detached path when worktree isolation is off', () => {
      expect(shouldUseDetachedPath({ provider: 'claude-cli', task: { working_directory: process.cwd() } })).toBe(true);
    });

    it('keeps claude-cli on the pipe path when cli_worktree_isolation=1 and the cwd is a git repo', () => {
      const dir = tmpGitRepo();
      cleanupDirs.push(dir);
      setWorktreeIsolation('1');
      expect(shouldUseDetachedPath({ provider: 'claude-cli', task: { working_directory: dir } })).toBe(false);
    });

    // The "not a git repo" case is intentionally not covered here.
    // gitWorktree.isGitRepo() walks up the directory tree, so a tmp dir
    // created on a worker that already lives inside any git checkout
    // (e.g. the remote workstation's project root) returns true and the
    // test is non-deterministic across environments. The fall-through
    // to detached when isolation is off is already covered by the next
    // test case below.

    it('routes claude-cli to the detached path when cli_worktree_isolation is unset', () => {
      const dir = tmpGitRepo();
      cleanupDirs.push(dir);
      // Default value (no setForTest call needed; beforeEach reset it to '0')
      expect(shouldUseDetachedPath({ provider: 'claude-cli', task: { working_directory: dir } })).toBe(true);
    });

    it('routes codex to detached even with cli_worktree_isolation=1 (codex never uses worktrees)', () => {
      const dir = tmpGitRepo();
      cleanupDirs.push(dir);
      setWorktreeIsolation('1');
      expect(shouldUseDetachedPath({ provider: 'codex', task: { working_directory: dir } })).toBe(true);
      expect(shouldUseDetachedPath({ provider: 'codex-spark', task: { working_directory: dir } })).toBe(true);
    });

    it('keeps non-eligible providers on the pipe path (ollama, claude-code-sdk, etc.)', () => {
      expect(shouldUseDetachedPath({ provider: 'ollama', task: {} })).toBe(false);
      expect(shouldUseDetachedPath({ provider: 'ollama-agentic', task: {} })).toBe(false);
      expect(shouldUseDetachedPath({ provider: 'claude-code-sdk', task: {} })).toBe(false);
      expect(shouldUseDetachedPath({ provider: 'cerebras', task: {} })).toBe(false);
      expect(shouldUseDetachedPath({ provider: 'unknown-provider', task: {} })).toBe(false);
    });

    it('handles missing task object without throwing', () => {
      expect(shouldUseDetachedPath({ provider: 'codex' })).toBe(true);
      expect(shouldUseDetachedPath({ provider: 'claude-cli' })).toBe(true);
    });
  });
});
