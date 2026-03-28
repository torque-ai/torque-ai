'use strict';

const { defaultContainer } = require('../container');
const { ErrorCodes, makeError } = require('./error-codes');
const { isPathTraversalSafe } = require('./shared');

const RISK_LEVELS = ['high', 'medium', 'low'];

function toJsonResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function getFileRiskService() {
  try {
    return defaultContainer.get('fileRisk');
  } catch (_err) {
    return null;
  }
}

function getVerificationLedgerService() {
  try {
    return defaultContainer.get('verificationLedger');
  } catch (_err) {
    return null;
  }
}

function getAdversarialReviewsService() {
  try {
    return defaultContainer.get('adversarialReviews');
  } catch (_err) {
    return null;
  }
}

function parseAdversarialIssues(raw) {
  if (raw === null || raw === undefined) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

function parseRiskReasons(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (_err) {
      return [raw];
    }
  }
  return [];
}

function normalizeLevel(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOverrideReason(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function handleGetFileRisk(args = {}) {
  const { file_path: filePath, working_directory: workingDirectory } = args;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  }
  if (!isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.PATH_TRAVERSAL, 'Unsafe file_path');
  }
  if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const fileRisk = getFileRiskService();
  if (!fileRisk) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'fileRisk service is not available');
  }

  const record = fileRisk.getFileRisk(filePath.trim(), workingDirectory.trim());
  if (!record) {
    return toJsonResponse({
      found: false,
      file_path: filePath.trim(),
      working_directory: workingDirectory.trim(),
      message: `No risk data found for ${filePath.trim()}`,
    });
  }

  const response = {
    found: true,
    file_path: record.file_path,
    working_directory: record.working_directory,
    risk_level: record.risk_level,
    risk_reasons: parseRiskReasons(record.risk_reasons),
    auto_scored: record.auto_scored === 1,
    scored_by: record.scored_by,
    scored_at: record.scored_at,
  };

  return toJsonResponse(response);
}

function handleGetTaskRiskSummary(args = {}) {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  if (!taskId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const fileRisk = getFileRiskService();
  if (!fileRisk) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'fileRisk service is not available');
  }

  const summary = fileRisk.getTaskRiskSummary(taskId) || {
    high: [],
    medium: [],
    low: [],
    unscored: [],
    overall_risk: 'low',
  };
  summary.task_id = taskId;
  const counts = {
    high: summary.high.length,
    medium: summary.medium.length,
    low: summary.low.length,
    unscored: summary.unscored.length,
  };

  return toJsonResponse({
    ...summary,
    counts,
    message: `Task risk summary for ${taskId}: ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.unscored} unscored (overall ${summary.overall_risk}).`,
  });
}

function handleSetFileRiskOverride(args = {}) {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  const workingDirectory = typeof args.working_directory === 'string' ? args.working_directory.trim() : '';
  const riskLevel = normalizeLevel(args.risk_level);
  const reason = parseOverrideReason(args.reason);

  if (!filePath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  }
  if (!isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.PATH_TRAVERSAL, 'Unsafe file_path');
  }
  if (!workingDirectory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  if (!riskLevel || !RISK_LEVELS.includes(riskLevel)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'risk_level must be one of: high, medium, low');
  }
  if (!reason) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'reason is required');
  }

  const fileRisk = getFileRiskService();
  if (!fileRisk) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'fileRisk service is not available');
  }

  fileRisk.setManualOverride(filePath, workingDirectory, riskLevel, reason);
  const updated = fileRisk.getFileRisk(filePath, workingDirectory);

  const result = {
    file_path: filePath,
    working_directory: workingDirectory,
    risk_level: updated?.risk_level || riskLevel,
    risk_reasons: parseRiskReasons(updated?.risk_reasons || JSON.stringify([reason])),
    auto_scored: false,
    override: true,
    reason,
  };

  return toJsonResponse(result);
}

function handleGetHighRiskFiles(args = {}) {
  const workingDirectory = typeof args.working_directory === 'string' ? args.working_directory.trim() : '';
  if (!workingDirectory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const minLevel = normalizeLevel(args.min_level) || 'high';
  if (!RISK_LEVELS.includes(minLevel)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'min_level must be one of: high, medium, low');
  }

  const fileRisk = getFileRiskService();
  if (!fileRisk) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'fileRisk service is not available');
  }

  const files = fileRisk.getFilesAtRisk(workingDirectory, minLevel) || [];
  const mapped = files.map((row) => ({
    file_path: row.file_path,
    risk_level: row.risk_level,
    risk_reasons: parseRiskReasons(row.risk_reasons),
    auto_scored: row.auto_scored === 1,
    scored_by: row.scored_by,
    scored_at: row.scored_at,
  }));

  return toJsonResponse({
    working_directory: workingDirectory,
    min_level: minLevel,
    count: mapped.length,
    files: mapped,
    message: `Found ${mapped.length} file(s) at minimum risk level "${minLevel}" in ${workingDirectory}`,
  });
}

function handleGetVerificationChecks(args = {}) {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  if (!taskId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const phase = typeof args.phase === 'string' ? args.phase.trim() : '';
  const checkName = typeof args.check_name === 'string' ? args.check_name.trim() : '';

  const verificationLedger = getVerificationLedgerService();
  if (!verificationLedger) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'verificationLedger service is not available');
  }

  const filters = {};
  if (phase) {
    filters.phase = phase;
  }
  if (checkName) {
    filters.checkName = checkName;
  }

  const checks = verificationLedger.getChecksForTask(taskId, filters);
  const summary = {
    task_id: taskId,
    count: checks.length,
    checks,
  };
  if (phase) {
    summary.phase = phase;
  }
  if (checkName) {
    summary.check_name = checkName;
  }

  return toJsonResponse({
    ...summary,
    message: `Found ${checks.length} verification check(s) for task ${taskId}`,
  });
}

function handleGetVerificationLedger(args = {}) {
  return handleGetVerificationChecks(args);
}

function handleGetVerificationSummary(args = {}) {
  const workflowId = typeof args.workflow_id === 'string' ? args.workflow_id.trim() : '';
  if (!workflowId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  const verificationLedger = getVerificationLedgerService();
  if (!verificationLedger) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'verificationLedger service is not available');
  }

  const summary = verificationLedger.getCheckSummary(workflowId) || {};
  const total = Object.values(summary).reduce((acc, info) => acc + (Number(info.total) || 0), 0);

  return toJsonResponse({
    workflow_id: workflowId,
    total,
    summary,
    message: `Verification check summary for workflow ${workflowId}: ${total} checks`,
  });
}

async function handleGetAdversarialReviews(args = {}) {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  if (!taskId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const adversarialReviews = getAdversarialReviewsService();
  if (!adversarialReviews) {
    return makeError(ErrorCodes.INTERNAL_ERROR, 'adversarialReviews service is not available');
  }

  const reviews = adversarialReviews.getReviewsForTask(taskId) || [];
  const parsed = reviews.map((review) => ({
    ...review,
    issues: parseAdversarialIssues(review.issues),
  }));
  const payload = {
    task_id: taskId,
    reviews: parsed,
    count: parsed.length,
  };

  return {
    structuredData: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

async function handleRequestAdversarialReview(args = {}) {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  if (!taskId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }
  if (typeof args.working_directory !== 'string' || !args.working_directory.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const taskCore = defaultContainer.get('taskCore');
  const task = taskCore.getTask(taskId);
  if (!task) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, 'Task not found');
  }
  if (task.status !== 'completed') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Task must be completed to review');
  }

  const { createAdversarialReviewStage } = require('../execution/adversarial-review-stage');
  const adversarialReviews = defaultContainer.get('adversarialReviews');
  const fileRiskAdapter = defaultContainer.get('fileRiskAdapter');
  const taskManager = defaultContainer.get('taskManager');
  const projectConfigCore = defaultContainer.get('projectConfigCore');
  const workflowEngine = defaultContainer.get('workflowEngine');

  let metadata = {};
  try {
    metadata = JSON.parse(task.metadata || '{}');
  } catch (_err) {
    metadata = {};
  }

  let filesModified = [];
  try {
    const parsedFiles = JSON.parse(task.files_modified);
    if (Array.isArray(parsedFiles)) {
      filesModified = parsedFiles;
    }
  } catch (_err) {
    filesModified = [];
  }

  const reviewer = typeof args.provider === 'string' ? args.provider.trim() : '';
  const stage = createAdversarialReviewStage({
    adversarialReviews,
    fileRiskAdapter,
    taskCore,
    workflowEngine,
    taskManager,
    projectConfigCore,
  });

  const ctx = {
    taskId,
    task: {
      ...task,
      metadata: JSON.stringify({ ...metadata, adversarial_review: true, adversarial_reviewer: reviewer || undefined }),
    },
    status: 'completed',
    code: 0,
    filesModified,
    earlyExit: false,
    validationStages: {},
    proc: { baselineCommit: task.git_before_sha },
  };

  await stage(ctx);

  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, task_id: taskId, message: 'Adversarial review task spawned' }) }],
  };
}

module.exports = {
  handleGetFileRisk,
  handleGetTaskRiskSummary,
  handleSetFileRiskOverride,
  handleGetHighRiskFiles,
  handleGetVerificationChecks,
  handleGetVerificationLedger,
  handleGetVerificationSummary,
  handleGetAdversarialReviews,
  handleRequestAdversarialReview,
};
