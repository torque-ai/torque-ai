'use strict';

const factoryDecisions = require('../db/factory-decisions');
const decisionLog = require('../factory/decision-log');
const logger = require('../logger').child({ component: 'phantom-success-detector' });

const PHANTOM_PROVIDERS = new Set(['codex', 'codex-spark']);

const OVERLOAD_PATTERNS = [
  /ERROR:\s*Reconnecting\.\.\./i,
  /currently experiencing high demand/i,
  /rate limit(?:ed| exceeded)?/i,
  /429\b/i,
  /exhausted\s+\d+\s+reconnect/i,
];

const NON_PRODUCT_PATH_PATTERNS = [
  /^runs\//i,
  /^logs\//i,
  /^\.torque-checkpoints\//i,
  /^\.tmp\//i,
  /^tmp\//i,
  /^docs\/superpowers\/plans\//i,
];

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function isCodexProvider(provider) {
  return PHANTOM_PROVIDERS.has(normalizeProvider(provider));
}

function hasOverloadSignature(stderr) {
  if (!stderr || typeof stderr !== 'string') return false;
  return OVERLOAD_PATTERNS.some((pattern) => pattern.test(stderr));
}

function isEmptyOutput(stdout) {
  if (stdout === null || stdout === undefined) return true;
  if (typeof stdout !== 'string') return false;
  const trimmed = stdout.trim();
  return trimmed.length === 0 || /^\(no output\)$/i.test(trimmed);
}

function normalizeRelativePath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim();
}

function getChangedFiles(input = {}) {
  const candidates = [
    input.filesModified,
    input.files_modified,
    input.changedFiles,
    input.changed_files,
    input.diffStat?.files,
    input.diffStat?.changedFiles,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(normalizeRelativePath).filter(Boolean);
    }
  }

  return [];
}

function isNonProductFile(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return true;
  return NON_PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasMeaningfulFileProduct(input = {}) {
  const files = getChangedFiles(input);
  if (files.length === 0) return false;
  return files.some((filePath) => !isNonProductFile(filePath));
}

function detectPhantomSuccess(input = {}) {
  const exitCode = Number(input.exitCode ?? input.exit_code);
  const provider = input.provider;
  const stdout = input.stdout ?? input.output;
  const stderr = input.stderr ?? input.errorOutput ?? input.error_output;

  if (exitCode !== 0) {
    return { isPhantom: false, reason: null, signals: [] };
  }

  if (!isCodexProvider(provider)) {
    return { isPhantom: false, reason: null, signals: [] };
  }

  if (!isEmptyOutput(stdout)) {
    return { isPhantom: false, reason: null, signals: [] };
  }

  if (!hasOverloadSignature(stderr)) {
    return { isPhantom: false, reason: null, signals: [] };
  }

  if (hasMeaningfulFileProduct(input)) {
    return { isPhantom: false, reason: null, signals: [] };
  }

  return {
    isPhantom: true,
    reason: 'codex exited 0 with empty output, overload/reconnect stderr, and no meaningful file product',
    signals: ['exit_zero', 'codex_provider', 'empty_output', 'overload_stderr', 'no_meaningful_file_product'],
  };
}

function parseTags(rawTags) {
  if (Array.isArray(rawTags)) return rawTags.map(String);
  if (!rawTags) return [];
  if (typeof rawTags !== 'string') return [];
  try {
    const parsed = JSON.parse(rawTags);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Fall through to comma/newline parsing.
  }
  return rawTags.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean);
}

function parseFactoryContext(task = {}) {
  const tags = parseTags(task.tags);
  const tagMap = new Map();
  for (const tag of tags) {
    const match = /^factory:([^=]+)=(.+)$/.exec(tag);
    if (match) tagMap.set(match[1], match[2]);
  }

  const batchId = tagMap.get('batch_id') || null;
  const workItemId = tagMap.get('work_item_id') || null;
  let projectId = task.factory_project_id || null;

  if (!projectId && batchId) {
    const batchMatch = /^factory-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(\d+))?$/i.exec(batchId);
    if (batchMatch && (!workItemId || !batchMatch[2] || batchMatch[2] === String(workItemId))) {
      projectId = batchMatch[1];
    }
  }

  return {
    project_id: projectId,
    batch_id: batchId,
    work_item_id: workItemId,
  };
}

function appendErrorOutput(current, message) {
  if (!message) return current || '';
  if (!current) return message;
  return `${current}\n${message}`;
}

function safeLogFactoryDecision(task, detection, ctx, options = {}) {
  const context = parseFactoryContext(task);
  if (!context.project_id) return null;

  const entry = {
    project_id: context.project_id,
    stage: 'execute',
    actor: 'executor',
    action: 'phantom_completion_detected',
    reasoning: detection.reason,
    inputs: {
      task_id: task.id || ctx.taskId,
      provider: task.provider || ctx.proc?.provider || null,
      work_item_id: context.work_item_id,
      signals: detection.signals,
    },
    outcome: {
      task_id: task.id || ctx.taskId,
      final_status: 'failed',
      raw_exit_code: ctx.rawExitCode ?? ctx.code,
    },
    confidence: 1,
    batch_id: context.batch_id,
  };

  if (typeof options.logDecision === 'function') {
    return options.logDecision(entry);
  }

  try {
    const rawDb = typeof options.getRawDb === 'function' ? options.getRawDb() : options.rawDb;
    if (rawDb && typeof rawDb.prepare === 'function') {
      factoryDecisions.setDb(rawDb);
    }
    return decisionLog.logDecision(entry);
  } catch (err) {
    logger.warn({ err: err.message, task_id: task.id || ctx.taskId }, 'Failed to log phantom completion decision');
    return null;
  }
}

function runPhantomSuccessDetection(ctx, options = {}) {
  if (!ctx || ctx.status !== 'completed') return null;

  const task = ctx.task || {};
  const detection = detectPhantomSuccess({
    exitCode: ctx.rawExitCode ?? ctx.code,
    stdout: ctx.output ?? ctx.proc?.output,
    stderr: ctx.errorOutput ?? ctx.proc?.errorOutput,
    provider: task.provider || ctx.proc?.provider,
    filesModified: ctx.filesModified,
  });

  if (!detection.isPhantom) return detection;

  ctx.status = 'failed';
  ctx.code = 1;
  ctx.errorOutput = appendErrorOutput(ctx.errorOutput, `[phantom-success] ${detection.reason}`);
  ctx.phantomSuccess = detection;

  safeLogFactoryDecision(task, detection, ctx, options);

  return detection;
}

module.exports = {
  detectPhantomSuccess,
  runPhantomSuccessDetection,
  parseFactoryContext,
  hasOverloadSignature,
  isEmptyOutput,
  hasMeaningfulFileProduct,
  PHANTOM_PROVIDERS,
  OVERLOAD_PATTERNS,
};
