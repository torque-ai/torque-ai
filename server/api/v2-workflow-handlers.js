'use strict';

/**
 * V2 Control-Plane Workflow Handlers
 *
 * Structured JSON REST handlers for the workflow lifecycle.
 * These return { data, meta } envelopes — not MCP text blobs.
 */

const workflowEngine = require('../db/workflow-engine');
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

function syncWorkflowBlockers(workflowId) {
  if (!workflowId) return;
  try {
    const workflowRuntime = require('../execution/workflow-runtime');
    if (typeof workflowRuntime.refreshWorkflowBlockerSnapshots === 'function') {
      workflowRuntime.refreshWorkflowBlockerSnapshots(workflowId);
    }
  } catch {
    // Non-critical: detail endpoints should still respond even if blocker refresh is unavailable.
  }
}

function getWorkflowTaskListWithBlockers(workflowId, statusOverride = null) {
  syncWorkflowBlockers(workflowId);

  const status = statusOverride || workflowEngine.getWorkflowStatus(workflowId);
  const taskList = Array.isArray(status?.tasks) ? status.tasks : Object.values(status?.tasks || {});
  const persistedTasks = typeof workflowEngine.getWorkflowTasks === 'function'
    ? (workflowEngine.getWorkflowTasks(workflowId) || [])
    : [];
  const blockerByTaskId = new Map(
    persistedTasks.map((task) => [
      task.id,
      task?.context && typeof task.context === 'object' && !Array.isArray(task.context)
        ? task.context.workflow_blocker || null
        : null,
    ])
  );

  return {
    status,
    taskList: taskList.map((task) => ({
      ...task,
      blocker_snapshot: blockerByTaskId.has(task.id)
        ? blockerByTaskId.get(task.id)
        : (task.blocker_snapshot || null),
    })),
  };
}

function buildWorkflowDetailPayload(workflow, workflowId = workflow?.id) {
  const { taskList } = getWorkflowTaskListWithBlockers(workflowId);
  const detail = buildWorkflowDetailResponse(workflow, taskList);
  if (!detail) return null;
  return {
    ...detail,
    tasks: Array.isArray(detail.tasks)
      ? detail.tasks.map((task) => {
        const sourceTask = taskList.find((candidate) => candidate.id === task.id);
        return sourceTask
          ? { ...task, blocker_snapshot: sourceTask.blocker_snapshot || null }
          : task;
      })
      : [],
  };
}

// ─── POST /api/v2/workflows — Create workflow ────────────────────────────

async function handleCreateWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const name = (body.name || '').trim();
  if (!name) {
    return sendError(res, requestId, 'validation_error', 'name is required', 400, undefined, req);
  }
  if (name.length > 200) {
    return sendError(res, requestId, 'validation_error', 'name must be 200 characters or less', 400, undefined, req);
  }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return sendError(res, requestId, 'validation_error', 'tasks must be a non-empty array', 400, undefined, req);
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
      const workflow = workflowEngine.getWorkflow(workflowId);
      sendSuccess(
        res,
        requestId,
        buildWorkflowDetailPayload(
          workflow || { id: workflowId, name, status: 'pending' },
          workflowId
        ),
        201,
        req
      );
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
    if (typeof workflowEngine.reconcileStaleWorkflows === 'function') {
      workflowEngine.reconcileStaleWorkflows();
    }
  } catch { /* non-critical */ }

  const workflows = workflowEngine.listWorkflows({
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
    if (typeof workflowEngine.reconcileStaleWorkflows === 'function') {
      workflowEngine.reconcileStaleWorkflows(workflowId);
    }
  } catch { /* non-critical */ }

  const workflow = workflowEngine.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, buildWorkflowDetailPayload(workflow, workflowId), 200, req);
}

// ─── POST /api/v2/workflows/:workflow_id/run — Run workflow ──────────────

async function handleRunWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = workflowEngine.getWorkflow(workflowId);
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

    const updated = workflowEngine.getWorkflow(workflowId);
    sendSuccess(res, requestId, buildWorkflowDetailPayload(updated || workflow, workflowId), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/workflows/:workflow_id/cancel — Cancel workflow ────────

async function handleCancelWorkflow(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = workflowEngine.getWorkflow(workflowId);
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

    const updated = workflowEngine.getWorkflow(workflowId);
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

  const workflow = workflowEngine.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  const description = (body.task || body.task_description || '').trim();
  if (!description) {
    return sendError(res, requestId, 'validation_error', 'task or task_description is required', 400, undefined, req);
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

  const workflow = workflowEngine.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  try {
    const history = workflowEngine.getWorkflowHistory ? workflowEngine.getWorkflowHistory(workflowId) : [];
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
    return sendError(res, requestId, 'validation_error', 'feature_name is required', 400, undefined, req);
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
      const workflow = workflowEngine.getWorkflow(workflowId);
      sendSuccess(
        res,
        requestId,
        buildWorkflowDetailPayload(
          workflow || { id: workflowId, name: body.feature_name || body.name, status: 'pending' },
          workflowId
        ),
        201,
        req
      );
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

  const workflow = workflowEngine.getWorkflow(workflowId);
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
      workflowEngine.updateWorkflow(workflowId, { status: 'paused' });
    }

    const updated = workflowEngine.getWorkflow(workflowId);
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

  const workflow = workflowEngine.getWorkflow(workflowId);
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
      workflowEngine.updateWorkflow(workflowId, { status: 'running' });
    }

    const updated = workflowEngine.getWorkflow(workflowId);
    sendSuccess(res, requestId, buildWorkflowDetailPayload(updated || workflow, workflowId), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── GET /api/v2/workflows/:workflow_id/tasks — List workflow tasks ────────

async function handleGetWorkflowTasks(req, res) {
  const requestId = resolveRequestId(req);
  const workflowId = req.params?.workflow_id;

  const workflow = workflowEngine.getWorkflow(workflowId);
  if (!workflow) {
    return sendError(res, requestId, 'workflow_not_found', `Workflow not found: ${workflowId}`, 404, {}, req);
  }

  try {
    const { taskList } = getWorkflowTaskListWithBlockers(workflowId);
    const items = taskList.map(t => ({
      ...buildTaskResponse(t),
      node_id: t.node_id || null,
      depends_on: t.depends_on || null,
      blocker_snapshot: t.blocker_snapshot || null,
    })).filter(Boolean);

    sendList(res, requestId, items, items.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

function createV2WorkflowHandlers(_deps) {
  return {
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
  createV2WorkflowHandlers,
};
