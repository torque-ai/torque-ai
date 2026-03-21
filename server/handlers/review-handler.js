'use strict';

const childProcess = require('child_process');
const uuid = require('uuid');
const db = require('../database');
const taskManager = require('../task-manager');

const DEFAULT_PROVIDER = 'codex';
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_DIFF_LENGTH = 5000;

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

  return `${normalizedDiff.slice(0, MAX_DIFF_LENGTH)}\n\n[diff truncated to 5000 chars]`;
}

function formatReviewPrompt(taskDescription, diffOutput) {
  const safeTaskDescription = typeof taskDescription === 'string' && taskDescription.trim()
    ? taskDescription.trim()
    : '(no task description available)';

  return [
    'Review the following code changes for:',
    '1. Logic/correctness errors',
    '2. Readability issues',
    '3. Performance concerns',
    '4. Missing test coverage',
    '5. Security vulnerabilities',
    '',
    `Task description: ${safeTaskDescription}`,
    '',
    'Changes:',
    truncateDiffOutput(diffOutput),
    '',
    'Output a markdown table with columns: File, Line, Issue, Severity (critical/warning/info), Suggestion',
  ].join('\n');
}

function collectDiffOutput(workingDirectory) {
  try {
    const output = childProcess.execFileSync('git', ['diff', 'HEAD~1', '--stat'], {
      cwd: workingDirectory,
    });
    return Buffer.isBuffer(output) ? output.toString('utf8') : String(output ?? '');
  } catch (error) {
    const stderr = error && error.stderr
      ? (Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr))
      : '';
    const detail = stderr.trim() || error.message || 'Unknown git diff error';
    return `Unable to collect git diff: ${detail}`;
  }
}

function buildReviewTaskPayload(prompt, provider, workingDirectory, sourceTaskId) {
  return {
    id: uuid.v4(),
    status: 'pending',
    task_description: prompt,
    working_directory: workingDirectory,
    timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
    auto_approve: false,
    priority: 0,
    provider: null,
    metadata: JSON.stringify({
      intended_provider: provider,
      user_provider_override: true,
      requested_provider: provider,
      review_task: true,
      review_of_task_id: sourceTaskId,
    }),
  };
}

function handleReviewTaskOutput(args = {}) {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  const workingDirectory = typeof args.working_directory === 'string'
    ? args.working_directory.trim()
    : '';
  const provider = typeof args.provider === 'string' && args.provider.trim()
    ? args.provider.trim()
    : DEFAULT_PROVIDER;

  if (!taskId) {
    return { review: null, issues_found: null, summary: 'task_id is required' };
  }

  if (!workingDirectory) {
    return { review: null, issues_found: null, summary: 'working_directory is required' };
  }

  const task = db.getTask(taskId);
  if (!task) {
    return { review: null, issues_found: null, summary: `Task not found: ${taskId}` };
  }

  try {
    const prompt = formatReviewPrompt(
      task.task_description || task.description,
      collectDiffOutput(workingDirectory),
    );
    const reviewTask = buildReviewTaskPayload(prompt, provider, workingDirectory, taskId);

    db.createTask(reviewTask);

    const startResult = taskManager.startTask(reviewTask.id);
    const taskState = startResult && startResult.queued ? 'queued' : 'started';

    return {
      review: reviewTask.id,
      issues_found: null,
      summary: `Review task ${reviewTask.id} ${taskState} for source task ${taskId}.`,
    };
  } catch (error) {
    return {
      review: null,
      issues_found: null,
      summary: `Failed to submit review task for ${taskId}: ${error.message || String(error)}`,
    };
  }
}

module.exports = {
  handleReviewTaskOutput,
  formatReviewPrompt,
};
