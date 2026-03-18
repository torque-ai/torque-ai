'use strict';

const childProcess = require('child_process');

const {
  failoverBackoffMs,
  MAX_BACKOFF_MS,
  BASE_BACKOFF_MS,
} = require('../utils/backoff');
const {
  parseModelSizeB,
  getModelSizeCategory,
  isSmallModel,
  isThinkingModel,
} = require('../utils/model');

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

describe('utils-all', () => {
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

    describe('safeGitExec', () => {
      it('uses safe default process options', () => {
        const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('ok');
        const { safeGitExec } = loadGitUtils();

        expect(safeGitExec(['status', '--porcelain'])).toBe('ok');
        expect(execFileSyncSpy).toHaveBeenCalledWith('git', ['status', '--porcelain'], expect.objectContaining({
          encoding: 'utf8',
          timeout: 4321,
          maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }));
      });

      it('merges caller env with safe git env and preserves explicit overrides', () => {
        const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('ok');
        const { safeGitExec } = loadGitUtils();

        safeGitExec(['status'], {
          cwd: '/repo',
          timeout: 99,
          env: {
            CUSTOM_FLAG: '1',
            GIT_OPTIONAL_LOCKS: '9',
          },
        });

        expect(execFileSyncSpy).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({
          cwd: '/repo',
          timeout: 99,
          env: expect.objectContaining({
            CUSTOM_FLAG: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '9',
          }),
        }));
      });

      it('forwards arbitrary git subcommands unchanged', () => {
        const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('diff-output');
        const { safeGitExec } = loadGitUtils();

        const result = safeGitExec(['diff', '--name-only', 'HEAD~1'], { timeout: 1000 });

        expect(result).toBe('diff-output');
        expect(execFileSyncSpy).toHaveBeenCalledWith('git', ['diff', '--name-only', 'HEAD~1'], expect.objectContaining({
          timeout: 1000,
        }));
      });
    });

    describe('parseGitStatusLine', () => {
      it.each([
        ['returns null for null input', null],
        ['returns null for empty input', ''],
        ['returns null for too-short input', 'M'],
        ['returns null when no file path remains', 'M  '],
      ])('%s', (_label, line) => {
        const { parseGitStatusLine } = loadGitUtils();
        expect(parseGitStatusLine(line)).toBeNull();
      });

      it('parses a staged modification', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine('M  tracked.js')).toEqual({
          indexStatus: 'M',
          workStatus: ' ',
          filePath: 'tracked.js',
          isNew: false,
          isModified: true,
          isDeleted: false,
          isRenamed: false,
        });
      });

      it('parses a worktree-only modification', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine(' M tracked.js')).toEqual(expect.objectContaining({
          indexStatus: ' ',
          workStatus: 'M',
          filePath: 'tracked.js',
          isModified: true,
        }));
      });

      it('parses an untracked file as new', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine('?? new-file.js')).toEqual(expect.objectContaining({
          indexStatus: '?',
          workStatus: '?',
          filePath: 'new-file.js',
          isNew: true,
          isModified: false,
        }));
      });

      it('parses a staged addition as new', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine('A  added.js')).toEqual(expect.objectContaining({
          filePath: 'added.js',
          isNew: true,
          isDeleted: false,
        }));
      });

      it('parses staged deletions', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine('D  removed.js')).toEqual(expect.objectContaining({
          filePath: 'removed.js',
          isDeleted: true,
        }));
      });

      it('parses worktree deletions', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine(' D removed.js')).toEqual(expect.objectContaining({
          indexStatus: ' ',
          workStatus: 'D',
          filePath: 'removed.js',
          isDeleted: true,
        }));
      });

      it('parses rename entries and keeps the rename arrow text', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine('R  old name.js -> new name.js')).toEqual(expect.objectContaining({
          filePath: 'old name.js -> new name.js',
          isRenamed: true,
          isNew: false,
        }));
      });

      it('strips outer quotes from quoted file paths', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine('?? "path with spaces.txt"')).toEqual(expect.objectContaining({
          filePath: 'path with spaces.txt',
          isNew: true,
        }));
      });

      it('trims surrounding whitespace from unquoted file paths', () => {
        const { parseGitStatusLine } = loadGitUtils();

        expect(parseGitStatusLine(' M tracked.js   ')).toEqual(expect.objectContaining({
          filePath: 'tracked.js',
          isModified: true,
        }));
      });
    });

    describe('getModifiedFiles', () => {
      it('returns an empty array for blank porcelain output', () => {
        vi.spyOn(childProcess, 'execFileSync').mockReturnValue(' \n ');
        const { getModifiedFiles } = loadGitUtils();

        expect(getModifiedFiles('/repo')).toEqual([]);
      });

      it('parses multiple porcelain lines and filters malformed entries', () => {
        vi.spyOn(childProcess, 'execFileSync').mockReturnValue(
          'M  tracked.js\n?? new.js\nM  \nR  old.js -> new.js\n'
        );
        const { getModifiedFiles } = loadGitUtils();

        expect(getModifiedFiles('/repo')).toEqual([
          expect.objectContaining({ filePath: 'tracked.js', isModified: true }),
          expect.objectContaining({ filePath: 'new.js', isNew: true }),
          expect.objectContaining({ filePath: 'old.js -> new.js', isRenamed: true }),
        ]);
      });

      it('uses the mocked default git timeout when none is provided', () => {
        const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('M  tracked.js\n');
        const { getModifiedFiles } = loadGitUtils();

        getModifiedFiles('/repo');

        expect(execFileSyncSpy).toHaveBeenCalledWith('git', ['status', '--porcelain'], expect.objectContaining({
          cwd: '/repo',
          timeout: 4321,
        }));
      });
    });

    describe('getWorktreeFingerprint', () => {
      it('combines HEAD and porcelain status into a fingerprint', () => {
        vi.spyOn(childProcess, 'execFileSync')
          .mockReturnValueOnce('abc123\n')
          .mockReturnValueOnce('M  tracked.js\n');
        const { getWorktreeFingerprint } = loadGitUtils();

        expect(getWorktreeFingerprint('/repo')).toBe('abc123\nM  tracked.js');
      });

      it('returns the cached fingerprint while inside the ttl window', () => {
        const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync')
          .mockReturnValueOnce('head-1\n')
          .mockReturnValueOnce('M  first.js\n');
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        const gitUtils = loadGitUtils();

        const first = gitUtils.getWorktreeFingerprint('/repo', { ttl: 100 });
        const second = gitUtils.getWorktreeFingerprint('/repo', { ttl: 100 });

        expect(first).toBe('head-1\nM  first.js');
        expect(second).toBe(first);
        expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
      });

      it('refreshes the fingerprint after the ttl expires', () => {
        vi.spyOn(childProcess, 'execFileSync')
          .mockReturnValueOnce('head-1\n')
          .mockReturnValueOnce('M  first.js\n')
          .mockReturnValueOnce('head-2\n')
          .mockReturnValueOnce('M  second.js\n');
        vi.spyOn(Date, 'now')
          .mockReturnValueOnce(1000)
          .mockReturnValueOnce(1200);
        const gitUtils = loadGitUtils();

        expect(gitUtils.getWorktreeFingerprint('/repo', { ttl: 50 })).toBe('head-1\nM  first.js');
        expect(gitUtils.getWorktreeFingerprint('/repo', { ttl: 50 })).toBe('head-2\nM  second.js');
      });

      it('returns status output with a leading newline when HEAD lookup fails', () => {
        vi.spyOn(childProcess, 'execFileSync')
          .mockImplementationOnce(() => {
            throw new Error('no head');
          })
          .mockReturnValueOnce('?? new.js\n');
        const { getWorktreeFingerprint } = loadGitUtils();

        expect(getWorktreeFingerprint('/repo')).toBe('\n?? new.js');
      });

      it('returns only the HEAD sha when status lookup fails', () => {
        vi.spyOn(childProcess, 'execFileSync')
          .mockReturnValueOnce('abc123\n')
          .mockImplementationOnce(() => {
            throw new Error('status failed');
          });
        const { getWorktreeFingerprint } = loadGitUtils();

        expect(getWorktreeFingerprint('/repo')).toBe('abc123');
      });

      it('returns an empty fingerprint when both git calls fail', () => {
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
          throw new Error('not a repo');
        });
        const { getWorktreeFingerprint } = loadGitUtils();

        expect(getWorktreeFingerprint('/repo')).toBe('');
      });
    });

    describe('invalidateFingerprintCache', () => {
      it('clears only the requested working directory', () => {
        const gitUtils = loadGitUtils();

        gitUtils._fingerprintCache.set('/repo-a', { fingerprint: 'a', timestamp: 1 });
        gitUtils._fingerprintCache.set('/repo-b', { fingerprint: 'b', timestamp: 2 });

        gitUtils.invalidateFingerprintCache('/repo-a');

        expect(gitUtils._fingerprintCache.has('/repo-a')).toBe(false);
        expect(gitUtils._fingerprintCache.has('/repo-b')).toBe(true);
      });

      it('clears the full cache when no directory is provided', () => {
        const gitUtils = loadGitUtils();

        gitUtils._fingerprintCache.set('/repo-a', { fingerprint: 'a', timestamp: 1 });
        gitUtils._fingerprintCache.set('/repo-b', { fingerprint: 'b', timestamp: 2 });

        gitUtils.invalidateFingerprintCache();

        expect(gitUtils._fingerprintCache.size).toBe(0);
      });

      it('forces recomputation after a cached fingerprint is invalidated', () => {
        const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync')
          .mockReturnValueOnce('head-1\n')
          .mockReturnValueOnce('M  first.js\n')
          .mockReturnValueOnce('head-2\n')
          .mockReturnValueOnce('M  second.js\n');
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        const gitUtils = loadGitUtils();

        expect(gitUtils.getWorktreeFingerprint('/repo')).toBe('head-1\nM  first.js');
        gitUtils.invalidateFingerprintCache('/repo');
        expect(gitUtils.getWorktreeFingerprint('/repo')).toBe('head-2\nM  second.js');
        expect(execFileSyncSpy).toHaveBeenCalledTimes(4);
      });
    });
  });

  describe('utils/backoff', () => {
    it('uses the base delay for undefined attempts', () => {
      expect(failoverBackoffMs()).toBe(BASE_BACKOFF_MS);
    });

    it('uses the base delay for zero and negative attempts', () => {
      expect(failoverBackoffMs(0)).toBe(BASE_BACKOFF_MS);
      expect(failoverBackoffMs(-3)).toBe(BASE_BACKOFF_MS);
    });

    it('scales linearly for positive integer attempts', () => {
      expect(failoverBackoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
      expect(failoverBackoffMs(3)).toBe(BASE_BACKOFF_MS * 3);
      expect(failoverBackoffMs(5)).toBe(BASE_BACKOFF_MS * 5);
    });

    it('does not round fractional attempts before applying the cap', () => {
      expect(failoverBackoffMs(1.5)).toBe(7500);
    });

    it('caps the delay at MAX_BACKOFF_MS at and beyond the threshold attempt', () => {
      const cappedAttempt = Math.ceil(MAX_BACKOFF_MS / BASE_BACKOFF_MS);

      expect(failoverBackoffMs(cappedAttempt)).toBe(MAX_BACKOFF_MS);
      expect(failoverBackoffMs(cappedAttempt + 10)).toBe(MAX_BACKOFF_MS);
    });

    it('never exceeds MAX_BACKOFF_MS across a wide attempt range', () => {
      for (let attempt = 1; attempt <= 100; attempt++) {
        expect(failoverBackoffMs(attempt)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      }
    });
  });

  describe('utils/model', () => {
    it('parses colon-delimited integer sizes', () => {
      expect(parseModelSizeB('qwen2.5-coder:32b')).toBe(32);
      expect(parseModelSizeB('gemma3:4b')).toBe(4);
    });

    it('parses decimal sizes after a delimiter', () => {
      expect(parseModelSizeB('model:1.5b')).toBe(1.5);
      expect(parseModelSizeB('model-2.75b-instruct')).toBe(2.75);
    });

    it('parses hyphen and underscore sizes case-insensitively', () => {
      expect(parseModelSizeB('model-7B-instruct')).toBe(7);
      expect(parseModelSizeB('MODEL_14b')).toBe(14);
    });

    it('returns 0 when the size token is missing its delimiter or input is empty', () => {
      expect(parseModelSizeB('model32b')).toBe(0);
      expect(parseModelSizeB('')).toBe(0);
      expect(parseModelSizeB(null)).toBe(0);
      expect(parseModelSizeB(undefined)).toBe(0);
    });

    it('uses the first matching size token in a more complex model name', () => {
      expect(parseModelSizeB('suite:7b-preview-14b')).toBe(7);
    });

    it('returns unknown when a size cannot be parsed', () => {
      expect(getModelSizeCategory('gpt-4')).toBe('unknown');
    });

    it('classifies 8B and below as small', () => {
      expect(getModelSizeCategory('model:1.5b')).toBe('small');
      expect(getModelSizeCategory('model:8b')).toBe('small');
    });

    it('classifies sizes above 8B through 20B as medium', () => {
      expect(getModelSizeCategory('model:8.1b')).toBe('medium');
      expect(getModelSizeCategory('model:20b')).toBe('medium');
    });

    it('classifies sizes above 20B as large', () => {
      expect(getModelSizeCategory('model:20.1b')).toBe('large');
      expect(getModelSizeCategory('model:70b')).toBe('large');
    });

    it('treats mini and tiny model names as small regardless of parsed size', () => {
      expect(isSmallModel('gpt-4-mini')).toBe(true);
      expect(isSmallModel('TinyLlama:70b')).toBe(true);
    });

    it('treats parsed sizes of 8B and below as small', () => {
      expect(isSmallModel('model:4b')).toBe(true);
      expect(isSmallModel('model:8b')).toBe(true);
    });

    it('does not treat large or unparseable non-mini models as small', () => {
      expect(isSmallModel('model:14b')).toBe(false);
      expect(isSmallModel('gpt-4')).toBe(false);
      expect(isSmallModel(null)).toBe(false);
    });

    it('detects deepseek thinking families case-insensitively', () => {
      expect(isThinkingModel('DeepSeek-R1:32b')).toBe(true);
      expect(isThinkingModel('deepseek-r2:70b')).toBe(true);
    });

    it('detects qwq and /r1 markers', () => {
      expect(isThinkingModel('QWQ:32b')).toBe(true);
      expect(isThinkingModel('provider/r1-model')).toBe(true);
    });

    it('returns false for standard non-thinking models', () => {
      expect(isThinkingModel('qwen2.5-coder:32b')).toBe(false);
      expect(isThinkingModel('llama3:70b')).toBe(false);
      expect(isThinkingModel('')).toBe(false);
    });

    it('supports numeric ordering by parsed model size', () => {
      const models = ['qwen2.5-coder:32b', 'gpt-4', 'gemma3:4b', 'deepseek-r1:14b'];
      const sorted = [...models].sort((left, right) => {
        const leftSize = parseModelSizeB(left) || Number.POSITIVE_INFINITY;
        const rightSize = parseModelSizeB(right) || Number.POSITIVE_INFINITY;
        return leftSize - rightSize;
      });

      expect(sorted).toEqual([
        'gemma3:4b',
        'deepseek-r1:14b',
        'qwen2.5-coder:32b',
        'gpt-4',
      ]);
    });
  });
});
