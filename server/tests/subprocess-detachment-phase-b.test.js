'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { isSubprocessDetachmentEnabled } = require('../utils/subprocess-detachment');
const { parseProcessExitAnnotation } = require('../providers/execute-cli');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const WRAPPER = path.resolve(__dirname, '..', 'utils', 'process-exit-wrapper.js');

describe('isSubprocessDetachmentEnabled', () => {
  // Phase G flipped the default to ON. The env var is now an opt-OUT
  // hatch (set to 0 / false / no / off to revert to legacy pipe path).
  const ORIG = process.env.TORQUE_DETACHED_SUBPROCESSES;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.TORQUE_DETACHED_SUBPROCESSES;
    else process.env.TORQUE_DETACHED_SUBPROCESSES = ORIG;
  });

  it('returns true when env var is unset (Phase G default-on)', () => {
    delete process.env.TORQUE_DETACHED_SUBPROCESSES;
    expect(isSubprocessDetachmentEnabled()).toBe(true);
  });

  it('returns true when env var is empty string (treat as unset)', () => {
    process.env.TORQUE_DETACHED_SUBPROCESSES = '';
    expect(isSubprocessDetachmentEnabled()).toBe(true);
  });

  it('still returns true for the historical opt-in values "1" / "true"', () => {
    process.env.TORQUE_DETACHED_SUBPROCESSES = '1';
    expect(isSubprocessDetachmentEnabled()).toBe(true);
    process.env.TORQUE_DETACHED_SUBPROCESSES = 'true';
    expect(isSubprocessDetachmentEnabled()).toBe(true);
    process.env.TORQUE_DETACHED_SUBPROCESSES = 'TRUE';
    expect(isSubprocessDetachmentEnabled()).toBe(true);
  });

  it('returns false for the explicit opt-out values 0 / false / no / off (case-insensitive)', () => {
    for (const v of ['0', 'false', 'FALSE', 'False', 'no', 'NO', 'off', 'OFF']) {
      process.env.TORQUE_DETACHED_SUBPROCESSES = v;
      expect(isSubprocessDetachmentEnabled(), `value ${JSON.stringify(v)} should disable`).toBe(false);
    }
  });

  it('returns true for any other unrecognized value (default-on wins; never silently revert)', () => {
    for (const v of ['yes', 'on', 'maybe', 'banana', '2', 'any-string']) {
      process.env.TORQUE_DETACHED_SUBPROCESSES = v;
      expect(isSubprocessDetachmentEnabled(), `value ${JSON.stringify(v)} should keep default-on`).toBe(true);
    }
  });
});

describe('parseProcessExitAnnotation', () => {
  it('parses a typical wrapper-emitted annotation', () => {
    const text = 'some prior output\n[process-exit] code=0 signal=none duration_ms=12345 provider=codex model=gpt-5.3-codex\n';
    expect(parseProcessExitAnnotation(text)).toEqual({
      code: 0, signal: null, duration_ms: 12345,
    });
  });

  it('returns null when annotation is absent', () => {
    expect(parseProcessExitAnnotation('arbitrary log lines\nnothing fancy')).toBeNull();
    expect(parseProcessExitAnnotation('')).toBeNull();
    expect(parseProcessExitAnnotation(null)).toBeNull();
  });

  it('prefers the LAST annotation when multiple exist (defensive)', () => {
    const text = '[process-exit] code=1 signal=none duration_ms=10 provider=codex\nlater output\n[process-exit] code=0 signal=none duration_ms=20 provider=codex\n';
    expect(parseProcessExitAnnotation(text)).toEqual({
      code: 0, signal: null, duration_ms: 20,
    });
  });

  it('handles code=null (wrapper-spawn-failure shape)', () => {
    const text = '[process-exit] code=null signal=detached_exit duration_ms=0 provider=codex\n';
    expect(parseProcessExitAnnotation(text)).toEqual({
      code: null, signal: 'detached_exit', duration_ms: 0,
    });
  });

  it('handles signal=SIGTERM (POSIX kill)', () => {
    const text = '[process-exit] code=null signal=SIGTERM duration_ms=500 provider=codex\n';
    expect(parseProcessExitAnnotation(text)).toEqual({
      code: null, signal: 'SIGTERM', duration_ms: 500,
    });
  });
});

describe('process-exit-wrapper.js — end-to-end', () => {
  it('emits [process-exit] annotation and propagates the child exit code', () => {
    const dir = tmpDir('torque-pew-');
    const stderrFile = path.join(dir, 'stderr.log');
    const stderrFd = fs.openSync(stderrFile, 'w');

    // Run a minimal child via the wrapper: `node -e "process.exit(7)"`.
    const result = spawnSync(process.execPath, [WRAPPER], {
      env: {
        ...process.env,
        TORQUE_PEW_PROGRAM: process.execPath,
        TORQUE_PEW_ARGS: JSON.stringify(['-e', 'process.exit(7)']),
        TORQUE_PEW_PROVIDER: 'codex',
        TORQUE_PEW_MODEL: 'test-model',
      },
      stdio: ['ignore', 'ignore', stderrFd],
      timeout: 15000,
      windowsHide: true,
    });
    fs.closeSync(stderrFd);

    expect(result.status).toBe(7);
    const stderr = fs.readFileSync(stderrFile, 'utf8');
    const annotation = parseProcessExitAnnotation(stderr);
    expect(annotation).not.toBeNull();
    expect(annotation.code).toBe(7);
    expect(annotation.signal).toBeNull();
    // duration_ms should be a finite, non-negative number
    expect(Number.isFinite(annotation.duration_ms)).toBe(true);
    expect(annotation.duration_ms).toBeGreaterThanOrEqual(0);
    // provider=codex / model=test-model should appear in the line
    expect(stderr).toMatch(/provider=codex/);
    expect(stderr).toMatch(/model=test-model/);
  });

  it('streams TORQUE_PEW_STDIN_FILE contents to the child stdin', () => {
    const dir = tmpDir('torque-pew-stdin-');
    const promptFile = path.join(dir, 'prompt.txt');
    const stdoutFile = path.join(dir, 'stdout.log');
    const stderrFile = path.join(dir, 'stderr.log');
    fs.writeFileSync(promptFile, 'hello-from-stdin');
    const stdoutFd = fs.openSync(stdoutFile, 'w');
    const stderrFd = fs.openSync(stderrFile, 'w');

    // Child reads stdin and writes it back to stdout, then exits 0.
    const childScript = 'let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { process.stdout.write(s); process.exit(0); });';
    const result = spawnSync(process.execPath, [WRAPPER], {
      env: {
        ...process.env,
        TORQUE_PEW_PROGRAM: process.execPath,
        TORQUE_PEW_ARGS: JSON.stringify(['-e', childScript]),
        TORQUE_PEW_PROVIDER: 'codex',
        TORQUE_PEW_STDIN_FILE: promptFile,
      },
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout: 15000,
      windowsHide: true,
    });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    expect(result.status).toBe(0);
    const stdout = fs.readFileSync(stdoutFile, 'utf8');
    expect(stdout).toBe('hello-from-stdin');
    const stderr = fs.readFileSync(stderrFile, 'utf8');
    expect(parseProcessExitAnnotation(stderr)?.code).toBe(0);
  });

  it('emits annotation with code=127 when the real binary cannot be spawned', () => {
    const dir = tmpDir('torque-pew-err-');
    const stderrFile = path.join(dir, 'stderr.log');
    const stderrFd = fs.openSync(stderrFile, 'w');

    const result = spawnSync(process.execPath, [WRAPPER], {
      env: {
        ...process.env,
        TORQUE_PEW_PROGRAM: '/__definitely__/does/not/exist',
        TORQUE_PEW_ARGS: JSON.stringify([]),
        TORQUE_PEW_PROVIDER: 'codex',
      },
      stdio: ['ignore', 'ignore', stderrFd],
      timeout: 15000,
      windowsHide: true,
    });
    fs.closeSync(stderrFd);

    expect(result.status).toBe(127);
    const stderr = fs.readFileSync(stderrFile, 'utf8');
    expect(stderr).toMatch(/spawn error/);
    expect(parseProcessExitAnnotation(stderr)?.code).toBe(127);
  });

  it('exits code=2 when wrapper env vars are missing', () => {
    const result = spawnSync(process.execPath, [WRAPPER], {
      env: {
        // Deliberately strip wrapper config so the guard at the top fires.
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TORQUE_PEW_'))),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    });
    expect(result.status).toBe(2);
    expect(result.stderr.toString()).toMatch(/missing TORQUE_PEW_PROGRAM/);
  });
});
