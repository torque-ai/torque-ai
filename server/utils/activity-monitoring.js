'use strict';

/**
 * Activity Monitoring Module
 *
 * Extracted from task-manager.js — filesystem activity detection,
 * per-task activity status, and capacity checking.
 *
 * Uses init() dependency injection for runningProcesses Map and
 * helper functions from the parent module.
 */

const { getWorktreeFingerprint } = require('./git');
const logger = require('../logger').child({ component: 'activity-monitoring' });

// Agent providers that work silently — editing files and running commands
// without necessarily producing stdout. Stall detection must check the
// filesystem before declaring these providers stalled.
const AGENT_PROVIDERS = new Set(['codex', 'claude-cli']);

// Dependency injection
let _runningProcesses = null;
let _getStallThreshold = null;
let _safeConfigInt = null;
let _skipGitInCloseHandler = () => false;

/**
 * Parse metadata payloads into a plain object.
 * @param {Object|string|null|undefined} value
 * @returns {Object}
 */
function parseTaskMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && value !== null) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse candidate metadata as a strictly positive number.
 *
 * @param {*} value
 * @returns {number|null} Positive number or null
 */
function parsePositiveNumber(value) {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Parse candidate metadata as a non-negative integer.
 *
 * @param {*} value
 * @returns {number|null} Integer or null
 */
function parseInteger(value) {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

/**
 * Parse candidate metadata as boolean.
 *
 * Supports boolean literals, numeric 1, and stringy truthy values.
 *
 * @param {*} value
 * @returns {boolean} Parsed boolean
 */
function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value === 1;
  const text = String(value).toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/**
 * Read context token estimate from proc metadata with fallbacks.
 *
 * @param {Object} proc - Task process metadata
 * @returns {number|null} Context token estimate if available
 */
function getContextTokenEstimate(proc) {
  const metadata = parseTaskMetadata(proc && proc.metadata);
  const candidates = [
    metadata.contextTokens,
    metadata.context_tokens,
    metadata.contextTokenEstimate,
    metadata.context_token_estimate,
    metadata.estimatedContextTokens,
    metadata.estimated_context_tokens,
    metadata.totalContextTokens,
    metadata.total_context_tokens,
    metadata.inputTokens,
    metadata.input_tokens,
    proc?.contextTokenEstimate
  ];

  for (const value of candidates) {
    const num = parseInteger(value);
    if (Number.isInteger(num) && num > 0) return num;
  }

  if (typeof metadata.context === 'string' && metadata.context.length > 0) {
    return parseInt(metadata.context.length / 4, 10);
  }

  return null;
}

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 * @param {Map} deps.runningProcesses - Map of running task processes
 * @param {Function} deps.getStallThreshold - Function to get stall threshold for model/provider
 * @param {Function} deps.safeConfigInt - Safe config int parser
 * @param {Function} deps.getSkipGitInCloseHandler - Getter for skipGitInCloseHandler flag
 */
function init(deps) {
  if (deps.runningProcesses) _runningProcesses = deps.runningProcesses;
  if (deps.getStallThreshold) _getStallThreshold = deps.getStallThreshold;
  if (deps.safeConfigInt) _safeConfigInt = deps.safeConfigInt;
  if (deps.getSkipGitInCloseHandler) _skipGitInCloseHandler = deps.getSkipGitInCloseHandler;
}

/**
 * Check if an agent task has filesystem activity despite no stdout.
 * Compares current git state (HEAD position + uncommitted changes) against
 * a stored fingerprint. If the fingerprint changed, the agent is actively
 * modifying files — not stalled.
 *
 * Only called when a task *appears* stalled by stdout silence.
 *
 * @param {Object} proc - Process tracking object from runningProcesses
 * @param {string} taskId - Task ID (for logging)
 * @returns {boolean} True if filesystem activity detected since last check
 */
function checkFilesystemActivity(proc, taskId) {
  if (_skipGitInCloseHandler()) return false;
  const cwd = proc.workingDirectory;
  if (!cwd) return false;

  try {
    // Use TTL-cached fingerprint to prevent git-status storms.
    // Multiple concurrent callers probing the same working directory
    // share one cached result instead of each spawning git processes.
    const fingerprint = getWorktreeFingerprint(cwd);
    if (!fingerprint) return false; // No git info available

    // First check — seed the fingerprint, no comparison possible yet
    if (proc.lastFsFingerprint === null || proc.lastFsFingerprint === undefined) {
      proc.lastFsFingerprint = fingerprint;
      return false;
    }

    // Compare against previous fingerprint
    if (fingerprint !== proc.lastFsFingerprint) {
      logger.info(`[Heartbeat] Task ${taskId} has filesystem activity despite no stdout (provider: ${proc.provider})`);
      proc.lastFsFingerprint = fingerprint;
      proc.lastOutputAt = Date.now();
      proc.stallWarned = false; // Reset so it can warn again if truly stuck later
      return true;
    }

    return false;
  } catch (e) {
    logger.info(`[Heartbeat] Filesystem activity check failed for task ${taskId}: ${e.message}`);
    return false;
  }
}

/**
 * Get activity status for a running task.
 * @param {string} taskId - Task ID
 * @param {{ skipGitCheck?: boolean }} [opts] - Pass skipGitCheck:true for
 *   read-only status rendering (returns last-known state without spawning git)
 * @returns {Object|null} Activity info or null if task not running
 */
function getTaskActivity(taskId, opts = {}) {
  if (!_runningProcesses) return null;
  const proc = _runningProcesses.get(taskId);
  if (!proc) {
    return null;
  }

  const metadata = parseTaskMetadata(proc.metadata);
  const now = Date.now();
  const lastActivityMs = now - proc.lastOutputAt;
  const lastActivitySeconds = Math.floor(lastActivityMs / 1000);

  // Use dynamic threshold based on model size and provider
  const taskTimeout = proc.stall_timeout_seconds;
  const providerThreshold = _getStallThreshold ? _getStallThreshold(proc.model, proc.provider) : null;
  let threshold = taskTimeout || providerThreshold;

  // Apply multiplier-based stall grace to reduce false positives for slow tasks.
  if (threshold !== null && Number.isFinite(threshold)) {
    let multiplier = 1;

    // Tasks with explicit multiplier override in metadata
    const graceMultiplier = parsePositiveNumber(metadata.stall_grace_multiplier) || 1;
    multiplier *= graceMultiplier;

    // Reasoning tasks on Codex are often I/O-heavy with delayed output
    const taskType = proc.taskType || metadata.task_type || metadata.taskType;
    if (proc.provider === 'codex' && taskType === 'reasoning') {
      multiplier *= 1.5;
    }

    // Large context prompts are often slow to complete the first output chunk
    const contextTokens = getContextTokenEstimate(proc);
    if (contextTokens && contextTokens > 10000) {
      multiplier *= 2;
    }

    // Explicit long-running tasks should have significantly larger stall thresholds
    const longRunning = parseBooleanFlag(metadata['long-running'])
      || parseBooleanFlag(metadata.longRunning)
      || parseBooleanFlag(metadata.long_running)
      || parseBooleanFlag(metadata.isLongRunning);
    if (longRunning) {
      multiplier *= 3;
    }

    threshold = threshold * multiplier;
  }

  // If threshold is null, stall detection is disabled for this provider
  let isStalled = threshold !== null && lastActivitySeconds > threshold;

  // For agent providers (codex, claude-cli), stdout silence doesn't mean stalled.
  // Check if the agent is actively modifying files before declaring it stalled.
  // When skipGitCheck is true (status rendering), skip the filesystem probe
  // and rely on the last known stall state to avoid spawning git processes.
  if (isStalled && AGENT_PROVIDERS.has(proc.provider) && !opts.skipGitCheck) {
    if (checkFilesystemActivity(proc, taskId)) {
      // Filesystem changed — agent is working, not stalled
      isStalled = false;
    }
  }

  // Warn once when a task becomes stalled (after filesystem check)
  if (isStalled && !proc.stallWarned) {
    proc.stallWarned = true;
    logger.info(`[Heartbeat] Task ${taskId} appears stalled - no output for ${lastActivitySeconds}s (threshold: ${threshold}s for model ${proc.model || 'unknown'})`);
  }

  return {
    taskId,
    lastOutputAt: proc.lastOutputAt,
    lastActivitySeconds,
    isStalled,
    stallThreshold: threshold,
    model: proc.model,
    provider: proc.provider,
    startTime: proc.startTime,
    elapsedSeconds: Math.floor((now - proc.startTime) / 1000)
  };
}

/**
 * Get activity status for all running tasks
 * @returns {Array} Array of activity info objects
 */
function getAllTaskActivity() {
  if (!_runningProcesses) return [];
  const activities = [];
  for (const taskId of _runningProcesses.keys()) {
    const activity = getTaskActivity(taskId);
    if (activity) {
      activities.push(activity);
    }
  }
  return activities;
}

/**
 * Check if server can accept more tasks
 * @returns {boolean} True if below the max concurrent limit
 */
function canAcceptTask() {
  if (!_runningProcesses) return true;
  const maxOllama = _safeConfigInt('max_ollama_concurrent', 8, 1, 50);
  const maxCodex = _safeConfigInt('max_codex_concurrent', 6, 1, 20);
  const maxApi = _safeConfigInt('max_api_concurrent', 4, 1, 20);
  const maxConcurrent = _safeConfigInt('max_concurrent', maxOllama + maxCodex + maxApi, 1, 100);
  return _runningProcesses.size < maxConcurrent;
}

module.exports = {
  init,
  AGENT_PROVIDERS,
  checkFilesystemActivity,
  getTaskActivity,
  getAllTaskActivity,
  canAcceptTask,
};
