/**
 * Dashboard API router.
 *
 * Maps HTTP method + URL pattern to route handler functions.
 * The dispatch function is called from dashboard-server.js for all /api/ requests.
 */
const { parseQuery, parseBody, isLocalhostOrigin, sendJson, sendError } = require('./utils');

const tasks = require('./routes/tasks');
const infrastructure = require('./routes/infrastructure');
const analytics = require('./routes/analytics');
const admin = require('./routes/admin');

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocalDashboardRequest(req) {
  const remoteIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return LOCALHOST_IPS.has(remoteIp);
}

function isAjaxRequest(req) {
  const headers = req.headers || {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerName === 'string' && headerName.toLowerCase() === 'x-requested-with') {
      return String(headerValue).toLowerCase() === 'xmlhttprequest';
    }
  }
  return false;
}

/**
 * Route definitions: { method, pattern, handler }
 *
 * handler signature: (req, res, query, ...captureGroups, context) => void
 *   - query: parsed query parameters
 *   - captureGroups: regex match groups from the URL pattern
 *   - context: { broadcastTaskUpdate, clients, serverPort } — injected by dispatch
 *
 * Order matters for overlapping patterns — more specific patterns must come first.
 */
const routes = [
  // --- Tasks --- (compat: v2 equivalents at /api/v2/tasks)
  { method: 'GET',  pattern: /^\/api\/tasks$/,                                                       handler: tasks.handleListTasks, compat: true },
  { method: 'GET',  pattern: /^\/api\/tasks\/([^/]+)\/diff$/,                                        handler: tasks.handleTaskDiff, compat: true },
  { method: 'GET',  pattern: /^\/api\/tasks\/([^/]+)\/logs$/,                                        handler: tasks.handleTaskLogs, compat: true },
  { method: 'GET',  pattern: /^\/api\/tasks\/([^/]+)$/,                                              handler: tasks.handleGetTask, compat: true },
  { method: 'POST', pattern: /^\/api\/tasks\/submit$/,                                                      handler: tasks.handleSubmitTask, compat: true },
  { method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/(retry|cancel|approve-switch|reject-switch|remove)$/,  handler: tasks.handleTaskAction },

  // --- Providers --- (compat: v2 equivalents at /api/v2/providers)
  { method: 'GET',  pattern: /^\/api\/providers$/,                        handler: infrastructure.handleListProviders, compat: true },
  { method: 'GET',  pattern: /^\/api\/providers\/trends$/,                handler: infrastructure.handleProviderTrends, compat: true },
  { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/percentiles$/,  handler: infrastructure.handleProviderPercentiles },
  { method: 'GET',  pattern: /^\/api\/providers\/([^/]+)\/stats$/,        handler: infrastructure.handleProviderStats, compat: true },
  { method: 'POST', pattern: /^\/api\/providers\/([^/]+)\/toggle$/,       handler: infrastructure.handleProviderToggle, compat: true },

  // --- Stats --- (compat: v2 equivalents at /api/v2/stats)
  { method: 'GET',  pattern: /^\/api\/stats\/overview$/,        handler: analytics.handleStatsOverview, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/timeseries$/,      handler: analytics.handleTimeSeries, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/quality$/,         handler: analytics.handleQualityStats, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/format-success$/,  handler: analytics.handleFormatSuccess, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/stuck$/,            handler: analytics.handleStuckTasks, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/models$/,           handler: analytics.handleModelStats, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/notifications$/,    handler: analytics.handleNotificationStats, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/event-history$/,    handler: analytics.handleEventHistory, compat: true },
  { method: 'GET',  pattern: /^\/api\/stats\/webhooks$/,        handler: analytics.handleWebhookStats, compat: true },

  // --- Remote Agents --- (compat: v2 equivalents at /api/v2/agents)
  { method: 'GET',    pattern: /^\/api\/agents$/,                      handler: infrastructure.handleListAgents, compat: true },
  { method: 'POST',   pattern: /^\/api\/agents$/,                      handler: infrastructure.handleCreateAgent, compat: true },
  { method: 'GET',    pattern: /^\/api\/agents\/([^/]+)\/health$/,      handler: infrastructure.handleAgentHealth, compat: true },
  { method: 'GET',    pattern: /^\/api\/agents\/([^/]+)$/,              handler: infrastructure.handleGetAgent, compat: true },
  { method: 'DELETE', pattern: /^\/api\/agents\/([^/]+)$/,              handler: infrastructure.handleDeleteAgent, compat: true },

  // --- Plan Projects --- (compat: v2 equivalents at /api/v2/plan-projects)
  { method: 'POST',   pattern: /^\/api\/plan-projects\/import$/,                              handler: admin.handleImportPlanApi, compat: true },
  { method: 'GET',    pattern: /^\/api\/plan-projects$/,                                      handler: admin.handleListPlanProjects, compat: true },
  { method: 'GET',    pattern: /^\/api\/plan-projects\/([^/]+)$/,                              handler: admin.handleGetPlanProject, compat: true },
  { method: 'POST',   pattern: /^\/api\/plan-projects\/([^/]+)\/(pause|resume|retry)$/,        handler: admin.handlePlanProjectAction, compat: true },
  { method: 'DELETE', pattern: /^\/api\/plan-projects\/([^/]+)$/,                              handler: admin.handleDeletePlanProject, compat: true },

  // --- Hosts --- (compat: v2 equivalents at /api/v2/hosts)
  { method: 'GET',  pattern: /^\/api\/hosts$/,                   handler: infrastructure.handleListHosts, compat: true },
  { method: 'GET',  pattern: /^\/api\/hosts\/activity$/,         handler: infrastructure.handleHostActivity },
  { method: 'POST', pattern: /^\/api\/hosts\/scan$/,             handler: infrastructure.handleHostScan, compat: true },
  { method: 'POST',   pattern: /^\/api\/hosts\/([^/]+)\/toggle$/,  handler: infrastructure.handleHostToggle, compat: true },
  { method: 'GET',    pattern: /^\/api\/peek-hosts$/,                    handler: infrastructure.handleListPeekHosts, compat: true },
  { method: 'POST',   pattern: /^\/api\/peek-hosts$/,                    handler: infrastructure.handleCreatePeekHost, compat: true },
  { method: 'POST',   pattern: /^\/api\/peek-hosts\/([^/]+)\/test$/,     handler: infrastructure.handleTestPeekHost },
  { method: 'POST',   pattern: /^\/api\/peek-hosts\/([^/]+)\/toggle$/,   handler: infrastructure.handlePeekHostToggle, compat: true },
  { method: 'PUT',    pattern: /^\/api\/peek-hosts\/([^/]+)$/,           handler: infrastructure.handleUpdatePeekHost },
  { method: 'DELETE', pattern: /^\/api\/peek-hosts\/([^/]+)$/,           handler: infrastructure.handleDeletePeekHost, compat: true },
  { method: 'GET',    pattern: /^\/api\/hosts\/([^/]+)\/credentials$/,                                 handler: infrastructure.handleListCredentials, compat: true },
  { method: 'PUT',    pattern: /^\/api\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,        handler: infrastructure.handleSaveCredential, compat: true },
  { method: 'DELETE', pattern: /^\/api\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,        handler: infrastructure.handleDeleteCredential, compat: true },
  { method: 'POST',   pattern: /^\/api\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)\/test$/,  handler: infrastructure.handleTestCredential },
  { method: 'DELETE', pattern: /^\/api\/hosts\/([^/]+)$/,          handler: infrastructure.handleDeleteHost, compat: true },
  { method: 'GET',    pattern: /^\/api\/hosts\/([^/]+)$/,          handler: infrastructure.handleGetHost, compat: true },

  // --- Budget --- (compat: v2 equivalents at /api/v2/budget)
  { method: 'GET',  pattern: /^\/api\/budget\/summary$/,  handler: analytics.handleBudgetSummary, compat: true },
  { method: 'GET',  pattern: /^\/api\/budget\/status$/,   handler: analytics.handleBudgetStatus, compat: true },
  { method: 'POST', pattern: /^\/api\/budget\/set$/,      handler: analytics.handleSetBudget, compat: true },

  // --- System --- (compat: v2 system-status equivalent at /api/v2/system/status)
  { method: 'GET', pattern: /^\/api\/system\/status$/, handler: infrastructure.handleSystemStatus, compat: true },
  { method: 'GET', pattern: /^\/api\/instances$/,      handler: infrastructure.handleInstances },

  // --- Project Tuning --- (compat: v2 equivalents at /api/v2/tuning)
  { method: 'GET',    pattern: /^\/api\/project-tuning$/,         handler: admin.handleListProjectTuning, compat: true },
  { method: 'POST',   pattern: /^\/api\/project-tuning$/,         handler: admin.handleCreateProjectTuning, compat: true },
  { method: 'GET',    pattern: /^\/api\/project-tuning\/(.+)$/,   handler: admin.handleGetProjectTuning },
  { method: 'DELETE', pattern: /^\/api\/project-tuning\/(.+)$/,   handler: admin.handleDeleteProjectTuning, compat: true },

  // --- Benchmarks --- (compat: v2 equivalents at /api/v2/benchmarks)
  { method: 'GET',  pattern: /^\/api\/benchmarks$/,        handler: admin.handleListBenchmarks, compat: true },
  { method: 'POST', pattern: /^\/api\/benchmarks\/apply$/,  handler: admin.handleApplyBenchmark, compat: true },

  // --- Schedules --- (compat: v2 equivalents at /api/v2/schedules)
  { method: 'GET',    pattern: /^\/api\/schedules$/,                    handler: admin.handleListSchedules, compat: true },
  { method: 'POST',   pattern: /^\/api\/schedules$/,                    handler: admin.handleCreateSchedule, compat: true },
  { method: 'POST',   pattern: /^\/api\/schedules\/([^/]+)\/toggle$/,   handler: admin.handleToggleSchedule, compat: true },
  { method: 'DELETE', pattern: /^\/api\/schedules\/([^/]+)$/,           handler: admin.handleDeleteSchedule, compat: true },

  // --- Workflows --- (compat: v2 equivalents at /api/v2/workflows)
  { method: 'GET', pattern: /^\/api\/workflows$/,                       handler: analytics.handleListWorkflows, compat: true },
  { method: 'GET', pattern: /^\/api\/workflows\/([^/]+)\/tasks$/,       handler: analytics.handleGetWorkflowTasks },
  { method: 'GET', pattern: /^\/api\/workflows\/([^/]+)\/history$/,     handler: analytics.handleGetWorkflowHistory, compat: true },
  { method: 'GET', pattern: /^\/api\/workflows\/([^/]+)$/,              handler: analytics.handleGetWorkflow, compat: true },

  // --- Approvals --- (compat: v2 equivalents at /api/v2/approvals)
  { method: 'GET',  pattern: /^\/api\/approvals$/,                          handler: admin.handleListPendingApprovals, compat: true },
  { method: 'GET',  pattern: /^\/api\/approvals\/history$/,                 handler: admin.handleGetApprovalHistory, compat: true },
  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/approve$/,        handler: admin.handleApproveTask, compat: true },
  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/reject$/,         handler: admin.handleRejectApproval, compat: true },

  // --- Coordination ---
  { method: 'GET',  pattern: /^\/api\/coordination$/,                       handler: admin.handleGetDashboard },
  { method: 'GET',  pattern: /^\/api\/coordination\/agents$/,               handler: admin.handleListAgents },
  { method: 'GET',  pattern: /^\/api\/coordination\/rules$/,                handler: admin.handleListRoutingRules },
  { method: 'GET',  pattern: /^\/api\/coordination\/claims$/,               handler: admin.handleListClaims },

  // --- Strategic Brain --- (compat: v2 partial — operations has no v2 equivalent)
  { method: 'GET',  pattern: /^\/api\/strategic\/status$/,             handler: analytics.handleGetStrategicStatus, compat: true },
  { method: 'GET',  pattern: /^\/api\/strategic\/operations$/,         handler: analytics.handleGetRecentOperations },
  { method: 'GET',  pattern: /^\/api\/strategic\/decisions$/,          handler: analytics.handleGetRoutingDecisions, compat: true },
  { method: 'GET',  pattern: /^\/api\/strategic\/provider-health$/,    handler: analytics.handleGetProviderHealth, compat: true },

  // --- Free Tier ---
  { method: 'GET',  pattern: /^\/api\/free-tier\/status$/,             handler: analytics.handleFreeTierStatus },
  { method: 'GET',  pattern: /^\/api\/free-tier\/history$/,            handler: analytics.handleFreeTierHistory },
  { method: 'GET',  pattern: /^\/api\/free-tier\/auto-scale$/,         handler: analytics.handleFreeTierAutoScale },
];

/**
 * Dispatch an API request to the matching route handler.
 *
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} context - Shared server state:
 *   { broadcastTaskUpdate: fn, clients: Set, serverPort: number }
 */
async function dispatch(req, res, context) {
  const url = req.url.split('?')[0];
  const method = req.method;

  try {
    const query = parseQuery(req.url);

    // Dashboard APIs are local-only control-plane endpoints.
    if (!isLocalDashboardRequest(req)) {
      sendError(res, 'Forbidden', 403);
      return;
    }

    // Validate CORS origin — only allow localhost
    const origin = req.headers.origin;
    const allowedOrigin = isLocalhostOrigin(origin) ? origin : null;
    res._corsOrigin = allowedOrigin;

    // CORS preflight
    if (method === 'OPTIONS') {
      const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
      if (allowedOrigin) {
        headers['Access-Control-Allow-Origin'] = allowedOrigin;
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !isAjaxRequest(req)) {
      sendError(res, 'Forbidden', 403);
      return;
    }

    for (const route of routes) {
      if (method !== route.method) continue;
      const match = url.match(route.pattern);
      if (!match) continue;

      const captures = match.slice(1);
      // Determine handler arity to decide how to call it.
      // Handlers that need context receive it as the last argument.
      // Task actions need broadcastTaskUpdate; system/instances need clients/port.
      return await route.handler(req, res, query, ...captures, context);
    }

    // No route matched
    sendError(res, 'Not found', 404);

  } catch (err) {
    process.stderr.write(`Dashboard API error: ${err.message}\n`);
    // Return 400 for client errors (bad JSON, body too large), 500 for server errors
    const status = (err.message === 'Invalid JSON body' || err.message === 'Request body too large') ? 400 : 500;
    sendError(res, err.message, status);
  }
}

module.exports = { dispatch, routes };
