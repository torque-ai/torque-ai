'use strict';

const { randomUUID } = require('crypto');
const logger = require('../../logger').child({ component: 'api-handlers' });
const serverConfig = require('../../config');
const taskCore = require('../../db/task-core');
const costTracking = require('../../db/cost-tracking');
const eventBus = require('../../event-bus');
const middleware = require('../middleware');
const { sendJson, parseBody, parseQuery } = middleware;
const { setQuotaTrackerGetter: setWebhookQuotaTrackerGetter } = require('../webhooks');

/** Localhost IP addresses that are always allowed to call /api/shutdown */
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * GET /api/quota/status — return quota provider quota status.
 */
let _quotaTrackerGetter = null;
function setQuotaTrackerGetter(getter) {
  _quotaTrackerGetter = getter;
  // Forward to webhook module so quota_task triggers can use it
  if (typeof setWebhookQuotaTrackerGetter === 'function') {
    setWebhookQuotaTrackerGetter(getter);
  }
}

async function handleGetQuotaStatus(_req, res, _context = {}) {
  try {
    const tracker = typeof _quotaTrackerGetter === 'function' ? _quotaTrackerGetter() : null;
    if (!tracker) {
      sendJson(res, { status: 'ok', providers: {}, message: 'FreeQuotaTracker not initialized' }, 200, _req);
      return;
    }
    sendJson(res, { status: 'ok', providers: tracker.getStatus() }, 200, _req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, _req);
  }
}

async function handleGetProviderQuotas(req, res, _context = {}) {
  try {
    const quotas = require('../../db/provider-quotas').getQuotaStore().getAllQuotas();
    sendJson(res, quotas, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

/**
 * GET /api/quota/history?days=7 — return quota daily usage history.
 */
async function handleGetQuotaHistory(req, res, _context = {}) {
  try {
    const query = parseQuery(req.url);
    const days = Math.max(1, Math.min(90, parseInt(query.days, 10) || 7));
    const history = costTracking.getUsageHistory(days);
    sendJson(res, { status: 'ok', history }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

/**
 * GET /api/quota/auto-scale — return quota auto-scale config + current status.
 */
async function handleGetQuotaAutoScale(_req, res, _context = {}) {
  try {
    const enabled = serverConfig.isOptIn('quota_auto_scale_enabled');
    const queueDepthThreshold = serverConfig.getInt('quota_queue_depth_threshold', 3);
    const cooldownSeconds = serverConfig.getInt('quota_cooldown_seconds', 60);

    // Count currently queued codex tasks
    let codexQueueDepth = 0;
    try {
      const queued = taskCore.listTasks({ status: 'queued', limit: 1000 });
      const queuedArr = Array.isArray(queued) ? queued : (queued.tasks || []);
      codexQueueDepth = queuedArr.filter(t => {
        if (t.provider === 'codex') return true;
        if (!t.provider) {
          try { const m = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata; return m?.intended_provider === 'codex'; } catch { return false; }
        }
        return false;
      }).length;
    } catch (_e) { void _e; }

    // Get last activation time from queue-scheduler
    let lastActivation = null;
    try {
      const scheduler = require('../../execution/queue-scheduler');
      const ts = scheduler._getLastAutoScaleActivation();
      if (ts > 0) lastActivation = new Date(ts).toISOString();
    } catch (_e) { void _e; }

    sendJson(res, {
      status: 'ok',
      auto_scale: {
        enabled,
        queue_depth_threshold: queueDepthThreshold,
        cooldown_seconds: cooldownSeconds,
        current_codex_queue_depth: codexQueueDepth,
        last_activation: lastActivation,
      },
    }, 200, _req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, _req);
  }
}

/**
 * POST /api/hooks/claude-event — receive Claude Code hook events.
 * Called by PostToolUse (notify-file-write), audit hooks, and any HTTP-type hooks.
 * Tracks file modifications by session for conflict detection with Codex sandboxes.
 */
const _claudeEventLog = new Map(); // sessionId -> { files: Set, events: [] }

async function handleClaudeEvent(req, res, _context = {}) {
  const requestId = _context.requestId || randomUUID();
  let body = {};
  try { body = await parseBody(req); } catch { /* ignore */ }

  const eventType = body.event_type || 'unknown';
  const sessionId = body.session_id || 'anonymous';
  const payload = body.payload || {};

  // Track file modifications per session
  if (eventType === 'file_write' && payload.file_path) {
    if (!_claudeEventLog.has(sessionId)) {
      _claudeEventLog.set(sessionId, { files: new Set(), events: [] });
      // Evict oldest entries if map grows beyond 1000 sessions
      if (_claudeEventLog.size > 1000) {
        const firstKey = _claudeEventLog.keys().next().value;
        _claudeEventLog.delete(firstKey);
      }
    }
    const session = _claudeEventLog.get(sessionId);
    session.files.add(payload.file_path);
    session.events.push({
      type: eventType,
      file: payload.file_path,
      tool: payload.tool_name || null,
      timestamp: payload.timestamp || new Date().toISOString(),
    });

    // Cap per-session event history at 500
    if (session.events.length > 500) {
      session.events = session.events.slice(-250);
    }
  }

  logger.debug('Claude event received', { eventType, sessionId, payload: JSON.stringify(payload).slice(0, 200) });

  sendJson(res, {
    status: 'ok',
    event_id: requestId,
    event_type: eventType,
    tracked_files: _claudeEventLog.get(sessionId)?.files.size || 0,
  }, 200, req);
}

/**
 * GET /api/hooks/claude-files — list files modified by Claude sessions.
 * Used by conflict detection to compare against Codex sandbox state.
 */
async function handleClaudeFiles(_req, res, _context = {}) {
  const query = parseQuery(_req.url);
  const sessionId = query.session_id;

  if (sessionId) {
    const session = _claudeEventLog.get(sessionId);
    sendJson(res, {
      session_id: sessionId,
      files: session ? [...session.files] : [],
      event_count: session ? session.events.length : 0,
    }, 200, _req);
  } else {
    // All sessions summary
    const sessions = {};
    for (const [sid, data] of _claudeEventLog.entries()) {
      sessions[sid] = { file_count: data.files.size, event_count: data.events.length };
    }
    sendJson(res, { sessions }, 200, _req);
  }
}

/**
 * POST /api/pii-scan — scan text for PII and return sanitized version.
 */
async function handlePiiScan(req, res, _context = {}) {
  void _context;

  const piiGuard = require('../../utils/pii-guard');
  let body = typeof req.body === 'object' && req.body !== null ? req.body : null;
  if (!body) {
    try {
      body = await parseBody(req);
    } catch {
      body = {};
    }
  }

  body = typeof body === 'object' && body !== null ? body : {};

  const text = body.text || '';
  const workingDir = body.working_directory || '';

  let customPatterns = [];
  const builtinOverrides = {};
  if (workingDir) {
    try {
      const projectConfigCore = require('../../db/project-config-core');
      const pcc = typeof projectConfigCore === 'function' ? projectConfigCore() : projectConfigCore;
      const project = pcc.getProjectFromPath(workingDir);
      if (project) {
        const piiJson = pcc.getProjectMetadata(project, 'pii_guard');
        if (piiJson) {
          const piiConfig = JSON.parse(piiJson);
          if (piiConfig.enabled === false) {
            sendJson(res, { clean: true, sanitized: text, findings: [] }, 200, req);
            return;
          }
          customPatterns = piiConfig.custom_patterns || [];
          if (piiConfig.builtin_categories) {
            for (const [cat, enabled] of Object.entries(piiConfig.builtin_categories)) {
              if (enabled === false) builtinOverrides[cat] = false;
            }
          }
        }
      }
    } catch (err) {
      logger.debug('[pii-scan] Failed to load project PII config:', err.message);
    }
  }

  const result = piiGuard.scanAndReplace(text, { builtinOverrides, customPatterns });
  sendJson(res, result, 200, req);
}

/**
 * POST /api/shutdown — trigger graceful shutdown from external callers.
 * Responds with 200 before initiating shutdown so the caller gets confirmation.
 * Requires a localhost source IP.
 */
async function handleShutdown(req, res, _context = {}) {
  void _context;
  const remoteIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const isLocalhost = LOCALHOST_IPS.has(remoteIp);

  if (!isLocalhost) {
    sendJson(res, { error: 'Forbidden' }, 403, req);
    return;
  }

  // Defense-in-depth: require X-Requested-With to prevent CSRF from browser contexts
  if (!req.headers['x-requested-with']) {
    sendJson(res, { error: 'X-Requested-With header required' }, 403, req);
    return;
  }

  // Defense-in-depth: validate Origin header if present
  const origin = req.headers['origin'];
  if (origin) {
    const localhostOriginPattern = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
    if (!localhostOriginPattern.test(origin)) {
      sendJson(res, { error: 'Origin not allowed' }, 403, req);
      return;
    }
  }

  let body = {};
  try { body = await parseBody(req); } catch { /* ignore */ }
  const reason = body.reason || 'HTTP /api/shutdown';
  const force = body.force === true;

  // Governance: block force-shutdown when tasks are running
  if (force) {
    try {
      const taskCore = require('../../db/task-core');
      const running = taskCore.listTasks({ status: 'running', limit: 1000 }).length;
      const queued = taskCore.listTasks({ status: 'queued', limit: 1000 }).length;
      if (running > 0 || queued > 0) {
        const { createGovernanceHooks } = require('../../governance/hooks');
        const governanceRules = require('../../db/governance-rules');
        const governance = createGovernanceHooks({ governanceRules, logger });
        const govResult = await governance.evaluate('server_restart', {}, {
          force: true, running, queued,
        });
        if (govResult.blocked && govResult.blocked.length > 0) {
          const msg = govResult.blocked.map(b => b.message).join('; ');
          sendJson(res, {
            error: `Governance blocked: ${msg}`,
            running, queued,
            hint: 'Restart always drains the pipeline — use restart_server or await_restart.',
          }, 409, req);
          return;
        }
      }
    } catch { /* governance unavailable — allow shutdown */ }
  }

  // Pipeline guard: refuse shutdown if tasks are in-flight, unless force=true.
  // stop-torque.sh should drain the pipeline first or pass force.
  if (!force) {
    try {
      const taskCore = require('../../db/task-core');
      const running = taskCore.listTasks({ status: 'running', limit: 1000 }).length;
      const queued = taskCore.listTasks({ status: 'queued', limit: 1000 }).length;
      const pending = taskCore.listTasks({ status: 'pending', limit: 1000 }).length;
      const blocked = taskCore.listTasks({ status: 'blocked', limit: 1000 }).length;
      const total = running + queued + pending + blocked;

      if (total > 0) {
        const parts = [];
        if (running > 0) parts.push(`${running} running`);
        if (queued > 0) parts.push(`${queued} queued`);
        if (pending > 0) parts.push(`${pending} pending`);
        if (blocked > 0) parts.push(`${blocked} blocked`);
        sendJson(res, {
          error: `Shutdown blocked: pipeline is not empty (${parts.join(', ')}). Use force: true to override.`,
          running, queued, pending, blocked,
        }, 409, req);
        return;
      }
    } catch { /* DB may be closed — allow shutdown to proceed */ }
  }

  sendJson(res, { status: 'shutting_down', reason }, 200, req);

  // Give the response time to flush, then trigger graceful shutdown
  setTimeout(() => {
    eventBus.emitShutdown(reason);
  }, 200);
}

module.exports = {
  setQuotaTrackerGetter,
  handleGetQuotaStatus,
  handleGetProviderQuotas,
  handleGetQuotaHistory,
  handleGetQuotaAutoScale,
  handleClaudeEvent,
  handleClaudeFiles,
  handlePiiScan,
  handleShutdown,
  _claudeEventLog,
  LOCALHOST_IPS,
};
