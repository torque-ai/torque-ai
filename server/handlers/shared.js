/**
 * Shared validation constants, helpers, and utilities for handler modules.
 * Extracted from tools.js to avoid duplication across handler files.
 */

const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { ErrorCodes, makeError } = require('./error-codes');
const { TASK_TIMEOUTS } = require('../constants');

// ============================================================
// Validation Constants
// ============================================================

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_TASK_LENGTH = 50000; // 50KB
const MAX_URL_LENGTH = 2048;
const MAX_BATCH_SIZE = 100;
const MAX_LIMIT = 1000;
const MAX_OFFSET = 100000;
const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB
const MAX_PAYLOAD_SIZE = 512 * 1024;   // 512KB

const VALID_WEBHOOK_EVENTS = ['completed', 'failed', 'started', 'cancelled', 'progress', 'timeout'];
const VALID_ALERT_TYPES = ['daily_tasks', 'daily_runtime', 'weekly_tasks', 'weekly_runtime', 'monthly_tasks', 'monthly_runtime'];
const VALID_PATTERN_TYPES = ['output', 'error', 'both'];
const VALID_BREAKPOINT_ACTIONS = ['pause', 'log', 'notify'];

// Maximum nesting depth for user-provided objects
const MAX_OBJECT_DEPTH = 10;
const MAX_OBJECT_KEYS = 100;

// Blocked file extensions for artifact storage
const BLOCKED_ARTIFACT_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr',
  '.sh', '.bash', '.zsh', '.csh',
  '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.wsf', '.wsh', '.hta',
  '.dll', '.sys', '.drv',
  '.app', '.dmg', '.pkg',
  '.deb', '.rpm', '.snap',
  '.jar', '.war', '.ear',
  '.reg', '.inf',
]);

const MIME_TYPE_PATTERN = /^[a-z]+\/[a-z0-9\-+.]+$/i;

// ============================================================
// Validation Helpers
// ============================================================

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// LIMITATION (M6): DNS rebinding attacks can bypass this check.
// Attacker registers domain pointing to internal IP, DNS changes after validation.
// Mitigation: document in SECURITY.md, recommend firewall rules.
function isInternalHost(url) {
  try {
    if (typeof url !== 'string') {
      return true;
    }

    const input = url.trim();
    if (!input) {
      return true;
    }

    let hostname;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
      hostname = new URL(input).hostname.toLowerCase();
    } else if (/^\[[^\]]+\](?::\d+)?$/.test(input)) {
      hostname = input.match(/^\[([^\]]+)\]/)[1].toLowerCase();
    } else if (/^[^/:]+:\d+$/.test(input)) {
      hostname = input.replace(/:\d+$/, '').toLowerCase();
    } else {
      hostname = input.toLowerCase();
    }

    if (!hostname) {
      return true;
    }

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) &&
        !hostname.includes('.') &&
        !hostname.includes(':') &&
        hostname !== 'localhost') {
      return true;
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1' ||
        hostname === '::1' || hostname === '[::1]') {
      return true;
    }
    if (hostname.endsWith('.localhost')) {
      return true;
    }

    // SECURITY: Detect IPv6-mapped IPv4 addresses (::ffff:x.x.x.x) and re-check the embedded IPv4
    const bareHostname = hostname.replace(/^\[|\]$/g, '');
    const ipv6MappedMatch = bareHostname.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (ipv6MappedMatch) {
      // Recursively check the embedded IPv4 address
      return isInternalHost(`http://${ipv6MappedMatch[1]}/`);
    }

    // SECURITY: Block IPv6 loopback, link-local, and unique local addresses
    if (bareHostname === '::1') return true;
    if (bareHostname.startsWith('fe80:')) return true;   // link-local
    if (bareHostname.startsWith('fc00:') || (/^fd[0-9a-f]{2}:/i).test(bareHostname)) return true; // unique local (ULA)
    if (/^\d{8,}$/.test(bareHostname)) return true;
    if (/^0x[0-9a-f]+$/i.test(bareHostname)) return true;
    if (/^0\d+\./.test(bareHostname)) return true;

    const ipv4Match = bareHostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b, c] = ipv4Match.map(Number);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 0) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      if (a === 192 && b === 0 && c === 0) return true;
      if (a === 192 && b === 0 && c === 2) return true;
      if (a === 198 && b === 51 && c === 100) return true;
      if (a === 203 && b === 0 && c === 113) return true;
      if (a >= 224) return true;
    }

    if (bareHostname === '169.254.169.254' || bareHostname === 'metadata.google.internal') {
      return true;
    }

    const internalPatterns = [
      /^(internal|intranet|corp|private|local)\./i,
      /\.(internal|intranet|corp|local)$/i,
      /^metadata\./i,
    ];
    for (const pattern of internalPatterns) {
      if (pattern.test(bareHostname)) return true;
    }

    return false;
  } catch {
    return true;
  }
}

function isValidWebhookUrl(url) {
  if (!isValidUrl(url)) {
    return { valid: false, reason: 'Invalid URL format or protocol' };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Webhook URL must use HTTPS for security' };
    }
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
  if (isInternalHost(url)) {
    return { valid: false, reason: 'Webhook URL cannot point to internal or private hosts' };
  }
  return { valid: true };
}

function isValidRegex(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isSafeRegexPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200) {
    return false;
  }
  if (/(\+|\*|\?|\{[^}]+\})\s*\)(\+|\*|\{[^}]+\})/.test(pattern) ||
      /\(\?[^)]*\)\+/.test(pattern)) {
    return false;
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function safeLimit(value, defaultVal, maxVal = MAX_LIMIT) {
  if (value === null || value === undefined) {
    return Math.min(defaultVal, maxVal);
  }
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1 || !Number.isFinite(num) || num > Number.MAX_SAFE_INTEGER) {
    return Math.min(defaultVal, maxVal);
  }
  return Math.min(num, maxVal);
}

function safeOffset(value, maxVal = MAX_OFFSET) {
  if (value === null || value === undefined) {
    return 0;
  }
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 0 || !Number.isFinite(num) || num > Number.MAX_SAFE_INTEGER) {
    return 0;
  }
  return Math.min(num, maxVal);
}

function isPathTraversalSafe(filePath, allowedBase = null) {
  if (typeof filePath !== 'string') {
    return false;
  }
  if (filePath.length === 0 || filePath.length > 4096) {
    return false;
  }
  if (filePath.includes('\x00')) {
    return false;
  }

  // Decode fully before checking — loop until stable to prevent double-encoding bypass
  let decodedPath = filePath;
  let prev;
  do {
    prev = decodedPath;
    try { decodedPath = decodeURIComponent(decodedPath); } catch { break; }
  } while (decodedPath !== prev);

  const normalizedSlashes = filePath.replace(/\\/g, '/');
  const decodedNormalized = decodedPath.replace(/\\/g, '/');
  const normalized = path.normalize(filePath);

  const pathsToCheck = [filePath, normalized, normalizedSlashes, decodedPath, decodedNormalized];
  for (const p of pathsToCheck) {
    if (p.includes('..')) {
      return false;
    }
  }

  const lowerNormalized = normalizedSlashes.toLowerCase();
  const dangerousPaths = [
    '/etc', '/root', '/var/log', '/proc', '/sys', '/dev',
    '/windows/system32', '/program files', '/programdata',
    '/users/administrator', '/boot', '/home/root'
  ];
  for (const dangerous of dangerousPaths) {
    if (lowerNormalized.startsWith(dangerous) || lowerNormalized.includes(dangerous + '/')) {
      return false;
    }
  }

  if (allowedBase) {
    const resolved = path.resolve(allowedBase, filePath);
    const resolvedBase = path.resolve(allowedBase);
    if (process.platform === 'win32') {
      return resolved.toLowerCase().startsWith(resolvedBase.toLowerCase());
    }
    return resolved.startsWith(resolvedBase);
  }
  return true;
}

function safeDate(dateStr) {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    if (year < 2000 || year > 2100) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

function toFiniteInt(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function getWorkflowTaskCounts(workflow) {
  const summary = workflow?.summary || {};
  const taskList = Array.isArray(workflow?.tasks)
    ? workflow.tasks
    : Object.values(workflow?.tasks || {});

  const summaryCounts = {
    total: toFiniteInt(summary.total, workflow?.total_tasks),
    completed: toFiniteInt(summary.completed, workflow?.completed_tasks),
    failed: toFiniteInt(summary.failed, workflow?.failed_tasks),
    running: toFiniteInt(summary.running),
    blocked: toFiniteInt(summary.blocked),
    pending: toFiniteInt(summary.pending),
    queued: toFiniteInt(summary.queued),
    skipped: toFiniteInt(summary.skipped, workflow?.skipped_tasks),
    cancelled: toFiniteInt(summary.cancelled),
    pending_provider_switch: toFiniteInt(summary.pending_provider_switch)
  };

  if (taskList.length > 0) {
    const taskCounts = {
      total: taskList.length,
      completed: 0,
      failed: 0,
      running: 0,
      blocked: 0,
      pending: 0,
      queued: 0,
      skipped: 0,
      cancelled: 0,
      pending_provider_switch: 0
    };

    for (const task of taskList) {
      const key = typeof task?.status === 'string' ? task.status : '';
      if (Object.prototype.hasOwnProperty.call(taskCounts, key)) {
        taskCounts[key] += 1;
      }
    }

    const counts = {
      total: Math.max(summaryCounts.total, taskCounts.total),
      completed: Math.max(summaryCounts.completed, taskCounts.completed),
      failed: Math.max(summaryCounts.failed, taskCounts.failed),
      running: Math.max(summaryCounts.running, taskCounts.running),
      blocked: Math.max(summaryCounts.blocked, taskCounts.blocked),
      pending: Math.max(summaryCounts.pending, taskCounts.pending),
      queued: Math.max(summaryCounts.queued, taskCounts.queued),
      skipped: Math.max(summaryCounts.skipped, taskCounts.skipped),
      cancelled: Math.max(summaryCounts.cancelled, taskCounts.cancelled),
      pending_provider_switch: Math.max(summaryCounts.pending_provider_switch, taskCounts.pending_provider_switch)
    };
    counts.open = counts.running + counts.pending + counts.queued + counts.blocked + counts.pending_provider_switch;
    counts.runnable = counts.running + counts.pending + counts.queued + counts.pending_provider_switch;
    counts.terminal = counts.completed + counts.failed + counts.skipped + counts.cancelled;
    return counts;
  }

  const counts = { ...summaryCounts };
  counts.open = counts.running + counts.pending + counts.queued + counts.blocked + counts.pending_provider_switch;
  counts.runnable = counts.running + counts.pending + counts.queued + counts.pending_provider_switch;
  counts.terminal = counts.completed + counts.failed + counts.skipped + counts.cancelled;
  return counts;
}

function getWorkflowRestartGuardError(workflow, options = {}) {
  if (!workflow) return null;

  const counts = getWorkflowTaskCounts(workflow);
  if (counts.runnable === 0) {
    return null;
  }

  const status = workflow.status || 'pending';
  const allowPausedResume = options.allowPausedResume === true;
  const allowFreshPendingStart = options.allowFreshPendingStart === true;
  const freshPendingStart = allowFreshPendingStart
    && status === 'pending'
    && !workflow.started_at
    && !workflow.completed_at
    && counts.running === 0
    && counts.queued === 0;

  if (freshPendingStart) {
    return null;
  }

  if (allowPausedResume && status === 'paused') {
    return null;
  }

  const workflowRef = workflow.name
    ? `workflow '${workflow.name}' (${workflow.id})`
    : `workflow ${workflow.id || '(unknown)'}`;
  const attemptedAction = options.attemptedAction || 'restart this workflow';

  return makeError(
    ErrorCodes.INVALID_STATUS_TRANSITION,
    `Cannot ${attemptedAction} because ${workflowRef} still has live runnable work (${counts.running} running, ${counts.pending} pending, ${counts.queued} queued). Wait for that work to finish, or reconcile/pause/cancel the workflow before trying again.`
  );
}

function evaluateWorkflowVisibility(workflow) {
  const status = workflow?.status || 'pending';
  const counts = getWorkflowTaskCounts(workflow);
  const terminalWorkflow = new Set(['completed', 'failed', 'cancelled']);
  const activeWorkflow = new Set(['pending', 'running', 'paused']);

  if (counts.total === 0) {
    return {
      state: 'hygiene',
      code: 'empty-workflow',
      actionable: false,
      label: 'HYGIENE: empty workflow',
      reason: `Workflow is ${status} but has no tasks attached.`,
      next_step: 'Add tasks or remove the workflow entry.',
      counts
    };
  }

  if (terminalWorkflow.has(status) && counts.open > 0) {
    return {
      state: 'hygiene',
      code: 'status-conflict',
      actionable: true,
      label: 'HYGIENE: status conflict',
      reason: `Workflow is marked ${status} but still has ${counts.open} open task(s).`,
      next_step: 'Reconcile workflow status before trusting this summary.',
      counts
    };
  }

  if (counts.runnable === 0 && counts.blocked > 0) {
    return {
      state: 'hygiene',
      code: 'blocked-only',
      actionable: false,
      label: 'HYGIENE: no runnable tasks',
      reason: `All ${counts.blocked} open task(s) are blocked, so the workflow cannot progress.`,
      next_step: 'Fix the dependency graph or unblock a prerequisite task.',
      counts
    };
  }

  if (activeWorkflow.has(status) && counts.open === 0) {
    return {
      state: 'hygiene',
      code: 'stale-active-status',
      actionable: false,
      label: 'HYGIENE: stale active status',
      reason: `Workflow is ${status} but every task is already terminal.`,
      next_step: 'Refresh or close the workflow so it stops appearing as active work.',
      counts
    };
  }

  if (status === 'paused') {
    return {
      state: 'paused',
      code: 'paused',
      actionable: true,
      label: 'PAUSED',
      reason: `Workflow is paused with ${counts.open} open task(s).`,
      next_step: 'Run run_workflow to resume task starts.',
      counts
    };
  }

  if (counts.running > 0 || counts.runnable > 0) {
    return {
      state: 'actionable',
      code: 'active',
      actionable: true,
      label: 'ACTIONABLE',
      reason: `${counts.running} running, ${counts.pending + counts.queued} ready, ${counts.blocked} blocked.`,
      next_step: 'Inspect task progress or await the next completion.',
      counts
    };
  }

  return {
    state: 'quiet',
    code: 'quiet',
    actionable: false,
    label: 'QUIET',
    reason: `Workflow has no open tasks and ${counts.terminal} terminal task(s).`,
    next_step: 'No action needed unless you want to inspect history or results.',
    counts
  };
}

function validateObjectDepth(obj, maxDepth = MAX_OBJECT_DEPTH, maxKeys = MAX_OBJECT_KEYS) {
  if (obj === null || obj === undefined) {
    return { valid: true };
  }
  if (typeof obj !== 'object') {
    return { valid: true };
  }

  let totalKeys = 0;

  function checkDepth(value, currentDepth) {
    if (currentDepth > maxDepth) {
      return `Object nesting too deep (max ${maxDepth} levels)`;
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      return null;
    }
    const keys = Object.keys(value);
    totalKeys += keys.length;
    if (totalKeys > maxKeys) {
      return `Object has too many keys (max ${maxKeys})`;
    }
    for (const key of keys) {
      const error = checkDepth(value[key], currentDepth + 1);
      if (error) return error;
    }
    return null;
  }

  const error = checkDepth(obj, 0);
  if (error) {
    return { valid: false, error };
  }
  return { valid: true };
}

function hasOwnKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function isDatabaseDependency(value) {
  return value !== null && value !== undefined;
}

function unwrapHandlerDatabase(db) {
  return db && typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
}

function resolveContainerValue(container, name) {
  if (!container || typeof container.get !== 'function') {
    return null;
  }
  try {
    if (typeof container.has === 'function' && !container.has(name)) {
      return null;
    }
    return container.get(name);
  } catch (_e) {
    try {
      if (typeof container.peek === 'function') {
        const value = container.peek(name);
        return value === undefined ? null : value;
      }
    } catch (_peekErr) {
      return null;
    }
    return null;
  }
}

function getDefaultHandlerContainer() {
  try {
    return require('../container').defaultContainer;
  } catch (_e) {
    return null;
  }
}

function appendUniqueContainer(containers, container) {
  if (container && !containers.includes(container)) {
    containers.push(container);
  }
}

function resolveHandlerDatabase(deps = {}, options = {}) {
  const normalizedDeps = deps && typeof deps === 'object' ? deps : {};
  const raw = options.raw === true;
  const explicitCandidates = raw
    ? [
      hasOwnKey(normalizedDeps, 'rawDb') ? normalizedDeps.rawDb : undefined,
      hasOwnKey(normalizedDeps, 'db') ? normalizedDeps.db : undefined,
    ]
    : [
      hasOwnKey(normalizedDeps, 'db') ? normalizedDeps.db : undefined,
      hasOwnKey(normalizedDeps, 'rawDb') ? normalizedDeps.rawDb : undefined,
    ];

  for (const candidate of explicitCandidates) {
    if (isDatabaseDependency(candidate)) {
      return raw ? unwrapHandlerDatabase(candidate) : candidate;
    }
  }

  const containers = [];
  appendUniqueContainer(containers, normalizedDeps.container);
  appendUniqueContainer(containers, options.container);
  if (hasOwnKey(options, 'defaultContainer')) {
    appendUniqueContainer(containers, options.defaultContainer);
  } else {
    appendUniqueContainer(containers, getDefaultHandlerContainer());
  }

  const services = Array.isArray(options.services) && options.services.length > 0
    ? options.services
    : ['db', 'dbInstance'];
  for (const container of containers) {
    for (const serviceName of services) {
      const candidate = resolveContainerValue(container, serviceName);
      if (isDatabaseDependency(candidate)) {
        return raw ? unwrapHandlerDatabase(candidate) : candidate;
      }
    }
  }

  return null;
}

function validateArtifactMimeType(filename, detectedMimeType) {
  const ext = path.extname(filename).toLowerCase();

  if (BLOCKED_ARTIFACT_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      reason: `File extension '${ext}' is not allowed for security reasons`
    };
  }

  if (detectedMimeType && !MIME_TYPE_PATTERN.test(detectedMimeType)) {
    return {
      valid: false,
      reason: 'Invalid MIME type format'
    };
  }

  const dangerousMimeTypes = [
    'application/x-msdownload',
    'application/x-msdos-program',
    'application/x-sh',
    'application/x-shellscript',
    'application/x-executable',
    'application/x-dosexec',
  ];

  if (detectedMimeType && dangerousMimeTypes.includes(detectedMimeType.toLowerCase())) {
    return {
      valid: false,
      reason: 'File type not allowed for security reasons'
    };
  }

  return { valid: true, mimeType: detectedMimeType };
}

function validateEnvVarName(name) {
  if (typeof name !== 'string') {
    return { valid: false, reason: 'Environment variable name must be a string' };
  }
  if (name.length === 0 || name.length > 256) {
    return { valid: false, reason: 'Environment variable name must be 1-256 characters' };
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return { valid: false, reason: 'Environment variable name must start with letter or underscore, contain only alphanumeric and underscore' };
  }
  const blockedNames = new Set(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']);
  if (blockedNames.has(name.toUpperCase())) {
    return { valid: false, reason: `Environment variable '${name}' is not allowed for security reasons` };
  }
  return { valid: true };
}

function checkForControlChars(str, fieldName = 'value') {
  if (typeof str !== 'string') {
    return { safe: true };
  }
  if (str.includes('\x00')) {
    return { safe: false, reason: `${fieldName} contains null bytes` };
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      return { safe: false, reason: `${fieldName} contains dangerous control characters` };
    }
  }
  return { safe: true };
}

function sanitizeControlChars(str) {
  if (typeof str !== 'string') return str;

  let sanitized = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      continue;
    }
    sanitized += str[i];
  }

  return sanitized;
}

/**
 * Strip authentication credentials (username:password) from a URL for safe logging.
 * @param {string} url - URL that may contain embedded credentials
 * @returns {string} URL with credentials removed, or '[invalid-url]' if unparseable
 */
function stripUrlAuth(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch { return '[invalid-url]'; }
}

function generateIdempotencyKey(operation, params) {
  const content = JSON.stringify({ operation, params });
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 32);
}

// Idempotency cache
const idempotencyCache = new Map();
const _idempotencyCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (now - entry.timestamp > 3600000) idempotencyCache.delete(key);
  }
}, 300000);
_idempotencyCleanupInterval.unref();
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;

function checkIdempotency(key) {
  const cached = idempotencyCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > IDEMPOTENCY_WINDOW_MS) {
    idempotencyCache.delete(key);
    return null;
  }

  return cached.result;
}

function storeIdempotencyResult(key, result) {
  if (idempotencyCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of idempotencyCache) {
      if (now - v.timestamp > IDEMPOTENCY_WINDOW_MS) {
        idempotencyCache.delete(k);
      }
    }
  }

  idempotencyCache.set(key, { timestamp: Date.now(), result });
}

function validationError(field, message, hint = null, example = null) {
  let text = `Validation Error: ${message}`;
  if (hint) {
    text += `\n\nHint: ${hint}`;
  }
  if (example) {
    text += `\n\nExample: ${example}`;
  }
  return makeError(ErrorCodes.INVALID_PARAM, text);
}

// ============================================================
// Common Validation Helpers
// ============================================================

/**
 * Validate that a required string field is present, is a string, and is non-empty.
 * @param {object} args - The arguments object.
 * @param {string} field - The field name to check.
 * @param {string} [label] - Human-readable label for error messages.
 * @returns {object|null} A makeError response if invalid, or null if valid.
 */
function requireString(args, field, label) {
  if (!args[field] || typeof args[field] !== 'string' || args[field].trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, `${label || field} is required and must be a non-empty string`);
  }
  return null;
}

/**
 * Validate that a required array field is present, is an array, and is non-empty.
 * @param {object} args - The arguments object.
 * @param {string} field - The field name to check.
 * @param {string} [label] - Human-readable label for error messages.
 * @returns {object|null} A makeError response if invalid, or null if valid.
 */
function requireArray(args, field, label) {
  if (!args[field] || !Array.isArray(args[field]) || args[field].length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, `${label || field} is required and must be a non-empty array`);
  }
  return null;
}

/**
 * Validate that a field value is one of the allowed values.
 * @param {object} args - The arguments object.
 * @param {string} field - The field name to check.
 * @param {Array} allowed - Array of allowed values.
 * @param {string} [label] - Human-readable label for error messages.
 * @returns {object|null} A makeError response if invalid, or null if valid.
 */
function requireEnum(args, field, allowed, label) {
  if (!args[field] || !allowed.includes(args[field])) {
    return makeError(ErrorCodes.INVALID_PARAM, `${label || field} must be one of: ${allowed.join(', ')}`);
  }
  return null;
}

/**
 * Validate that a field is a positive integer.
 * @param {object} args - The arguments object.
 * @param {string} field - The field name to check.
 * @param {string} [label] - Human-readable label for error messages.
 * @returns {object|null} A makeError response if invalid, or null if valid.
 */
function requirePositiveInt(args, field, label) {
  const val = args[field];
  if (val === undefined || val === null || typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
    return makeError(ErrorCodes.INVALID_PARAM, `${label || field} must be a positive integer`);
  }
  return null;
}

/**
 * Validate that an optional field, if provided, is a string.
 * @param {object} args - The arguments object.
 * @param {string} field - The field name to check.
 * @param {string} [label] - Human-readable label for error messages.
 * @returns {object|null} A makeError response if invalid, or null if valid.
 */
function optionalString(args, field, label) {
  if (args[field] !== undefined && args[field] !== null && typeof args[field] !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, `${label || field} must be a string`);
  }
  return null;
}

const VALIDATION_HINTS = {
  task: 'Provide a clear description of what you want Codex to do',
  timeout: 'Timeout should be between 1 and 120 minutes',
  priority: 'Priority ranges from 1 (lowest) to 10 (highest)',
  cron: 'Use standard cron format: "minute hour day month dayOfWeek" (e.g., "0 * * * *" for hourly)',
  url: 'URL must start with http:// or https:// and be publicly accessible',
  tags: 'Tags should be an array of strings, e.g., ["tag1", "tag2"]',
  json: 'Provide valid JSON format',
  path: 'Use absolute paths or paths relative to the working directory'
};

// ============================================================
// Ollama Host Probing (shared between MCP handlers and REST API)
// ============================================================

/**
 * Probe an Ollama host by hitting GET /api/tags.
 * Returns a structured result with health, models, latency, and error info.
 * Callers handle DB recording themselves.
 *
 * @param {string} hostUrl - Base URL of the Ollama host (e.g., "http://192.0.2.100:11434")
 * @param {number} [timeoutMs] - Timeout in ms (defaults to TASK_TIMEOUTS.HEALTH_CHECK)
 * @returns {Promise<{ok: boolean, models: Array, latencyMs: number, error: string|null}>}
 */
function probeOllamaEndpoint(hostUrl, timeoutMs) {
  const timeout = timeoutMs || TASK_TIMEOUTS.HEALTH_CHECK || 5000;
  const startedAt = Date.now();

  let url;
  try {
    url = new URL('/api/tags', hostUrl);
  } catch (err) {
    return Promise.resolve({
      ok: false,
      models: [],
      latencyMs: 0,
      error: err.message || 'Invalid Ollama host URL',
    });
  }

  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const finish = (result) => resolve({
      models: [],
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...result,
    });

    const req = client.get(url.toString(), { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish({ ok: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const payload = data ? JSON.parse(data) : {};
          const models = Array.isArray(payload?.models) ? payload.models : [];
          finish({ ok: true, models, error: null });
        } catch (err) {
          finish({ ok: false, error: `Invalid JSON from /api/tags: ${err.message}` });
        }
      });
    });

    req.on('error', (err) => {
      let errorMsg = err.message || 'Connection failed';
      if (err.code === 'ECONNREFUSED') {
        errorMsg = `Could not connect to Ollama at ${hostUrl}. ` +
          `Start Ollama: ollama serve | ` +
          `Or configure a different host: torque config set ollama_host http://your-host:11434`;
      }
      finish({ ok: false, error: errorMsg });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: `Timed out after ${timeout}ms` });
    });
  });
}

/**
 * D2.3: Unified provider availability gate (RB-031).
 * Returns an error object if no providers can serve, or null if at least one is available.
 * @param {Object} db - database module
 * @param {Object} [options]
 * @param {boolean} [options.hasExplicitProvider] - true if user specified a provider override
 * @returns {{ error: Object } | null}
 */
function checkProviderAvailability(options = {}) {
  if (options.hasExplicitProvider) return null;
  const providerRoutingCore = require('../db/provider-routing-core');
  const hostManagement = require('../db/host-management');
  if (!providerRoutingCore.isCodexExhausted() || hostManagement.hasHealthyOllamaHost()) return null;
  return {
    error: makeError(ErrorCodes.NO_HOSTS_AVAILABLE,
      'No providers available: Codex quota exhausted and local LLM offline. ' +
      'Resubmit when either recovers, or specify an explicit provider override.'),
  };
}

/**
 * Require a task to exist, returning an error response if not found.
 * @param {string} taskId - Task ID to look up
 * @returns {{ task: object }|{ error: object }} task object or error response
 */
function requireTask(taskId) {
  if (!taskId) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required') };
  }
  const taskCore = require('../db/task-core');
  const task = taskCore.getTask(taskId);
  if (!task) {
    return { error: makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${taskId}`) };
  }
  return { task };
}

/**
 * Require a workflow to exist, returning an error response if not found.
 * @param {string} workflowId - Workflow ID to look up
 * @returns {{ workflow: object }|{ error: object }} workflow object or error response
 */
function requireWorkflow(workflowId) {
  if (!workflowId) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required') };
  }
  const workflowEngine = require('../db/workflow-engine');
  const workflow = workflowEngine.getWorkflow(workflowId);
  if (!workflow) {
    return { error: makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${workflowId}`) };
  }
  return { workflow };
}

/**
 * Build a Markdown table from headers and rows.
 * @param {string[]} headers - Column header labels
 * @param {Array<string[]>} rows - Array of row arrays (each matching headers length)
 * @returns {string} Formatted Markdown table string
 */
function buildMarkdownTable(headers, rows) {
  let out = `| ${headers.join(' | ')} |\n`;
  out += `| ${headers.map(() => '---').join(' | ')} |\n`;
  for (const row of rows) {
    out += `| ${row.join(' | ')} |\n`;
  }
  return out;
}

/**
 * Format an ISO timestamp for display.
 */
function formatTime(isoString) {
  if (!isoString) return 'N/A';
  const date = new Date(isoString);
  return date.toLocaleString('en-US');
}

module.exports = {
  // Constants
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TASK_LENGTH,
  MAX_URL_LENGTH,
  MAX_BATCH_SIZE,
  MAX_LIMIT,
  MAX_OFFSET,
  MAX_RESPONSE_SIZE,
  MAX_PAYLOAD_SIZE,
  VALID_WEBHOOK_EVENTS,
  VALID_ALERT_TYPES,
  VALID_PATTERN_TYPES,
  VALID_BREAKPOINT_ACTIONS,
  MAX_OBJECT_DEPTH,
  MAX_OBJECT_KEYS,
  BLOCKED_ARTIFACT_EXTENSIONS,
  MIME_TYPE_PATTERN,
  IDEMPOTENCY_WINDOW_MS,
  VALIDATION_HINTS,

  // Functions
  escapeRegExp,
  isValidUrl,
  isInternalHost,
  isValidWebhookUrl,
  isValidRegex,
  isSafeRegexPattern,
  safeLimit,
  safeOffset,
  isPathTraversalSafe,
  safeDate,
  getWorkflowTaskCounts,
  getWorkflowRestartGuardError,
  evaluateWorkflowVisibility,
  resolveHandlerDatabase,
  validateObjectDepth,
  validateArtifactMimeType,
  validateEnvVarName,
  checkForControlChars,
  sanitizeControlChars,
  stripUrlAuth,
  generateIdempotencyKey,
  checkIdempotency,
  storeIdempotencyResult,
  validationError,

  // Common validation helpers
  requireString,
  requireArray,
  requireEnum,
  requirePositiveInt,
  optionalString,
  requireTask,
  requireWorkflow,
  buildMarkdownTable,

  // Time formatting
  formatTime,

  // Ollama probing
  probeOllamaEndpoint,

  // Provider availability gate (D2.3: single source for codex_exhausted + ollama offline check)
  checkProviderAvailability,

  // Structured error codes (re-exported from error-codes.js)
  ErrorCodes,
  makeError,
};
