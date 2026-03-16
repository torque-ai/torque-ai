'use strict';

/**
 * V2 Control-Plane Workflow Handlers
 *
 * Structured JSON REST handlers for the workflow lifecycle.
 * These return { data, meta } envelopes — not MCP text blobs.
 */

const db = require('../database');
const {
  sendSuccess,
  sendError,
  sendList,
  resolveRequestId,
  buildWorkflowResponse,
  buildWorkflowDetailResponse,
  buildTaskResponse,
} = require('./v2-control-plane');
const { parseBody } = require('./middleware');

let _taskManager = null;

function init(taskManager) {
  _taskManager = taskManager;
}

// ─── POST /api/v2/workflows — Create workflow ────────────────────────────

async function handleCreateWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const name = (body.name || '').trim();
  if (!name) {
    return sendError(res, requestId, 'validation_error', 'name is required', 400);
  }
  if (name.length > 200) {
    return sendError(res, requestId, 'validation_error', 'name must be 200 characters or less', 400);
  }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return sendError(res, requestId, 'validation_error', 'tasks must be a non-empty array', 400);
  }

  try {
    // Delegate to MCP handler for task normalization + creation
    const workflowHandler = require('../handlers/workflow/index');
    const result = workflowHandler.handleCreateWorkflow({
      name,
      description: body.description,
      priority: body.priority,
      working_directory: body.working_directory,
      tasks: body.tasks,
    });

    if (result.isError || result.error_code) {
      const msg = result.content?.[0]?.text || result.message || 'Workflow creation failed';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    // Extract workflow ID from MCP response
    const text = result.content?.[0]?.text || '';
    const idMatch = text.match(/\*\*ID:\*\*\s*([a-f0-9-]+)/);
    const workflowId = idMatch ? idMatch[1] : null;

    if (workflowId) {
      const workflow = db.getWorkflow(workflowId);
      const status = db.getWorkflowStatus(workflowId);
      sendSuccess(res, requestId, buildWorkflowDetailResponse(
        workflow || { id: workflowId, name, status: 'pending' },
        status?.tasks || {}
      ), 201, req);
    } else {
      sendSuccess(res, requestId, { name, message: text }, 201, req);
    }
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── GET /api/v2/workflows — List workflows ─────────────────────────────

async function handleListWorkflows(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);

  try {
    if (typeof db.reconcileStaleWorkflows === 'function') {
      db.reconcileStaleWorkflows();
    }
  } catch { /* non-critical */ }

  const workflows = db.listWorkflows({
    status: query.status || undefined,
    limit,
  });

  const items = workflows.map(buildWorkflowResponse).filter(Boolean);
  sendList(res, requestId, items, items.length, req);
}

// ─── GET /api/v2/workflows/:workflow_id — Get workflow detail ────────────

async function handleGetWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  try {
    if (typeof db.reconcileStaleWorkflows === 'function') {
      db.reconcileStaleWorkflows(workflowId);
    }
  } catch { /* non-critical */ }

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  const status = db.getWorkflowStatus(workflowId);
  sendSuccess(res, requestId, buildWorkflowDetailResponse(
    workflow,
    status?.tasks || {}
  ), 200, req);
}

// ─── POST /api/v2/workflows/:workflow_id/run — Run workflow ──────────────

async function handleRunWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  if (workflow.status === 'running') {
    return sendError(res, requestId, 'invalid_status', 'Workflow is already running', 400, {}, req);
  }

  try {
    const workflowHandler = require('../handlers/workflow/index');
    const result = workflowHandler.handleRunWorkflow({ workflow_id: workflowId });

    if (result.isError || result.error_code) {
      const msg = result.content?.[0]?.text || 'Failed to run workflow';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const updated = db.getWorkflow(workflowId);
    const status = db.getWorkflowStatus(workflowId);
    sendSuccess(res, requestId, buildWorkflowDetailResponse(
      updated || workflow,
      status?.tasks || {}
    ), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/workflows/:workflow_id/cancel — Cancel workflow ────────

async function handleCancelWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  if (terminalStatuses.has(workflow.status)) {
    return sendSuccess(res, requestId, {
      workflow_id: workflowId,
      cancelled: false,
      status: workflow.status,
      reason: 'Workflow already in terminal state',
    }, 200, req);
  }

  try {
    const workflowHandler = require('../handlers/workflow/index');
    workflowHandler.handleCancelWorkflow({ workflow_id: workflowId });

    const updated = db.getWorkflow(workflowId);
    sendSuccess(res, requestId, {
      workflow_id: workflowId,
      cancelled: true,
      status: updated?.status || 'cancelled',
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/workflows/:workflow_id/tasks — Add task to workflow ────

async function handleAddWorkflowTask(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;
  const body = req.body || await parseBody(req);

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  const description = (body.task || body.task_description || '').trim();
  if (!description) {
    return sendError(res, requestId, 'validation_error', 'task or task_description is required', 400);
  }

  try {
    const workflowHandler = require('../handlers/workflow/index');
    const result = workflowHandler.handleAddWorkflowTask({
      workflow_id: workflowId,
      task: description,
      task_description: body.task_description,
      node_id: body.node_id,
      depends_on: body.depends_on,
      provider: body.provider,
      model: body.model,
      working_directory: body.working_directory || workflow.working_directory,
    });

    if (result.isError || result.error_code) {
      const msg = result.content?.[0]?.text || 'Failed to add task';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    // Extract task ID from response
    const text = result.content?.[0]?.text || '';
    const idMatch = text.match(/([a-f0-9]{8}-[a-f0-9-]+)/);
    const taskId = idMatch ? idMatch[1] : null;

    sendSuccess(res, requestId, {
      workflow_id: workflowId,
      task_id: taskId,
      description: description.slice(0, 200),
      added: true,
    }, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── GET /api/v2/workflows/:workflow_id/history — Workflow history ───────

async function handleWorkflowHistory(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  try {
    const history = db.getWorkflowHistory ? db.getWorkflowHistory(workflowId) : [];
    const events = Array.isArray(history) ? history : [];

    sendSuccess(res, requestId, {
      workflow_id: workflowId,
      events: events.map(e => ({
        timestamp: e.created_at || e.timestamp,
        event_type: e.event_type || e.type,
        task_id: e.task_id || null,
        old_status: e.old_value || null,
        new_status: e.new_value || null,
        details: e.event_data || e.details || null,
      })),
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/workflows/feature — Create feature workflow ────────────

async function handleCreateFeatureWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.feature_name && !body.name) {
    return sendError(res, requestId, 'validation_error', 'feature_name is required', 400);
  }

  try {
    const workflowHandler = require('../handlers/workflow/index');
    const createFeature = workflowHandler.handleCreateFeatureWorkflow || workflowHandler.handleFeatureWorkflow;
    if (!createFeature) {
      return sendError(res, requestId, 'not_implemented', 'Feature workflow creation not available', 501, {}, req);
    }

    const result = createFeature(body);

    if (result.isError || result.error_code) {
      const msg = result.content?.[0]?.text || 'Failed to create feature workflow';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const text = result.content?.[0]?.text || '';
    const idMatch = text.match(/([a-f0-9]{8}-[a-f0-9-]+)/);
    const workflowId = idMatch ? idMatch[1] : null;

    if (workflowId) {
      const workflow = db.getWorkflow(workflowId);
      const status = db.getWorkflowStatus(workflowId);
      sendSuccess(res, requestId, buildWorkflowDetailResponse(
        workflow || { id: workflowId, name: body.feature_name || body.name, status: 'pending' },
        status?.tasks || {}
      ), 201, req);
    } else {
      sendSuccess(res, requestId, { message: text }, 201, req);
    }
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/workflows/:workflow_id/pause — Pause workflow ────────────

async function handlePauseWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  if (workflow.status !== 'running') {
    return sendError(res, requestId, 'invalid_status', `Cannot pause workflow with status: ${workflow.status}`, 400, {}, req);
  }

  try {
    const workflowHandler = require('../handlers/workflow/index');
    if (typeof workflowHandler.handlePauseWorkflow === 'function') {
      workflowHandler.handlePauseWorkflow({ workflow_id: workflowId });
    } else {
      db.updateWorkflow(workflowId, { status: 'paused' });
    }

    const updated = db.getWorkflow(workflowId);
    sendSuccess(res, requestId, {
      workflow_id: workflowId,
      paused: true,
      status: updated?.status || 'paused',
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/workflows/:workflow_id/resume — Resume workflow ──────────

async function handleResumeWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  if (workflow.status !== 'paused') {
    return sendError(res, requestId, 'invalid_status', `Cannot resume workflow with status: ${workflow.status}`, 400, {}, req);
  }

  try {
    const workflowHandler = require('../handlers/workflow/index');
    if (typeof workflowHandler.handleResumeWorkflow === 'function') {
      workflowHandler.handleResumeWorkflow({ workflow_id: workflowId });
    } else {
      db.updateWorkflow(workflowId, { status: 'running' });
    }

    const updated = db.getWorkflow(workflowId);
    const status = db.getWorkflowStatus(workflowId);
    sendSuccess(res, requestId, buildWorkflowDetailResponse(
      updated || workflow,
      status?.tasks || {}
    ), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── GET /api/v2/workflows/:workflow_id/tasks — List workflow tasks ────────

async function handleGetWorkflowTasks(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  try {
    const status = db.getWorkflowStatus(workflowId);
    const tasks = status?.tasks || {};
    const taskList = Array.isArray(tasks) ? tasks : Object.values(tasks);

    const items = taskList.map(t => ({
      ...buildTaskResponse(t),
      node_id: t.node_id || null,
      depends_on: t.depends_on || null,
    })).filter(Boolean);

    sendList(res, requestId, items, items.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

module.exports = {
  init,
  handleCreateWorkflow,
  handleListWorkflows,
  handleGetWorkflow,
  handleRunWorkflow,
  handleCancelWorkflow,
  handleAddWorkflowTask,
  handleWorkflowHistory,
  handleCreateFeatureWorkflow,
  handlePauseWorkflow,
  handleResumeWorkflow,
  handleGetWorkflowTasks,
};
