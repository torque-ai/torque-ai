/**
 * Task route handlers — CRUD, diff, logs, retry, cancel, approve/reject.
 *
 * All handlers follow the signature: (req, res, query, ...captures, context)
 * where context = { broadcastTaskUpdate, clients, serverPort }.
 */
const db = require('../../database');
const { sendJson, sendError, parseBody, enrichTaskWithHostName } = require('../utils');

/**
 * GET /api/tasks - List tasks with filtering and pagination
 */
function handleListTasks(req, res, query) {
  const page = parseInt(query.page) || 1;
  const limit = Math.min(parseInt(query.limit) || 25, 100);
  const offset = (page - 1) * limit;

  const filters = {};
  if (query.status === 'archived') {
    filters.archivedOnly = true;
  } else {
    if (query.status) filters.status = query.status;
  }
  if (query.provider) filters.provider = query.provider;
  if (query.search) filters.search = query.search;
  if (query.from) filters.from_date = query.from;
  if (query.to) filters.to_date = query.to;
  if (query.orderBy) filters.orderBy = query.orderBy;
  if (query.orderDir) filters.orderDir = query.orderDir;

  const tasks = db.listTasks({ ...filters, limit, offset }).map(enrichTaskWithHostName);
  const total = db.countTasks(filters);

  sendJson(res, {
    tasks,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

/**
 * GET /api/tasks/:id - Get task details
 */
function handleGetTask(req, res, query, taskId) {
  const task = db.getTask(taskId);
  if (!task) {
    sendError(res, 'Task not found', 404);
    return;
  }

  // Include streamed output chunks
  try {
    task.output_chunks = db.getStreamChunks(taskId);
  } catch { task.output_chunks = []; }

  enrichTaskWithHostName(task);
  sendJson(res, task);
}

/**
 * POST /api/tasks/:id/:action - Task actions (retry, cancel, approve-switch, reject-switch)
 */
async function handleTaskAction(req, res, query, taskId, action, context) {
  const { broadcastTaskUpdate } = context;
  const task = db.getTask(taskId);
  if (!task) {
    sendError(res, 'Task not found', 404);
    return;
  }

  switch (action) {
    case 'retry':
      if (task.status !== 'failed') {
        sendError(res, 'Can only retry failed tasks');
        return;
      }
      db.updateTaskStatus(taskId, 'queued', {
        error_output: null,
        started_at: null,
        completed_at: null,
      });
      broadcastTaskUpdate(taskId);
      sendJson(res, { success: true, message: 'Task requeued' });
      break;

    case 'cancel':
      if (!['queued', 'running'].includes(task.status)) {
        sendError(res, 'Can only cancel queued or running tasks');
        return;
      }
      try {
        const taskManager = require('../../task-manager');
        taskManager.cancelTask(taskId, 'Cancelled by user via dashboard');
      } catch (cancelErr) {
        db.updateTaskStatus(taskId, 'failed', {
          error_output: 'Cancelled by user via dashboard',
        });
      }
      broadcastTaskUpdate(taskId);
      sendJson(res, { success: true, message: 'Task cancelled' });
      break;

    case 'approve-switch':
      if (task.status !== 'pending_provider_switch') {
        sendError(res, 'Task is not pending provider switch');
        return;
      }
      {
        // Extract target provider from metadata (same logic as v2 handler)
        let metadata = {};
        try { metadata = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}); } catch { /* ignore */ }
        const targetProvider = metadata.provider_switch_target
          || metadata.target_provider
          || metadata.fallback_provider;
        db.approveProviderSwitch(taskId, targetProvider || undefined);
      }
      broadcastTaskUpdate(taskId);
      sendJson(res, { success: true, message: 'Provider switch approved' });
      break;

    case 'reject-switch':
      if (task.status !== 'pending_provider_switch') {
        sendError(res, 'Task is not pending provider switch');
        return;
      }
      db.rejectProviderSwitch(taskId, 'Rejected via dashboard');
      broadcastTaskUpdate(taskId);
      sendJson(res, { success: true, message: 'Provider switch rejected' });
      break;

    case 'remove':
      if (!['failed', 'cancelled', 'completed'].includes(task.status)) {
        sendError(res, 'Can only remove completed, failed, or cancelled tasks');
        return;
      }
      try {
        db.deleteTask(taskId);
        try {
          const dashboard = require('../../dashboard-server');
          dashboard.notifyTaskDeleted(taskId);
        } catch (_) { /* dashboard may not be running */ }
        sendJson(res, { success: true, message: 'Task removed' });
      } catch (err) {
        sendError(res, `Failed to remove task: ${err.message}`, 500);
      }
      break;

    default:
      sendError(res, 'Unknown action', 400);
  }
}

/**
 * POST /api/tasks/submit - Submit a new task via the dashboard.
 * Delegates to the smart_submit_task or submit_task MCP tool handler.
 */
async function handleSubmitTask(req, res, query, context) {
  const body = await parseBody(req);
  const { task, provider, model, working_directory } = body;

  if (!task || typeof task !== 'string' || !task.trim()) {
    return sendError(res, 'task is required and must be a non-empty string', 400);
  }

  // Build args for the tool call
  const args = { task: task.trim() };
  if (working_directory) args.working_directory = working_directory;

  // If provider is specified (not "auto"), use submit_task with explicit provider
  // Otherwise use smart_submit_task for automatic routing
  let toolName = 'smart_submit_task';
  if (provider && provider !== 'auto') {
    toolName = 'submit_task';
    args.provider = provider;
  }
  if (model) args.model = model;

  try {
    const tools = require('../../tools');
    const result = await tools.handleToolCall(toolName, args);
    if (result.isError) {
      const errorText = result.content?.[0]?.text || 'Task submission failed';
      return sendError(res, errorText, 400);
    }

    // Parse the MCP tool result text to extract task info
    const resultText = result.content?.[0]?.text || '';
    let parsed = {};
    try {
      parsed = JSON.parse(resultText);
    } catch {
      parsed = { raw: resultText };
    }

    // Broadcast the new task to WebSocket clients
    if (parsed.task_id && context?.broadcastTaskUpdate) {
      context.broadcastTaskUpdate(parsed.task_id);
    }

    sendJson(res, { success: true, ...parsed });
  } catch (err) {
    sendError(res, `Task submission failed: ${err.message}`, 500);
  }
}

/**
 * GET /api/tasks/:id/diff - Get diff preview for a task
 */
function handleTaskDiff(req, res, query, taskId) {
  const diff = db.getDiffPreview(taskId);
  return sendJson(res, diff || { diff_content: null, files_changed: 0, lines_added: 0, lines_removed: 0 });
}

/**
 * GET /api/tasks/:id/logs - Get task logs
 */
function handleTaskLogs(req, res, query, taskId) {
  const logs = db.getTaskLogs(taskId);
  return sendJson(res, logs);
}

module.exports = {
  handleListTasks,
  handleGetTask,
  handleTaskAction,
  handleSubmitTask,
  handleTaskDiff,
  handleTaskLogs,
};
