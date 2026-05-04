/**
 * Admin route handlers — coordination, approvals, schedules, benchmarks, tuning, plan projects.
 *
 * Merged from: coordination.js, approvals.js, schedules.js, benchmarks.js, project-tuning.js, plan-projects.js
 */
const taskCore = require('../../db/task-core');
const coordination = require('../../db/coordination');
const hostManagement = require('../../db/host/management');
const projectConfigCore = require('../../db/project-config-core');
const schedulingAutomation = require('../../db/scheduling-automation');
const validationRules = require('../../db/validation-rules');
const logger = require('../../logger');
const { sendJson, sendError, parseBody, safeDecodeParam } = require('../utils');

let _db = null;

function init(deps = {}) {
  if (deps.db) {
    _db = deps.db;
  }
  return module.exports;
}

function getDbService() {
  if (_db) {
    return _db;
  }
  throw new Error('dashboard admin routes require init({ db }) before running schedules');
}

// ── Coordination ────────────────────────────────────────────────────────

function handleGetDashboard(req, res, query) {
  const hours = parseInt(query.hours, 10) || 24;
  const dashboard = coordination.getCoordinationDashboard ? coordination.getCoordinationDashboard(hours) : {};
  sendJson(res, dashboard);
}

function handleListAgents(req, res) {
  const agents = coordination.listAgents ? coordination.listAgents() : [];
  sendJson(res, { agents });
}

function handleListRoutingRules(req, res) {
  const rules = coordination.listRoutingRules ? coordination.listRoutingRules() : [];
  sendJson(res, { rules });
}

function handleListClaims(req, res) {
  const claims = coordination.listClaims ? coordination.listClaims({ active_only: true }) : [];
  sendJson(res, { claims });
}

// ── Approvals ───────────────────────────────────────────────────────────

function handleListPendingApprovals(req, res, query) {
  const approvals = schedulingAutomation.listPendingApprovals ? schedulingAutomation.listPendingApprovals() : [];
  sendJson(res, { approvals });
}

function handleGetApprovalHistory(req, res, query) {
  const limit = parseInt(query.limit, 10) || 50;
  const history = schedulingAutomation.listApprovalHistory
    ? schedulingAutomation.listApprovalHistory({ limit })
    : (schedulingAutomation.getApprovalHistory ? schedulingAutomation.getApprovalHistory(limit) : []);
  sendJson(res, { history });
}

function handleApproveTask(req, res, query, approvalId) {
  if (!approvalId) { sendError(res, 'approval_id required', 400); return; }
  const workflowRequest = schedulingAutomation.getApprovalRequestById
    ? schedulingAutomation.getApprovalRequestById(approvalId)
    : null;
  const result = workflowRequest?.task_id
    ? schedulingAutomation.approveTask?.(workflowRequest.task_id, 'dashboard', null)
    : (validationRules.decideApproval ? validationRules.decideApproval(approvalId, 'approved', 'dashboard') : null);
  if (!result) { sendError(res, 'Approval not found', 404); return; }
  sendJson(res, { status: 'approved', approval_id: approvalId });
}

function handleRejectApproval(req, res, query, approvalId) {
  if (!approvalId) { sendError(res, 'approval_id required', 400); return; }
  const workflowRequest = schedulingAutomation.getApprovalRequestById
    ? schedulingAutomation.getApprovalRequestById(approvalId)
    : null;
  const result = workflowRequest?.task_id
    ? schedulingAutomation.rejectApproval?.(workflowRequest.task_id, 'dashboard', null)
    : (validationRules.decideApproval ? validationRules.decideApproval(approvalId, 'rejected', 'dashboard') : null);
  if (!result) { sendError(res, 'Approval not found', 404); return; }
  sendJson(res, { status: 'rejected', approval_id: approvalId });
}

// ── Schedules ───────────────────────────────────────────────────────────

function handleListSchedules(req, res) {
  const schedules = schedulingAutomation.listScheduledTasks();
  return sendJson(res, { schedules });
}

async function handleCreateSchedule(req, res) {
  const body = await parseBody(req);
  if (!body.name || !body.cron_expression || !body.task_description) {
    return sendError(res, 'name, cron_expression, and task_description are required', 400);
  }
  const schedule = schedulingAutomation.createCronScheduledTask(
    body.name,
    body.cron_expression,
    body.task_description,
    {
      provider: body.provider || null,
      model: body.model || null,
      working_directory: body.working_directory || null,
    }
  );
  return sendJson(res, schedule, 201);
}

async function handleToggleSchedule(req, res, query, id) {
  const body = await parseBody(req);
  const enabled = body.enabled !== undefined ? body.enabled : true;
  const result = schedulingAutomation.toggleScheduledTask(id, enabled);
  if (!result) return sendError(res, 'Schedule not found', 404);
  return sendJson(res, result);
}

function handleDeleteSchedule(req, res, query, id) {
  const result = schedulingAutomation.deleteScheduledTask(id);
  if (!result) return sendError(res, 'Schedule not found', 404);
  return sendJson(res, { deleted: true });
}

function handleRunSchedule(req, res, query, id) {
  try {
    const result = schedulingAutomation.runScheduledTaskNow(id, { db: getDbService() });
    if (!result) return sendError(res, 'Schedule not found', 404);
    return sendJson(res, result, 202);
  } catch (err) {
    logger.error({ err, schedule_id: id }, 'Failed to run schedule manually');
    return sendError(res, err.message || 'Failed to run schedule', 500);
  }
}

// ── Benchmarks & Tuning ─────────────────────────────────────────────────

function clampQueryInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseLimit(limit, fallback = 10) {
  return clampQueryInt(limit, 1, 1000, fallback);
}

function handleListBenchmarks(req, res, query) {
  const hostId = query.hostId;
  if (!hostId) return sendError(res, 'hostId is required', 400);
  const results = hostManagement.getBenchmarkResults(hostId, parseLimit(query?.limit, 10));
  const stats = hostManagement.getBenchmarkStats(hostId);
  return sendJson(res, { results, stats });
}

async function handleApplyBenchmark(req, res) {
  const body = await parseBody(req);
  if (!body.hostId) return sendError(res, 'hostId is required', 400);
  const result = hostManagement.applyBenchmarkResults(body.hostId, body.model);
  return sendJson(res, result);
}

function handleListProjectTuning(req, res) {
  const tunings = hostManagement.listProjectTuning();
  return sendJson(res, tunings);
}

async function handleCreateProjectTuning(req, res) {
  const body = await parseBody(req);
  if (!body.projectPath) return sendError(res, 'projectPath is required', 400);
  if (!body.settings) return sendError(res, 'settings is required', 400);
  hostManagement.setProjectTuning(body.projectPath, body.settings, body.description);
  return sendJson(res, { success: true });
}

function handleGetProjectTuning(req, res, query, projectPath) {
  const decodedPath = safeDecodeParam(projectPath, res);
  if (decodedPath === null) return;
  const tuning = hostManagement.getProjectTuning(decodedPath);
  if (!tuning) return sendError(res, 'Project tuning not found', 404);
  return sendJson(res, tuning);
}

function handleDeleteProjectTuning(req, res, query, projectPath) {
  const decodedPath = safeDecodeParam(projectPath, res);
  if (decodedPath === null) return;
  hostManagement.deleteProjectTuning(decodedPath);
  return sendJson(res, { success: true });
}

// ── Plan Projects ───────────────────────────────────────────────────────

/**
 * GET /api/plan-projects - List plan projects
 */
function handleListPlanProjects(req, res, query) {
  const projects = projectConfigCore.listPlanProjects({
    status: query.status,
    limit: parseInt(query.limit, 10) || 20
  });

  sendJson(res, {
    projects: projects.map(p => ({
      ...p,
      progress: p.total_tasks > 0
        ? Math.round((p.completed_tasks / p.total_tasks) * 100)
        : 0
    }))
  });
}

/**
 * GET /api/plan-projects/:id - Get plan project details
 */
function handleGetPlanProject(req, res, query, projectId) {
  const project = projectConfigCore.getPlanProject(projectId);
  if (!project) {
    sendError(res, 'Project not found', 404);
    return;
  }

  const tasks = projectConfigCore.getPlanProjectTasks(projectId);

  sendJson(res, {
    ...project,
    progress: project.total_tasks > 0
      ? Math.round((project.completed_tasks / project.total_tasks) * 100)
      : 0,
    tasks
  });
}

/**
 * POST /api/plan-projects/import - Import plan (preview or create)
 */
async function handleImportPlanApi(req, res) {
  try {
    const body = await parseBody(req);
    const { plan_content, project_name, dry_run = true, working_directory } = body;

    if (!plan_content) {
      sendError(res, 'plan_content is required');
      return;
    }

    // Write to temp file and use import handler
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const crypto = require('crypto');

    const tempFile = path.join(os.tmpdir(), `plan-${crypto.randomUUID()}.md`);
    fs.writeFileSync(tempFile, plan_content, { flag: 'wx' });

    try {
      // Import the tools module to use handleToolCall
      const { handleToolCall } = require('../../tools');
      let result;
      try {
        result = await handleToolCall('import_plan', {
          file_path: tempFile,
          project_name,
          dry_run,
          working_directory
        });
      } catch (toolErr) {
        logger.debug(`import_plan tool call failed: ${toolErr.message}`);
        sendError(res, toolErr.message, 500);
        return;
      }

      if (!result || typeof result !== 'object') {
        logger.debug(`import_plan tool call returned invalid result: ${JSON.stringify(result)}`);
        sendError(res, 'Invalid import tool response', 500);
        return;
      }

      if (result.error) {
        logger.debug(`import_plan tool call returned error: ${result.error}`);
        sendError(res, result.error, 400);
        return;
      }

      sendJson(res, result);
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (cleanupErr) {
        logger.debug(`Failed to delete temp plan import file ${tempFile}: ${cleanupErr.message}`);
      }
    }
  } catch (err) {
    sendError(res, err.message, 500);
  }
}

/**
 * POST /api/plan-projects/:id/:action - Plan project actions (pause, resume, retry)
 */
async function handlePlanProjectAction(req, res, query, projectId, action) {
  const project = projectConfigCore.getPlanProject(projectId);
  if (!project) {
    sendError(res, 'Project not found', 404);
    return;
  }

  const { handleToolCall } = require('../../tools');

  let result;
  switch (action) {
    case 'pause':
      result = await handleToolCall('pause_plan_project', { project_id: projectId });
      break;
    case 'resume':
      result = await handleToolCall('resume_plan_project', { project_id: projectId });
      break;
    case 'retry':
      result = await handleToolCall('retry_plan_project', { project_id: projectId });
      break;
    default:
      sendError(res, 'Unknown action', 400);
      return;
  }

  sendJson(res, result);
}

/**
 * DELETE /api/plan-projects/:id - Delete plan project
 */
function handleDeletePlanProject(req, res, query, projectId) {
  const project = projectConfigCore.getPlanProject(projectId);
  if (!project) {
    sendError(res, 'Project not found', 404);
    return;
  }

  // Cancel running tasks via task-manager (kills processes properly)
  const taskManager = require('../../task-manager');
  const tasks = projectConfigCore.getPlanProjectTasks(projectId);
  for (const task of tasks) {
    if (['queued', 'running', 'waiting'].includes(task.status)) {
      try {
        taskManager.cancelTask(task.task_id, 'Plan project deleted');
      } catch {
        taskCore.updateTaskStatus(task.task_id, 'cancelled', {
          error_output: 'Plan project deleted',
          cancel_reason: 'user',
        });
      }
    }
  }

  // Delete project and task associations
  projectConfigCore.deletePlanProject(projectId);

  sendJson(res, { success: true, message: 'Project deleted' });
}

function createDashboardAdminRoutes(deps = {}) {
  init(deps);
  return {
    handleGetDashboard, handleListAgents, handleListRoutingRules, handleListClaims,
    handleListPendingApprovals, handleGetApprovalHistory, handleApproveTask, handleRejectApproval,
    handleListSchedules, handleCreateSchedule, handleRunSchedule, handleToggleSchedule, handleDeleteSchedule,
    handleListBenchmarks, handleApplyBenchmark,
    handleListProjectTuning, handleCreateProjectTuning, handleGetProjectTuning, handleDeleteProjectTuning,
    handleListPlanProjects, handleGetPlanProject, handleImportPlanApi, handlePlanProjectAction, handleDeletePlanProject,
  };
}

module.exports = {
  init,
  // Coordination
  handleGetDashboard, handleListAgents, handleListRoutingRules, handleListClaims,
  // Approvals
  handleListPendingApprovals, handleGetApprovalHistory, handleApproveTask, handleRejectApproval,
  // Schedules
  handleListSchedules, handleCreateSchedule, handleRunSchedule, handleToggleSchedule, handleDeleteSchedule,
  // Benchmarks & Tuning
  handleListBenchmarks, handleApplyBenchmark,
  handleListProjectTuning, handleCreateProjectTuning, handleGetProjectTuning, handleDeleteProjectTuning,
  // Plan Projects
  handleListPlanProjects, handleGetPlanProject, handleImportPlanApi, handlePlanProjectAction, handleDeletePlanProject,
  createDashboardAdminRoutes,
};
