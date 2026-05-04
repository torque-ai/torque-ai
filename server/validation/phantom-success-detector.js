'use strict';

const factoryDecisions = require('../db/factory/decisions');
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

// ── Banner-only failure detection ────────────────────────────────────────────
// Distinct from phantom-success: these tasks have status='failed' or
// 'cancelled' (exit_code≠0 or null), but error_output captures only the
// Codex CLI startup banner and nothing else. Operators see the banner and
// can't tell why the task died (was it cancelled? timed out? crashed before
// producing output?). The substitution gives them a more actionable error
// message while preserving the banner inside (still visible if needed).
//
// Banner shape (codex CLI emits this to stderr at startup):
//   OpenAI Codex v0.125.0 (research preview)
//   --------
//   workdir: ...
//   model: ...
//   provider: ...
//   approval: ...
//   sandbox: ...
//   reasoning effort: ...
//   reasoning summaries: ...
//   session id: ...
//
// Live evidence: 3 codex tasks failed in 72h (2026-04-25/26) with
// error_output starting `OpenAI Codex v0.125.0 (research preview) -------- workdir: ...`
// and nothing else — the process was killed (stall, timeout, or crash) before
// producing real work output.

const CODEX_BANNER_OPEN = /OpenAI Codex v\d+\.\d+\.\d+/;
// Lines that come from the banner. Anything outside this set in stderr means
// the model actually started doing something — don't reclassify those.
const CODEX_BANNER_LINE_PATTERNS = [
  /OpenAI Codex v\d+\.\d+\.\d+/,
  /^-{4,}\s*$/,
  /^workdir:\s*/i,
  /^model:\s*/i,
  /^provider:\s*/i,
  /^approval:\s*/i,
  /^sandbox:\s*/i,
  /^reasoning (effort|summaries):\s*/i,
  /^session id:\s*/i,
  /^\s*$/,
];

function isCodexBannerLine(line) {
  return CODEX_BANNER_LINE_PATTERNS.some((re) => re.test(line));
}

function isBannerOnlyOutput(errorOutput) {
  if (!errorOutput || typeof errorOutput !== 'string') return false;
  if (!CODEX_BANNER_OPEN.test(errorOutput)) return false;
  const lines = errorOutput.split(/\r?\n/);
  return lines.every(isCodexBannerLine);
}

function detectCodexBannerOnly(input = {}) {
  const provider = input.provider;
  const status = input.status;
  const errorOutput = input.errorOutput ?? input.error_output;
  const stdout = input.output ?? input.stdout;

  if (status === 'completed') {
    return { isBannerOnly: false, reason: null };
  }
  if (!isCodexProvider(provider)) {
    return { isBannerOnly: false, reason: null };
  }
  if (!isEmptyOutput(stdout)) {
    return { isBannerOnly: false, reason: null };
  }
  if (!isBannerOnlyOutput(errorOutput)) {
    return { isBannerOnly: false, reason: null };
  }
  if (hasMeaningfulFileProduct(input)) {
    return { isBannerOnly: false, reason: null };
  }

  return {
    isBannerOnly: true,
    reason: 'codex was killed before producing any work output (banner-only stderr) — likely cancelled mid-startup, timed out, or crashed before model first token',
  };
}

function runCodexBannerOnlyDetection(ctx, _options = {}) {
  if (!ctx) return null;
  // Only fire on terminal non-success states where error_output ends up surfaced.
  if (ctx.status !== 'failed' && ctx.status !== 'cancelled') return null;

  const task = ctx.task || {};
  const detection = detectCodexBannerOnly({
    provider: task.provider || ctx.proc?.provider,
    status: ctx.status,
    output: ctx.output ?? ctx.proc?.output,
    errorOutput: ctx.errorOutput ?? ctx.proc?.errorOutput,
    filesModified: ctx.filesModified,
  });

  if (!detection.isBannerOnly) return detection;

  // Preserve the original banner inside the rewritten message — operators
  // who want to see the raw codex banner can still find it. Don't drop it
  // entirely or we destroy diagnostic data.
  const original = String(ctx.errorOutput || '').trim();
  const rewritten = original
    ? `${detection.reason}\n\n--- Original Codex stderr (banner only) ---\n${original}`
    : detection.reason;

  ctx.errorOutput = rewritten;
  ctx.codexBannerOnly = detection;

  return detection;
}

module.exports = {
  detectPhantomSuccess,
  runPhantomSuccessDetection,
  detectCodexBannerOnly,
  runCodexBannerOnlyDetection,
  isBannerOnlyOutput,
  parseFactoryContext,
  hasOverloadSignature,
  isEmptyOutput,
  hasMeaningfulFileProduct,
  PHANTOM_PROVIDERS,
  OVERLOAD_PATTERNS,
  CODEX_BANNER_LINE_PATTERNS,
};
