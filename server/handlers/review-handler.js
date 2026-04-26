'use strict';

const childProcess = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(childProcess.execFile);
const { randomUUID } = require('crypto');
const { ErrorCodes, makeError } = require('./error-codes');
const { buildTaskStudyContextEnvelope } = require('../integrations/codebase-study-engine');
const { recordStudyTaskSubmitted } = require('../db/study-telemetry');

const DEFAULT_PROVIDER = 'codex';
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_DIFF_LENGTH = 5000;
const REVIEW_PROVIDER_FALLBACKS = [
  DEFAULT_PROVIDER,
  'deepinfra',
  'claude-cli',
  'openrouter',
  'anthropic',
  'groq',
  'google-ai',
  'cerebras',
  'hyperbolic',
  'ollama',
];

function normalizeString(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : '';
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) {
    return {};
  }

  if (typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
    return { ...rawMetadata };
  }

  if (typeof rawMetadata !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_err) {
    return {};
  }
}

function parseFilesModified(rawFilesModified) {
  if (Array.isArray(rawFilesModified)) {
    return rawFilesModified.filter((value) => typeof value === 'string' && value.trim());
  }

  if (typeof rawFilesModified !== 'string' || !rawFilesModified.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawFilesModified);
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === 'string' && value.trim())
      : [];
  } catch (_err) {
    return [];
  }
}

function truncateDiffOutput(diffOutput) {
  const normalizedDiff = typeof diffOutput === 'string'
    ? diffOutput
    : String(diffOutput ?? '');

  if (!normalizedDiff) {
    return '(no diff output available)';
  }

  if (normalizedDiff.length <= MAX_DIFF_LENGTH) {
    return normalizedDiff;
  }

  return `${normalizedDiff.slice(0, MAX_DIFF_LENGTH)}\n\n[diff truncated to ${MAX_DIFF_LENGTH} chars]`;
}

function formatReviewPrompt(taskDescriptionOrDiffOutput, maybeDiffOutput) {
  const taskDescription = maybeDiffOutput === undefined
    ? ''
    : normalizeString(taskDescriptionOrDiffOutput);
  const rawDiffOutput = maybeDiffOutput === undefined
    ? taskDescriptionOrDiffOutput
    : maybeDiffOutput;
  const diffOutput = typeof rawDiffOutput === 'object' && rawDiffOutput !== null
    ? rawDiffOutput.diff_output
    : rawDiffOutput;
  const studyContextPrompt = typeof rawDiffOutput === 'object' && rawDiffOutput !== null
    ? normalizeString(rawDiffOutput.study_context_prompt)
    : '';

  const lines = [
    'Review this code change for:',
    '- Logic/correctness bugs',
    '- Security vulnerabilities',
    '- Performance issues',
    '- Missing error handling',
    '- Test coverage gaps',
  ];

  if (taskDescription) {
    lines.push('', `Task description: ${taskDescription}`);
  }

  if (studyContextPrompt) {
    lines.push('', studyContextPrompt);
  }

  lines.push(
    '',
    'Diff:',
    truncateDiffOutput(diffOutput),
    '',
    'Respond with a JSON array of issues:',
    '[{ "file": "...", "line": N, "severity": "critical|warning|info", "category": "bug|security|performance|error_handling|test_coverage", "description": "...", "suggestion": "..." }]',
    '',
    'If no issues found, respond with an empty array [].',
  );

  return lines.join('\n');
}

function getDiffArgs(task) {
  const beforeSha = normalizeString(task?.git_before_sha);
  const afterSha = normalizeString(task?.git_after_sha);

  if (beforeSha && afterSha) {
    return ['diff', beforeSha, afterSha];
  }

  if (beforeSha) {
    return ['diff', beforeSha];
  }

  return ['diff', 'HEAD~1'];
}

async function collectDiffOutput(workingDirectory, task = null) {
  const diffArgs = getDiffArgs(task);

  try {
    const { stdout } = await execFileAsync('git', diffArgs, {
      cwd: workingDirectory,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const stderr = error && error.stderr
      ? (Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr))
      : '';
    const detail = stderr.trim() || error.message || 'Unknown git diff error';
    throw new Error(`Unable to collect git diff: ${detail}`);
  }
}

function extractOriginalProvider(task) {
  const metadata = parseMetadata(task?.metadata);

  return normalizeString(task?.provider)
    || normalizeString(task?.original_provider)
    || normalizeString(metadata.intended_provider)
    || normalizeString(metadata.requested_provider)
    || normalizeString(metadata.original_provider)
    || '';
}

function selectReviewProvider(requestedProvider, originalProvider) {
  const explicitProvider = normalizeString(requestedProvider);
  if (explicitProvider) {
    return explicitProvider;
  }

  const normalizedOriginal = normalizeString(originalProvider);
  const fallbackProvider = REVIEW_PROVIDER_FALLBACKS.find((provider) => provider !== normalizedOriginal);
  return fallbackProvider || DEFAULT_PROVIDER;
}

function buildReviewTaskPayload({
  prompt,
  provider,
  workingDirectory,
  sourceTaskId,
  sourceTaskProvider,
  requestedProvider,
  studyContextSummary,
  sourceStudyContextSummary,
}) {
  return {
    id: randomUUID(),
    status: 'pending',
    task_description: prompt,
    working_directory: workingDirectory,
    timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
    auto_approve: false,
    priority: 0,
    provider,
    metadata: JSON.stringify({
      review_task: true,
      review_of_task_id: sourceTaskId,
      source_task_provider: sourceTaskProvider || null,
      intended_provider: provider,
      requested_provider: requestedProvider || null,
      user_provider_override: Boolean(normalizeString(requestedProvider)),
      study_context_enabled: Boolean(studyContextSummary),
      study_context_summary: studyContextSummary || null,
      source_study_context_summary: sourceStudyContextSummary || studyContextSummary || null,
    }),
  };
}

function getServices() {
  try {
    const { defaultContainer } = require('../container');
    return {
      taskCore: defaultContainer.get('taskCore'),
      taskManager: defaultContainer.get('taskManager'),
    };
  } catch (error) {
    throw new Error(`Review services unavailable: ${error.message}`);
  }
}

async function handleReviewTaskOutput(args = {}) {
  const taskId = normalizeString(args.task_id);
  const requestedProvider = normalizeString(args.provider);

  if (!taskId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  let services;
  try {
    services = getServices();
  } catch (error) {
    return makeError(ErrorCodes.INTERNAL_ERROR, error.message);
  }

  const { taskCore, taskManager } = services;
  const task = taskCore.getTask(taskId);

  if (!task) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${taskId}`);
  }

  if (task.status !== 'completed') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Task must be completed to review');
  }

  const workingDirectory = normalizeString(task.working_directory);
  if (!workingDirectory) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Completed task is missing working_directory');
  }

  try {
    const sourceTaskProvider = extractOriginalProvider(task);
    const reviewProvider = selectReviewProvider(requestedProvider, sourceTaskProvider);
    const diffOutput = await collectDiffOutput(workingDirectory, task);
    const metadata = parseMetadata(task.metadata);
    const fallbackStudyEnvelope = buildTaskStudyContextEnvelope({
      workingDirectory,
      taskDescription: task.task_description || task.description || '',
      files: parseFilesModified(task.files_modified),
    });
    const studyContextPrompt = normalizeString(metadata.study_context_prompt)
      || normalizeString(fallbackStudyEnvelope?.study_context_prompt);
    const studyContextSummary = metadata.study_context_summary && typeof metadata.study_context_summary === 'object'
      ? metadata.study_context_summary
      : (fallbackStudyEnvelope?.study_context_summary || null);
    const prompt = formatReviewPrompt(task.task_description || task.description || '', {
      diff_output: diffOutput,
      study_context_prompt: studyContextPrompt,
    });
    const reviewTask = buildReviewTaskPayload({
      prompt,
      provider: reviewProvider,
      workingDirectory,
      sourceTaskId: taskId,
      sourceTaskProvider,
      requestedProvider,
      studyContextSummary,
      sourceStudyContextSummary: studyContextSummary,
    });

    taskCore.createTask(reviewTask);
    try {
      recordStudyTaskSubmitted(
        typeof taskCore.getTask === 'function'
          ? (taskCore.getTask(reviewTask.id) || reviewTask)
          : reviewTask
      );
    } catch (_studyTelemetryErr) {
      // Non-blocking telemetry.
    }

    const startResult = taskManager.startTask(reviewTask.id);
    if (startResult?.blocked) {
      return makeError(ErrorCodes.OPERATION_FAILED, startResult.reason || 'Review task blocked before execution');
    }

    return {
      review_task_id: reviewTask.id,
      message: 'Review task submitted',
      content: [{
        type: 'text',
        text: JSON.stringify({
          review_task_id: reviewTask.id,
          provider: reviewProvider,
          message: 'Review task submitted',
        }),
      }],
      structuredData: {
        review_task_id: reviewTask.id,
        provider: reviewProvider,
        message: 'Review task submitted',
      },
    };
  } catch (error) {
    return makeError(ErrorCodes.OPERATION_FAILED, error.message || String(error));
  }
}

function createReviewHandler() {
  return {
    truncateDiffOutput,
    formatReviewPrompt,
    collectDiffOutput,
    buildReviewTaskPayload,
    handleReviewTaskOutput,
  };
}

module.exports = {
  truncateDiffOutput,
  formatReviewPrompt,
  collectDiffOutput,
  buildReviewTaskPayload,
  handleReviewTaskOutput,
  createReviewHandler,
};
