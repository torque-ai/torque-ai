const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const taskCore = require('../../../db/task-core');
const emailPeek = require('../../../db/email-peek');
const { getWorkflow } = require('../../../db/workflow-engine');
const { getArtifactConfig } = require('../../../db/task-metadata');
const { ErrorCodes, makeError } = require('../../../handlers/shared');

const BYTES_PER_KIB = 1024;
const LARGE_ARTIFACT_THRESHOLD = 1024 * 1024;
const DEFAULT_PEEK_TIMEOUT = 5000;
const INVALID_JSON_PREVIEW_LENGTH = 500;
const RETRY_DELAY_MS = 1500;
const RETRYABLE_ERRORS = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'Request timed out'];
const PEEK_ARTIFACT_STORAGE_ROOT = ['.local', 'share', 'torque', 'artifacts'];
const PEEK_DIAGNOSE_DIRNAME = 'peek-diagnose';
const LOCALHOST_HOST_PATTERN = /127\.0\.0\.1|localhost/i;
const LOCAL_TARGET_URL_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i;
const PEEK_HOSTS = new Map();

function formatBytes(bytes) {
  if (bytes < BYTES_PER_KIB) return `${bytes} B`;
  if (bytes < LARGE_ARTIFACT_THRESHOLD) return `${(bytes / BYTES_PER_KIB).toFixed(1)} KB`;
  return `${(bytes / LARGE_ARTIFACT_THRESHOLD).toFixed(1)} MB`;
}

function resolvePeekTaskContext(args) {
  const taskId = typeof args?.__taskId === 'string' && args.__taskId.trim()
    ? args.__taskId.trim()
    : (typeof args?.task_id === 'string' && args.task_id.trim() ? args.task_id.trim() : null);
  const task = taskId ? taskCore.getTask(taskId) : null;
  if (taskId && !task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const explicitWorkflowId = typeof args?.__workflowId === 'string' && args.__workflowId.trim()
    ? args.__workflowId.trim()
    : (typeof args?.workflow_id === 'string' && args.workflow_id.trim() ? args.workflow_id.trim() : null);
  const workflowId = explicitWorkflowId || task?.workflow_id || null;
  if (explicitWorkflowId && !getWorkflow(explicitWorkflowId)) {
    throw new Error(`Workflow not found: ${explicitWorkflowId}`);
  }

  return {
    task,
    taskId,
    workflowId,
    taskLabel: task?.workflow_node_id || null,
  };
}

function getTorqueArtifactStorageRoot() {
  const config = typeof getArtifactConfig === 'function' ? getArtifactConfig() : null;
  return config?.storage_path || path.join(os.homedir(), ...PEEK_ARTIFACT_STORAGE_ROOT);
}

function buildPeekPersistOutputDir(context, args) {
  const root = getTorqueArtifactStorageRoot();
  let ownerDir;
  if (context.taskId) {
    ownerDir = path.join(root, context.taskId, PEEK_DIAGNOSE_DIRNAME);
  } else if (context.workflowId) {
    ownerDir = path.join(root, '_workflows', context.workflowId, PEEK_DIAGNOSE_DIRNAME);
  } else {
    ownerDir = path.join(root, '_adhoc', PEEK_DIAGNOSE_DIRNAME);
  }
  const targetValue = args.process || args.title || context.taskLabel || 'window';
  const targetKey = sanitizePeekTargetKey(targetValue, PEEK_DIAGNOSE_DIRNAME);
  // SECURITY (M7): Use crypto.randomUUID() instead of Math.random()
  const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const outputDir = path.join(ownerDir, runId, targetKey);
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function inferPeekArtifactMimeType(filePath) {
  switch (path.extname(filePath || '').toLowerCase()) {
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function sanitizePeekTargetKey(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function resolvePeekHost(args) {
  // Phase 3: Use workstation adapter for peek host resolution
  try {
    const wsAdapters = require('../../../workstation/adapters');
    const wsHost = wsAdapters.resolvePeekHost(args);
    if (wsHost) {
      return {
        hostName: wsHost.name,
        hostUrl: `http://${wsHost.host}:9876`,
        ssh: null,
        platform: wsHost.platform || null,
      };
    }
  } catch { /* fall through to legacy */ }

  if (args.host) {
    const host = emailPeek.getPeekHost(args.host);
    if (!host) {
      return {
        error: makeError(ErrorCodes.INVALID_PARAM, `Peek host not found: ${args.host}`),
      };
    }
    if (host.enabled === 0) {
      return {
        error: makeError(ErrorCodes.INVALID_PARAM, `Peek host "${args.host}" is disabled. Enable it via the dashboard.`),
      };
    }
    PEEK_HOSTS.set(host.name, host);
    return {
      hostName: host.name,
      hostUrl: String(host.url).replace(/\/+$/, ''),
      ssh: host.ssh || null,
      platform: host.platform || null,
    };
  }

  let hosts = [];
  if (typeof emailPeek.listPeekHosts === 'function') {
    try {
      hosts = emailPeek.listPeekHosts() || [];
    } catch (_err) {
      hosts = [];
    }
  }
  PEEK_HOSTS.clear();
  for (const host of hosts) {
    if (host?.name) {
      PEEK_HOSTS.set(host.name, host);
    }
  }

  if (args._prefer_local || isLocalTarget(args)) {
    const localHost = hosts.find((host) => host.enabled !== 0 && LOCALHOST_HOST_PATTERN.test(host.url));
    if (localHost) {
      return {
        hostName: localHost.name,
        hostUrl: String(localHost.url).replace(/\/+$/, ''),
        ssh: localHost.ssh || null,
        platform: localHost.platform || null,
      };
    }
  }

  let defaultHost = null;
  if (typeof emailPeek.getDefaultPeekHost === 'function') {
    try {
      defaultHost = emailPeek.getDefaultPeekHost();
    } catch (_err) {
      defaultHost = null;
    }
  }
  if (defaultHost && defaultHost.url && defaultHost.enabled !== 0) {
    if (defaultHost.name) {
      PEEK_HOSTS.set(defaultHost.name, defaultHost);
    }
    return {
      hostName: defaultHost.name,
      hostUrl: String(defaultHost.url).replace(/\/+$/, ''),
      ssh: defaultHost.ssh || null,
      platform: defaultHost.platform || null,
    };
  }

  return {
    error: makeError(
      ErrorCodes.RESOURCE_NOT_FOUND,
      'No peek host configured. Connect Peek from a workstation card in the dashboard or use the register_peek_host tool.',
    ),
  };
}

function isLocalTarget(args) {
  return !!(args.url && LOCAL_TARGET_URL_PATTERN.test(args.url));
}

function getPeekTargetKey(args, peekData) {
  if (args.process) {
    return sanitizePeekTargetKey(`process-${peekData.process || args.process}`, 'process');
  }
  if (args.title) {
    return sanitizePeekTargetKey(`title-${peekData.title || args.title}`, 'title');
  }
  return 'screen';
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getHttpModule(targetUrl) {
  return new URL(String(targetUrl)).protocol === 'https:' ? https : http;
}

function peekHttpGetUrl(fullUrl, timeoutMs = DEFAULT_PEEK_TIMEOUT) {
  return new Promise((resolve) => {
    const url = new URL(fullUrl);
    const req = getHttpModule(url.href).get(url.href, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ data: JSON.parse(body), status: res.statusCode });
        } catch (err) {
          resolve({ error: `Invalid JSON: ${err.message}`, status: res.statusCode });
        }
      });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timed out' });
    });
  });
}

function peekHttpPost(fullUrl, payload, timeoutMs = DEFAULT_PEEK_TIMEOUT) {
  return new Promise((resolve) => {
    const url = new URL(fullUrl);
    const body = JSON.stringify(payload);
    const req = getHttpModule(url.href).request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ data: JSON.parse(raw), status: res.statusCode });
        } catch (err) {
          resolve({
            error: `Invalid JSON: ${err.message}`,
            raw: raw.substring(0, INVALID_JSON_PREVIEW_LENGTH),
            status: res.statusCode,
          });
        }
      });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timed out' });
    });
    req.write(body);
    req.end();
  });
}

function postCompare(hostUrl, baselineB64, currentB64, threshold, timeoutMs = DEFAULT_PEEK_TIMEOUT, ignoreRegions) {
  return new Promise((resolve) => {
    const url = new URL(hostUrl.replace(/\/+$/, '') + '/compare');
    const payloadObj = {
      baseline: baselineB64,
      current: currentB64,
      threshold,
    };
    if (ignoreRegions && ignoreRegions.length > 0) {
      payloadObj.ignore_regions = ignoreRegions;
    }
    const payload = JSON.stringify(payloadObj);
    const req = getHttpModule(url.href).request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ data: JSON.parse(body), status: res.statusCode });
        } catch (err) {
          resolve({
            error: `Invalid JSON: ${err.message}`,
            raw: body.substring(0, INVALID_JSON_PREVIEW_LENGTH),
            status: res.statusCode,
          });
        }
      });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request timed out' });
    });
    req.write(payload);
    req.end();
  });
}

function isRetryableError(result) {
  return !!(result?.error && RETRYABLE_ERRORS.some((errorCode) => result.error.includes(errorCode)));
}

async function peekHttpGetWithRetry(url, timeoutMs, maxAttempts = 2) {
  let lastResult;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await peekHttpGetUrl(url, timeoutMs);
    if (!isRetryableError(lastResult)) {
      return lastResult;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return lastResult;
}

async function postCompareWithRetry(hostUrl, baselineB64, currentB64, threshold, timeoutMs, maxAttempts = 2, ignoreRegions) {
  let lastResult;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await postCompare(hostUrl, baselineB64, currentB64, threshold, timeoutMs, ignoreRegions);
    if (!isRetryableError(lastResult)) {
      return lastResult;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return lastResult;
}

async function peekHttpPostWithRetry(fullUrl, payload, timeoutMs, maxAttempts = 2) {
  let lastResult;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await peekHttpPost(fullUrl, payload, timeoutMs);
    if (!isRetryableError(lastResult)) {
      return lastResult;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return lastResult;
}

function createPeekSharedHandlers() {
  return {
    PEEK_HOSTS,
    DEFAULT_PEEK_TIMEOUT,
    LARGE_ARTIFACT_THRESHOLD,
    RETRYABLE_ERRORS,
    RETRY_DELAY_MS,
    formatBytes,
    resolvePeekTaskContext,
    getTorqueArtifactStorageRoot,
    buildPeekPersistOutputDir,
    inferPeekArtifactMimeType,
    sanitizePeekTargetKey,
    resolvePeekHost,
    isLocalTarget,
    getPeekTargetKey,
    escapeXml,
    getHttpModule,
    peekHttpGetUrl,
    peekHttpPost,
    postCompare,
    isRetryableError,
    peekHttpGetWithRetry,
    postCompareWithRetry,
    peekHttpPostWithRetry,
  };
}

module.exports = {
  PEEK_HOSTS,
  DEFAULT_PEEK_TIMEOUT,
  LARGE_ARTIFACT_THRESHOLD,
  RETRYABLE_ERRORS,
  RETRY_DELAY_MS,
  formatBytes,
  resolvePeekTaskContext,
  getTorqueArtifactStorageRoot,
  buildPeekPersistOutputDir,
  inferPeekArtifactMimeType,
  sanitizePeekTargetKey,
  resolvePeekHost,
  isLocalTarget,
  getPeekTargetKey,
  escapeXml,
  getHttpModule,
  peekHttpGetUrl,
  peekHttpPost,
  postCompare,
  isRetryableError,
  peekHttpGetWithRetry,
  postCompareWithRetry,
  peekHttpPostWithRetry,
  createPeekSharedHandlers,
};
