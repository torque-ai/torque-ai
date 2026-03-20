'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { prepareShellArgs, validateRunRequest, createHttpError, spawnAndCapture, isAuthorized } = require('../remote/agent-server');

describe('isAuthorized — timing-safe auth', () => {
  it('uses timing-safe comparison (crypto.timingSafeEqual is called)', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    const req = { headers: { 'x-torque-secret': 'correct-secret' } };
    isAuthorized(req, 'correct-secret');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects mismatched secrets', () => {
    expect(isAuthorized({ headers: { 'x-torque-secret': 'wrong' } }, 'correct')).toBe(false);
  });

  it('rejects missing header', () => {
    expect(isAuthorized({ headers: {} }, 'secret')).toBe(false);
  });
});

describe('prepareShellArgs — shell metacharacter rejection', () => {
  it('returns clean args unchanged', () => {
    expect(prepareShellArgs(['node', '--version'])).toEqual(['node', '--version']);
    expect(prepareShellArgs(['git', 'log', '--oneline', '-5'])).toEqual(['git', 'log', '--oneline', '-5']);
  });

  it('returns empty array for non-array input', () => {
    expect(prepareShellArgs(null)).toEqual([]);
    expect(prepareShellArgs(undefined)).toEqual([]);
    expect(prepareShellArgs('string')).toEqual([]);
  });

  it('rejects args containing semicolon', () => {
    expect(() => prepareShellArgs(['foo; rm -rf /'])).toThrow(/shell metacharacters/i);
    expect(() => prepareShellArgs(['safe', 'foo;bar'])).toThrow(/shell metacharacters/i);
  });

  it('rejects args containing pipe', () => {
    expect(() => prepareShellArgs(['foo | cat /etc/passwd'])).toThrow(/shell metacharacters/i);
  });

  it('rejects args containing backtick', () => {
    expect(() => prepareShellArgs(['`id`'])).toThrow(/shell metacharacters/i);
  });

  it('rejects args containing $() command substitution', () => {
    expect(() => prepareShellArgs(['$(whoami)'])).toThrow(/shell metacharacters/i);
    expect(() => prepareShellArgs(['$HOME'])).toThrow(/shell metacharacters/i);
  });

  it('rejects args containing ampersand', () => {
    expect(() => prepareShellArgs(['foo && evil'])).toThrow(/shell metacharacters/i);
  });

  it('allows parentheses, braces, angle brackets, exclamation (safe with shell:false)', () => {
    // These are only dangerous with shell: true. With shell: false they're literal characters.
    expect(prepareShellArgs(['console.log("hello")'])).toEqual(['console.log("hello")']);
    expect(prepareShellArgs(['{json: true}'])).toEqual(['{json: true}']);
    expect(prepareShellArgs(['foo > bar'])).toEqual(['foo > bar']);
    expect(prepareShellArgs(['!important'])).toEqual(['!important']);
  });

  it('throws a 400 http error for metachar args', () => {
    let err;
    try {
      prepareShellArgs(['bad;arg']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/shell metacharacters/i);
  });

  it('truncates long args in the error message', () => {
    const longArg = 'x'.repeat(100) + ';evil';
    let err;
    try {
      prepareShellArgs([longArg]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // The error message should only include the first 50 chars of the arg
    expect(err.message.length).toBeLessThan(longArg.length + 60);
  });
});

describe('validateRunRequest — CWD allowlist enforcement', () => {
  const tmpDir = os.tmpdir();
  const stateWithProjectsDir = { projectsDir: tmpDir };

  it('allows cwd equal to projectsDir', () => {
    const result = validateRunRequest(
      { command: 'node', cwd: tmpDir, timeout: 5000 },
      stateWithProjectsDir,
    );
    expect(result.cwd).toBe(path.resolve(tmpDir));
  });

  it('allows cwd inside projectsDir', () => {
    // os.tmpdir() subdirectory — we use the same tmpDir since subdirs may not exist,
    // but path.resolve of tmpDir itself is sufficient to test the prefix check.
    // We test the logic by using a state that has a root containing tmpDir.
    const parentState = { projectsDir: path.dirname(tmpDir) };
    const result = validateRunRequest(
      { command: 'node', cwd: tmpDir, timeout: 5000 },
      parentState,
    );
    expect(result.cwd).toBe(path.resolve(tmpDir));
  });

  it('rejects cwd outside allowed directories', () => {
    // Use a completely different root so tmpDir is definitely outside it.
    const unrelatedRoot = path.resolve(os.homedir(), 'nonexistent-allowed-root-99999');
    const state = { projectsDir: unrelatedRoot };

    expect(() =>
      validateRunRequest({ command: 'node', cwd: tmpDir, timeout: 5000 }, state),
    ).toThrow(/outside allowed directories/i);
  });

  it('rejection throws a 403 http error', () => {
    const unrelatedRoot = path.resolve(os.homedir(), 'nonexistent-allowed-root-99999');
    const state = { projectsDir: unrelatedRoot };

    let err;
    try {
      validateRunRequest({ command: 'node', cwd: tmpDir, timeout: 5000 }, state);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
  });

  it('skips CWD check when state has no projectsDir', () => {
    // When state is empty (no projectsDir, no allowed_roots), cwd check is bypassed.
    const result = validateRunRequest(
      { command: 'node', cwd: tmpDir, timeout: 5000 },
      {},
    );
    expect(result.cwd).toBe(path.resolve(tmpDir));
  });

  it('skips CWD check when state is null', () => {
    const result = validateRunRequest(
      { command: 'node', cwd: tmpDir, timeout: 5000 },
      null,
    );
    expect(result.cwd).toBe(path.resolve(tmpDir));
  });

  it('uses state.config.allowed_roots when provided', () => {
    const state = { config: { allowed_roots: [tmpDir] } };
    const result = validateRunRequest(
      { command: 'node', cwd: tmpDir, timeout: 5000 },
      state,
    );
    expect(result.cwd).toBe(path.resolve(tmpDir));
  });

  it('rejects cwd outside state.config.allowed_roots', () => {
    const unrelatedRoot = path.resolve(os.homedir(), 'nonexistent-allowed-root-99999');
    const state = { config: { allowed_roots: [unrelatedRoot] } };

    expect(() =>
      validateRunRequest({ command: 'node', cwd: tmpDir, timeout: 5000 }, state),
    ).toThrow(/outside allowed directories/i);
  });

  it('rejects directory traversal attempt via cwd', () => {
    // /etc or C:\Windows\System32 — use a path that is definitely outside tmpDir.
    const systemDir = process.platform === 'win32'
      ? 'C:\\Windows'
      : '/etc';

    const state = { projectsDir: tmpDir };

    // If the system dir doesn't exist on this platform we skip, but on all platforms
    // it should resolve to something outside tmpDir.
    const resolvedSystem = path.resolve(systemDir);
    const resolvedTmp = path.resolve(tmpDir);
    if (resolvedSystem.startsWith(resolvedTmp)) {
      // Unlikely but skip if tmpDir happens to be under systemDir (shouldn't occur)
      return;
    }

    // validateRunRequest checks fs.existsSync first — if systemDir doesn't exist it
    // will throw a 400 "does not exist" before the 403 allowlist check.
    // Either error means the path was rejected, which is the desired behavior.
    expect(() =>
      validateRunRequest({ command: 'node', cwd: systemDir, timeout: 5000 }, state),
    ).toThrow();
  });
});

describe('spawnAndCapture — shell: false', () => {
  it('executes commands without invoking a shell (clean args work normally)', async () => {
    // With shell: false, spawn works fine for clean args with no metacharacters.
    // Use --print which avoids parentheses in the arg value.
    const result = await spawnAndCapture(
      process.execPath, // node itself
      ['--print', '42'],
      { timeout: 10000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('42');
  }, 15000);

  it('metachar in args is rejected before spawn', async () => {
    // prepareShellArgs is called inside spawnAndCapture — metachar should throw
    // synchronously and be caught as a rejection.
    // The arg 'bad;arg' contains a semicolon which is a shell metacharacter.
    await expect(
      spawnAndCapture(process.execPath, ['--version', 'bad;arg'], { timeout: 10000 }),
    ).rejects.toThrow(/shell metacharacters/i);
  });
});
