const factoryHandlers = require('../../handlers/factory-handlers');
const { sendError, sendSuccess } = require('../v2-control-plane');

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

  if (status >= 400) {
    return sendError(
      res,
      context.requestId,
      result?.errorCode || 'operation_failed',
      result?.errorMessage || 'Factory request failed',
      status,
      {},
      req
    );
  }

  return sendSuccess(res, context.requestId, parseFactoryHandlerPayload(result), status, req);
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
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/start$/, tool: 'start_factory_loop', mapParams: ['project'], mapBody: true },
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
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop\/batch$/, tool: 'attach_factory_batch', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/loop$/, tool: 'factory_loop_status', mapParams: ['project'] },
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
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/notifications$/, tool: 'factory_notifications', mapParams: ['project'], mapQuery: true },
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/notifications\/test$/, tool: 'factory_notifications', mapParams: ['project'], mapBody: true },
  { method: 'GET', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/digest$/, tool: 'factory_digest', mapParams: ['project'] },
];

module.exports = {
  FACTORY_V2_ROUTES,
};
