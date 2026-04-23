'use strict';

const childProcess = require('child_process');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const GIT_MODULE_PATH = require.resolve('../utils/git');
const CONSTANTS_MODULE_PATH = require.resolve('../constants');
const originalConstantsCache = require.cache[CONSTANTS_MODULE_PATH];
const mockConstants = {
  TASK_TIMEOUTS: {
    GIT_STATUS: 4321,
  },
};

function restoreConstantsModule() {
  if (originalConstantsCache) {
    require.cache[CONSTANTS_MODULE_PATH] = originalConstantsCache;
  } else {
    delete require.cache[CONSTANTS_MODULE_PATH];
  }
}

function unloadGitModule() {
  delete require.cache[GIT_MODULE_PATH];
}

function loadGitUtils() {
  unloadGitModule();
  installMock('../constants', mockConstants);
  return require('../utils/git');
}

describe('utils/git', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    restoreConstantsModule();
    unloadGitModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreConstantsModule();
    unloadGitModule();
  });

  it('exports the safe git environment defaults', () => {
    const { GIT_SAFE_ENV } = loadGitUtils();

    expect(GIT_SAFE_ENV).toEqual(expect.objectContaining({
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    }));
  });

  describe('parseGitStatusLine', () => {
    it('parses common porcelain status formats', () => {
      const { parseGitStatusLine } = loadGitUtils();

      const cases = [
        {
          line: 'M  tracked.js',
          expected: {
            indexStatus: 'M',
            workStatus: ' ',
            filePath: 'tracked.js',
            isNew: false,
            isModified: true,
            isDeleted: false,
            isRenamed: false,
          },
        },
        {
          line: 'A  added.js',
          expected: {
            indexStatus: 'A',
            workStatus: ' ',
            filePath: 'added.js',
            isNew: true,
            isModified: false,
            isDeleted: false,
            isRenamed: false,
          },
        },
        {
          line: ' D removed.js',
          expected: {
            indexStatus: ' ',
            workStatus: 'D',
            filePath: 'removed.js',
            isNew: false,
            isModified: false,
            isDeleted: true,
            isRenamed: false,
          },
        },
        {
          line: '?? untracked.js',
          expected: {
            indexStatus: '?',
            workStatus: '?',
            filePath: 'untracked.js',
            isNew: true,
            isModified: false,
            isDeleted: false,
            isRenamed: false,
          },
        },
        {
          line: 'R  old name.js -> new name.js',
          expected: {
            indexStatus: 'R',
            workStatus: ' ',
            filePath: 'old name.js -> new name.js',
            isNew: false,
            isModified: false,
            isDeleted: false,
            isRenamed: true,
          },
        },
        {
          line: '?? "path with spaces.txt"',
          expected: {
            indexStatus: '?',
            workStatus: '?',
            filePath: 'path with spaces.txt',
            isNew: true,
            isModified: false,
            isDeleted: false,
            isRenamed: false,
          },
        },
      ];

      for (const { line, expected } of cases) {
        expect(parseGitStatusLine(line)).toMatchObject(expected);
      }
    });

    it('returns null for blank or malformed status lines', () => {
      const { parseGitStatusLine } = loadGitUtils();

      expect(parseGitStatusLine('')).toBeNull();
      expect(parseGitStatusLine('M')).toBeNull();
      expect(parseGitStatusLine('?? ')).toBeNull();
    });
  });

  describe('safeGitExec', () => {
    it('executes git with safe defaults and merged environment variables', () => {
      const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('status-output');
      const { safeGitExec } = loadGitUtils();

      const result = safeGitExec(['status', '--porcelain'], {
        cwd: 'C:\\repo',
        env: {
          CUSTOM_FLAG: '1',
          GIT_OPTIONAL_LOCKS: '9',
        },
      });

      expect(result).toBe('status-output');
      expect(execFileSyncSpy).toHaveBeenCalledWith('git', ['status', '--porcelain'], expect.objectContaining({
        cwd: 'C:\\repo',
        encoding: 'utf8',
        timeout: 4321,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: expect.objectContaining({
          CUSTOM_FLAG: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '9',
        }),
      }));
    });

    it('rethrows git execution errors', () => {
      const execError = new Error('git failed');
      vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        throw execError;
      });
      const { safeGitExec } = loadGitUtils();

      expect(() => safeGitExec(['status', '--porcelain'])).toThrow(execError);
    });
  });

  describe('cleanupStaleGitStatusProcesses', () => {
    it('does nothing off Windows', () => {
      const execFileSyncSpy = vi.fn();
      const { cleanupStaleGitStatusProcesses } = loadGitUtils();

      const cleaned = cleanupStaleGitStatusProcesses({
        platform: 'linux',
        execFileSync: execFileSyncSpy,
        allowInTest: true,
      });

      expect(cleaned).toBe(0);
      expect(execFileSyncSpy).not.toHaveBeenCalled();
    });

    it('terminates only stale orphaned git status probes through a hidden PowerShell sweep', () => {
      const execFileSyncSpy = vi.fn(() => '111\r\n222\r\n');
      const { cleanupStaleGitStatusProcesses } = loadGitUtils();

      const cleaned = cleanupStaleGitStatusProcesses({
        platform: 'win32',
        execFileSync: execFileSyncSpy,
        allowInTest: true,
        force: true,
        minAgeMs: 60000,
      });

      expect(cleaned).toBe(2);
      expect(execFileSyncSpy).toHaveBeenCalledWith('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        expect.stringContaining('status\\s+--porcelain'),
      ], expect.objectContaining({
        timeout: 10000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      const script = execFileSyncSpy.mock.calls[0][1][5];
      expect(script).toContain("Name -ieq 'git.exe'");
      expect(script).toContain('ParentProcessId');
      expect(script).toContain('Stop-Process');
    });
  });

  describe('getModifiedFiles', () => {
    it('parses porcelain output into file entries', () => {
      const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue(
        'M  tracked.js\nA  added.js\n D removed.js\n?? new.js\nR  old.js -> renamed.js\n'
      );
      const { getModifiedFiles } = loadGitUtils();

      const files = getModifiedFiles('C:\\repo', { timeout: 99 });

      expect(files).toEqual([
        expect.objectContaining({ filePath: 'tracked.js', isModified: true }),
        expect.objectContaining({ filePath: 'added.js', isNew: true }),
        expect.objectContaining({ filePath: 'removed.js', isDeleted: true }),
        expect.objectContaining({ filePath: 'new.js', isNew: true }),
        expect.objectContaining({ filePath: 'old.js -> renamed.js', isRenamed: true }),
      ]);
      expect(execFileSyncSpy).toHaveBeenCalledWith('git', ['status', '--porcelain'], expect.objectContaining({
        cwd: 'C:\\repo',
        timeout: 99,
      }));
    });

    it('returns an empty array when git status is empty', () => {
      vi.spyOn(childProcess, 'execFileSync').mockReturnValue(' \n ');
      const { getModifiedFiles } = loadGitUtils();

      expect(getModifiedFiles('C:\\repo')).toEqual([]);
    });
  });

  describe('getWorktreeFingerprint', () => {
    it('builds and caches a fingerprint string within the ttl window', () => {
      const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync')
        .mockReturnValueOnce('abc123\n')
        .mockReturnValueOnce('M  tracked.js\n');
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      const gitUtils = loadGitUtils();

      const fingerprint1 = gitUtils.getWorktreeFingerprint('C:\\repo', { ttl: 100 });
      const fingerprint2 = gitUtils.getWorktreeFingerprint('C:\\repo', { ttl: 100 });

      expect(typeof fingerprint1).toBe('string');
      expect(fingerprint1).toBe('abc123\nM  tracked.js');
      expect(fingerprint2).toBe(fingerprint1);
      expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
      expect(gitUtils._fingerprintCache.get('C:\\repo')).toEqual({
        fingerprint: fingerprint1,
        timestamp: 1000,
      });
    });

    it('refreshes the fingerprint after the ttl expires', () => {
      const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync')
        .mockReturnValueOnce('head-1\n')
        .mockReturnValueOnce('M  first.js\n')
        .mockReturnValueOnce('head-2\n')
        .mockReturnValueOnce('M  second.js\n');
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1200)
        .mockReturnValue(1200);
      const gitUtils = loadGitUtils();

      const fingerprint1 = gitUtils.getWorktreeFingerprint('C:\\repo', { ttl: 50 });
      const fingerprint2 = gitUtils.getWorktreeFingerprint('C:\\repo', { ttl: 50 });

      expect(fingerprint1).toBe('head-1\nM  first.js');
      expect(fingerprint2).toBe('head-2\nM  second.js');
      expect(execFileSyncSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe('invalidateFingerprintCache', () => {
    it('clears a single cached worktree entry', () => {
      const gitUtils = loadGitUtils();

      gitUtils._fingerprintCache.set('C:\\repo-a', { fingerprint: 'a', timestamp: 1 });
      gitUtils._fingerprintCache.set('C:\\repo-b', { fingerprint: 'b', timestamp: 2 });

      gitUtils.invalidateFingerprintCache('C:\\repo-a');

      expect(gitUtils._fingerprintCache.has('C:\\repo-a')).toBe(false);
      expect(gitUtils._fingerprintCache.has('C:\\repo-b')).toBe(true);
    });

    it('clears the full fingerprint cache when no directory is provided', () => {
      const gitUtils = loadGitUtils();

      gitUtils._fingerprintCache.set('C:\\repo-a', { fingerprint: 'a', timestamp: 1 });
      gitUtils._fingerprintCache.set('C:\\repo-b', { fingerprint: 'b', timestamp: 2 });

      gitUtils.invalidateFingerprintCache();

      expect(gitUtils._fingerprintCache.size).toBe(0);
    });
  });
});
