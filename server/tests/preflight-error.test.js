import { describe, test, expect } from 'vitest';
const { PreflightError, isPreflightError } = require('../execution/preflight-error');

describe('PreflightError', () => {
  test('exposes code, deterministic, and retryable fields', () => {
    const err = new PreflightError('working directory missing', {
      code: 'WORKING_DIR_MISSING',
      deterministic: true,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PreflightError);
    expect(err.name).toBe('PreflightError');
    expect(err.message).toBe('working directory missing');
    expect(err.code).toBe('WORKING_DIR_MISSING');
    expect(err.deterministic).toBe(true);
    expect(err.retryable).toBe(false);
  });

  test('defaults retryable based on deterministic=false', () => {
    const err = new PreflightError('transient failure', {
      code: 'TRANSIENT_FS',
      deterministic: false,
    });
    expect(err.retryable).toBe(true);
  });

  test('isPreflightError recognises our error and rejects others', () => {
    expect(isPreflightError(new PreflightError('x', { code: 'A', deterministic: true }))).toBe(true);
    expect(isPreflightError(new Error('plain'))).toBe(false);
    expect(isPreflightError(null)).toBe(false);
    expect(isPreflightError(undefined)).toBe(false);
    expect(isPreflightError('not an error')).toBe(false);
  });

  test('preserves cause chain when passed', () => {
    const cause = new Error('ENOENT');
    cause.code = 'ENOENT';
    const err = new PreflightError('wd missing', {
      code: 'WORKING_DIR_MISSING',
      deterministic: true,
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runPreflightChecks } = require('../execution/task-startup');

describe('runPreflightChecks', () => {
  test('throws deterministic PreflightError when working_directory is missing', () => {
    const missing = path.join(os.tmpdir(), 'preflight-no-dir-' + Date.now());
    expect.assertions(3);
    try {
      runPreflightChecks({ task_description: 'x', working_directory: missing });
    } catch (err) {
      expect(err.name).toBe('PreflightError');
      expect(err.code).toBe('WORKING_DIR_MISSING');
      expect(err.deterministic).toBe(true);
    }
  });

  test('throws deterministic PreflightError when working_directory is a file, not a dir', () => {
    const tmpFile = path.join(os.tmpdir(), 'preflight-not-dir-' + Date.now());
    fs.writeFileSync(tmpFile, 'hi');
    try {
      expect.assertions(3);
      try {
        runPreflightChecks({ task_description: 'x', working_directory: tmpFile });
      } catch (err) {
        expect(err.name).toBe('PreflightError');
        expect(err.code).toBe('WORKING_DIR_NOT_DIRECTORY');
        expect(err.deterministic).toBe(true);
      }
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('throws deterministic PreflightError when task_description is empty or whitespace', () => {
    expect.assertions(3);
    try {
      runPreflightChecks({ task_description: '   ' });
    } catch (err) {
      expect(err.name).toBe('PreflightError');
      expect(err.code).toBe('TASK_DESCRIPTION_EMPTY');
      expect(err.deterministic).toBe(true);
    }
  });

  test('does NOT throw when inputs are valid', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-ok-'));
    try {
      expect(() => runPreflightChecks({
        task_description: 'real work',
        working_directory: tmpDir,
      })).not.toThrow();
    } finally {
      fs.rmdirSync(tmpDir);
    }
  });

  test('wraps non-ENOENT fs errors as non-deterministic PreflightError', () => {
    const origStat = fs.statSync;
    fs.statSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
    try {
      expect.assertions(3);
      try {
        runPreflightChecks({ task_description: 'x', working_directory: '/any/path' });
      } catch (err) {
        expect(err.name).toBe('PreflightError');
        expect(err.code).toBe('WORKING_DIR_STAT_FAILED');
        expect(err.deterministic).toBe(false);
      }
    } finally {
      fs.statSync = origStat;
    }
  });
});
