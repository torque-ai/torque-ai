const factoryHandlers = require('../../handlers/factory-handlers');
const { parseBody } = require('../middleware');
const { sendError, sendSuccess } = require('../v2-control-plane');

const UUID_PATH_SEGMENT = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})';
const FACTORY_LOOP_INSTANCE_ROUTE = new RegExp(`^\\/api\\/v2\\/factory\\/loops\\/${UUID_PATH_SEGMENT}$`);
const FACTORY_LOOP_INSTANCE_ADVANCE_ROUTE = new RegExp(`^\\/api\\/v2\\/factory\\/loops\\/${UUID_PATH_SEGMENT}\\/advance$`);
const FACTORY_LOOP_INSTANCE_ADVANCE_JOB_ROUTE = new RegExp(`^\\/api\\/v2\\/factory\\/loops\\/${UUID_PATH_SEGMENT}\\/advance\\/${UUID_PATH_SEGMENT}$`);
const FACTORY_LOOP_INSTANCE_APPROVE_ROUTE = new RegExp(`^\\/api\\/v2\\/factory\\/loops\\/${UUID_PATH_SEGMENT}\\/approve$`);
const FACTORY_LOOP_INSTANCE_REJECT_ROUTE = new RegExp(`^\\/api\\/v2\\/factory\\/loops\\/${UUID_PATH_SEGMENT}\\/reject$`);
const FACTORY_LOOP_INSTANCE_RETRY_VERIFY_ROUTE = new RegExp(`^\\/api\\/v2\\/factory\\/loops\\/${UUID_PATH_SEGMENT}\\/retry-verify$`);
const FACTORY_LOOP_INSTANCE_TERMINATE_ROUTE = new RegExp(`^\\/api\\/v2\\/factory\\/loops\\/${UUID_PATH_SEGMENT}\\/terminate$`);

function parseFactoryHandlerPayload(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'structuredData')) {
    return result.structuredData;
  }

  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseFactoryHandlerErrorMessage(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    return 'Factory request failed';
  }

  const firstLine = text.split(/\r?\n/, 1)[0];
  const errorCode = result?.errorCode || result?.error_code || null;
  if (errorCode && firstLine.startsWith(`${errorCode}: `)) {
    return firstLine.slice(errorCode.length + 2);
  }

  return firstLine;
}

async function sendFactoryHandlerResponse(req, res, context, handler, args) {
  const result = await handler(args);
  const status = Number.isInteger(result?.status) ? result.status : 200;
  const headers = result?.headers && typeof result.headers === 'object' ? result.headers : null;

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        res.setHeader(key, value);
      }
    }
  }

  if (result?.isError || status >= 400) {
    return sendError(
      res,
      context.requestId,
      result?.errorCode || result?.error_code || 'operation_failed',
      result?.errorMessage || parseFactoryHandlerErrorMessage(result),
      status >= 400 ? status : 400,
      {},
      req
    );
  }

  return sendSuccess(res, context.requestId, parseFactoryHandlerPayload(result), status, req);
}

function coerceFactoryBoolean(value) {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return undefined;
}

async function readFactoryBody(req) {
  return Object.prototype.hasOwnProperty.call(req, 'body')
    ? req.body
    : parseBody(req);
}

async function sendFactoryRouteHandlerResponse(req, res, context, handler, buildArgs) {
  try {
    const args = await buildArgs();
    return sendFactoryHandlerResponse(req, res, context, handler, args);
  } catch (error) {
    return sendError(
      res,
      context.requestId,
      'invalid_request',
      error instanceof Error ? error.message : String(error),
      400,
      {},
      req,
    );
  }
}

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
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/github-poll$/, tool: 'poll_github_issues', mapParams: ['project'], mapBody: true },
  // Architect
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/architect$/, tool: 'trigger_architect', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/backlog$/, tool: 'architect_backlog', mapParams: ['project'], mapQuery: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/architect\/log$/, tool: 'architect_log', mapParams: ['project'], mapQuery: true },
  // Policy
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/policy$/, tool: 'get_project_policy', mapParams: ['project'] },
  { method: 'PUT', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/policy$/, tool: 'set_project_policy', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/guardrails$/, tool: 'guardrail_status', mapParams: ['project'] },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/guardrails\/check$/, tool: 'run_guardrail_check', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/guardrails\/events$/, tool: 'guardrail_events', mapParams: ['project'], mapQuery: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/reset$/, tool: 'reset_factory_loop', mapParams: ['project'] },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/start$/, tool: 'start_factory_loop', mapParams: ['project'], mapBody: true },
  {
    method: 'POST',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/await$/,
    tool: 'await_factory_loop',
    mapParams: ['project'],
    mapBody: true,
    handlerName: 'handleAwaitFactoryLoop',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleAwaitFactoryLoop,
      async () => {
        // NOTE: custom-handler routes do NOT auto-parse the body (see
        // api-server.core.js line 359) — we must parse it ourselves, otherwise
        // req.body is undefined and every param silently falls back to default.
        const body = await readFactoryBody(req);
        return {
          project: req.params.project,
          ...(body || {}),
        };
      },
    ),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/advance$/,
    mapParams: ['project'],
    handlerName: 'handleAdvanceFactoryLoopAsync',
    handler: async (req, res, context) => sendFactoryHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleAdvanceFactoryLoopAsync,
      { project: req.params.project }
    ),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/advance\/([^/]+)$/,
    mapParams: ['project', 'job_id'],
    handlerName: 'handleFactoryLoopJobStatus',
    handler: async (req, res, context) => sendFactoryHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleFactoryLoopJobStatus,
      { project: req.params.project, job_id: req.params.job_id }
    ),
  },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/approve$/, tool: 'approve_factory_gate', mapParams: ['project'], mapBody: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/retry-verify$/, tool: 'retry_factory_verify', mapParams: ['project'] },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/baseline-resume$/, tool: 'resume_project_baseline_fixed', mapParams: ['project'], mapBody: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/batch$/, tool: 'attach_factory_batch', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop$/, tool: 'factory_loop_status', mapParams: ['project'] },
  {
    method: 'GET',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loops$/,
    tool: 'list_factory_loop_instances',
    mapParams: ['project'],
    mapQuery: true,
    handlerName: 'handleListFactoryLoopInstances',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleListFactoryLoopInstances,
      async () => ({
        project: req.params.project,
        active_only: coerceFactoryBoolean(req.query?.active_only),
      }),
    ),
  },
  {
    method: 'GET',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/cycles$/,
    tool: 'factory_cycle_history',
    mapParams: ['project'],
    handlerName: 'handleFactoryCycleHistory',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleFactoryCycleHistory,
      async () => ({ project: req.params.project }),
    ),
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loops\/start$/,
    tool: 'start_factory_loop_instance',
    mapParams: ['project'],
    handlerName: 'handleStartFactoryLoopInstance',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleStartFactoryLoopInstance,
      async () => ({ project: req.params.project }),
    ),
  },
  {
    method: 'GET',
    path: FACTORY_LOOP_INSTANCE_ROUTE,
    tool: 'factory_loop_instance_status',
    mapParams: ['instance_id'],
    handlerName: 'handleFactoryLoopInstanceStatus',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleFactoryLoopInstanceStatus,
      async () => ({ instance: req.params.instance_id }),
    ),
  },
  {
    method: 'POST',
    path: FACTORY_LOOP_INSTANCE_ADVANCE_ROUTE,
    tool: 'advance_factory_loop_instance',
    mapParams: ['instance_id'],
    handlerName: 'handleAdvanceFactoryLoopInstanceAsync',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleAdvanceFactoryLoopInstanceAsync,
      async () => ({ instance: req.params.instance_id }),
    ),
  },
  {
    method: 'GET',
    path: FACTORY_LOOP_INSTANCE_ADVANCE_JOB_ROUTE,
    mapParams: ['instance_id', 'job_id'],
    handlerName: 'handleFactoryLoopInstanceJobStatus',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleFactoryLoopInstanceJobStatus,
      async () => ({
        instance: req.params.instance_id,
        job_id: req.params.job_id,
      }),
    ),
  },
  {
    method: 'POST',
    path: FACTORY_LOOP_INSTANCE_APPROVE_ROUTE,
    tool: 'approve_factory_gate_instance',
    mapParams: ['instance_id'],
    mapBody: true,
    handlerName: 'handleApproveFactoryGateInstance',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleApproveFactoryGateInstance,
      async () => {
        const body = await readFactoryBody(req);
        return { instance: req.params.instance_id, stage: body.stage };
      },
    ),
  },
  {
    method: 'POST',
    path: FACTORY_LOOP_INSTANCE_REJECT_ROUTE,
    tool: 'reject_factory_gate_instance',
    mapParams: ['instance_id'],
    mapBody: true,
    handlerName: 'handleRejectFactoryGateInstance',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleRejectFactoryGateInstance,
      async () => {
        const body = await readFactoryBody(req);
        return { instance: req.params.instance_id, stage: body.stage };
      },
    ),
  },
  {
    method: 'POST',
    path: FACTORY_LOOP_INSTANCE_RETRY_VERIFY_ROUTE,
    tool: 'retry_factory_verify_instance',
    mapParams: ['instance_id'],
    handlerName: 'handleRetryFactoryVerifyInstance',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleRetryFactoryVerifyInstance,
      async () => ({ instance: req.params.instance_id }),
    ),
  },
  {
    method: 'POST',
    path: FACTORY_LOOP_INSTANCE_TERMINATE_ROUTE,
    tool: 'terminate_factory_loop_instance',
    mapParams: ['instance_id'],
    handlerName: 'handleTerminateFactoryLoopInstance',
    handler: async (req, res, context) => sendFactoryRouteHandlerResponse(
      req,
      res,
      context,
      factoryHandlers.handleTerminateFactoryLoopInstance,
      async () => ({ instance: req.params.instance_id }),
    ),
  },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/analyze$/, tool: 'analyze_batch', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/drift$/, tool: 'factory_drift_status', mapParams: ['project'], mapQuery: true },
  {
    method: 'GET',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/costs$/,
    tool: 'factory_cost_metrics',
    mapParams: ['project'],
    v2StructuredResponse: true,
  },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/corrections$/, tool: 'record_correction', mapParams: ['project'], mapBody: true },
  // Observability
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/decisions$/, tool: 'decision_log', mapParams: ['project'], mapQuery: true },
  {
    method: 'GET',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/recovery_history$/,
    mapParams: ['project_id'],
    handlerName: 'handleRecoveryHistory',
    handler: async (req, res, context) => {
      try {
        const { getRecoveryHistory } = require('../../handlers/auto-recovery-handlers');
        const { defaultContainer: container } = require('../../container');
        const dbService = container.get('db');
        const rawDb = typeof dbService.getDbInstance === 'function' ? dbService.getDbInstance() : dbService;
        const limit = Number.parseInt(req.query.limit, 10) || 100;
        const result = getRecoveryHistory({ db: rawDb, project_id: req.params.project_id, limit });
        return sendSuccess(res, context.requestId, result, 200, req);
      } catch (err) {
        return sendError(
          res,
          context.requestId,
          'invalid_request',
          err instanceof Error ? err.message : String(err),
          400,
          {},
          req,
        );
      }
    },
  },
  {
    method: 'POST',
    path: /^\/api\/v2\/factory\/projects\/([^/]+)\/auto-recovery\/clear$/,
    mapParams: ['project_id'],
    handlerName: 'handleClearAutoRecovery',
    handler: async (req, res, context) => {
      try {
        const { clearAutoRecovery } = require('../../handlers/auto-recovery-handlers');
        const { defaultContainer: container } = require('../../container');
        const dbService = container.get('db');
        const rawDb = typeof dbService.getDbInstance === 'function' ? dbService.getDbInstance() : dbService;
        const result = clearAutoRecovery({ db: rawDb, project_id: req.params.project_id });
        return sendSuccess(res, context.requestId, result, 200, req);
      } catch (err) {
        return sendError(
          res,
          context.requestId,
          'invalid_request',
          err instanceof Error ? err.message : String(err),
          400,
          {},
          req,
        );
      }
    },
  },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/notifications$/, tool: 'factory_notifications', mapParams: ['project'], mapQuery: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/notifications\/test$/, tool: 'factory_notifications', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/digest$/, tool: 'factory_digest', mapParams: ['project'] },
];

module.exports = {
  parseFactoryHandlerPayload,
  sendFactoryHandlerResponse,
  FACTORY_V2_ROUTES,
};
