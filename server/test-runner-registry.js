'use strict';

const { spawn } = require('child_process');
const { resolveWindowsPowerShellEnv } = require('./utils/windows-powershell-env');

function createTestRunnerRegistry() {
  let _overrides = null;

  async function _localRunVerifyCommand(verifyCommand, cwd, options = {}) {
    const command = typeof verifyCommand === 'string' ? verifyCommand.trim() : '';
    if (!command) {
      return { success: true, output: '', error: '', exitCode: 0, durationMs: 0, remote: false };
    }

    const timeout = options.timeout || 300000;
    const startMs = Date.now();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const childEnv = resolveWindowsPowerShellEnv(command);
      const child = spawn(command, {
        cwd,
        windowsHide: true,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(childEnv ? { env: childEnv } : {}),
      });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      const MAX_BUF = 10 * 1024 * 1024;
      child.stdout.on('data', (d) => { if (stdout.length < MAX_BUF) stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < MAX_BUF) stderr += d; });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          success: !timedOut && code === 0,
          output: stdout,
          error: timedOut ? `Verify command timed out after ${Math.round(timeout / 1000)}s` : stderr,
          exitCode: timedOut ? 124 : (code ?? 1),
          durationMs: Date.now() - startMs,
          remote: false,
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          success: false,
          output: stdout,
          error: err.message || 'spawn error',
          exitCode: 1,
          durationMs: Date.now() - startMs,
          remote: false,
          timedOut: false,
        });
      });
    });
  }

  function _localRunRemoteOrLocal(command, args, cwd, options = {}) {
    const { spawnSync } = require('child_process');
    const startMs = Date.now();
    const childEnv = resolveWindowsPowerShellEnv([command, ...(args || [])].join(' '));
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: options.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: true,
      ...(childEnv ? { env: childEnv } : {}),
    });

    return Promise.resolve({
      success: result.status === 0,
      output: result.stdout || '',
      error: result.stderr || '',
      exitCode: result.status ?? 1,
      durationMs: Date.now() - startMs,
      remote: false,
    });
  }

  function runVerifyCommand(verifyCommand, cwd, options) {
    if (_overrides && _overrides.runVerifyCommand) {
      return _overrides.runVerifyCommand(verifyCommand, cwd, options);
    }
    return _localRunVerifyCommand(verifyCommand, cwd, options);
  }

  function runRemoteOrLocal(command, args, cwd, options) {
    if (_overrides && _overrides.runRemoteOrLocal) {
      return _overrides.runRemoteOrLocal(command, args, cwd, options);
    }
    return _localRunRemoteOrLocal(command, args, cwd, options);
  }

  function register(overrides) {
    _overrides = overrides;
  }

  function unregister() {
    _overrides = null;
  }

  return { runVerifyCommand, runRemoteOrLocal, register, unregister };
}

module.exports = { createTestRunnerRegistry };
