'use strict';

const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_REVIEW_CHAIN = ['codex', 'deepinfra', 'claude-cli', 'ollama'];
const DIFF_MAX_BYTES = 50 * 1024;
const DIFF_TIMEOUT_MS = 30_000;

function parseTaskMetadata(taskMetadata) {
  if (!taskMetadata) return {};
  try {
    return JSON.parse(taskMetadata);
  } catch {
    return {};
  }
}

function selectReviewerProvider(originalProvider, chain = DEFAULT_REVIEW_CHAIN) {
  for (const candidate of chain) {
    if (candidate !== originalProvider) {
      return candidate;
    }
  }
  return null;
}

function buildReviewPrompt(taskDescription, diff, highRiskFiles) {
  const lines = [
    'You are a hostile code reviewer.',
    'Your goal is to find concrete problems, regressions, and security issues.',
    '',
    `Task description: ${taskDescription}`,
    '',
    'High-risk file annotations:',
  ];

  if (Array.isArray(highRiskFiles) && highRiskFiles.length > 0) {
    for (const entry of highRiskFiles) {
      const reasons = Array.isArray(entry.risk_reasons)
        ? entry.risk_reasons.join(', ')
        : entry.risk_reasons || 'unknown';
      lines.push(`- ${entry.file_path}: ${reasons}`);
    }
  } else {
    lines.push('- (none)');
  }

  lines.push(
    '',
    'Diff:',
    diff,
    '',
    'Respond with ONLY a JSON object in this shape:',
    '{',
    '  "verdict": "approve" | "reject" | "concerns",',
    '  "confidence": "high" | "medium" | "low",',
    '  "issues": [',
    '    { "file": "...", "line": 42, "severity": "critical|warning|info", "category": "bug|security|logic|performance|style", "description": "...", "suggestion": "..." }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- "approve" for no material issues.',
    '- "concerns" for non-blocking problems.',
    '- "reject" only for security or correctness blockers.',
  );

  return lines.join('\n');
}

function collectDiff(workingDirectory) {
  try {
    const output = execFileSync('git', ['diff', 'HEAD~1'], {
      cwd: workingDirectory,
      windowsHide: true,
      timeout: DIFF_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BYTES + 1024,
    });

    const diff = output.toString('utf8');
    return diff.length > DIFF_MAX_BYTES
      ? diff.slice(0, DIFF_MAX_BYTES)
      : diff;
  } catch {
    return null;
  }
}
 
function createAdversarialReviewStage({
  adversarialReviews,
  fileRiskAdapter,
  taskCore,
  taskManager,
  verificationLedger,
  projectConfigCore,
}) {
  void adversarialReviews;
  void verificationLedger;

  return async function adversarialReviewStage(ctx) {
    if (ctx.status !== 'completed') return;

    const task = ctx.task || {};
    const metadata = parseTaskMetadata(task.metadata);

    // Prevent infinite recursion
    if (metadata.review_task || metadata.adversarial_review_task) return;

    // Determine trigger mode from project config
    const projectConfig = projectConfigCore.getProjectConfig(task.working_directory) || {};
    const mode = projectConfig.adversarial_review || 'off';

    let highRiskFiles = [];
    let shouldRun = false;

    if (mode === 'auto') {
      const scored = fileRiskAdapter.scoreAndPersist(
        ctx.filesModified || [],
        task.working_directory || '',
        ctx.taskId,
      );
      highRiskFiles = scored.filter(s => s.risk_level === 'high');
      shouldRun = highRiskFiles.length > 0;
    } else if (mode === 'always') {
      shouldRun = true;
    }

    if (!shouldRun) return;

    const reviewerProvider = selectReviewerProvider(task.provider, DEFAULT_REVIEW_CHAIN);
    if (!reviewerProvider) return;

    // Collect diff
    const diff = collectDiff(task.working_directory);
    if (!diff) return;

    // Build and spawn review task
    const reviewPrompt = buildReviewPrompt(
      task.task_description || '',
      diff,
      highRiskFiles,
    );
    const reviewTaskId = randomUUID();
    const reviewTask = {
      id: reviewTaskId,
      status: 'pending',
      task_description: reviewPrompt,
      working_directory: task.working_directory,
      provider: null,
      metadata: JSON.stringify({
        intended_provider: reviewerProvider,
        user_provider_override: true,
        adversarial_review_task: true,
        adversarial_review_of_task_id: ctx.taskId,
      }),
    };

    taskCore.createTask(reviewTask);
    taskManager.startTask(reviewTaskId);

    // Mark original task (best effort)
    try {
      const updatedMeta = {
        ...metadata,
        adversarial_review_pending: true,
      };
      taskCore.updateTask(ctx.taskId, { metadata: JSON.stringify(updatedMeta) });
    } catch (_) { /* best effort */ }
  };
}

module.exports = {
  createAdversarialReviewStage,
  selectReviewerProvider,
  buildReviewPrompt,
  collectDiff,
};
