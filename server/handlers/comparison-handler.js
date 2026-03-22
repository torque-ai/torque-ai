'use strict';

const { randomUUID } = require('crypto');
const taskCore = require('../db/task-core');

const DEFAULT_TIMEOUT_MINUTES = 5;
const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    throw new TypeError('args must be an object');
  }

  if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
    throw new TypeError('prompt must be a non-empty string');
  }

  if (!Array.isArray(args.providers) || args.providers.length === 0) {
    throw new TypeError('providers must be a non-empty array');
  }

  const providers = args.providers.map((provider, index) => {
    if (typeof provider !== 'string' || provider.trim().length === 0) {
      throw new TypeError(`providers[${index}] must be a non-empty string`);
    }
    return provider.trim();
  });

  if (
    args.working_directory !== undefined
    && args.working_directory !== null
    && (typeof args.working_directory !== 'string' || args.working_directory.trim().length === 0)
  ) {
    throw new TypeError('working_directory must be a non-empty string when provided');
  }

  const timeoutMinutes = args.timeout_minutes === undefined
    ? DEFAULT_TIMEOUT_MINUTES
    : Number(args.timeout_minutes);

  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new TypeError('timeout_minutes must be a positive number');
  }

  return {
    prompt: args.prompt.trim(),
    providers,
    workingDirectory: args.working_directory ? args.working_directory.trim() : null,
    timeoutMinutes,
    timeoutMs: timeoutMinutes * 60 * 1000,
  };
}

function isTerminalTask(task) {
  return Boolean(task && TERMINAL_STATUSES.has(task.status));
}

function getTaskOutput(task) {
  if (!task) {
    return '';
  }
  if (typeof task.output === 'string' && task.output.length > 0) {
    return task.output;
  }
  if (typeof task.error_output === 'string' && task.error_output.length > 0) {
    return task.error_output;
  }
  return '';
}

function getDurationMs(task, submittedAtMs, fallbackEndMs) {
  const startedAtMs = parseTimestamp(task?.started_at) ?? parseTimestamp(task?.created_at) ?? submittedAtMs;
  const completedAtMs = parseTimestamp(task?.completed_at) ?? fallbackEndMs;

  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return null;
  }

  return Math.max(0, completedAtMs - startedAtMs);
}

function toComparisonResult(provider, task, submittedAtMs, fallbackEndMs) {
  const output = getTaskOutput(task);
  const exitCode = task?.exit_code ?? null;
  const success = Boolean(task && task.status === 'completed' && (exitCode === null || exitCode === 0));

  return {
    provider,
    output,
    durationMs: getDurationMs(task, submittedAtMs, fallbackEndMs),
    exitCode,
    costUsd: parseFloat(task?.cost_usd) || 0,
    success,
  };
}

function buildSummary(results, timedOut) {
  const fastest = results
    .filter((result) => Number.isFinite(result.durationMs))
    .sort((left, right) => left.durationMs - right.durationMs)[0] || null;

  const mostOutput = results
    .map((result) => ({
      provider: result.provider,
      outputLength: typeof result.output === 'string' ? result.output.length : 0,
    }))
    .sort((left, right) => right.outputLength - left.outputLength)[0] || null;

  const successCount = results.filter((result) => result.success).length;

  return {
    fastestProvider: fastest ? fastest.provider : null,
    fastestDurationMs: fastest ? fastest.durationMs : null,
    mostOutputProvider: mostOutput ? mostOutput.provider : null,
    mostOutputLength: mostOutput ? mostOutput.outputLength : 0,
    allSucceeded: results.length > 0 && successCount === results.length,
    allFailed: results.length > 0 && successCount === 0,
    successCount,
    failureCount: results.length - successCount,
    timedOut,
  };
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return '-';
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatComparisonTable(results) {
  if (!Array.isArray(results)) {
    throw new TypeError('results must be an array');
  }

  const lines = [
    '| Provider | Duration | Exit Code | Output Length | Status |',
    '|----------|----------|-----------|---------------|--------|',
  ];

  for (const result of results) {
    const outputLength = typeof result?.output === 'string' ? result.output.length : 0;
    const exitCode = result?.exitCode ?? '-';
    const status = result?.success ? 'Success' : 'Failed';

    lines.push(
      `| ${result?.provider ?? '-'} | ${formatDuration(result?.durationMs)} | ${exitCode} | ${outputLength} chars | ${status} |`,
    );
  }

  return lines.join('\n');
}

async function handleCompareProviders(args) {
  const {
    prompt,
    providers,
    workingDirectory,
    timeoutMinutes,
    timeoutMs,
  } = validateArgs(args);

  const tasks = providers.map((provider) => {
    const task = {
      id: randomUUID(),
      status: 'queued',
      task_description: prompt,
      provider,
      timeout_minutes: timeoutMinutes,
    };

    if (workingDirectory) {
      task.working_directory = workingDirectory;
    }

    let createdTask;
    try {
      createdTask = taskCore.createTask(task);
    } catch (error) {
      throw new Error(`Failed to create comparison task for provider "${provider}": ${error.message}`);
    }

    return {
      provider,
      taskId: createdTask?.id || task.id,
      submittedAtMs: Date.now(),
    };
  });

  const deadline = Date.now() + timeoutMs;
  let finalTasks = new Map();

  while (true) {
    finalTasks = new Map(tasks.map((taskRef) => [taskRef.taskId, taskCore.getTask(taskRef.taskId)]));
    if (tasks.every((taskRef) => isTerminalTask(finalTasks.get(taskRef.taskId)))) {
      break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }

  finalTasks = new Map(tasks.map((taskRef) => [taskRef.taskId, taskCore.getTask(taskRef.taskId)]));
  const now = Date.now();
  const timedOut = tasks.some((taskRef) => !isTerminalTask(finalTasks.get(taskRef.taskId)));
  const results = tasks.map((taskRef) => (
    toComparisonResult(
      taskRef.provider,
      finalTasks.get(taskRef.taskId),
      taskRef.submittedAtMs,
      now,
    )
  ));

  return {
    results,
    summary: buildSummary(results, timedOut),
  };
}

function createComparisonHandler() {
  return {
    handleCompareProviders,
    formatComparisonTable,
  };
}

module.exports = {
  handleCompareProviders,
  formatComparisonTable,
  createComparisonHandler,
};
