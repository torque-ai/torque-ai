'use strict';
const logger = require('../logger').child({ component: 'routes' });

const providerRoutingCore = require('../db/provider-routing-core');
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

  // Claude Code Hook Bridge
  { method: 'POST', path: '/api/hooks/claude-event', handlerName: 'handleClaudeEvent' },
  { method: 'GET', path: '/api/hooks/claude-files', handlerName: 'handleClaudeFiles', mapQuery: true },

  // Providers
  { method: 'GET', path: '/api/providers', tool: 'list_providers' },
  { method: 'GET', path: '/api/provider-quotas', handlerName: 'handleGetProviderQuotas' },
  { method: 'GET', path: '/api/bootstrap/workstation', handlerName: 'handleBootstrapWorkstation', skipAuth: true },
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
        options: () => ({ defaultProvider: providerRoutingCore.getDefaultProvider?.() || null }),
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
    // NOTE: A second GET /api/v2/providers entry exists below as
    // handleV2CpListProviders (dashboard convergence CP handler).
    // The api-server.core.js dispatcher resolves handler names, so both
    // entries exist to serve legacy (inference API) and CP (dashboard) callers
    // via their respective handler names. This duplication is intentional.
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
    tool: 'retry_task',
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
    tool: 'workflow_history',
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
    tool: 'list_schedules',
    handlerName: 'handleV2CpListSchedules',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/schedules',
    tool: 'create_one_time_schedule',
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
    tool: 'toggle_schedule',
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
  {
    method: 'PUT',
    path: /^\/api\/v2\/schedules\/([^/]+)$/,
    handlerName: 'handleV2CpUpdateSchedule',
    mapParams: ['schedule_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('schedule_id', 'schedule id'),
    }),
  },

  // Policies
  {
    method: 'GET',
    path: '/api/v2/policies',
    tool: 'list_policies',
    handlerName: 'handleV2CpListPolicies',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/policies/evaluate',
    tool: 'evaluate_policies',
    handlerName: 'handleV2CpEvaluatePolicies',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/policies\/([^/]+)$/,
    tool: 'get_policy',
    handlerName: 'handleV2CpGetPolicy',
    mapParams: ['policy_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('policy_id', 'policy id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/policies\/([^/]+)\/mode$/,
    tool: 'set_policy_mode',
    handlerName: 'handleV2CpSetPolicyMode',
    mapParams: ['policy_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('policy_id', 'policy id'),
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/policy-evaluations',
    tool: 'list_policy_evaluations',
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
    tool: 'override_policy_decision',
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
    tool: 'list_plan_projects',
    handlerName: 'handleV2CpListPlanProjects',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/plan-projects/import',
    tool: 'import_plan',
    handlerName: 'handleV2CpImportPlan',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/plan-projects\/([^/]+)$/,
    tool: 'get_plan_project',
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
    tool: 'list_providers',
    handlerName: 'handleV2CpListProviders',
    middleware: buildV2Middleware(),
  },

  // Provider Stats & Toggle
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)\/stats$/,
    tool: 'provider_stats',
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
    tool: 'add_provider',
    handlerName: 'handleV2CpAddProvider',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/providers/remove',
    tool: 'remove_provider',
    handlerName: 'handleV2CpRemoveProvider',
    middleware: buildV2Middleware(),
  },

  // Provider percentiles
  {
    method: 'GET',
    path: /^\/api\/v2\/providers\/([^/]+)\/percentiles$/,
    tool: 'get_provider_percentiles',
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
    method: 'GET',
    path: '/api/v2/projects',
    tool: 'list_projects',
    handlerName: 'handleV2CpListProjects',
    middleware: buildV2Middleware(),
  },
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
    tool: 'list_webhooks',
    handlerName: 'handleV2CpListWebhooks',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/webhooks',
    tool: 'add_webhook',
    handlerName: 'handleV2CpAddWebhook',
    middleware: buildV2Middleware(),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/webhooks\/([^/]+)$/,
    tool: 'remove_webhook',
    handlerName: 'handleV2CpRemoveWebhook',
    mapParams: ['webhook_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('webhook_id', 'webhook id'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/webhooks\/([^/]+)\/test$/,
    tool: 'test_webhook',
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
    tool: 'webhook_stats',
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
    tool: 'set_budget',
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
    path: '/api/v2/quota/status',
    handlerName: 'handleV2CpQuotaStatus',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/quota/history',
    handlerName: 'handleV2CpQuotaHistory',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: '/api/v2/quota/auto-scale',
    handlerName: 'handleV2CpQuotaAutoScale',
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
  { method: 'GET', path: '/api/v2/strategic/config', tool: 'strategic_config_get', handlerName: 'handleV2CpStrategicConfigGet', middleware: buildV2Middleware() },
  { method: 'PUT', path: '/api/v2/strategic/config', tool: 'strategic_config_set', handlerName: 'handleV2CpStrategicConfigSet', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/strategic/config/reset', handlerName: 'handleV2CpStrategicConfigReset', middleware: buildV2Middleware() },
  { method: 'GET', path: '/api/v2/strategic/templates', tool: 'strategic_config_templates', handlerName: 'handleV2CpStrategicTemplates', middleware: buildV2Middleware() },
  { method: 'GET', path: /^\/api\/v2\/strategic\/templates\/([^/]+)$/, handlerName: 'handleV2CpStrategicTemplateGet', mapParams: ['template_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_name', 'template name') }) },
  { method: 'POST', path: /^\/api\/v2\/strategic\/test\/([^/]+)$/, handlerName: 'handleV2CpStrategicTest', mapParams: ['capability'], middleware: buildV2Middleware({ params: validateDecodedParamField('capability', 'capability name') }) },

  // ─── V2 Control-Plane: Infrastructure ─────────────────────────────────

  // Workstations
  {
    method: 'GET',
    path: '/api/v2/workstations',
    tool: 'list_workstations',
    handlerName: 'handleV2CpListWorkstations',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/workstations',
    tool: 'add_workstation',
    handlerName: 'handleV2CpCreateWorkstation',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workstations\/([^/]+)\/toggle$/,
    handlerName: 'handleV2CpToggleWorkstation',
    mapParams: ['workstation_name'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workstation_name', 'workstation name'),
    }),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/workstations\/([^/]+)\/probe$/,
    tool: 'probe_workstation',
    handlerName: 'handleV2CpProbeWorkstation',
    mapParams: ['workstation_name'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('workstation_name', 'workstation name'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/workstations\/([^/]+)$/,
    tool: 'remove_workstation',
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
    method: 'PATCH',
    path: /^\/api\/v2\/hosts\/([^/]+)$/,
    handlerName: 'handleV2CpUpdateHost',
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
    tool: 'list_peek_hosts',
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
    tool: 'list_remote_agents',
    handlerName: 'handleV2CpListAgents',
    middleware: buildV2Middleware(),
  },
  {
    method: 'POST',
    path: '/api/v2/agents',
    tool: 'register_remote_agent',
    handlerName: 'handleV2CpCreateAgent',
    middleware: buildV2Middleware(),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/agents\/([^/]+)$/,
    tool: 'get_remote_agent',
    handlerName: 'handleV2CpGetAgent',
    mapParams: ['agent_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('agent_id', 'agent id'),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/agents\/([^/]+)\/health$/,
    tool: 'check_remote_agent_health',
    handlerName: 'handleV2CpAgentHealth',
    mapParams: ['agent_id'],
    middleware: buildV2Middleware({
      params: validateDecodedParamField('agent_id', 'agent id'),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/v2\/agents\/([^/]+)$/,
    tool: 'remove_remote_agent',
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

  // Stall detection
  { method: 'POST', path: '/api/stall-detection', tool: 'configure_stall_detection', mapBody: true },

  // Metrics (Phase 5)
  { method: 'GET', path: '/api/metrics', tool: 'export_metrics_prometheus' },

  // SnapScope
  { method: 'POST', path: '/api/snapscope/capture', tool: 'capture_screenshots', mapBody: true },
  { method: 'POST', path: '/api/snapscope/view', tool: 'capture_view', mapBody: true },
  { method: 'POST', path: '/api/snapscope/views', tool: 'capture_views', mapBody: true },
  { method: 'POST', path: '/api/snapscope/validate', tool: 'validate_manifest', mapBody: true },

  // Free-tier quota status (TDA-09: deprecated — use /api/v2/quota/* instead)
  { method: 'GET', path: '/api/quota/status', handlerName: 'handleGetQuotaStatus', deprecated: '/api/v2/quota/status' },
  { method: 'GET', path: '/api/quota/history', handlerName: 'handleGetQuotaHistory', deprecated: '/api/v2/quota/history' },
  { method: 'GET', path: '/api/quota/auto-scale', handlerName: 'handleGetQuotaAutoScale', deprecated: '/api/v2/quota/auto-scale' },

  // Concurrency limits
  { method: 'GET', path: '/api/v2/concurrency', tool: 'get_concurrency_limits', handlerName: 'handleV2CpGetConcurrencyLimits', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/concurrency/set', tool: 'set_concurrency_limit', handlerName: 'handleV2CpSetConcurrencyLimit', middleware: buildV2Middleware() },
  // Economy mode removed — use routing templates (Cost Saver, Free Agentic) instead

  // Routing templates
  { method: 'GET', path: '/api/v2/routing/templates', tool: 'list_routing_templates', handlerName: 'handleV2CpListRoutingTemplates', middleware: buildV2Middleware() },
  { method: 'GET', path: /^\/api\/v2\/routing\/templates\/([^/]+)$/, tool: 'get_routing_template', handlerName: 'handleV2CpGetRoutingTemplate', mapParams: ['template_id'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_id', 'template id') }) },
  { method: 'POST', path: '/api/v2/routing/templates', tool: 'set_routing_template', handlerName: 'handleV2CpCreateRoutingTemplate', middleware: buildV2Middleware() },
  { method: 'PUT', path: /^\/api\/v2\/routing\/templates\/([^/]+)$/, tool: 'set_routing_template', handlerName: 'handleV2CpUpdateRoutingTemplate', mapParams: ['template_id'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_id', 'template id') }) },
  { method: 'DELETE', path: /^\/api\/v2\/routing\/templates\/([^/]+)$/, tool: 'delete_routing_template', handlerName: 'handleV2CpDeleteRoutingTemplate', mapParams: ['template_id'], middleware: buildV2Middleware({ params: validateDecodedParamField('template_id', 'template id') }) },
  { method: 'GET', path: '/api/v2/routing/active', tool: 'get_active_routing', handlerName: 'handleV2CpGetActiveRouting', middleware: buildV2Middleware() },
  { method: 'PUT', path: '/api/v2/routing/active', handlerName: 'handleV2CpSetActiveRouting', middleware: buildV2Middleware() },
  { method: 'GET', path: '/api/v2/routing/categories', handlerName: 'handleV2CpListCategories', middleware: buildV2Middleware() },

  // Provider API key management
  { method: 'PUT', path: /^\/api\/v2\/providers\/([^/]+)\/api-key$/, tool: 'set_provider_api_key', handlerName: 'handleV2CpSetProviderApiKey', mapParams: ['provider_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('provider_name', 'provider name') }) },
  { method: 'DELETE', path: /^\/api\/v2\/providers\/([^/]+)\/api-key$/, tool: 'clear_provider_api_key', handlerName: 'handleV2CpClearProviderApiKey', mapParams: ['provider_name'], middleware: buildV2Middleware({ params: validateDecodedParamField('provider_name', 'provider name') }) },

  // Model registry
  { method: 'GET', path: '/api/v2/models', tool: 'list_models', handlerName: 'handleV2CpListModels', middleware: buildV2Middleware() },
  { method: 'GET', path: '/api/v2/models/pending', tool: 'list_pending_models', handlerName: 'handleV2CpListPendingModels', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/models/approve', tool: 'approve_model', handlerName: 'handleV2CpApproveModel', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/models/deny', tool: 'deny_model', handlerName: 'handleV2CpDenyModel', middleware: buildV2Middleware() },
  { method: 'POST', path: '/api/v2/models/bulk-approve', tool: 'bulk_approve_models', handlerName: 'handleV2CpBulkApproveModels', middleware: buildV2Middleware() },

  // Auth: key management
  { method: 'POST', path: '/api/auth/keys', handlerName: 'handleCreateApiKey' },
  { method: 'GET', path: '/api/auth/keys', handlerName: 'handleListApiKeys' },
  { method: 'DELETE', path: /^\/api\/auth\/keys\/([^/]+)$/, handlerName: 'handleRevokeApiKey', mapParams: ['key_id'] },
  // Auth: dashboard login/logout (skipAuth — handlers validate credentials themselves)
  { method: 'POST', path: '/api/auth/login', handlerName: 'handleDashboardLogin', skipAuth: true },
  { method: 'POST', path: '/api/auth/logout', handlerName: 'handleDashboardLogout' },
  { method: 'POST', path: '/api/auth/setup', handlerName: 'handleSetup', skipAuth: true },
  { method: 'GET', path: '/api/auth/status', handlerName: 'handleAuthStatus', skipAuth: true },
  // Auth: user management (admin CRUD + self-service)
  { method: 'GET', path: '/api/auth/users', handlerName: 'handleListUsers' },
  { method: 'POST', path: '/api/auth/users', handlerName: 'handleCreateUser' },
  { method: 'PATCH', path: /^\/api\/auth\/users\/([^/]+)$/, handlerName: 'handleUpdateUser', mapParams: ['user_id'] },
  { method: 'DELETE', path: /^\/api\/auth\/users\/([^/]+)$/, handlerName: 'handleDeleteUser', mapParams: ['user_id'] },
  { method: 'GET', path: '/api/auth/me', handlerName: 'handleGetMe' },
  { method: 'PATCH', path: '/api/auth/me', handlerName: 'handleUpdateMe' },

  // Auth: ticket exchange (key → short-lived SSE ticket)
  { method: 'POST', path: '/api/auth/ticket', handlerName: 'handleCreateTicket' },
  { method: 'POST', path: '/api/auth/sse-ticket', handlerName: 'handleCreateSseTicket' },

  // Shutdown — auth is handled inside handleShutdown (localhost bypass + key check)
  { method: 'POST', path: '/api/shutdown', handlerName: 'handleShutdown', skipAuth: true },

  // ─── Auto-generated tool passthrough routes (410 MCP tools) ─────────────────
  // Every MCP tool gets a semantic REST endpoint via handleToolCall() dispatch.
  // Generated by: node scripts/generate-rest-routes.js
  ...require('./routes-passthrough'),
];

function createApiRoutes(_deps) {
  return { routes, buildV2Middleware, validateDecodedParamField, handleOpenApiSpec };
}

module.exports = routes;
module.exports.buildV2Middleware = buildV2Middleware;
module.exports.validateDecodedParamField = validateDecodedParamField;
module.exports.handleOpenApiSpec = handleOpenApiSpec;
module.exports.createApiRoutes = createApiRoutes;
