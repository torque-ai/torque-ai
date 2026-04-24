'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isPytestCommand,
  resolveTrustedTempBase,
  prepareLocalVerifyEnv,
} = require('../utils/local-verify-env');

describe('local-verify-env', () => {
  it('detects pytest commands across common Python launchers', () => {
    expect(isPytestCommand('py -3.12 -m pytest tests/ -q')).toBe(true);
    expect(isPytestCommand('python -m pytest tests/ -q')).toBe(true);
    expect(isPytestCommand('poetry run pytest tests/ -q')).toBe(true);
    expect(isPytestCommand('npm test')).toBe(false);
  });

  it('resolves a trusted Windows temp base from LOCALAPPDATA instead of inherited TEMP', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
      TEMP: 'C:\\Users\\TestUser\\.codex\\memories\\bitsy-autodev-pytest-runtime\\tmp',
      TMP: 'C:\\Users\\TestUser\\.codex\\memories\\bitsy-autodev-pytest-runtime\\tmp',
    };

    expect(resolveTrustedTempBase(env, 'win32')).toBe('C:\\Users\\TestUser\\AppData\\Local\\Temp');
  });

  it('builds an isolated pytest temp env on Windows and removes inherited debug temp roots', () => {
    const tempBaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-local-verify-test-'));
    const env = {
      LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
      TEMP: 'C:\\Users\\TestUser\\.codex\\memories\\bitsy-autodev-pytest-runtime\\tmp',
      TMP: 'C:\\Users\\TestUser\\.codex\\memories\\bitsy-autodev-pytest-runtime\\tmp',
      TMPDIR: 'C:\\Users\\TestUser\\.codex\\memories\\bitsy-autodev-pytest-runtime\\tmp',
      PYTEST_DEBUG_TEMPROOT: 'C:\\Users\\TestUser\\.codex\\memories\\bitsy-autodev-pytest-runtime\\pytest-temp-root',
    };

    const prepared = prepareLocalVerifyEnv('py -3.12 -m pytest tests/ -q', env, {
      platform: 'win32',
      tempBaseRoot,
    });

    try {
      expect(prepared.env).toBeTruthy();
      expect(prepared.runtimeRoot).toContain(tempBaseRoot);
      expect(prepared.env.TEMP).toContain(path.join(prepared.runtimeRoot, 'tmp'));
      expect(prepared.env.TMP).toBe(prepared.env.TEMP);
      expect(prepared.env.TMPDIR).toBe(prepared.env.TEMP);
      expect(prepared.env.PYTEST_DEBUG_TEMPROOT).toBeUndefined();
      expect(fs.existsSync(prepared.runtimeRoot)).toBe(true);
    } finally {
      prepared.cleanup();
      fs.rmSync(tempBaseRoot, { recursive: true, force: true });
    }

    expect(fs.existsSync(prepared.runtimeRoot)).toBe(false);
  });
});
