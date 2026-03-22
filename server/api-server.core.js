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
const serverConfig = require('./config');
const logger = require('./logger').child({ component: 'api-server' });
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');
const remoteAgentHandlers = require('./handlers/remote-agent-handlers');
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
const { handleInboundWebhook, verifyWebhookSignature, substitutePayload, setFreeTierTrackerGetter: setWebhookFreeTierTrackerGetter } = webhooks;
const { handleHealthz, handleReadyz, handleLivez } = require('./api/health-probes');
const authMiddleware = require('./auth/middleware');
const { requireRole } = require('./auth/role-guard');

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
  normalizeV2Transport,
  getV2ProviderTransport,
  sendV2Success,
  sendV2Error,
  buildV2MetaEnvelope,
  sendV2DiscoverySuccess,
  sendV2DiscoveryError,
  sendAuthError,
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
// Auth: ticket exchange
// ============================================

async function handleCreateTicket(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const ticketManager = require('./auth/ticket-manager');

  // Extract Bearer token from Authorization header
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKey = bearerMatch ? bearerMatch[1] : null;

  if (!apiKey) {
    sendJson(res, { error: 'Authorization header with Bearer token required' }, 401, req);
    return;
  }

  const identity = keyManager.validateKey(apiKey);
  if (!identity) {
    sendJson(res, { error: 'Invalid API key' }, 401, req);
    return;
  }

  try {
    const ticket = ticketManager.createTicket(identity);
    sendJson(res, { ticket }, 200, req);
  } catch (err) {
    // Ticket cap reached
    sendJson(res, { error: err.message }, 503, req);
  }
}

async function handleCreateSseTicket(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const sseTicketManager = require('./auth/sse-tickets');

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKey = bearerMatch ? bearerMatch[1] : null;

  if (!apiKey) {
    sendJson(res, { error: 'Authorization header with Bearer token required' }, 401, req);
    return;
  }

  const identity = keyManager.validateKey(apiKey);
  if (!identity) {
    sendJson(res, { error: 'Invalid API key' }, 401, req);
    return;
  }

  const { ticket, expiresAt } = sseTicketManager.generateTicket(identity.id);
  sendJson(res, { ticket, expires_at: expiresAt }, 200, req);
}

// ============================================
// Auth: key management REST handlers
// ============================================

async function handleCreateApiKey(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');

  // Only admin may create keys
  const identity = req._identity || authMiddleware.authenticate(req);
  if (!identity || !requireRole(identity, 'admin')) {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }

  try {
    const body = Object.prototype.hasOwnProperty.call(req, 'body')
      ? req.body
      : await parseBody(req);
    const { name, role } = body || {};
    if (!name) {
      sendJson(res, { error: '`name` is required' }, 400, req);
      return;
    }
    const userId = identity.type === 'user' ? identity.id : null;
    const result = keyManager.createKey({ name, role: role || identity.role, userId });
    sendJson(res, { id: result.id, key: result.key, name: result.name, role: result.role, userId: result.userId }, 201, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 400, req);
  }
}

async function handleListApiKeys(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');

  const identity = req._identity || authMiddleware.authenticate(req);
  if (!identity) {
    sendJson(res, { error: 'Forbidden' }, 403, req);
    return;
  }

  // Non-admin: show only their own keys
  if (!requireRole(identity, 'admin')) {
    if (identity.type === 'user') {
      sendJson(res, { keys: keyManager.listKeysByUser(identity.id) }, 200, req);
      return;
    }
    sendJson(res, { error: 'Forbidden' }, 403, req);
    return;
  }

  // Admin: show all keys
  try {
    const keys = keyManager.listKeys();
    sendJson(res, { keys }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

async function handleRevokeApiKey(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');

  const identity = req._identity || authMiddleware.authenticate(req);
  if (!identity) {
    sendJson(res, { error: 'Forbidden' }, 403, req);
    return;
  }

  const keyId = req.params?.key_id;
  if (!keyId) {
    sendJson(res, { error: '`key_id` is required' }, 400, req);
    return;
  }

  // Non-admin: verify key ownership before revoking
  if (!requireRole(identity, 'admin')) {
    const keys = keyManager.listKeysByUser(identity.id);
    if (!keys.some(k => k.id === keyId)) {
      sendJson(res, { error: 'Forbidden — can only revoke your own keys' }, 403, req);
      return;
    }
  }

  try {
    keyManager.revokeKey(keyId);
    sendJson(res, { success: true }, 200, req);
  } catch (err) {
    const status = err.message === 'Key not found' ? 404 : 400;
    sendJson(res, { error: err.message }, status, req);
  }
}

async function handleDashboardLogin(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const sessionManager = require('./auth/session-manager');
  const { loginLimiter } = require('./auth/rate-limiter');

  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';

  // Rate limit check
  if (loginLimiter.isLimited(ip)) {
    sendJson(res, { error: 'Too many login attempts. Please try again later.' }, 429, req);
    return;
  }

  try {
    const body = Object.prototype.hasOwnProperty.call(req, 'body')
      ? req.body
      : await parseBody(req);
    const { key, username, password } = body || {};

    // Open mode: no keys AND no users configured — auto-login as admin
    const { isOpenMode } = require('./auth/middleware');
    if (isOpenMode()) {
      const identity = { id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' };
      const { sessionId, csrfToken } = sessionManager.createSession(identity);
      res.setHeader('Set-Cookie', [
        `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
        `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
      ]);
      sendJson(res, { success: true, role: identity.role, csrfToken }, 200, req);
      return;
    }

    // Username/password login
    if (username && password) {
      const userManager = require('./auth/user-manager');
      const identity = await userManager.validatePassword(username, password);
      if (!identity) {
        loginLimiter.recordFailure(ip);
        sendJson(res, { error: 'Invalid username or password' }, 401, req);
        return;
      }
      const { sessionId, csrfToken } = sessionManager.createSession(identity);
      res.setHeader('Set-Cookie', [
        `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
        `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
      ]);
      sendJson(res, {
        success: true,
        role: identity.role,
        csrfToken,
        user: { id: identity.id, username: identity.username, displayName: identity.name },
      }, 200, req);
      return;
    }

    // API key login (existing flow — backward compat)
    if (!key) {
      loginLimiter.recordFailure(ip);
      sendJson(res, { error: 'API key is required' }, 401, req);
      return;
    }

    const identity = keyManager.validateKey(key);
    if (!identity) {
      loginLimiter.recordFailure(ip);
      sendJson(res, { error: 'Invalid API key' }, 401, req);
      return;
    }

    const { sessionId, csrfToken } = sessionManager.createSession(identity);
    res.setHeader('Set-Cookie', [
      `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
      `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
    ]);
    sendJson(res, { success: true, role: identity.role, csrfToken }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

async function handleDashboardLogout(req, res, _context = {}) {
  const sessionManager = require('./auth/session-manager');
  const { parseCookie } = require('./auth/middleware');

  const sessionId = parseCookie(req.headers?.cookie, 'torque_session');
  if (sessionId) {
    sessionManager.destroySession(sessionId);
  }

  // Clear cookies
  res.setHeader('Set-Cookie', [
    'torque_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    'torque_csrf=; SameSite=Strict; Path=/; Max-Age=0',
  ]);
  sendJson(res, { success: true }, 200, req);
}

/**
 * POST /api/auth/setup — create the first admin user (setup wizard).
 * Only works when no users exist yet. Rate-limited.
 */
async function handleSetup(req, res) {
  const userManager = require('./auth/user-manager');
  const sessionManager = require('./auth/session-manager');
  const { loginLimiter } = require('./auth/rate-limiter');

  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  if (loginLimiter.isLimited(ip)) {
    sendJson(res, { error: 'Too many attempts. Try again later.' }, 429, req);
    return;
  }

  if (userManager.hasAnyUsers()) {
    sendJson(res, { error: 'Setup already completed — users exist' }, 403, req);
    return;
  }

  try {
    const body = Object.prototype.hasOwnProperty.call(req, 'body')
      ? req.body
      : await parseBody(req);
    const { username, password, displayName } = body || {};
    const user = await userManager.createUser({ username, password, role: 'admin', displayName });

    const identity = { id: user.id, name: user.displayName || user.username, username: user.username, role: 'admin', type: 'user' };
    const { sessionId, csrfToken } = sessionManager.createSession(identity);
    res.setHeader('Set-Cookie', [
      `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
      `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
    ]);
    sendJson(res, {
      success: true,
      role: 'admin',
      csrfToken,
      user: { id: user.id, username: user.username, displayName: user.displayName },
    }, 201, req);
  } catch (err) {
    loginLimiter.recordFailure(ip);
    sendJson(res, { error: err.message }, 400, req);
  }
}

/**
 * GET /api/auth/status — returns auth state for the current request.
 * Works for unauthenticated clients (skipAuth: true).
 */
function handleAuthStatus(req, res) {
  const { isOpenMode } = require('./auth/middleware');
  const userManager = require('./auth/user-manager');

  if (isOpenMode()) {
    sendJson(res, { authenticated: true, mode: 'open', needsSetup: false }, 200, req);
    return;
  }

  const needsSetup = !userManager.hasAnyUsers();
  const identity = authMiddleware.authenticate(req);

  if (!identity) {
    sendJson(res, { authenticated: false, needsSetup }, 200, req);
    return;
  }

  const response = {
    authenticated: true,
    mode: 'authenticated',
    needsSetup: false,
    role: identity.role,
  };

  if (identity.type === 'user') {
    response.user = { id: identity.id, username: identity.username, displayName: identity.name, role: identity.role };
  }

  sendJson(res, response, 200, req);
}

// ============================================
// User management handlers
// ============================================

async function handleListUsers(req, res) {
  const userManager = require('./auth/user-manager');
  const identity = req._identity;
  if (!identity || !requireRole(identity, 'admin')) {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }
  sendJson(res, { users: userManager.listUsers() }, 200, req);
}

async function handleCreateUser(req, res) {
  const userManager = require('./auth/user-manager');
  const identity = req._identity;
  if (!identity || !requireRole(identity, 'admin')) {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }
  try {
    const body = await parseBody(req);
    const { username, password, role, displayName } = body || {};
    const user = await userManager.createUser({ username, password, role, displayName });
    sendJson(res, { user }, 201, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 400, req);
  }
}

async function handleUpdateUser(req, res, context) {
  const userManager = require('./auth/user-manager');
  const identity = req._identity;
  if (!identity || !requireRole(identity, 'admin')) {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }
  try {
    const body = await parseBody(req);
    const userId = context.params?.user_id;
    if (!userId) { sendJson(res, { error: 'Missing user ID' }, 400, req); return; }
    await userManager.updateUser(userId, body);
    const updated = userManager.getUserById(userId);
    sendJson(res, { user: updated }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 400, req);
  }
}

async function handleDeleteUser(req, res, context) {
  const userManager = require('./auth/user-manager');
  const sessionManager = require('./auth/session-manager');
  const identity = req._identity;
  if (!identity || !requireRole(identity, 'admin')) {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }
  try {
    const userId = context.params?.user_id;
    if (!userId) { sendJson(res, { error: 'Missing user ID' }, 400, req); return; }
    userManager.deleteUser(userId);
    sessionManager.destroySessionsByIdentityId(userId);
    sendJson(res, { success: true }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 400, req);
  }
}

function handleGetMe(req, res) {
  const identity = req._identity;
  if (!identity) {
    sendJson(res, { error: 'Not authenticated' }, 401, req);
    return;
  }
  if (identity.type === 'user') {
    const userManager = require('./auth/user-manager');
    const user = userManager.getUserById(identity.id);
    if (user) {
      sendJson(res, { user }, 200, req);
    } else {
      sendJson(res, { error: 'User not found' }, 404, req);
    }
  } else {
    sendJson(res, { user: { id: identity.id, name: identity.name, role: identity.role, type: identity.type || 'api_key' } }, 200, req);
  }
}

async function handleUpdateMe(req, res) {
  const identity = req._identity;
  if (!identity || identity.type !== 'user') {
    sendJson(res, { error: 'Only user accounts can update profile' }, 400, req);
    return;
  }
  try {
    const userManager = require('./auth/user-manager');
    const body = await parseBody(req);
    const { currentPassword, newPassword, displayName } = body || {};

    const updates = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (newPassword) {
      if (!currentPassword) {
        sendJson(res, { error: 'Current password required to change password' }, 400, req);
        return;
      }
      const valid = await userManager.validatePassword(identity.username, currentPassword);
      if (!valid) {
        sendJson(res, { error: 'Current password is incorrect' }, 401, req);
        return;
      }
      updates.password = newPassword;
    }

    if (Object.keys(updates).length > 0) {
      await userManager.updateUser(identity.id, updates);
    }
    const updated = userManager.getUserById(identity.id);
    sendJson(res, { user: updated }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 400, req);
  }
}

// ============================================
// Route definitions
// ============================================

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
  handleV2CpRunRemoteCommand: remoteAgentHandlers.handleRunRemoteCommand,
  handleV2CpRunTests: remoteAgentHandlers.handleRunTests,
  handleShutdown,
  handleCreateTicket,
  handleCreateSseTicket,
  handleCreateApiKey,
  handleListApiKeys,
  handleRevokeApiKey,
  handleDashboardLogin,
  handleDashboardLogout,
  handleSetup,
  handleAuthStatus,
  handleListUsers,
  handleCreateUser,
  handleUpdateUser,
  handleDeleteUser,
  handleGetMe,
  handleUpdateMe,
  handleClaudeEvent,
  handleClaudeFiles,
  handleGetFreeTierStatus,
  handleGetFreeTierHistory,
  handleGetFreeTierAutoScale,
  handleGetProviderQuotas,
  handleBootstrapWorkstation: require('./api/bootstrap').handleBootstrapWorkstation,
  // V2 Control-Plane: Tasks
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
  handleV2CpToggleSchedule: v2GovernanceHandlers.handleToggleSchedule,
  handleV2CpDeleteSchedule: v2GovernanceHandlers.handleDeleteSchedule,
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
  handleV2CpToggleHost: v2InfrastructureHandlers.handleToggleHost,
  handleV2CpDeleteHost: v2InfrastructureHandlers.handleDeleteHost,
  handleV2CpHostScan: v2InfrastructureHandlers.handleHostScan,
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

function resolveApiRoutes(deps = {}) {
  const baseRoutes = routes.filter((route) => !V2_PROVIDER_ROUTE_HANDLER_NAMES.has(route.handlerName));
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
  return v2Routes.concat(resolvedRoutes, createHealthRoutes(deps));
}

function createApiServer(deps = {}) {
  const serverDeps = {
    db: deps.db || db,
    taskManager: deps.taskManager,
    tools: deps.tools || tools,
    agentRegistry: deps.agentRegistry,
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
    }),
  };
}

/** Localhost IP addresses that are always allowed to call /api/shutdown */
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * GET /api/free-tier/status — return free-tier provider quota status.
 */
let _freeTierTrackerGetter = null;
function setFreeTierTrackerGetter(getter) {
  _freeTierTrackerGetter = getter;
  // Forward to webhook module so free_tier_task triggers can use it
  if (typeof setWebhookFreeTierTrackerGetter === 'function') {
    setWebhookFreeTierTrackerGetter(getter);
  }
}

async function handleGetFreeTierStatus(_req, res, _context = {}) {
  try {
    const tracker = typeof _freeTierTrackerGetter === 'function' ? _freeTierTrackerGetter() : null;
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
 * GET /api/free-tier/history?days=7 — return free-tier daily usage history.
 */
async function handleGetFreeTierHistory(req, res, _context = {}) {
  try {
    const query = parseQuery(req.url);
    const days = Math.max(1, Math.min(90, parseInt(query.days, 10) || 7));
    const history = db.getUsageHistory(days);
    sendJson(res, { status: 'ok', history }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

/**
 * GET /api/free-tier/auto-scale — return free-tier auto-scale config + current status.
 */
async function handleGetFreeTierAutoScale(_req, res, _context = {}) {
  try {
    const enabled = serverConfig.isOptIn('free_tier_auto_scale_enabled');
    const queueDepthThreshold = serverConfig.getInt('free_tier_queue_depth_threshold', 3);
    const cooldownSeconds = serverConfig.getInt('free_tier_cooldown_seconds', 60);

    // Count currently queued codex tasks
    let codexQueueDepth = 0;
    try {
      const queued = db.listTasks({ status: 'queued', limit: 1000 });
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
 * POST /api/shutdown — trigger graceful shutdown from external callers.
 * Responds with 200 before initiating shutdown so the caller gets confirmation.
 * Requires either a localhost source IP or a valid API key.
 */
async function handleShutdown(req, res, _context = {}) {
  void _context;
  const remoteIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const isLocalhost = LOCALHOST_IPS.has(remoteIp);

  if (!isLocalhost && !authMiddleware.authenticate(req)) {
    sendJson(res, { error: 'Forbidden' }, 403, req);
    return;
  }

  // Defense-in-depth: require X-Requested-With to prevent CSRF from browser contexts
  if (!req.headers['x-requested-with']) {
    sendJson(res, { error: 'X-Requested-With header required' }, 403, req);
    return;
  }

  let body = {};
  try { body = await parseBody(req); } catch { /* ignore */ }
  const reason = body.reason || 'HTTP /api/shutdown';

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
  // This is NOT in the routes array — it's a special handler with its own auth (HMAC, not API key)
  if (req.method === 'POST' && url.startsWith(INBOUND_WEBHOOK_PREFIX)) {
    try {
      const webhookName = decodeURIComponent(url.slice(INBOUND_WEBHOOK_PREFIX.length));
      if (webhookName) {
        return await handleInboundWebhook(req, res, webhookName, { requestId });
      }
    } catch (err) {
      if (err instanceof URIError) {
        sendJson(res, { error: 'Invalid webhook name encoding' }, 400, req);
        return;
      }
      throw err;
    }
  }

  if (req.method === 'GET' && url === '/api/openapi.json') {
    const spec = generateOpenApiSpec(routes);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(spec, null, 2));
    return;
  }

  // Version endpoint — always accessible (no auth required)
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

    // Auth check — skip for routes that handle auth themselves (e.g. skipAuth: true)
    // or explicit allow-listed unauthenticated health routes.
    const shouldSkipAuth = route.skipAuth === true
      || (Array.isArray(route.skipAuth) && route.skipAuth.includes(url));
    if (!shouldSkipAuth) {
      const identity = authMiddleware.authenticate(req);
      if (!identity) {
        sendAuthError(res, requestId, req);
        return;
      }
      req._identity = identity;
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
        sendJson(res, {
          tool: route.tool,
          result: result.content?.[0]?.text || '',
        }, 200, req);
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
  // SECURITY: Requires API key + tier enforcement (rest_api_tool_mode config).
  const TOOL_PREFIX = '/api/tools/';
  // Tools that must not be callable via the generic REST passthrough regardless of auth/tier
  const BLOCKED_REST_TOOLS = new Set(['restart_server', 'shutdown', 'database_backup', 'database_restore']);
  if (req.method === 'POST' && url.startsWith(TOOL_PREFIX)) {
    const toolName = url.slice(TOOL_PREFIX.length);
    if (toolName && /^[a-z_]+$/.test(toolName) && tools.routeMap.has(toolName)) {
      if (BLOCKED_REST_TOOLS.has(toolName)) {
        sendJson(res, { error: `Tool '${toolName}' is not available via the REST API` }, 403, req);
        return;
      }
      {
        const identity = authMiddleware.authenticate(req);
        if (!identity || identity.id === 'open-mode') {
          sendAuthError(res, requestId, req);
          return;
        }
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
      agentRegistry: options.agentRegistry || null,
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
  setFreeTierTrackerGetter,
  handleGetFreeTierHistory,
  handleGetFreeTierAutoScale,
  _testing: {
    handleV2TaskCancel,
    setV2TaskManager: (tm) => { _initV2TaskManager(tm); },
    handleClaudeEvent,
    handleClaudeFiles,
    handleCreateSseTicket,
    _claudeEventLog,
  },
};
