'use strict';

const OUTPUT_TRUNCATE_BYTES = 4 * 1024;

async function probeProjectBaseline({ project, verifyCommand, runner, timeoutMs = 5 * 60 * 1000 }) {
  if (!verifyCommand || !String(verifyCommand).trim()) {
    return { passed: false, exitCode: null, output: '', durationMs: 0, error: 'no_verify_command' };
  }
  let result;
  try {
    result = await runner({
      command: verifyCommand,
      cwd: project.path,
      timeoutMs,
    });
  } catch (_e) {
    return { passed: false, exitCode: null, output: '', durationMs: 0, error: 'runner_threw' };
  }

  const combined = String(result.stdout || '') + (result.stderr ? '\n' + String(result.stderr) : '');
  const output = combined.length > OUTPUT_TRUNCATE_BYTES ? combined.slice(-OUTPUT_TRUNCATE_BYTES) : combined;

  if (result.timedOut) {
    return { passed: false, exitCode: result.exitCode, output, durationMs: result.durationMs, error: 'timeout' };
  }
  if (result.exitCode === 0) {
    return { passed: true, exitCode: 0, output, durationMs: result.durationMs, error: null };
  }
  return { passed: false, exitCode: result.exitCode, output, durationMs: result.durationMs, error: null };
}

module.exports = { probeProjectBaseline };
