'use strict';

const { randomUUID } = require('crypto');
const { defaultContainer } = require('../container');

const DEFAULT_TIMEOUT_MINUTES = 5;
const POLL_INTERVAL_MS = 5000;
const MAX_OUTPUT_CHARS = 500;
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

  const effectiveTimeoutMinutes = Math.min(timeoutMinutes, DEFAULT_TIMEOUT_MINUTES);

  return {
    prompt: args.prompt.trim(),
    providers,
    workingDirectory: args.working_directory ? args.working_directory.trim() : null,
    timeoutMinutes: effectiveTimeoutMinutes,
    timeoutMs: effectiveTimeoutMinutes * 60 * 1000,
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
  if (typeof task.partial_output === 'string' && task.partial_output.length > 0) {
    return task.partial_output;
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

function truncateOutput(output) {
  if (typeof output !== 'string' || output.length === 0) {
    return '';
  }

  return output.slice(0, MAX_OUTPUT_CHARS);
}

function toComparisonResult(provider, task, submittedAtMs, fallbackEndMs) {
  const fullOutput = getTaskOutput(task);
  const output = truncateOutput(fullOutput);
  const exitCode = task?.exit_code ?? null;
  const success = Boolean(task && task.status === 'completed' && (exitCode === null || exitCode === 0));

  return {
    provider,
    output,
    outputLength: fullOutput.length,
    durationMs: getDurationMs(task, submittedAtMs, fallbackEndMs),
    exitCode,
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
      outputLength: Number.isFinite(result.outputLength)
        ? result.outputLength
        : (typeof result.output === 'string' ? result.output.length : 0),
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

function escapeTableCell(value) {
  if (value === null || value === undefined) {
    return '-';
  }

  return String(value)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim() || '-';
}

function formatComparisonTable(results) {
  if (!Array.isArray(results)) {
    throw new TypeError('results must be an array');
  }

  const lines = [
    '| Provider | Duration | Exit Code | Success | Output |',
    '|----------|----------|-----------|---------|--------|',
  ];

  for (const result of results) {
    const exitCode = result?.exitCode ?? '-';
    const status = result?.success ? 'Yes' : 'No';
    const output = escapeTableCell(result?.output || '-');

    lines.push(
      `| ${escapeTableCell(result?.provider)} | ${formatDuration(result?.durationMs)} | ${exitCode} | ${status} | ${output} |`,
    );
  }

  return lines.join('\n');
}

function getServices() {
  return {
    taskCore: defaultContainer.get('taskCore'),
    taskManager: defaultContainer.get('taskManager'),
  };
}

function submitComparisonTasks(taskCore, taskManager, prompt, providers, workingDirectory, timeoutMinutes) {
  return providers.map((provider) => {
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

    const taskId = createdTask?.id || task.id;

    try {
      const startResult = taskManager.startTask(taskId);
      if (startResult?.blocked) {
        throw new Error(startResult.reason || 'Task blocked before execution');
      }
      if (startResult && typeof startResult.catch === 'function') {
        startResult.catch(() => {});
      }
    } catch (error) {
      throw new Error(`Failed to start comparison task for provider "${provider}": ${error.message}`);
    }

    return {
      provider,
      taskId,
      submittedAtMs: Date.now(),
    };
  });
}

async function waitForCompletion(taskCore, tasks, timeoutMs) {
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
  return {
    finalTasks,
    timedOut: tasks.some((taskRef) => !isTerminalTask(finalTasks.get(taskRef.taskId))),
    completedAtMs: Date.now(),
  };
}

function buildResponseText(results, summary) {
  const lines = [
    '## Provider Comparison',
    '',
    formatComparisonTable(results),
    '',
    `Timed out: ${summary.timedOut ? 'Yes' : 'No'}`,
    `Succeeded: ${summary.successCount}/${results.length}`,
  ];

  if (summary.fastestProvider) {
    lines.push(`Fastest: ${summary.fastestProvider} (${formatDuration(summary.fastestDurationMs)})`);
  }

  if (summary.mostOutputProvider) {
    lines.push(`Most output: ${summary.mostOutputProvider} (${summary.mostOutputLength} chars)`);
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
  } = validateArgs(args || {});
  const { taskCore, taskManager } = getServices();
  const tasks = submitComparisonTasks(taskCore, taskManager, prompt, providers, workingDirectory, timeoutMinutes);
  const { finalTasks, timedOut, completedAtMs } = await waitForCompletion(taskCore, tasks, timeoutMs);
  const results = tasks.map((taskRef) => (
    toComparisonResult(
      taskRef.provider,
      finalTasks.get(taskRef.taskId),
      taskRef.submittedAtMs,
      completedAtMs,
    )
  ));
  const summary = buildSummary(results, timedOut);

  return {
    content: [{
      type: 'text',
      text: buildResponseText(results, summary),
    }],
    results,
    summary,
    structuredData: {
      results,
      summary,
    },
  };
}

function createComparisonHandler() {
  return {
    handleCompareProviders,
    formatComparisonTable,
  };
}

module.exports = {
  sleep,
  parseTimestamp,
  validateArgs,
  isTerminalTask,
  getTaskOutput,
  getDurationMs,
  toComparisonResult,
  buildSummary,
  formatDuration,
  handleCompareProviders,
  formatComparisonTable,
  createComparisonHandler,
};
