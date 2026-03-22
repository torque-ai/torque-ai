'use strict';

const db = require('../database');
const { handleToolCall } = require('../tools');
const { sendJson } = require('./middleware');

// Track server start time for readiness check
const serverStartTime = Date.now();

/**
 * Probe DB initialization/accessibility using a lightweight query.
 * Used by readiness and health probes.
 * @returns {{ initialized: boolean, accessible: boolean, status: string, reason?: string }}
 */
function probeDatabase() {
  const hasDbInstance = typeof db.getDbInstance === 'function' && Boolean(db.getDbInstance());
  const isDbClosed = typeof db.isDbClosed === 'function' ? db.isDbClosed() : false;
  const initialized = hasDbInstance && !isDbClosed;

  if (!initialized) {
    return {
      initialized: false,
      accessible: false,
      status: 'not_initialized',
      reason: 'database not initialized',
    };
  }

  try {
    // Simple query to prove DB is reachable.
    db.countTasks({ status: 'running' });
    return { initialized: true, accessible: true, status: 'connected' };
  } catch (err) {
    return {
      initialized: true,
      accessible: false,
      status: 'error',
      reason: err?.message || 'database query failed',
    };
  }
}

/**
 * Kubernetes-style health probe:
 * "What is the full health status of this instance?"
 * - Critical dependency: database (503 when unavailable)
 * - Optional dependency: Ollama (reports degraded, but remains 200)
 * Includes Ollama health check with a 5-second timeout to prevent hanging.
 */
async function handleHealthz(req, res, _context = {}) {
  void _context;
  const uptimeSeconds = Math.round(process.uptime());
  const databaseState = probeDatabase();
  let ollamaStatus = 'unknown';
  try {
    const healthPromise = handleToolCall('check_ollama_health', { force_check: false });
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('timeout')), 5000);
    });
    const health = await Promise.race([healthPromise, timeoutPromise]);
    clearTimeout(timeoutHandle);
    const healthText = health?.content?.[0]?.text || '';
    ollamaStatus = /\bhealthy\b/.test(healthText) && !healthText.includes('unhealthy') ? 'healthy' : 'unhealthy';
  } catch (e) {
    ollamaStatus = e.message === 'timeout' ? 'timeout' : 'error';
  }

  let queueDepth = null;
  let runningCount = null;
  if (databaseState.accessible) {
    try {
      // Batch both counts into a single grouped query to avoid two DB round-trips
      const counts = db.countTasksByStatus();
      queueDepth = counts.queued;
      runningCount = counts.running;
    } catch {
      queueDepth = null;
      runningCount = null;
    }
  }

  let status = 'healthy';
  let httpStatus = 200;
  if (!databaseState.accessible) {
    status = 'unhealthy';
    httpStatus = 503;
  } else if (ollamaStatus !== 'healthy') {
    status = 'degraded';
  }

  const response = {
    status,
    uptime_seconds: uptimeSeconds,
    database: databaseState.status,
    ollama: ollamaStatus,
    queue_depth: queueDepth,
    running_tasks: runningCount,
  };
  if (databaseState.reason) {
    response.database_reason = databaseState.reason;
  }

  sendJson(res, response, httpStatus, req);
}

/**
 * Kubernetes-style readiness probe:
 * "Can this instance accept traffic right now?"
 * Fails during startup warm-up and when DB is not initialized/accessible.
 */
function handleReadyz(req, res, _context = {}) {
  void _context;
  const uptimeMs = Date.now() - serverStartTime;
  const minUptimeMs = 5000;
  const databaseState = probeDatabase();

  if (databaseState.accessible && uptimeMs >= minUptimeMs) {
    sendJson(res, { status: 'ready' }, 200, req);
  } else {
    const reasons = [];
    if (!databaseState.initialized) reasons.push('database not initialized');
    else if (!databaseState.accessible) reasons.push('database not accessible');
    if (uptimeMs < minUptimeMs) reasons.push(`server warming up (${Math.round(uptimeMs / 1000)}s < 5s)`);
    sendJson(res, { status: 'not ready', reasons }, 503, req);
  }
}

/**
 * Kubernetes-style liveness probe:
 * "Is the process alive and event loop responsive?"
 * Never depends on external services and always returns 200 while process is running.
 */
function handleLivez(req, res, _context = {}) {
  void _context;
  sendJson(res, { status: 'ok', uptime: process.uptime() }, 200, req);
}

function createHealthProbes(deps) {
  return { handleHealthz, handleReadyz, handleLivez };
}

module.exports = {
  handleHealthz,
  handleReadyz,
  handleLivez,
  createHealthProbes,
};
