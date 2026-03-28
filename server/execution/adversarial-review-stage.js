'use strict';

const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_REVIEW_CHAIN = ['codex', 'deepinfra', 'claude-cli', 'ollama'];
const DEFAULT_TIMEOUT_MINUTES = 30;

function createAdversarialReviewStage({
  adversarialReviews, fileRiskAdapter, taskCore, taskManager,
  projectConfigCore,
}) {

  function selectReviewerProvider(originalProvider, chain) {
    for (const candidate of chain) {
      if (candidate !== originalProvider) return candidate;
    }
    return null;
  }

  function buildReviewPrompt(taskDescription, diff, highRiskFiles) {
    let prompt = `You are a hostile code reviewer. Your job is to FIND PROBLEMS, not approve.

Task description: ${taskDescription}
`;

    if (highRiskFiles && highRiskFiles.length > 0) {
      prompt += '\nHIGH-RISK FILES (pay special attention):\n';
      for (const f of highRiskFiles) {
        const reasons = Array.isArray(f.risk_reasons) ? f.risk_reasons.join(', ') : f.risk_reasons;
        prompt += `- ${f.file_path}: ${reasons}\n`;
      }
    }

    prompt += `
Diff:
${diff}

Respond with ONLY a JSON object:
{
  "verdict": "approve" | "reject" | "concerns",
  "confidence": "high" | "medium" | "low",
  "issues": [
    { "file": "...", "line": 42, "severity": "critical|warning|info",
      "category": "bug|security|logic|performance|style",
      "description": "...", "suggestion": "..." }
  ]
}

Rules:
- "approve" = no issues found worth flagging
- "concerns" = issues found but not blocking
- "reject" = critical issues that should block commit
- Only use "reject" for genuine bugs or security holes, not style preferences`;

    return prompt;
  }

  function collectDiff(workingDirectory, beforeSha) {
    try {
      const args = beforeSha ? ['diff', `${beforeSha}..HEAD`] : ['diff', 'HEAD~1'];
      const output = execFileSync('git', args, {
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      });
      const diffStr = output.toString('utf8');
      return diffStr.length > 50000 ? diffStr.slice(0, 50000) + '\n... (truncated)' : diffStr;
    } catch (e) {
      return null;
    }
  }

  return async function adversarialReviewStage(ctx) {
    if (ctx.status !== 'completed') return;

    let metadata = {};
    try { metadata = JSON.parse(ctx.task?.metadata || '{}'); } catch (_) { /* ignore */ }

    // Prevent infinite recursion
    if (metadata.review_task || metadata.adversarial_review_task) return;

    // Determine trigger
    const projectConfig = projectConfigCore.getProjectConfig(ctx.task?.working_directory) || {};
    const taskLevel = metadata.adversarial_review;
    const projectLevel = projectConfig.adversarial_review || 'off';

    let shouldRun = false;
    let highRiskFiles = [];

    if (taskLevel === true || taskLevel === 'true') {
      shouldRun = true;
    } else if (projectLevel === 'always') {
      shouldRun = true;
    } else if (projectLevel === 'auto') {
      const scored = fileRiskAdapter.scoreAndPersist(
        ctx.filesModified || [],
        ctx.task?.working_directory || '',
        ctx.taskId
      );
      highRiskFiles = scored.filter(s => s.risk_level === 'high');
      shouldRun = highRiskFiles.length > 0;
    }

    if (!shouldRun) return;

    // Score files for prompt context if not done yet
    if (highRiskFiles.length === 0 && (ctx.filesModified || []).length > 0) {
      const scored = fileRiskAdapter.scoreAndPersist(
        ctx.filesModified,
        ctx.task?.working_directory || '',
        ctx.taskId
      );
      highRiskFiles = scored.filter(s => s.risk_level === 'high');
    }

    // Select reviewer
    const chain = projectConfig.adversarial_review_chain
      ? (typeof projectConfig.adversarial_review_chain === 'string'
          ? JSON.parse(projectConfig.adversarial_review_chain)
          : projectConfig.adversarial_review_chain)
      : DEFAULT_REVIEW_CHAIN;
    const reviewerProvider = metadata.adversarial_reviewer
      || selectReviewerProvider(ctx.task?.provider, chain);

    if (!reviewerProvider) return;

    // Collect diff
    const diff = collectDiff(ctx.task?.working_directory, ctx.proc?.baselineCommit);
    if (!diff) return;

    // Build and spawn review task
    const reviewPrompt = buildReviewPrompt(
      ctx.task?.task_description || '',
      diff,
      highRiskFiles
    );
    const reviewTaskId = randomUUID();
    const reviewTask = {
      id: reviewTaskId,
      status: 'pending',
      task_description: reviewPrompt,
      working_directory: ctx.task?.working_directory,
      timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
      auto_approve: false,
      priority: 0,
      provider: null,
      metadata: JSON.stringify({
        intended_provider: reviewerProvider,
        user_provider_override: true,
        requested_provider: reviewerProvider,
        adversarial_review_task: true,
        adversarial_review_of_task_id: ctx.taskId,
        review_task: true,
      }),
    };

    taskCore.createTask(reviewTask);
    taskManager.startTask(reviewTaskId);

    // Mark original task (best effort)
    try {
      const updatedMeta = { ...metadata, adversarial_review_pending: true, adversarial_review_task_id: reviewTaskId };
      if (taskCore.updateTask) {
        taskCore.updateTask(ctx.taskId, { metadata: JSON.stringify(updatedMeta) });
      }
    } catch (_) { /* best effort */ }
  };
}

module.exports = { createAdversarialReviewStage };

