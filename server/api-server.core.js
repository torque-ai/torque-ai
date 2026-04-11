/**
 * TORQUE REST API Server
 *
 * HTTP endpoints that map to MCP tools for external tool integration.
 * Runs alongside the MCP stdio server and dashboard.
 */

const http = require('http');
const { randomUUID } = require('crypto');
const tools = require('./tools');
const { handleToolCall } = tools;
const db = require('./database');
const taskCore = require('./db/task-core');
const costTracking = require('./db/cost-tracking');
const serverConfig = require('./config');
const logger = require('./logger').child({ component: 'api-server' });
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');
const middleware = require('./api/middleware');
const routes = require('./api/routes');
const { generateOpenApiSpec } = require('./api/openapi-generator');
const { createHealthRoutes } = require('./api/health');
const { createV2Router, V2_PROVIDER_ROUTE_HANDLER_NAMES } = require('./api/v2-router');
const { normalizeError } = require('./api/v2-middleware');
const v2TaskHandlers = require('./api/v2-task-handlers');
const v2WorkflowHandlers = require('./api/v2-workflow-handlers');
const eventBus = require('./event-bus');
const v2GovernanceHandlers = require('./api/v2-governance-handlers');
const v2AnalyticsHandlers = require('./api/v2-analytics-handlers');
const v2InfrastructureHandlers = require('./api/v2-infrastructure-handlers');
const webhooks = require('./api/webhooks');

const {
  createRateLimiter,
  getRateLimit,
  checkRateLimit,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  parseBody,
  sendJson,
  parseQuery,
  applyMiddleware,
  DEFAULT_RATE_WINDOW_MS,
} = middleware;
const { handleInboundWebhook, verifyWebhookSignature, substitutePayload, setQuotaTrackerGetter: setWebhookQuotaTrackerGetter } = webhooks;
const { handleHealthz, handleReadyz, handleLivez } = require('./api/health-probes');

let apiServer = null;
let apiPort = 3457;


const V2_RATE_POLICIES = new Set(['enforced', 'disabled']);
const DEFAULT_V2_RATE_LIMIT = 120;
let v2RateLimiter = null;
let v2RateLimit = null;

function getV2RatePolicy() {
  try {
    const configuredPolicy = (serverConfig.get('v2_rate_policy', 'enforced')).toLowerCase().trim();
    return V2_RATE_POLICIES.has(configuredPolicy) ? configuredPolicy : 'enforced';
  } catch {
    return 'enforced';
  }
}

function getV2RateLimitConfig() {
  try {
    const configValue = serverConfig.getInt('v2_rate_limit', 0);
    if (configValue > 0) return configValue;
  } catch {
    // No-op
  }
  return DEFAULT_V2_RATE_LIMIT;
}

function getV2RateLimiter() {
  const limit = getV2RateLimitConfig();
  if (v2RateLimit === limit && v2RateLimiter) {
    return v2RateLimiter;
  }

  v2RateLimiter = createRateLimiter(limit, DEFAULT_RATE_WINDOW_MS);
  v2RateLimit = limit;
  return v2RateLimiter;
}

/**
 * Resolve a request ID from incoming headers or generate a new one.
 */
function resolveRequestId(req) {
  const headerValue = req.headers["x-request-id"];
  if (Array.isArray(headerValue)) {
    const first = headerValue.find(value => typeof value === "string" && value.trim());
    if (first) return first.trim();
  } else if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return randomUUID();
}

// ============================================
// V2 discovery helpers (extracted to api/v2-discovery-helpers.js)
// ============================================
const v2DiscoveryHelpers = require('./api/v2-discovery-helpers');
const {
  sendV2Success,
  sendV2Error,
  getV2ProviderDefaultTimeoutMs,
  getV2ProviderQueueDepth,
  getV2ProviderDefaultProvider,
} = v2DiscoveryHelpers;

// ============================================
// V2 core handlers (extracted to api/v2-core-handlers.js)
// ============================================
const v2CoreHandlers = require('./api/v2-core-handlers');
const {
  handleV2TaskStatus,
  handleV2TaskCancel,
  handleV2TaskEvents,
  handleV2Inference,
  handleV2ProviderInference,
  handleV2ProviderModels,
  handleV2ProviderHealth,
  handleV2ListProviders,
  handleV2ProviderCapabilities,
  handleV2ProviderDetail,
  handleV2RemoteRun,
  handleV2RemoteTest,
  initTaskManager: _initV2TaskManager,
} = v2CoreHandlers;

// NOTE: Lines 149-1963 of the original file have been extracted to:
//   - api/v2-discovery-helpers.js  (provider descriptors, model resolution, health)
//   - api/v2-core-handlers.js      (inference, task, provider endpoint handlers)


// ============================================
// Route definitions
// ============================================

const EXCLUDED_ROUTE_PATH_PREFIXES = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/keys(?:\/|$)/,
];

function isExcludedRoute(route) {
  const path = route && route.path;
  if (typeof path === 'string') {
    return EXCLUDED_ROUTE_PATH_PREFIXES.some((prefix) => prefix.test(path));
  }
  if (path instanceof RegExp) {
    return EXCLUDED_ROUTE_PATH_PREFIXES.some((prefix) => prefix.test(path.source));
  }
  return false;
}

const ROUTE_HANDLER_LOOKUP = {
  handleV2Inference,
  handleV2ProviderInference,
  handleV2TaskStatus,
  handleV2TaskCancel,
  handleV2TaskEvents,
  handleV2ListProviders,
  handleV2ProviderCapabilities,
  handleV2ProviderModels,
  handleV2ProviderHealth,
  handleV2ProviderDetail,
  handleV2RemoteRun,
  handleV2RemoteTest,
  handlePiiScan,
  handleShutdown,
  handleClaudeEvent,
  handleClaudeFiles,
  handleGetQuotaStatus,
  handleGetQuotaHistory,
  handleGetQuotaAutoScale,
  handleGetProviderQuotas,
  handleBootstrapWorkstation: require('./plugins/remote-agents/bootstrap').handleBootstrapWorkstation,
  // V2 Control-Plane: Tasks
  handleV2CpPreviewTaskStudyContext: v2TaskHandlers.handlePreviewTaskStudyContext,
  handleV2CpSubmitTask: v2TaskHandlers.handleSubmitTask,
  handleV2CpListTasks: v2TaskHandlers.handleListTasks,
  handleV2CpTaskDiff: v2TaskHandlers.handleTaskDiff,
  handleV2CpTaskLogs: v2TaskHandlers.handleTaskLogs,
  handleV2CpTaskProgress: v2TaskHandlers.handleTaskProgress,
  handleV2CpRetryTask: v2TaskHandlers.handleRetryTask,
  handleV2CpReassignTaskProvider: v2TaskHandlers.handleReassignTaskProvider,
  handleV2CpCommitTask: v2TaskHandlers.handleCommitTask,
  handleV2CpGetTask: v2TaskHandlers.handleGetTask,
  handleV2CpCancelTask: v2TaskHandlers.handleCancelTask,
  handleV2CpDeleteTask: v2TaskHandlers.handleDeleteTask,
  handleV2CpApproveSwitch: v2TaskHandlers.handleApproveSwitch,
  handleV2CpRejectSwitch: v2TaskHandlers.handleRejectSwitch,
  // V2 Control-Plane: Workflows
  handleV2CpCreateWorkflow: v2WorkflowHandlers.handleCreateWorkflow,
  handleV2CpListWorkflows: v2WorkflowHandlers.handleListWorkflows,
  handleV2CpGetWorkflow: v2WorkflowHandlers.handleGetWorkflow,
  handleV2CpRunWorkflow: v2WorkflowHandlers.handleRunWorkflow,
  handleV2CpCancelWorkflow: v2WorkflowHandlers.handleCancelWorkflow,
  handleV2CpAddWorkflowTask: v2WorkflowHandlers.handleAddWorkflowTask,
  handleV2CpWorkflowHistory: v2WorkflowHandlers.handleWorkflowHistory,
  handleV2CpCreateFeatureWorkflow: v2WorkflowHandlers.handleCreateFeatureWorkflow,
  // V2 Control-Plane: Governance
  handleV2CpListApprovals: v2GovernanceHandlers.handleListApprovals,
  handleV2CpApprovalDecision: v2GovernanceHandlers.handleApprovalDecision,
  handleV2CpListSchedules: v2GovernanceHandlers.handleListSchedules,
  handleV2CpCreateSchedule: v2GovernanceHandlers.handleCreateSchedule,
  handleV2CpGetSchedule: v2GovernanceHandlers.handleGetSchedule,
  handleV2CpGetScheduleRun: v2GovernanceHandlers.handleGetScheduleRun,
  handleV2CpRunSchedule: v2GovernanceHandlers.handleRunSchedule,
  handleV2CpToggleSchedule: v2GovernanceHandlers.handleToggleSchedule,
  handleV2CpDeleteSchedule: v2GovernanceHandlers.handleDeleteSchedule,
  handleV2CpUpdateSchedule: v2GovernanceHandlers.handleUpdateSchedule,
  handleV2CpListPolicies: v2GovernanceHandlers.handleListPolicies,
  handleV2CpGetPolicy: v2GovernanceHandlers.handleGetPolicy,
  handleV2CpSetPolicyMode: v2GovernanceHandlers.handleSetPolicyMode,
  handleV2CpEvaluatePolicies: v2GovernanceHandlers.handleEvaluatePolicies,
  handleV2CpListPolicyEvaluations: v2GovernanceHandlers.handleListPolicyEvaluations,
  handleV2CpGetPolicyEvaluation: v2GovernanceHandlers.handleGetPolicyEvaluation,
  handleV2CpOverridePolicyDecision: v2GovernanceHandlers.handleOverridePolicyDecision,
  handleV2CpPeekAttestationExport: v2GovernanceHandlers.handlePeekAttestationExport,
  handleV2CpListPlanProjects: v2GovernanceHandlers.handleListPlanProjects,
  handleV2CpGetPlanProject: v2GovernanceHandlers.handleGetPlanProject,
  handleV2CpPlanProjectAction: v2GovernanceHandlers.handlePlanProjectAction,
  handleV2CpDeletePlanProject: v2GovernanceHandlers.handleDeletePlanProject,
  handleV2CpImportPlan: v2GovernanceHandlers.handleImportPlan,
  handleV2CpListBenchmarks: v2GovernanceHandlers.handleListBenchmarks,
  handleV2CpApplyBenchmark: v2GovernanceHandlers.handleApplyBenchmark,
  handleV2CpListProjectTuning: v2GovernanceHandlers.handleListProjectTuning,
  handleV2CpCreateProjectTuning: v2GovernanceHandlers.handleCreateProjectTuning,
  handleV2CpDeleteProjectTuning: v2GovernanceHandlers.handleDeleteProjectTuning,
  handleV2CpProviderStats: v2GovernanceHandlers.handleProviderStats,
  handleV2CpProviderToggle: v2GovernanceHandlers.handleProviderToggle,
  handleV2CpProviderTrends: v2GovernanceHandlers.handleProviderTrends,
  handleV2CpSystemStatus: v2GovernanceHandlers.handleSystemStatus,
  // V2 Control-Plane: Config
  handleV2CpConfigureProvider: v2GovernanceHandlers.handleConfigureProvider,
  handleV2CpSetDefaultProvider: v2GovernanceHandlers.handleSetDefaultProvider,
  // V2 Control-Plane: Config
  handleV2CpGetConfig: v2GovernanceHandlers.handleGetConfig,
  handleV2CpSetConfig: v2GovernanceHandlers.handleSetConfig,
  handleV2CpConfigureStallDetection: v2GovernanceHandlers.handleConfigureStallDetection,
  // V2 Control-Plane: Project Config
  handleV2CpListProjects: v2GovernanceHandlers.handleListProjects,
  handleV2CpScanProject: v2GovernanceHandlers.handleScanProject,
  handleV2CpGetProjectDefaults: v2GovernanceHandlers.handleGetProjectDefaults,
  handleV2CpSetProjectDefaults: v2GovernanceHandlers.handleSetProjectDefaults,
  // V2 Control-Plane: Webhooks
  handleV2CpListWebhooks: v2GovernanceHandlers.handleListWebhooks,
  handleV2CpAddWebhook: v2GovernanceHandlers.handleAddWebhook,
  handleV2CpRemoveWebhook: v2GovernanceHandlers.handleRemoveWebhook,
  handleV2CpTestWebhook: v2GovernanceHandlers.handleTestWebhook,
  // V2 Control-Plane: Validation
  handleV2CpAutoVerifyAndFix: v2GovernanceHandlers.handleAutoVerifyAndFix,
  handleV2CpDetectFileConflicts: v2GovernanceHandlers.handleDetectFileConflicts,
  // V2 Control-Plane: Analytics & Budget
  handleV2CpStatsOverview: v2AnalyticsHandlers.handleStatsOverview,
  handleV2CpTimeSeries: v2AnalyticsHandlers.handleTimeSeries,
  handleV2CpQualityStats: v2AnalyticsHandlers.handleQualityStats,
  handleV2CpStuckTasks: v2AnalyticsHandlers.handleStuckTasks,
  handleV2CpModelStats: v2AnalyticsHandlers.handleModelStats,
  handleV2CpFormatSuccess: v2AnalyticsHandlers.handleFormatSuccess,
  handleV2CpEventHistory: v2AnalyticsHandlers.handleEventHistory,
  handleV2CpWebhookStats: v2AnalyticsHandlers.handleWebhookStats,
  handleV2CpNotificationStats: v2AnalyticsHandlers.handleNotificationStats,
  handleV2CpThroughputMetrics: v2AnalyticsHandlers.handleThroughputMetrics,
  handleV2CpBudgetSummary: v2AnalyticsHandlers.handleBudgetSummary,
  handleV2CpBudgetStatus: v2AnalyticsHandlers.handleBudgetStatus,
  handleV2CpSetBudget: v2AnalyticsHandlers.handleSetBudget,
  handleV2CpStrategicStatus: v2AnalyticsHandlers.handleStrategicStatus,
  handleV2CpRoutingDecisions: v2AnalyticsHandlers.handleRoutingDecisions,
  handleV2CpProviderHealthCards: v2AnalyticsHandlers.handleProviderHealth,
  // V2 Control-Plane: Infrastructure
  handleV2CpListHosts: v2InfrastructureHandlers.handleListHosts,
  handleV2CpGetHost: v2InfrastructureHandlers.handleGetHost,
  handleV2CpUpdateHost: v2InfrastructureHandlers.handleUpdateHost,
  handleV2CpToggleHost: v2InfrastructureHandlers.handleToggleHost,
  handleV2CpDeleteHost: v2InfrastructureHandlers.handleDeleteHost,
  handleV2CpHostScan: v2InfrastructureHandlers.handleHostScan,
  handleV2CpHostActivity: v2InfrastructureHandlers.handleHostActivity,
  handleV2CpProviderPercentiles: v2InfrastructureHandlers.handleProviderPercentiles,
  handleV2CpListPeekHosts: v2InfrastructureHandlers.handleListPeekHosts,
  handleV2CpCreatePeekHost: v2InfrastructureHandlers.handleCreatePeekHost,
  handleV2CpDeletePeekHost: v2InfrastructureHandlers.handleDeletePeekHost,
  handleV2CpTogglePeekHost: v2InfrastructureHandlers.handleTogglePeekHost,
  handleV2CpListCredentials: v2InfrastructureHandlers.handleListCredentials,
  handleV2CpSaveCredential: v2InfrastructureHandlers.handleSaveCredential,
  handleV2CpDeleteCredential: v2InfrastructureHandlers.handleDeleteCredential,
  handleV2CpListAgents: v2InfrastructureHandlers.handleListAgents,
  handleV2CpCreateAgent: v2InfrastructureHandlers.handleCreateAgent,
  handleV2CpGetAgent: v2InfrastructureHandlers.handleGetAgent,
  handleV2CpAgentHealth: v2InfrastructureHandlers.handleAgentHealth,
  handleV2CpDeleteAgent: v2InfrastructureHandlers.handleDeleteAgent,
};

const PII_SCAN_ROUTE = {
  method: 'POST',
  path: '/api/pii-scan',
  handlerName: 'handlePiiScan',
};

const FACTORY_V2_ROUTES = [
  { method: 'GET', path: '/api/v2/factory/status', tool: 'factory_status' },
  { method: 'GET', path: '/api/v2/factory/projects', tool: 'list_factory_projects', mapQuery: true },
  { method: 'POST', path: '/api/v2/factory/projects', tool: 'register_factory_project', mapBody: true },
  {
    method: 'GET',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)$/,
    tool: 'project_health',
    mapParams: ['project'],
    mapQuery: true,
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/scan$/,
    tool: 'scan_project_health',
    mapParams: ['project'],
    mapBody: true,
  },
  {
    method: 'PUT',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/trust$/,
    tool: 'set_factory_trust_level',
    mapParams: ['project'],
    mapBody: true,
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/pause$/,
    tool: 'pause_project',
    mapParams: ['project'],
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/resume$/,
    tool: 'resume_project',
    mapParams: ['project'],
  },
  { method: 'POST', path: '/api/v2/factory/pause-all', tool: 'pause_all_projects' },
  // Intake
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/intake$/, tool: 'list_work_items', mapParams: ['project'], mapQuery: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/intake$/, tool: 'create_work_item', mapParams: ['project'], mapBody: true },
  { method: 'PUT', path: /^\/api\/v2\/factory\/intake\/([^/]+)$/, tool: 'update_work_item', mapParams: ['id'], mapBody: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/intake\/([^/]+)\/reject$/, tool: 'reject_work_item', mapParams: ['id'], mapBody: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/intake\/from-findings$/, tool: 'intake_from_findings', mapParams: ['project'], mapBody: true },
];

const hasPiiScanRoute = routes.some((route) => route.method === PII_SCAN_ROUTE.method && route.path === PII_SCAN_ROUTE.path);
if (!hasPiiScanRoute) {
  const shutdownRouteIndex = routes.findIndex((route) => route.method === 'POST' && route.path === '/api/shutdown');
  if (shutdownRouteIndex >= 0) {
    routes.splice(shutdownRouteIndex, 0, PII_SCAN_ROUTE);
  } else {
    routes.push(PII_SCAN_ROUTE);
  }
}

function resolveApiRoutes(deps = {}) {
  const baseRoutes = routes.filter((route) => !V2_PROVIDER_ROUTE_HANDLER_NAMES.has(route.handlerName))
    .filter((route) => !isExcludedRoute(route));
  const resolvedRoutes = baseRoutes.map((route) => {
    if (!route.handler && route.handlerName) {
      return {
        ...route,
        handler: ROUTE_HANDLER_LOOKUP[route.handlerName],
      };
    }
    return route;
  });

  const v2Routes = createV2Router({
    mountPath: '/api/v2',
    resolveRequestId,
    handlers: {
      listProviderModels: handleV2ProviderModels,
      getProviderHealth: handleV2ProviderHealth,
    },
  });

  // v2 discovery routes (from v2-router) must precede CP routes to avoid shadowing
  // e.g. GET /api/v2/providers has both a discovery handler and a CP handler
  return v2Routes.concat(FACTORY_V2_ROUTES, resolvedRoutes, createHealthRoutes(deps));
}

function createApiServer(deps = {}) {
  const serverDeps = {
    db: deps.db || db,
    taskManager: deps.taskManager,
    tools: deps.tools || tools,
    logger: deps.logger || logger,
  };

  // Initialize v2 control-plane handlers with task manager
  if (serverDeps.taskManager) {
    _initV2TaskManager(serverDeps.taskManager);
    v2TaskHandlers.init(serverDeps.taskManager);
    v2WorkflowHandlers.init(serverDeps.taskManager);
    v2GovernanceHandlers.init(serverDeps.taskManager);
    v2InfrastructureHandlers.init(serverDeps.taskManager);
  }

  const routeTable = resolveApiRoutes(serverDeps);
  const middlewareContext = applyMiddleware(null, {
    getV2RatePolicy,
    getV2RateLimiter,
    getRateLimit: () => getRateLimit(serverDeps.db || db),
  });

  return {
    routes: routeTable,
    middlewareContext,
    requestHandler: (req, res) => handleRequest(req, res, {
      routes: routeTable,
      middlewareContext,
      deps: serverDeps,
    }).catch((err) => {
      logger.error('Unhandled error in request handler', { error: err.message, stack: err.stack, url: req.url });
      if (!res.headersSent) {
        sendJson(res, { error: 'Internal server error' }, 500, req);
      }
    }),
  };
}

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
    const quotas = require('./db/provider-quotas').getQuotaStore().getAllQuotas();
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
      const scheduler = require('./execution/queue-scheduler');
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

  const piiGuard = require('./utils/pii-guard');
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
  let builtinOverrides = {};
  if (workingDir) {
    try {
      const projectConfigCore = require('./db/project-config-core');
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
      const taskCore = require('./db/task-core');
      const running = taskCore.listTasks({ status: 'running', limit: 1000 }).length;
      const queued = taskCore.listTasks({ status: 'queued', limit: 1000 }).length;
      if (running > 0 || queued > 0) {
        const { createGovernanceHooks } = require('./governance/hooks');
        const governanceRules = require('./db/governance-rules');
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
      const taskCore = require('./db/task-core');
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

const INBOUND_WEBHOOK_PREFIX = '/api/webhooks/inbound/';

// ============================================
// Request handler
// ============================================

function executeRouteMiddleware(middlewareFn, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function next(err) {
      if (settled) {
        return;
      }

      settled = true;
      if (err) {
        reject(err);
        return;
      }

      resolve(true);
    }

    try {
      Promise.resolve(middlewareFn(req, res, next))
        .then(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
    } catch (err) {
      reject(err);
    }
  });
}

async function runRouteMiddleware(middlewares, req, res) {
  for (const middlewareFn of middlewares || []) {
    const shouldContinue = await executeRouteMiddleware(middlewareFn, req, res);
    if (!shouldContinue) {
      return false;
    }
  }

  return true;
}

/**
 * Handle incoming HTTP request
 */
async function handleRequest(req, res, context = {}) {
  const activeContext = context && context.routes && context.middlewareContext
    ? context
    : createApiServer();
  const {
    routes: routeTable,
    middlewareContext,
  } = activeContext;

  const requestId = resolveRequestId(req);
  const requestStart = Date.now();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  logger.info(`Incoming request ${req.method} ${req.url}`, {
    requestId,
    method: req.method,
    path: req.url,
  });

  res.on('finish', () => {
    logger.info(`Completed request ${req.method} ${req.url}`, {
      requestId,
      method: req.method,
      path: req.url,
      statusCode: res.statusCode,
      durationMs: Date.now() - requestStart,
    });
  });

  // CORS preflight
  if (middlewareContext.handleCorsPreflight(req, res)) {
    return;
  }

  const url = req.url.split('?')[0];
  const endpointRateLimiter = middlewareContext.getEndpointRateLimiter(url);

  // Endpoint-specific limiter first, then fallback to global limiter.
  const rateLimiter = endpointRateLimiter || checkRateLimit;
  if (!rateLimiter(req, res)) {
    return;
  }

  const query = parseQuery(req.url);

  // Inbound webhook route — POST /api/webhooks/inbound/:name
  // This is NOT in the routes array — it's a special handler with its own HMAC verification.
  if (req.method === 'POST' && url.startsWith(INBOUND_WEBHOOK_PREFIX)) {
    try {
      const webhookName = decodeURIComponent(url.slice(INBOUND_WEBHOOK_PREFIX.length));
      if (webhookName) {
        return await handleInboundWebhook(req, res, webhookName, { requestId });
      } else {
        sendJson(res, { error: 'Webhook name is required' }, 400, req);
        return;
      }
    } catch (err) {
      if (err instanceof URIError) {
        sendJson(res, { error: 'Invalid webhook name encoding' }, 400, req);
        return;
      }
      logger.error('Webhook handler error', { error: err.message, stack: err.stack, url: req.url });
      sendJson(res, { error: 'Internal webhook error' }, 500, req);
      return;
    }
  }

  if (req.method === 'GET' && url === '/api/openapi.json') {
    const spec = generateOpenApiSpec(routeTable);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(spec, null, 2));
    return;
  }

  // Version endpoint — always accessible.
  if (req.method === 'GET' && url === '/api/version') {
    const pkg = require('./package.json');
    sendJson(res, { version: pkg.version, name: pkg.name || 'torque' }, 200, req);
    return;
  }

  // Find matching route
  for (const route of routeTable) {
    if (route.method !== req.method) continue;

    let match = null;
    if (typeof route.path === 'string') {
      if (url !== route.path) continue;
      match = [];
    } else {
      match = url.match(route.path);
      if (!match) continue;
    }

    // TDA-09/TDA-10: Emit deprecation headers for legacy routes
    if (route.deprecated) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', '2026-09-01');
      res.setHeader('Link', `<${route.deprecated}>; rel="successor-version"`);
    }

    const routeParams = [];
    const mappedParams = {};
    if (route.mapParams && match) {
      route.mapParams.forEach((param, i) => {
        if (param) {
          const value = match[i + 1];
          routeParams.push(value);
          mappedParams[param] = value;
        }
      });
    }

    req.params = mappedParams;
    req.query = query;

    try {
      if (route.middleware?.length) {
        const shouldContinue = await runRouteMiddleware(route.middleware, req, res);
        if (!shouldContinue) {
          return;
        }
      }

      // Custom handler
      if (route.handler) {
        return await route.handler(req, res, { requestId, params: req.params, query: req.query }, ...routeParams, req);
      }

      // Build args for MCP tool
      let args = {};

      if (route.mapBody) {
        args = Object.prototype.hasOwnProperty.call(req, 'body')
          ? req.body
          : await parseBody(req);
      }

      if (route.mapQuery) {
        for (const [key, value] of Object.entries(req.query)) {
          if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            args[key] = value;
          }
        }
      }

      Object.assign(args, req.params);

      // Call MCP tool
      const result = await handleToolCall(route.tool, args);

      // Convert MCP result to REST response
      if (result.isError) {
        sendJson(res, { error: result.content?.[0]?.text || 'Unknown error' }, 400, req);
      } else {
        const textResult = result.content?.[0]?.text || '';
        if (route.v2StructuredResponse === true && result.structuredData && typeof result.structuredData === 'object') {
          sendJson(res, {
            data: result.structuredData,
            meta: {
              request_id: req.requestId || null,
              tool: route.tool,
              result: textResult,
            },
          }, 200, req);
        } else {
          sendJson(res, {
            tool: route.tool,
            result: textResult,
          }, 200, req);
        }
      }
    } catch (err) {
      const isV2Route = typeof route.path === 'string' ? route.path.startsWith('/api/v2/') : false;
      if (isV2Route) {
        const normalized = normalizeError(err, req);
        sendJson(res, normalized.body, normalized.status, req);
      } else {
        const status = err.message?.includes('Invalid JSON') || err.message?.includes('too large') ? 400 : 500;
        sendJson(res, { error: err.message }, status, req);
      }
    }
    return;
  }

  // Tool discovery — GET /api/tools lists all available MCP tools
  if (req.method === 'GET' && url === '/api/tools') {
    sendJson(res, { tools: [...tools.routeMap.keys()].sort(), count: tools.routeMap.size }, 200, req);
    return;
  }

  // Generic tool passthrough — POST /api/tools/:tool_name
  // Exposes MCP tools via REST API without per-tool route definitions.
  // SECURITY: Enforced by external middleware/gateway (if configured) and tool-tier config.
  const TOOL_PREFIX = '/api/tools/';
  // Tools that must not be callable via the generic REST passthrough
  const BLOCKED_REST_TOOLS = new Set(['restart_server', 'shutdown', 'database_backup', 'database_restore']);
  if (req.method === 'POST' && url.startsWith(TOOL_PREFIX)) {
    const toolName = url.slice(TOOL_PREFIX.length);
    if (toolName && /^[a-z_]+$/.test(toolName) && tools.routeMap.has(toolName)) {
      if (BLOCKED_REST_TOOLS.has(toolName)) {
        sendJson(res, { error: `Tool '${toolName}' is not available via the REST API` }, 403, req);
        return;
      }

      // F3: Enforce tool tier on REST passthrough (mirrors MCP stdio/SSE tier enforcement)
      const restToolMode = serverConfig.get('rest_api_tool_mode', 'core');
      if (restToolMode !== 'full') {
        const allowedNames = restToolMode === 'extended' ? EXTENDED_TOOL_NAMES : CORE_TOOL_NAMES;
        if (!allowedNames.includes(toolName)) {
          sendJson(res, {
            error: `Tool '${toolName}' is not available in '${restToolMode}' mode. ` +
              `Set rest_api_tool_mode to 'extended' or 'full' to access this tool.`,
          }, 403, req);
          return;
        }
      }

      try {
        const body = await parseBody(req);
        const result = await handleToolCall(toolName, body || {});
        if (result.isError) {
          sendJson(res, { error: result.content?.[0]?.text || 'Unknown error' }, 400, req);
        } else {
          sendJson(res, {
            tool: toolName,
            result: result.content?.[0]?.text || '',
          }, 200, req);
        }
      } catch (err) {
        const status = err.message?.includes('Invalid JSON') || err.message?.includes('too large') ? 400 : 500;
        sendJson(res, { error: err.message }, status, req);
      }
      return;
    }
  }

  sendJson(res, { error: 'Not found' }, 404, req);
}

// ============================================
// Server lifecycle
// ============================================

/**
 * Start the API server
 */
function start(options = {}) {
  return new Promise((resolve) => {
    if (apiServer) {
      resolve({ success: true, port: apiPort, message: 'Already running' });
      return;
    }

    const apiContext = createApiServer({
      db,
      taskManager: options.taskManager || null,
      tools,
      logger,
    });

    apiPort = options.port || serverConfig.getPort('api');

    apiServer = http.createServer(apiContext.requestHandler);
    startRateLimitCleanup();

    apiServer.on('error', (err) => {
      // Reset server reference so start() can be retried
      try { apiServer.close(); } catch { /* ignore */ }
      apiServer = null;
      stopRateLimitCleanup();
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(
          `\nPort ${apiPort} is already in use.\n\n` +
          `Options:\n` +
          `  1. Stop existing TORQUE: bash stop-torque.sh\n` +
          `  2. Use different port: TORQUE_API_PORT=${apiPort + 2} torque start\n` +
          `  3. Find what's using it: lsof -i :${apiPort} (Linux/Mac) or netstat -ano | findstr :${apiPort} (Windows)\n\n`
        );
        resolve({ success: false, error: 'Port in use' });
      } else {
        process.stderr.write(`API server error: ${err.message}\n`);
        resolve({ success: false, error: err.message });
      }
    });

    apiServer.listen(apiPort, '127.0.0.1', () => {
      process.stderr.write(`TORQUE API server listening on http://127.0.0.1:${apiPort}\n`);
      resolve({ success: true, port: apiPort });
    });
  });
}

/**
 * Stop the API server
 */
function stop() {
  stopRateLimitCleanup();
  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }
}

module.exports = {
  start,
  stop,
  createRateLimiter,
  getRateLimit,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  checkRateLimit,
  resolveRequestId,
  parseBody,
  sendJson,
  parseQuery,
  sendV2Success,
  sendV2Error,
  getV2ProviderDefaultTimeoutMs,
  getV2ProviderQueueDepth,
  getV2ProviderDefaultProvider,
  handleInboundWebhook,
  handleHealthz,
  handleReadyz,
  handleLivez,
  verifyWebhookSignature,
  substitutePayload,
  setQuotaTrackerGetter,
  handleGetQuotaHistory,
  handleGetQuotaAutoScale,
  _testing: {
    handleV2TaskCancel,
    handlePiiScan,
    setV2TaskManager: (tm) => { _initV2TaskManager(tm); },
    handleClaudeEvent,
    handleClaudeFiles,
    _claudeEventLog,
  },
};
