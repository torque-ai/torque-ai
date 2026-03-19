'use strict';
const logger = require('../logger').child({ component: 'routes' });

const db = require('../database');
const { validateInferenceRequest } = require('./v2-schemas');
const { requestId, validateRequest } = require('./v2-middleware');

function buildV2Middleware(schema = {}) {
  return [requestId, validateRequest(schema)];
}

function validateDecodedParamField(field, label = field) {
  return (params = {}) => {
    const rawValue = typeof params?.[field] === 'string' ? params[field] : '';

    if (!rawValue.trim()) {
      return {
        valid: false,
        errors: [{
          field,
          code: 'missing',
          message: `\`${field}\` is required`,
        }],
        value: {},
      };
    }

    try {
      const decodedValue = decodeURIComponent(rawValue).trim();
      if (!decodedValue) {
        return {
          valid: false,
          errors: [{
            field,
            code: 'type',
            message: `\`${field}\` must be a non-empty string`,
          }],
          value: {},
        };
      }

      return {
        valid: true,
        errors: [],
        value: {
          ...params,
          [field]: decodedValue,
        },
      };
    } catch (err) {
      logger.debug("task handler error", { err: err.message });
      return {
        valid: false,
        errors: [{
          field,
          code: 'encoding',
          message: `Invalid ${label} encoding`,
        }],
        value: {},
      };
    }
  };
}

function handleOpenApiSpec(req, res) {
  const { generateOpenApiSpec } = require('./openapi-generator');
  const { sendJson } = require('./middleware');
  sendJson(res, generateOpenApiSpec(routes), 200, req);
}

const routes = [
  { method: 'GET', path: '/api/openapi.json', handler: handleOpenApiSpec, handlerName: 'handleOpenApiSpec', skipAuth: true },
  // Tasks
  // NOTE (M5): Task data is accessible to any authenticated client on this server.
  // TORQUE is designed for single-user or trusted-team deployments.
  // Multi-tenant isolation requires user accounts (Phase 3).
  { method: 'POST', path: '/api/tasks', tool: 'smart_submit_task', mapBody: true },
  { method: 'POST', path: '/api/tasks/submit', tool: 'submit_task', mapBody: true },
  { method: 'GET', path: '/api/tasks', tool: 'list_tasks', mapQuery: true },
  { method: 'GET', path: /^\/api\/tasks\/([^/]+)$/, tool: 'get_result', mapParams: ['task_id'] },
  { method: 'DELETE', path: /^\/api\/tasks\/([^/]+)$/, tool: 'cancel_task', mapParams: ['task_id'], mapQuery: true },
  { method: 'DELETE', path: '/api/tasks', tool: 'delete_task', mapQuery: true },

  // Status & Health
  { method: 'GET', path: '/api/status', tool: 'check_status', mapQuery: true },
  { method: 'GET', path: '/api/health', tool: 'check_ollama_health' },

  // Providers
  { method: 'GET', path: '/api/providers', tool: 'list_providers' },
  { method: 'GET', path: '/api/provider-quotas', handlerName: 'handleGetProviderQuotas' },
  { method: 'POST', path: '/api/providers/configure', tool: 'configure_provider', mapBody: true },
  { method: 'POST', path: '/api/providers/default', tool: 'set_default_provider', mapBody: true },
  // TDA-10: Legacy Ollama host routes — use /api/v2/hosts/* instead
  { method: 'GET', path: '/api/ollama/hosts', tool: 'list_ollama_hosts', mapQuery: true, deprecated: '/api/v2/hosts' },
  { method: 'POST', path: '/api/ollama/hosts', tool: 'add_ollama_host', mapBody: true, deprecated: '/api/v2/hosts' },
  { method: 'DELETE', path: /^\/api\/ollama\/hosts\/([^/]+)$/, tool: 'remove_ollama_host', mapParams: ['host_id'], deprecated: '/api/v2/hosts/:id' },
  { method: 'POST', path: /^\/api\/ollama\/hosts\/([^/]+)\/enable$/, tool: 'enable_ollama_host', mapParams: ['host_id'], deprecated: '/api/v2/hosts/:id/toggle' },
  { method: 'POST', path: /^\/api\/ollama\/hosts\/([^/]+)\/disable$/, tool: 'disable_ollama_host', mapParams: ['host_id'], deprecated: '/api/v2/hosts/:id/toggle' },
  { method: 'POST', path: /^\/api\/ollama\/hosts\/([^/]+)\/refresh-models$/, tool: 'refresh_host_models', mapParams: ['host_id'], deprecated: '/api/v2/hosts/:id/refresh-models' },
  {
    method: 'POST',
    path: '/api/v2/inference',
    handlerName: 'handleV2Inference',
    middleware: buildV2Middleware({
      body: {
        validator: validateInferenceRequest,
        options: () => ({ defaultProvider: db.getDefaultProvider?.() || null }),
      },
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/providers\/([^/]+)\/inference$/,
    handlerName: 'handleV2ProviderInference',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
      body: {
        validator: validateInferenceRequest,
        options: (req) => ({ defaultProvider: req.params?.provider_id || null }),
      },
    }),
  },
  // NOTE: GET /api/v2/tasks/:id and POST /api/v2/tasks/:id/cancel are handled
  // by the CP handlers (handleV2CpGetTask, handleV2CpCancelTask) defined below.
  {
    method: 'GET',
    path: /^\/api\/v2\/tasks\/([^/]+)\/events$/,
    handlerName: 'handleV2TaskEvents',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/providers',
    handlerName: 'handleV2ListProviders',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)\/capabilities$/,
    handlerName: 'handleV2ProviderCapabilities',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)\/models$/,
    handlerName: 'handleV2ProviderModels',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)\/health$/,
    handlerName: 'handleV2ProviderHealth',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)$/,
    handlerName: 'handleV2ProviderDetail',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/remote/run',
    handlerName: 'handleV2RemoteRun',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/remote/test',
    handlerName: 'handleV2RemoteTest',
    middleware: buildV2Middleware(),
  },

  // ─── V2 Control-Plane: Tasks ─────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v2/tasks',
    handlerName: 'handleV2CpSubmitTask',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/tasks',
    handlerName: 'handleV2CpListTasks',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/tasks\/([^/]+)\/diff$/,
    handlerName: 'handleV2CpTaskDiff',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/tasks\/([^/]+)\/logs$/,
    handlerName: 'handleV2CpTaskLogs',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/tasks\/([^/]+)\/progress$/,
    handlerName: 'handleV2CpTaskProgress',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/tasks\/([^/]+)\/retry$/,
    handlerName: 'handleV2CpRetryTask',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'PATCH',
    path: /^\/api\/v2\/tasks\/([^/]+)\/provider$/,
    handlerName: 'handleV2CpReassignTaskProvider',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/tasks\/([^/]+)\/commit$/,
    handlerName: 'handleV2CpCommitTask',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/tasks\/([^/]+)$/,
    handlerName: 'handleV2CpGetTask',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/tasks\/([^/]+)\/cancel$/,
    handlerName: 'handleV2CpCancelTask',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/tasks\/([^/]+)$/,
    handlerName: 'handleV2CpDeleteTask',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/tasks\/([^/]+)\/approve-switch$/,
    handlerName: 'handleV2CpApproveSwitch',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/tasks\/([^/]+)\/reject-switch$/,
    handlerName: 'handleV2CpRejectSwitch',
    mapParams: ['task_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('task_id', 'task id'),
    }),
  },

  // ─── V2 Control-Plane: Workflows ───────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v2/workflows',
    handlerName: 'handleV2CpCreateWorkflow',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/workflows',
    handlerName: 'handleV2CpListWorkflows',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/workflows\/([^/]+)$/,
    handlerName: 'handleV2CpGetWorkflow',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workflows\/([^/]+)\/run$/,
    handlerName: 'handleV2CpRunWorkflow',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workflows\/([^/]+)\/cancel$/,
    handlerName: 'handleV2CpCancelWorkflow',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workflows\/([^/]+)\/tasks$/,
    handlerName: 'handleV2CpAddWorkflowTask',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/workflows\/([^/]+)\/history$/,
    handlerName: 'handleV2CpWorkflowHistory',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/workflows/feature',
    handlerName: 'handleV2CpCreateFeatureWorkflow',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workflows\/([^/]+)\/pause$/,
    handlerName: 'handleV2CpPauseWorkflow',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workflows\/([^/]+)\/resume$/,
    handlerName: 'handleV2CpResumeWorkflow',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/workflows\/([^/]+)\/tasks$/,
    handlerName: 'handleV2CpGetWorkflowTasks',
    mapParams: ['workflow_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workflow_id', 'workflow id'),
    }),
  },

  // ─── V2 Control-Plane: Governance ───────────────────────────────────────

  // Approvals
  {
    method: 'GET',
    path: '/api/v2/approvals',
    handlerName: 'handleV2CpListApprovals',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/approvals\/([^/]+)\/decide$/,
    handlerName: 'handleV2CpApprovalDecision',
    mapParams: ['approval_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('approval_id', 'approval id'),
    }),
  },

  // Schedules
  {
    method: 'GET',
    path: '/api/v2/schedules',
    handlerName: 'handleV2CpListSchedules',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/schedules',
    handlerName: 'handleV2CpCreateSchedule',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/schedules\/([^/]+)$/,
    handlerName: 'handleV2CpGetSchedule',
    mapParams: ['schedule_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('schedule_id', 'schedule id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/schedules\/([^/]+)\/toggle$/,
    handlerName: 'handleV2CpToggleSchedule',
    mapParams: ['schedule_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('schedule_id', 'schedule id'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/schedules\/([^/]+)$/,
    handlerName: 'handleV2CpDeleteSchedule',
    mapParams: ['schedule_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('schedule_id', 'schedule id'),
    }),
  },

  // Policies
  {
    method: 'GET',
    path: '/api/v2/policies',
    handlerName: 'handleV2CpListPolicies',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/policies/evaluate',
    handlerName: 'handleV2CpEvaluatePolicies',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/policies\/([^/]+)$/,
    handlerName: 'handleV2CpGetPolicy',
    mapParams: ['policy_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('policy_id', 'policy id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/policies\/([^/]+)\/mode$/,
    handlerName: 'handleV2CpSetPolicyMode',
    mapParams: ['policy_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('policy_id', 'policy id'),
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/policy-evaluations',
    handlerName: 'handleV2CpListPolicyEvaluations',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/policy-evaluations\/([^/]+)$/,
    handlerName: 'handleV2CpGetPolicyEvaluation',
    mapParams: ['evaluation_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('evaluation_id', 'evaluation id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/policy-evaluations\/([^/]+)\/override$/,
    handlerName: 'handleV2CpOverridePolicyDecision',
    mapParams: ['evaluation_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('evaluation_id', 'evaluation id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/peek\/attestations\/([^/]+)$/,
    handlerName: 'handleV2CpPeekAttestationExport',
    mapParams: ['id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('id', 'report id'),
    }),
  },

  // Plan Projects
  {
    method: 'GET',
    path: '/api/v2/plan-projects',
    handlerName: 'handleV2CpListPlanProjects',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/plan-projects/import',
    handlerName: 'handleV2CpImportPlan',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/plan-projects\/([^/]+)$/,
    handlerName: 'handleV2CpGetPlanProject',
    mapParams: ['project_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('project_id', 'project id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/plan-projects\/([^/]+)\/(pause|resume|retry)$/,
    handlerName: 'handleV2CpPlanProjectAction',
    mapParams: ['project_id', 'action'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('project_id', 'project id'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/plan-projects\/([^/]+)$/,
    handlerName: 'handleV2CpDeletePlanProject',
    mapParams: ['project_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('project_id', 'project id'),
    }),
  },

  // Benchmarks & Tuning
  {
    method: 'GET',
    path: '/api/v2/benchmarks',
    handlerName: 'handleV2CpListBenchmarks',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/benchmarks/apply',
    handlerName: 'handleV2CpApplyBenchmark',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/tuning',
    handlerName: 'handleV2CpListProjectTuning',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/tuning',
    handlerName: 'handleV2CpCreateProjectTuning',
    middleware: buildV2Middleware(),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/tuning\/([^/]+)$/,
    handlerName: 'handleV2CpDeleteProjectTuning',
    mapParams: ['project_path'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('project_path', 'project path'),
    }),
  },

  // Provider List (CP — for dashboard convergence)
  {
    method: 'GET',
    path: '/api/v2/providers',
    handlerName: 'handleV2CpListProviders',
    middleware: buildV2Middleware(),
  },

  // Provider Stats & Toggle
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)\/stats$/,
    handlerName: 'handleV2CpProviderStats',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/providers\/([^/]+)\/toggle$/,
    handlerName: 'handleV2CpProviderToggle',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/providers/trends',
    handlerName: 'handleV2CpProviderTrends',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/providers\/([^/]+)\/configure$/,
    handlerName: 'handleV2CpConfigureProvider',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/providers/default',
    handlerName: 'handleV2CpSetDefaultProvider',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/providers/add',
    handlerName: 'handleV2CpAddProvider',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/providers/remove',
    handlerName: 'handleV2CpRemoveProvider',
    middleware: buildV2Middleware(),
  },

  // Provider percentiles
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)\/percentiles$/,
    handlerName: 'handleV2CpProviderPercentiles',
    mapParams: ['provider_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('provider_id', 'provider id'),
    }),
  },

  // System
  {
    method: 'GET',
    path: '/api/v2/system/status',
    handlerName: 'handleV2CpSystemStatus',
    middleware: buildV2Middleware(),
  },

  // Project Config
  {
    method: 'POST',
    path: '/api/v2/projects/scan',
    handlerName: 'handleV2CpScanProject',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/projects/defaults',
    handlerName: 'handleV2CpGetProjectDefaults',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/projects/defaults',
    handlerName: 'handleV2CpSetProjectDefaults',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/config',
    handlerName: 'handleV2CpGetConfig',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/config\/([^/]+)$/,
    handlerName: 'handleV2CpGetConfig',
    mapParams: ['key'],
    middleware: buildV2Middleware(),
  },
  {
    method: 'PUT',
    path: /^\/api\/v2\/config\/([^/]+)$/,
    handlerName: 'handleV2CpSetConfig',
    mapParams: ['key'],
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/config',
    handlerName: 'handleV2CpSetConfig',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/config/stall-detection',
    handlerName: 'handleV2CpConfigureStallDetection',
    middleware: buildV2Middleware(),
  },

  // Webhooks
  {
    method: 'GET',
    path: '/api/v2/webhooks',
    handlerName: 'handleV2CpListWebhooks',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/webhooks',
    handlerName: 'handleV2CpAddWebhook',
    middleware: buildV2Middleware(),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/webhooks\/([^/]+)$/,
    handlerName: 'handleV2CpRemoveWebhook',
    mapParams: ['webhook_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('webhook_id', 'webhook id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/webhooks\/([^/]+)\/test$/,
    handlerName: 'handleV2CpTestWebhook',
    mapParams: ['webhook_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('webhook_id', 'webhook id'),
    }),
  },

  // Validation
  {
    method: 'POST',
    path: '/api/v2/validation/verify-and-fix',
    handlerName: 'handleV2CpAutoVerifyAndFix',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/validation/conflicts',
    handlerName: 'handleV2CpDetectFileConflicts',
    middleware: buildV2Middleware(),
  },

  // ─── V2 Control-Plane: Analytics & Budget ─────────────────────────────

  {
    method: 'GET',
    path: '/api/v2/stats/overview',
    handlerName: 'handleV2CpStatsOverview',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/timeseries',
    handlerName: 'handleV2CpTimeSeries',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/quality',
    handlerName: 'handleV2CpQualityStats',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/stuck',
    handlerName: 'handleV2CpStuckTasks',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/models',
    handlerName: 'handleV2CpModelStats',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/format-success',
    handlerName: 'handleV2CpFormatSuccess',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/events',
    handlerName: 'handleV2CpEventHistory',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/webhooks',
    handlerName: 'handleV2CpWebhookStats',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/stats/notifications',
    handlerName: 'handleV2CpNotificationStats',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/analytics/throughput',
    handlerName: 'handleV2CpThroughputMetrics',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/budget/summary',
    handlerName: 'handleV2CpBudgetSummary',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/budget/status',
    handlerName: 'handleV2CpBudgetStatus',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/budget',
    handlerName: 'handleV2CpSetBudget',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/strategic/status',
    handlerName: 'handleV2CpStrategicStatus',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/strategic/decisions',
    handlerName: 'handleV2CpRoutingDecisions',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/strategic/provider-health',
    handlerName: 'handleV2CpProviderHealthCards',
    middleware: buildV2Middleware(),
  },

  // Free-tier
  {
    method: 'GET',
    path: '/api/v2/free-tier/status',
    handlerName: 'handleV2CpFreeTierStatus',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/free-tier/history',
    handlerName: 'handleV2CpFreeTierHistory',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/free-tier/auto-scale',
    handlerName: 'handleV2CpFreeTierAutoScale',
    middleware: buildV2Middleware(),
  },

  // Metrics
  {
    method: 'GET',
    path: '/api/v2/metrics/prometheus',
    handlerName: 'handleV2CpPrometheusMetrics',
    middleware: buildV2Middleware(),
  },

  // Strategic operations
  {
    method: 'GET',
    path: '/api/v2/strategic/operations',
    handlerName: 'handleV2CpStrategicOperations',
    middleware: buildV2Middleware(),
  },

  // Strategic Brain configuration
  { method: 'GET', path: '/api/v2/strategic/config', handlerName: 'handleV2CpStrategicConfigGet', middleware: buildV2Middleware() },
  { method: 'PUT', path: '/api/v2/strategic/config', handlerName: 'handleV2CpStrategicConfigSet', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/strategic/config/reset', handlerName: 'handleV2CpStrategicConfigReset', middleware: buildV2Middleware() },
  { method: 'GET', path: '/api/v2/strategic/templates', handlerName: 'handleV2CpStrategicTemplates', middleware: buildV2Middleware() },
  { method: 'GET', path: /^\/api\/v2\/strategic\/templates\/([^/]+)$/, handlerName: 'handleV2CpStrategicTemplateGet', mapParams: ['template_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_name', 'template name') }) },
  { method: 'POST', path: /^\/api\/v2\/strategic\/test\/([^/]+)$/, handlerName: 'handleV2CpStrategicTest', mapParams: ['capability'], middleware: buildV2Middleware({ params: validateDecodedParamField('capability', 'capability name') }) },

  // ─── V2 Control-Plane: Infrastructure ─────────────────────────────────

  // Workstations
  {
    method: 'GET',
    path: '/api/v2/workstations',
    handlerName: 'handleV2CpListWorkstations',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/workstations',
    handlerName: 'handleV2CpCreateWorkstation',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workstations\/([^/]+)\/probe$/,
    handlerName: 'handleV2CpProbeWorkstation',
    mapParams: ['workstation_name'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workstation_name', 'workstation name'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/workstations\/([^/]+)$/,
    handlerName: 'handleV2CpDeleteWorkstation',
    mapParams: ['workstation_name'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workstation_name', 'workstation name'),
    }),
  },

  // Ollama Hosts
  {
    method: 'GET',
    path: '/api/v2/hosts',
    handlerName: 'handleV2CpListHosts',
    middleware: buildV2Middleware(),
  },
  // Host activity (must be before /hosts/:id to avoid regex match)
  {
    method: 'GET',
    path: '/api/v2/hosts/activity',
    handlerName: 'handleV2CpHostActivity',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/hosts\/([^/]+)$/,
    handlerName: 'handleV2CpGetHost',
    mapParams: ['host_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_id', 'host id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/hosts\/([^/]+)\/toggle$/,
    handlerName: 'handleV2CpToggleHost',
    mapParams: ['host_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_id', 'host id'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/hosts\/([^/]+)$/,
    handlerName: 'handleV2CpDeleteHost',
    mapParams: ['host_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_id', 'host id'),
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/hosts/scan',
    handlerName: 'handleV2CpHostScan',
    middleware: buildV2Middleware(),
  },

  // Peek Hosts
  {
    method: 'GET',
    path: '/api/v2/peek-hosts',
    handlerName: 'handleV2CpListPeekHosts',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/peek-hosts',
    handlerName: 'handleV2CpCreatePeekHost',
    middleware: buildV2Middleware(),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/peek-hosts\/([^/]+)$/,
    handlerName: 'handleV2CpDeletePeekHost',
    mapParams: ['host_name'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_name', 'host name'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/peek-hosts\/([^/]+)\/toggle$/,
    handlerName: 'handleV2CpTogglePeekHost',
    mapParams: ['host_name'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_name', 'host name'),
    }),
  },

  // Host Credentials
  {
    method: 'GET',
    path: /^\/api\/v2\/hosts\/([^/]+)\/credentials$/,
    handlerName: 'handleV2CpListCredentials',
    mapParams: ['host_name'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_name', 'host name'),
    }),
  },
  {
    method: 'PUT',
    path: /^\/api\/v2\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,
    handlerName: 'handleV2CpSaveCredential',
    mapParams: ['host_name', 'credential_type'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_name', 'host name'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/hosts\/([^/]+)\/credentials\/(ssh|http_auth|windows)$/,
    handlerName: 'handleV2CpDeleteCredential',
    mapParams: ['host_name', 'credential_type'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_name', 'host name'),
    }),
  },

  // Remote Agents
  {
    method: 'GET',
    path: '/api/v2/agents',
    handlerName: 'handleV2CpListAgents',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/agents',
    handlerName: 'handleV2CpCreateAgent',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/agents\/([^/]+)$/,
    handlerName: 'handleV2CpGetAgent',
    mapParams: ['agent_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('agent_id', 'agent id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/agents\/([^/]+)\/health$/,
    handlerName: 'handleV2CpAgentHealth',
    mapParams: ['agent_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('agent_id', 'agent id'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/agents\/([^/]+)$/,
    handlerName: 'handleV2CpDeleteAgent',
    mapParams: ['agent_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('agent_id', 'agent id'),
    }),
  },

  // Coordination
  {
    method: 'GET',
    path: '/api/v2/coordination',
    handlerName: 'handleV2CpCoordinationDashboard',
    middleware: buildV2Middleware(),
  },

  // Host Management (new)
  {
    method: 'POST',
    path: '/api/v2/hosts',
    handlerName: 'handleV2CpAddHost',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/hosts\/([^/]+)\/refresh-models$/,
    handlerName: 'handleV2CpRefreshModels',
    mapParams: ['host_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('host_id', 'host id'),
    }),
  },

  // Workflows (legacy)
  { method: 'POST', path: '/api/workflows', tool: 'create_workflow', mapBody: true },
  { method: 'POST', path: /^\/api\/workflows\/([^/]+)\/run$/, tool: 'run_workflow', mapParams: ['workflow_id'] },

  // Workflows (extended)
  { method: 'GET', path: /^\/api\/workflows\/([^/]+)$/, tool: 'workflow_status', mapParams: ['workflow_id'] },
  { method: 'GET', path: '/api/workflows', tool: 'list_workflows', mapQuery: true },
  { method: 'POST', path: /^\/api\/workflows\/([^/]+)\/tasks$/, tool: 'add_workflow_task', mapParams: ['workflow_id'], mapBody: true },
  { method: 'POST', path: /^\/api\/workflows\/([^/]+)\/cancel$/, tool: 'cancel_workflow', mapParams: ['workflow_id'], mapBody: true },
  { method: 'POST', path: /^\/api\/workflows\/([^/]+)\/pause$/, tool: 'pause_workflow', mapParams: ['workflow_id'] },
  { method: 'POST', path: '/api/workflows/await', tool: 'await_workflow', mapBody: true },
  { method: 'POST', path: '/api/tasks/await', tool: 'await_task', mapBody: true },
  { method: 'POST', path: '/api/workflows/feature', tool: 'create_feature_workflow', mapBody: true },

  // Project scanning & config
  { method: 'POST', path: '/api/scan', tool: 'scan_project', mapBody: true },
  { method: 'POST', path: '/api/project/defaults', tool: 'set_project_defaults', mapBody: true },
  { method: 'GET', path: '/api/project/defaults', tool: 'get_project_defaults', mapQuery: true },

  // Automation & batch
  { method: 'POST', path: '/api/verify', tool: 'auto_verify_and_fix', mapBody: true },
  { method: 'POST', path: '/api/batch', tool: 'run_batch', mapBody: true },
  { method: 'POST', path: '/api/batch/full', tool: 'run_full_batch', mapBody: true },
  { method: 'POST', path: '/api/batch/commit', tool: 'auto_commit_batch', mapBody: true },
  { method: 'POST', path: /^\/api\/batch\/([^/]+)\/summary$/, tool: 'get_batch_summary', mapParams: ['workflow_id'] },
  { method: 'POST', path: '/api/batch/conflicts', tool: 'detect_file_conflicts', mapBody: true },
  { method: 'POST', path: '/api/tasks/generate-tests', tool: 'generate_test_tasks', mapBody: true },
  { method: 'POST', path: '/api/tasks/generate-feature', tool: 'generate_feature_tasks', mapBody: true },

  // Strategic orchestration tools
  { method: 'POST', path: '/api/tools/strategic_decompose', tool: 'strategic_decompose', mapBody: true },
  { method: 'POST', path: '/api/tools/strategic_diagnose', tool: 'strategic_diagnose', mapBody: true },
  { method: 'POST', path: '/api/tools/strategic_review', tool: 'strategic_review', mapBody: true },
  { method: 'POST', path: '/api/tools/strategic_benchmark', tool: 'strategic_benchmark', mapBody: true },

  // Task progress & changes
  { method: 'GET', path: /^\/api\/tasks\/([^/]+)\/progress$/, tool: 'get_progress', mapParams: ['task_id'] },
  { method: 'GET', path: /^\/api\/tasks\/([^/]+)\/changes$/, tool: 'task_changes', mapParams: ['task_id'] },
  { method: 'POST', path: /^\/api\/tasks\/([^/]+)\/commit$/, tool: 'commit_task', mapParams: ['task_id'], mapBody: true },

  // Remote Agents
  { method: 'POST', path: '/api/agents', tool: 'register_remote_agent', mapBody: true },
  { method: 'GET', path: '/api/agents', tool: 'list_remote_agents' },
  { method: 'DELETE', path: /^\/api\/agents\/([^/]+)$/, tool: 'remove_remote_agent', mapParams: ['agent_id'] },
  { method: 'GET', path: /^\/api\/agents\/([^/]+)\/health$/, tool: 'check_remote_agent_health', mapParams: ['agent_id'] },
  { method: 'GET', path: /^\/api\/agents\/([^/]+)$/, tool: 'get_remote_agent', mapParams: ['agent_id'] },

  // Stall detection
  { method: 'POST', path: '/api/stall-detection', tool: 'configure_stall_detection', mapBody: true },

  // Metrics (Phase 5)
  { method: 'GET', path: '/api/metrics', tool: 'export_metrics_prometheus' },

  // SnapScope
  { method: 'POST', path: '/api/snapscope/capture', tool: 'capture_screenshots', mapBody: true },
  { method: 'POST', path: '/api/snapscope/view', tool: 'capture_view', mapBody: true },
  { method: 'POST', path: '/api/snapscope/views', tool: 'capture_views', mapBody: true },
  { method: 'POST', path: '/api/snapscope/validate', tool: 'validate_manifest', mapBody: true },

  // Free-tier quota status (TDA-09: deprecated — use /api/v2/free-tier/* instead)
  { method: 'GET', path: '/api/free-tier/status', handlerName: 'handleGetFreeTierStatus', deprecated: '/api/v2/free-tier/status' },
  { method: 'GET', path: '/api/free-tier/history', handlerName: 'handleGetFreeTierHistory', deprecated: '/api/v2/free-tier/history' },
  { method: 'GET', path: '/api/free-tier/auto-scale', handlerName: 'handleGetFreeTierAutoScale', deprecated: '/api/v2/free-tier/auto-scale' },

  // Concurrency limits
  { method: 'GET', path: '/api/v2/concurrency', handlerName: 'handleV2CpGetConcurrencyLimits', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/concurrency/set', handlerName: 'handleV2CpSetConcurrencyLimit', middleware: buildV2Middleware() },
  { method: 'GET', path: '/api/v2/economy/status', handlerName: 'handleV2CpGetEconomyStatus', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/economy/set', handlerName: 'handleV2CpSetEconomyMode', middleware: buildV2Middleware() },

  // Routing templates
  { method: 'GET', path: '/api/v2/routing/templates', handlerName: 'handleV2CpListRoutingTemplates', middleware: buildV2Middleware() },
  { method: 'GET', path: /^\/api\/v2\/routing\/templates\/([^/]+)$/, handlerName: 'handleV2CpGetRoutingTemplate', mapParams: ['template_id'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_id', 'template id') }) },
  { method: 'POST', path: '/api/v2/routing/templates', handlerName: 'handleV2CpCreateRoutingTemplate', middleware: buildV2Middleware() },
  { method: 'PUT', path: /^\/api\/v2\/routing\/templates\/([^/]+)$/, handlerName: 'handleV2CpUpdateRoutingTemplate', mapParams: ['template_id'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_id', 'template id') }) },
  { method: 'DELETE', path: /^\/api\/v2\/routing\/templates\/([^/]+)$/, handlerName: 'handleV2CpDeleteRoutingTemplate', mapParams: ['template_id'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_id', 'template id') }) },
  { method: 'GET', path: '/api/v2/routing/active', handlerName: 'handleV2CpGetActiveRouting', middleware: buildV2Middleware() },
  { method: 'PUT', path: '/api/v2/routing/active', handlerName: 'handleV2CpSetActiveRouting', middleware: buildV2Middleware() },
  { method: 'GET', path: '/api/v2/routing/categories', handlerName: 'handleV2CpListCategories', middleware: buildV2Middleware() },

  // Provider API key management
  { method: 'PUT', path: /^\/api\/v2\/providers\/([^/]+)\/api-key$/, handlerName: 'handleV2CpSetProviderApiKey', mapParams: ['provider_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('provider_name', 'provider name') }) },
  { method: 'DELETE', path: /^\/api\/v2\/providers\/([^/]+)\/api-key$/, handlerName: 'handleV2CpClearProviderApiKey', mapParams: ['provider_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('provider_name', 'provider name') }) },

  // Model registry
  { method: 'GET', path: '/api/v2/models', handlerName: 'handleV2CpListModels', middleware: buildV2Middleware() },
  { method: 'GET', path: '/api/v2/models/pending', handlerName: 'handleV2CpListPendingModels', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/models/approve', handlerName: 'handleV2CpApproveModel', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/models/deny', handlerName: 'handleV2CpDenyModel', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/models/bulk-approve', handlerName: 'handleV2CpBulkApproveModels', middleware: buildV2Middleware() },

  // Shutdown — auth is handled inside handleShutdown (localhost bypass + key check)
  { method: 'POST', path: '/api/shutdown', handlerName: 'handleShutdown', skipAuth: true },

  // ─── Auto-generated tool passthrough routes (397 MCP tools) ─────────────────
  // Every MCP tool gets a semantic REST endpoint via handleToolCall() dispatch.
  // Generated by: node scripts/generate-rest-routes.js
  ...require('./routes-passthrough'),
];

module.exports = routes;
module.exports.buildV2Middleware = buildV2Middleware;
module.exports.validateDecodedParamField = validateDecodedParamField;
module.exports.handleOpenApiSpec = handleOpenApiSpec;
