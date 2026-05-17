'use strict';

const { wrapVerifyCommandForTestLane } = require('./test-lane-verify');

const OUTPUT_TRUNCATE_BYTES = 4 * 1024;
const DEFAULT_BASELINE_PROBE_TIMEOUT_MINUTES = 60;
const MAX_BASELINE_PROBE_TIMEOUT_MINUTES = 240;
const DEFAULT_BASELINE_PROBE_TIMEOUT_MS = DEFAULT_BASELINE_PROBE_TIMEOUT_MINUTES * 60 * 1000;

/**
 * Normalizes a timeout value in minutes to a valid range.
 * 
 * @param {number} timeoutMinutes - The timeout in minutes to normalize
 * @param {number} fallbackMinutes - The fallback timeout in minutes if input is invalid
 * @returns {number} The normalized timeout in minutes (clamped between 1 and 240)
 */
function normalizeBaselineProbeTimeoutMinutes(timeoutMinutes, fallbackMinutes = DEFAULT_BASELINE_PROBE_TIMEOUT_MINUTES) {
  const fallback = Number.isFinite(Number(fallbackMinutes)) && Number(fallbackMinutes) > 0
    ? Number(fallbackMinutes)
    : DEFAULT_BASELINE_PROBE_TIMEOUT_MINUTES;
  const numeric = timeoutMinutes == null ? fallback : Number(timeoutMinutes);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 1; // Always fallback to 1 minute for invalid inputs
  }
  return Math.min(Math.max(numeric, 1), MAX_BASELINE_PROBE_TIMEOUT_MINUTES);
}

function resolveBaselineProbeTimeoutMs({ timeout_minutes, config } = {}) {
  const configuredTimeout = config && typeof config === 'object'
    ? config.baseline_probe_timeout_minutes
    : undefined;
  return normalizeBaselineProbeTimeoutMinutes(timeout_minutes ?? configuredTimeout) * 60 * 1000;
}

// Resolve which verify command the baseline probe should run.
// Precedence: cfg.baseline_verify_command > defaults.baseline_verify_command
//           > cfg.baseline_broken_evidence.verify_command
//           > cfg.verify_command         > defaults.verify_command.
// `baseline_verify_command` exists so the probe can run a fast smoke subset
// while per-task verification keeps the broader `verify_command`.
function resolveBaselineVerifyCommand({ cfg, defaults } = {}) {
  if (cfg && cfg.baseline_verify_command && cfg.baseline_verify_command.trim()) return cfg.baseline_verify_command;
  if (defaults && defaults.baseline_verify_command && defaults.baseline_verify_command.trim()) return defaults.baseline_verify_command;
  const evidenceCommand = cfg?.baseline_broken_evidence?.verify_command;
  if (typeof evidenceCommand === 'string' && evidenceCommand.trim()) return evidenceCommand;
  if (cfg && cfg.verify_command && cfg.verify_command.trim()) return cfg.verify_command;
  if (defaults && defaults.verify_command && defaults.verify_command.trim()) return defaults.verify_command;
  return null;
}

async function probeProjectBaseline({ project, verifyCommand, runner, timeoutMs = DEFAULT_BASELINE_PROBE_TIMEOUT_MS }) {
  const command = wrapVerifyCommandForTestLane(verifyCommand, { projectPath: project?.path });
  if (!command || !String(command).trim()) {
    return { passed: false, exitCode: null, output: '', durationMs: 0, error: 'no_verify_command' };
  }
  let result;
  try {
    result = await runner({
      command,
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

module.exports = {
  DEFAULT_BASELINE_PROBE_TIMEOUT_MINUTES,
  DEFAULT_BASELINE_PROBE_TIMEOUT_MS,
  MAX_BASELINE_PROBE_TIMEOUT_MINUTES,
  normalizeBaselineProbeTimeoutMinutes,
  resolveBaselineProbeTimeoutMs,
  resolveBaselineVerifyCommand,
  probeProjectBaseline,
};
