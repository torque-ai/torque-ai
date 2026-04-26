'use strict';

/**
 * V2 Control-Plane Route Dispatcher
 *
 * Standalone dispatcher for v2 control-plane routes, usable by both
 * the API server (port 3457) and the dashboard server (port 3456).
 *
 * This module enables dashboard convergence: the React dashboard can
 * call /api/v2/* endpoints on the same port (3456) instead of needing
 * a separate API server connection.
 */
const logger = require('../logger').child({ component: 'v2-dispatch' });

const routes = require('./routes');
const { normalizeError } = require('./v2-middleware');
const { sendJson, validateJsonDepth } = require('./middleware');

// V2 handler modules (initialized by api-server.core.js in the same process)
const v2TaskHandlers = require('./v2-task-handlers');
const v2WorkflowHandlers = require('./v2-workflow-handlers');
const v2GovernanceHandlers = require('./v2-governance-handlers');
const v2AnalyticsHandlers = require('./v2-analytics-handlers');
const v2InfrastructureHandlers = require('./v2-infrastructure-handlers');
const concurrencyHandlers = require('../handlers/concurrency-handlers');

// Hoisted handler modules (avoids repeated require() inside handler functions)
const routingHandlers = require('../handlers/routing-template-handlers');
const strategicConfigHandlers = require('../handlers/strategic-config-handlers');
const providerCrudHandlers = require('../handlers/provider-crud-handlers');
const modelHandlers = require('../handlers/model-handlers');

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const BODY_PARSE_TIMEOUT_MS = 30000;
let _remoteAgentRegistry = null;
let _remoteAgentRegistryResolved = false;

function unwrapRemoteAgentDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('remote agent registry requires db service with prepare()');
  }
  return rawDb;
}

function getOrCreateRemoteAgentRegistry(deps = {}) {
  if (Object.prototype.hasOwnProperty.call(deps, 'remoteAgentRegistry')) {
    _remoteAgentRegistry = deps.remoteAgentRegistry || null;
    _remoteAgentRegistryResolved = true;
    return _remoteAgentRegistry;
  }

  if (_remoteAgentRegistryResolved) {
    return _remoteAgentRegistry;
  }

  try {
    const dbService = deps.db || require('../database');
    const { RemoteAgentRegistry } = require('../plugins/remote-agents/agent-registry');
    _remoteAgentRegistry = new RemoteAgentRegistry(unwrapRemoteAgentDb(dbService));
  } catch (err) {
    logger.warn('Remote agent registry unavailable for v2 dispatch', { error: err.message });
    _remoteAgentRegistry = null;
  }
  _remoteAgentRegistryResolved = true;
  return _remoteAgentRegistry;
}

function normalizeInitDeps(depsOrTaskManager) {
  if (!depsOrTaskManager) {
    return {};
  }

  const isObject = typeof depsOrTaskManager === 'object' && !Array.isArray(depsOrTaskManager);
  if (!isObject) {
    return { taskManager: depsOrTaskManager };
  }

  const hasDependencyKeys = Object.prototype.hasOwnProperty.call(depsOrTaskManager, 'taskManager')
    || Object.prototype.hasOwnProperty.call(depsOrTaskManager, 'remoteAgentRegistry')
    || Object.prototype.hasOwnProperty.call(depsOrTaskManager, 'db');
  if (hasDependencyKeys) {
    return depsOrTaskManager;
  }

  return Object.keys(depsOrTaskManager).length === 0
    ? {}
    : { taskManager: depsOrTaskManager };
}

// NOTE: Three separate JSON body parsers exist in this codebase:
//   1. middleware.js parseBody       — canonical parser; used by v2-middleware validateRequest
//                                     for routes with schema validation. Calls validateJsonDepth.
//   2. v2-dispatch.js readJsonBody   — lightweight parser for CP handlers that bypass the
//                                     schema-validation middleware (e.g., concurrency, economy,
//                                     routing templates). Should call validateJsonDepth (see below).
//   3. mcp-sse.js body accumulator  — SSE-specific inline parser for the POST /messages endpoint.
// All three enforce the 10 MB size cap and a 30-second parse timeout. Consolidation is tracked but
// deferred because the three call sites have divergent error-handling requirements and control-flow shapes.
async function readJsonBody(req) {
  if (req?.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body;
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bodySize = 0;
    let settled = false;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(bodyTimeout);
      resolve(value);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(bodyTimeout);
      reject(err);
    };
    const bodyTimeout = setTimeout(() => {
      const err = new Error('Body parse timeout');
      finishReject(err);
      req.destroy(err);
    }, BODY_PARSE_TIMEOUT_MS);

    req.on('data', chunk => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodySize += bufferChunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        finishReject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(bufferChunk);
    });
    req.on('end', () => {
      if (settled) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data.trim()) {
        finishResolve({});
        return;
      }
      try {
        const parsed = JSON.parse(data);
        validateJsonDepth(parsed); // Guard against deeply nested DoS payloads
        finishResolve(parsed);
      } catch (err) {
        logger.debug("task handler error", { err: err.message });
        finishReject(new Error(err.message === 'JSON nesting too deep' ? err.message : 'Invalid JSON'));
      }
    });
    req.on('error', (err) => {
      finishReject(err);
    });
  });
}

function unwrapToolResult(result) {
  if (!result || typeof result !== 'object') {
    return {};
  }

  const data = { ...result };
  delete data.content;
  delete data.isError;
  delete data.error_code;
  delete data.code;
  delete data.status;
  delete data.details;
  if (Object.keys(data).length > 0) {
    return data;
  }

  const text = result?.content?.[0]?.text || '';
  return text ? { message: text } : {};
}

function throwToolResultError(result) {
  const error = new Error(result?.content?.[0]?.text || 'Operation failed');
  error.code = result?.code || 'operation_failed';
  error.status = Number.isInteger(result?.status) ? result.status : 400;
  error.details = result?.details || {};
  throw error;
}

// ─── Handler Lookup ──────────────────────────────────────────────────────────

const V2_CP_HANDLER_LOOKUP = {
  // Concurrency limits
  handleV2CpGetConcurrencyLimits: (req, res, ctx) => {
    const result = concurrencyHandlers.handleGetConcurrencyLimits();
    const text = result?.content?.[0]?.text || '{}';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpSetConcurrencyLimit: async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const result = concurrencyHandlers.handleSetConcurrencyLimit(body);
    const text = result?.content?.[0]?.text || '';
    sendJson(res, { data: { message: text }, meta: { request_id: ctx.requestId } }, 200, req);
  },
  // Economy mode removed — use routing templates instead
  handleV2CpGetEconomyStatus: (_req, res, ctx) => {
    sendJson(res, { data: { removed: true, message: 'Economy mode removed. Use routing templates (Cost Saver, Free Agentic) instead.' }, meta: { request_id: ctx.requestId } }, 410, _req);
  },
  handleV2CpSetEconomyMode: (_req, res, ctx) => {
    sendJson(res, { data: { removed: true, message: 'Economy mode removed. Use routing templates (Cost Saver, Free Agentic) instead.' }, meta: { request_id: ctx.requestId } }, 410, _req);
  },
  handleV2CpAddProvider: async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const result = await providerCrudHandlers.handleAddProvider(body);
    if (result?.isError) {
      throwToolResultError(result);
    }

    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 201, req);
  },
  handleV2CpRemoveProvider: async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const result = await providerCrudHandlers.handleRemoveProvider(body);
    if (result?.isError) {
      throwToolResultError(result);
    }

    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 200, req);
  },
  // Provider API key management
  handleV2CpSetProviderApiKey: async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const providerName = ctx.params?.provider_name || '';
    const result = providerCrudHandlers.handleSetApiKey({ provider: providerName, api_key: body.api_key });
    if (result?.isError) {
      throwToolResultError(result);
    }
    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpClearProviderApiKey: (req, res, ctx) => {
    const providerName = ctx.params?.provider_name || '';
    const result = providerCrudHandlers.handleClearApiKey({ provider: providerName });
    if (result?.isError) {
      throwToolResultError(result);
    }
    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 200, req);
  },
  // Strategic Brain configuration
  handleV2CpStrategicConfigGet: (req, res, ctx) => {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    const result = strategicConfigHandlers.handleConfigGet({ working_directory: query.working_directory });
    if (result?.isError) { throwToolResultError(result); }
    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpStrategicConfigSet: async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const result = strategicConfigHandlers.handleConfigSet({ working_directory: body.working_directory, config: body.config || body });
    if (result?.isError) { throwToolResultError(result); }
    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpStrategicConfigReset: async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const result = strategicConfigHandlers.handleConfigReset({ working_directory: body.working_directory });
    if (result?.isError) { throwToolResultError(result); }
    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpStrategicTemplates: (req, res, ctx) => {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    const result = strategicConfigHandlers.handleConfigTemplates({ working_directory: query.working_directory });
    if (result?.isError) { throwToolResultError(result); }
    sendJson(res, { data: unwrapToolResult(result), meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpStrategicTemplateGet: (req, res, ctx) => {
    const templateName = ctx.params?.template_name || '';
    const configLoader = require('../orchestrator/config-loader'); // inline require to avoid circular dependency
    const template = configLoader.loadTemplate(templateName);
    if (!template) {
      sendJson(res, { error: { code: 'TEMPLATE_NOT_FOUND', message: `Template not found: ${templateName}` }, meta: { request_id: ctx.requestId } }, 404, req);
      return;
    }
    sendJson(res, { data: template, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpStrategicTest: async (req, res, ctx) => {
    // Strategic dry-run testing is not yet implemented — return 501 NOT_IMPLEMENTED
    sendJson(res, {
      error: { code: 'NOT_IMPLEMENTED', message: 'Strategic dry-run testing is not yet implemented' },
      meta: { request_id: ctx.requestId },
    }, 501, req);
  },
  // Routing templates
  handleV2CpListRoutingTemplates: (req, res, ctx) => {

    const result = routingHandlers.handleListRoutingTemplates();
    const text = result?.content?.[0]?.text || '[]';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpGetRoutingTemplate: (req, res, ctx) => {

    const templateId = ctx.params?.template_id || '';
    const result = routingHandlers.handleGetRoutingTemplate({ id: templateId });
    if (result?.isError) {
      throwToolResultError({ ...result, status: 404 });
    }
    const text = result?.content?.[0]?.text || '{}';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpCreateRoutingTemplate: async (req, res, ctx) => {
    const body = await readJsonBody(req);

    const result = routingHandlers.handleSetRoutingTemplate(body);
    if (result?.isError) {
      throwToolResultError({ ...result, status: 400 });
    }
    const text = result?.content?.[0]?.text || '{}';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 201, req);
  },
  handleV2CpUpdateRoutingTemplate: async (req, res, ctx) => {
    const body = await readJsonBody(req);

    const templateId = ctx.params?.template_id || '';
    // Resolve template by ID first, then merge body for update
    const existing = routingHandlers.handleGetRoutingTemplate({ id: templateId });
    if (existing?.isError) {
      throwToolResultError({ ...existing, status: 404 });
    }
    let existingData; try { existingData = JSON.parse(existing?.content?.[0]?.text || '{}'); } catch { existingData = { error: 'Failed to parse tool response' }; }
    const result = routingHandlers.handleSetRoutingTemplate({
      name: body.name || existingData.name,
      description: body.description !== undefined ? body.description : existingData.description,
      rules: body.rules || existingData.rules,
      complexity_overrides: body.complexity_overrides !== undefined ? body.complexity_overrides : existingData.complexity_overrides,
    });
    if (result?.isError) {
      throwToolResultError({ ...result, status: 400 });
    }
    const text = result?.content?.[0]?.text || '{}';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpDeleteRoutingTemplate: (req, res, ctx) => {

    const templateId = ctx.params?.template_id || '';
    const result = routingHandlers.handleDeleteRoutingTemplate({ id: templateId });
    if (result?.isError) {
      const text = result?.content?.[0]?.text || '';
      const status = text.includes('preset') ? 403 : 404;
      throwToolResultError({ ...result, status });
    }
    const text = result?.content?.[0]?.text || '';
    sendJson(res, { data: { message: text }, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpGetActiveRouting: (req, res, ctx) => {

    const result = routingHandlers.handleGetActiveRouting();
    if (result?.isError) {
      throwToolResultError({ ...result, status: 404 });
    }
    const text = result?.content?.[0]?.text || '{}';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpSetActiveRouting: async (req, res, ctx) => {
    const body = await readJsonBody(req);

    const result = routingHandlers.handleActivateRoutingTemplate({
      id: body.template_id !== undefined ? body.template_id : (body.id !== undefined ? body.id : undefined),
      name: body.template_name !== undefined ? body.template_name : (body.name !== undefined ? body.name : undefined),
    });
    if (result?.isError) {
      throwToolResultError({ ...result, status: 404 });
    }
    const text = result?.content?.[0]?.text || '';
    sendJson(res, { data: { message: text }, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpListCategories: (req, res, ctx) => {

    const result = routingHandlers.handleListRoutingCategories();
    const text = result?.content?.[0]?.text || '[]';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  // Model registry
  handleV2CpListModels: (req, res, ctx) => {

    const result = modelHandlers.handleListModels(req.query || {});
    const text = result?.content?.[0]?.text || '{}';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpListPendingModels: (req, res, ctx) => {

    const result = modelHandlers.handleListPendingModels();
    const text = result?.content?.[0]?.text || '{}';
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Failed to parse tool response' }; }
    sendJson(res, { data, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpApproveModel: async (req, res, ctx) => {
    const body = await readJsonBody(req);

    const result = modelHandlers.handleApproveModel(body);
    const text = result?.content?.[0]?.text || '';
    sendJson(res, { data: { message: text }, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpDenyModel: async (req, res, ctx) => {
    const body = await readJsonBody(req);

    const result = modelHandlers.handleDenyModel(body);
    const text = result?.content?.[0]?.text || '';
    sendJson(res, { data: { message: text }, meta: { request_id: ctx.requestId } }, 200, req);
  },
  handleV2CpBulkApproveModels: async (req, res, ctx) => {
    const body = await readJsonBody(req);

    const result = modelHandlers.handleBulkApproveModels(body);
    const text = result?.content?.[0]?.text || '';
    sendJson(res, { data: { message: text }, meta: { request_id: ctx.requestId } }, 200, req);
  },
  // Tasks
  handleV2CpPreviewTaskStudyContext: (...args) => v2TaskHandlers.handlePreviewTaskStudyContext(...args),
  handleV2CpSubmitTask: v2TaskHandlers.handleSubmitTask,
  handleV2CpListTasks: v2TaskHandlers.handleListTasks,
  handleV2CpKanbanSummary: v2TaskHandlers.handleKanbanSummary,
  handleV2CpTaskDiff: v2TaskHandlers.handleTaskDiff,
  handleV2CpTaskLogs: v2TaskHandlers.handleTaskLogs,
  handleV2CpTaskArtifacts: v2TaskHandlers.handleTaskArtifacts,
  handleV2CpTaskArtifact: v2TaskHandlers.handleGetTaskArtifact,
  handleV2CpTaskArtifactContent: v2TaskHandlers.handleTaskArtifactContent,
  handleV2CpPromoteTaskArtifact: v2TaskHandlers.handlePromoteTaskArtifact,
  handleV2CpTaskProgress: v2TaskHandlers.handleTaskProgress,
  handleV2CpRetryTask: v2TaskHandlers.handleRetryTask,
  handleV2CpReassignTaskProvider: (...args) => v2TaskHandlers.handleReassignTaskProvider(...args),
  handleV2CpCommitTask: v2TaskHandlers.handleCommitTask,
  handleV2CpGetTask: v2TaskHandlers.handleGetTask,
  handleV2CpCancelTask: v2TaskHandlers.handleCancelTask,
  handleV2CpDeleteTask: v2TaskHandlers.handleDeleteTask,
  handleV2CpApproveTask: v2TaskHandlers.handleApproveTask,
  handleV2CpRejectTask: v2TaskHandlers.handleRejectTask,
  handleV2CpApproveTaskBatch: v2TaskHandlers.handleApproveTaskBatch,
  handleV2CpApproveSwitch: v2TaskHandlers.handleApproveSwitch,
  handleV2CpRejectSwitch: v2TaskHandlers.handleRejectSwitch,
  // Workflows
  handleV2CpCreateWorkflow: v2WorkflowHandlers.handleCreateWorkflow,
  handleV2CpListWorkflows: v2WorkflowHandlers.handleListWorkflows,
  handleV2CpGetWorkflow: v2WorkflowHandlers.handleGetWorkflow,
  handleV2CpRunWorkflow: v2WorkflowHandlers.handleRunWorkflow,
  handleV2CpCancelWorkflow: v2WorkflowHandlers.handleCancelWorkflow,
  handleV2CpAddWorkflowTask: v2WorkflowHandlers.handleAddWorkflowTask,
  handleV2CpWorkflowHistory: v2WorkflowHandlers.handleWorkflowHistory,
  handleV2CpGetWorkflowCheckpoints: v2WorkflowHandlers.handleGetWorkflowCheckpoints,
  handleV2CpForkWorkflow: v2WorkflowHandlers.handleForkWorkflow,
  handleV2CpCreateFeatureWorkflow: v2WorkflowHandlers.handleCreateFeatureWorkflow,
  handleV2CpPauseWorkflow: v2WorkflowHandlers.handlePauseWorkflow,
  handleV2CpResumeWorkflow: v2WorkflowHandlers.handleResumeWorkflow,
  handleV2CpGetWorkflowTasks: v2WorkflowHandlers.handleGetWorkflowTasks,
  // Perf counters
  handleV2CpGetPerfCounters: v2GovernanceHandlers.handleGetPerfCounters,
  // Governance
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
  handleV2CpListProviders: v2GovernanceHandlers.handleListProviders,
  handleV2CpProviderStats: v2GovernanceHandlers.handleProviderStats,
  handleV2CpProviderToggle: v2GovernanceHandlers.handleProviderToggle,
  handleV2CpProviderTrends: v2GovernanceHandlers.handleProviderTrends,
  handleV2CpSystemStatus: v2GovernanceHandlers.handleSystemStatus,
  handleV2CpConfigureProvider: v2GovernanceHandlers.handleConfigureProvider,
  handleV2CpSetDefaultProvider: v2GovernanceHandlers.handleSetDefaultProvider,
  // Project Config
  handleV2CpListProjects: v2GovernanceHandlers.handleListProjects,
  handleV2CpScanProject: v2GovernanceHandlers.handleScanProject,
  handleV2CpGetProjectConfig: v2GovernanceHandlers.handleGetProjectConfig,
  handleV2CpSetProjectConfig: v2GovernanceHandlers.handleSetProjectConfig,
  handleV2CpGetProjectDefaults: v2GovernanceHandlers.handleGetProjectDefaults,
  handleV2CpSetProjectDefaults: v2GovernanceHandlers.handleSetProjectDefaults,
  handleV2CpGetConfig: v2GovernanceHandlers.handleGetConfig,
  handleV2CpSetConfig: v2GovernanceHandlers.handleSetConfig,
  handleV2CpConfigureStallDetection: v2GovernanceHandlers.handleConfigureStallDetection,
  // Webhooks
  handleV2CpListWebhooks: v2GovernanceHandlers.handleListWebhooks,
  handleV2CpAddWebhook: v2GovernanceHandlers.handleAddWebhook,
  handleV2CpRemoveWebhook: v2GovernanceHandlers.handleRemoveWebhook,
  handleV2CpTestWebhook: v2GovernanceHandlers.handleTestWebhook,
  // Validation
  handleV2CpAutoVerifyAndFix: v2GovernanceHandlers.handleAutoVerifyAndFix,
  handleV2CpDetectFileConflicts: v2GovernanceHandlers.handleDetectFileConflicts,
  // Analytics & Budget
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
  handleV2CpQuotaStatus: v2AnalyticsHandlers.handleQuotaStatus,
  handleV2CpQuotaHistory: v2AnalyticsHandlers.handleQuotaHistory,
  handleV2CpQuotaAutoScale: v2AnalyticsHandlers.handleQuotaAutoScale,
  handleV2CpPrometheusMetrics: v2AnalyticsHandlers.handlePrometheusMetrics,
  handleV2CpStrategicOperations: v2AnalyticsHandlers.handleStrategicOperations,
  // Infrastructure
  handleV2CpListWorkstations: v2InfrastructureHandlers.handleListWorkstations,
  handleV2CpCreateWorkstation: v2InfrastructureHandlers.handleCreateWorkstation,
  handleV2CpToggleWorkstation: v2InfrastructureHandlers.handleToggleWorkstation,
  handleV2CpProbeWorkstation: v2InfrastructureHandlers.handleProbeWorkstation,
  handleV2CpDeleteWorkstation: v2InfrastructureHandlers.handleDeleteWorkstation,
  handleV2CpListHosts: v2InfrastructureHandlers.handleListHosts,
  handleV2CpGetHost: v2InfrastructureHandlers.handleGetHost,
  handleV2CpUpdateHost: v2InfrastructureHandlers.handleUpdateHost,
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
  // Host Management (new)
  handleV2CpAddHost: v2InfrastructureHandlers.handleAddHost,
  handleV2CpRefreshModels: v2InfrastructureHandlers.handleRefreshModels,
  // Host Activity & Coordination
  handleV2CpHostActivity: v2InfrastructureHandlers.handleHostActivity,
  handleV2CpProviderPercentiles: v2InfrastructureHandlers.handleProviderPercentiles,
  handleV2CpCoordinationDashboard: v2InfrastructureHandlers.handleCoordinationDashboard,
};

// ─── Build resolved v2 route table ───────────────────────────────────────────

const v2CpRoutes = routes
  .filter(r => {
    if (!r.handlerName || !r.handlerName.startsWith('handleV2Cp')) return false;
    if (typeof r.path === 'string') return r.path.startsWith('/api/v2/');
    // Regex source escapes slashes: \/api\/v2\/ or /api/v2/
    return r.path.source.includes('/api/v2/') || r.path.source.includes('\\/api\\/v2\\/');
  })
  .map(r => ({
    ...r,
    handler: V2_CP_HANDLER_LOOKUP[r.handlerName],
  }))
  .filter(r => r.handler);

// ─── Query parser ────────────────────────────────────────────────────────────

function parseQuery(url) {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return {};
  const queryString = url.slice(queryIndex + 1);
  return Object.fromEntries(new URL('http://x?' + queryString).searchParams);
}

// ─── Middleware runner (Express-style next() pattern) ────────────────────────

function executeMiddleware(fn, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function next(err) {
      if (settled) return;
      settled = true;
      if (err) { reject(err); return; }
      resolve(true);
    }
    try {
      Promise.resolve(fn(req, res, next))
        .then(() => {
          if (!settled) { settled = true; resolve(false); }
        })
        .catch((err) => {
          if (!settled) { settled = true; reject(err); }
        });
    } catch (err) { reject(err); }
  });
}

async function runMiddleware(middlewares, req, res) {
  for (const fn of middlewares || []) {
    const shouldContinue = await executeMiddleware(fn, req, res);
    if (!shouldContinue) return false;
  }
  return true;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Attempt to dispatch an incoming request to a v2 control-plane handler.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} true if a v2 route handled the request
 */
async function dispatchV2(req, res) {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/v2/')) return false;

  for (const route of v2CpRoutes) {
    if (route.method !== req.method) continue;

    let match = null;
    if (typeof route.path === 'string') {
      if (url !== route.path) continue;
      match = [];
    } else {
      match = url.match(route.path);
      if (!match) continue;
    }

    // Map path parameters
    const mappedParams = {};
    const routeParams = [];
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
    req.query = parseQuery(req.url);

    try {
      // Run v2 middleware (requestId, validation)
      if (route.middleware?.length) {
        const shouldContinue = await runMiddleware(route.middleware, req, res);
        if (!shouldContinue) return true;
      }

      // Call the handler with the same signature as api-server.core.js
      await route.handler(req, res, {
        requestId: req.requestId,
        params: req.params,
        query: req.query,
      }, ...routeParams, req);
      return true;

    } catch (err) {
      // Surface real handler errors to the log at warn-level. Without this, the
      // normalizeError path only logs at debug which the default 'info' logger
      // filters out — a whole class of "endpoint returns 500 with no detail"
      // bugs stays invisible. 2026-04-24 hit this with
      // /api/v2/strategic/operations: "Internal server error" for months with
      // zero 200s in any rotated log, no stack anywhere. Keep the user-facing
      // body unchanged (still goes through normalizeError).
      logger.warn('v2 handler threw', {
        method: req.method,
        path: (req.url || '').split('?')[0],
        handlerName: route.handlerName,
        requestId: req.requestId,
        err: err && err.message,
        stack: err && err.stack ? err.stack.split('\n').slice(0, 8).join(' | ') : null,
        code: err?.code,
      });
      // Use v2 error normalization for consistent responses
      const { status, body } = normalizeError(err, req);
      if (!res.headersSent) {
        sendJson(res, body, status, req);
      }
      return true;
    }
  }

  return false;
}

/**
 * Initialize handler modules with shared v2 dependencies.
 * Only needed if the API server hasn't already initialized them.
 */
function init(depsOrTaskManager = {}) {
  const deps = normalizeInitDeps(depsOrTaskManager);
  const taskManager = deps.taskManager;

  if (taskManager) {
    v2TaskHandlers.init(taskManager);
    v2WorkflowHandlers.init(taskManager);
    v2GovernanceHandlers.init({ taskManager });
  }

  const shouldInitInfrastructure = taskManager
    || Object.prototype.hasOwnProperty.call(deps, 'remoteAgentRegistry')
    || Object.prototype.hasOwnProperty.call(deps, 'db');
  if (shouldInitInfrastructure) {
    v2InfrastructureHandlers.init({
      taskManager,
      remoteAgentRegistry: getOrCreateRemoteAgentRegistry(deps),
    });
  }
}

module.exports = {
  dispatchV2,
  init,
  v2CpRoutes,
  V2_CP_HANDLER_LOOKUP,
  MAX_BODY_SIZE,
  validateJsonDepth,
};
