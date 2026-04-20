/**
 * Integration plan project handlers.
 */

const projectConfigCore = require('../../db/project-config-core');
const taskCore = require('../../db/task-core');
const { isPathTraversalSafe, makeError, ErrorCodes } = require('../shared');
const { prependResumeContextToPrompt } = require('../../utils/resume-context');

// ============================================
// Plan Project Handlers
// ============================================

/**
 * Import tasks from a markdown plan file
 */
async function handleImportPlan(args) {
  try {
  
  const { file_path, project_name, dry_run = true, working_directory } = args;
  
  const fs = require('fs');
  const path = require('path');

  if (file_path && !isPathTraversalSafe(file_path)) {
    const invalidErr = makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
    return { ...invalidErr, error: invalidErr.content?.[0]?.text };
  }

  // Read the plan file
  if (!fs.existsSync(file_path)) {
    return { error: `Plan file not found: ${file_path}` };
  }

  const planContent = fs.readFileSync(file_path, 'utf8');
  const filename = path.basename(file_path, path.extname(file_path));
  const name = project_name || filename;

  // Parse the plan using AI
  const parsePrompt = `Analyze this project plan and extract individual tasks.

For each task, provide:
- seq: Sequential number (1, 2, 3...)
- description: Clear, actionable task description suitable for an AI coding agent
- depends_on: Array of seq numbers this task depends on (empty array [] if none)

Rules:
- Each task should be a single, focused action
- Dependencies should be explicit - if step 3 needs step 1's output, depends_on: [1]
- Tasks that can run in parallel should have no dependencies on each other
- Keep descriptions actionable and specific

Return ONLY valid JSON (no markdown, no explanation):
{
  "tasks": [
    { "seq": 1, "description": "...", "depends_on": [] },
    { "seq": 2, "description": "...", "depends_on": [1] }
  ]
}

Plan content:
${planContent}`;

  // Use Claude to parse (via Anthropic SDK)
  let parsedTasks;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: parsePrompt }]
    });

    const responseText = response.content[0].text;
    parsedTasks = JSON.parse(responseText);
  } catch (parseErr) {
    return { error: `Failed to parse plan: ${parseErr.message}` };
  }

  if (!parsedTasks.tasks || !Array.isArray(parsedTasks.tasks)) {
    return { error: 'Invalid parse result: missing tasks array' };
  }

  // Build task ID mapping (seq -> taskId)
  const taskIdMap = new Map();
  const tasksToCreate = [];

  for (const task of parsedTasks.tasks) {
    const taskId = require('crypto').randomUUID();
    taskIdMap.set(task.seq, taskId);
    tasksToCreate.push({
      id: taskId,
      seq: task.seq,
      description: task.description,
      depends_on_seqs: task.depends_on || []
    });
  }

  // Convert seq dependencies to task IDs
  for (const task of tasksToCreate) {
    task.depends_on = task.depends_on_seqs.map(seq => taskIdMap.get(seq)).filter(Boolean);
  }

  // Dry run - return preview
  if (dry_run) {
    return {
      dry_run: true,
      project_name: name,
      source_file: file_path,
      task_count: tasksToCreate.length,
      tasks: tasksToCreate.map(t => ({
        seq: t.seq,
        description: t.description,
        depends_on: t.depends_on_seqs,
        can_start_immediately: t.depends_on.length === 0
      })),
      message: 'Preview complete. Run with dry_run=false to create the project.'
    };
  }

  // Create the project
  const project = projectConfigCore.createPlanProject({
    name,
    source_file: file_path,
    total_tasks: tasksToCreate.length
  });

  // Create tasks and link to project
  for (const task of tasksToCreate) {
    // Determine initial status
    const canStart = task.depends_on.length === 0;
    const initialStatus = canStart ? 'queued' : 'waiting';

    taskCore.createTask({
      id: task.id,
      task_description: task.description,
      working_directory: working_directory || process.cwd(),
      status: initialStatus
    });

    projectConfigCore.addTaskToPlanProject(project.id, task.id, task.seq, task.depends_on);
  }

  return {
    success: true,
    project_id: project.id,
    project_name: name,
    total_tasks: tasksToCreate.length,
    queued: tasksToCreate.filter(t => t.depends_on.length === 0).length,
    waiting: tasksToCreate.filter(t => t.depends_on.length > 0).length,
    message: `Project created with ${tasksToCreate.length} tasks`
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * List all plan projects
 */
function handleListPlanProjects(args) {
  const projects = projectConfigCore.listPlanProjects({
    status: args.status,
    limit: args.limit || 20
  });

  return {
    projects: projects.map(p => ({
      ...p,
      progress: p.total_tasks > 0
        ? Math.round((p.completed_tasks / p.total_tasks) * 100)
        : 0
    })),
    count: projects.length
  };
}


/**
 * Get plan project details with tasks
 */
function handleGetPlanProject(args) {
  const { project_id } = args;

  const project = projectConfigCore.getPlanProject(project_id);
  if (!project) {
    return { error: 'Project not found' };
  }

  const tasks = projectConfigCore.getPlanProjectTasks(project_id);

  // Group by status
  const byStatus = {
    running: [],
    queued: [],
    waiting: [],
    blocked: [],
    completed: [],
    failed: []
  };

  for (const task of tasks) {
    if (byStatus[task.status]) {
      byStatus[task.status].push(task);
    }
  }

  return {
    ...project,
    progress: project.total_tasks > 0
      ? Math.round((project.completed_tasks / project.total_tasks) * 100)
      : 0,
    tasks,
    tasks_by_status: byStatus
  };
}


/**
 * Pause all tasks in a plan project
 */
function handlePausePlanProject(args) {
  const { project_id } = args;

  const project = projectConfigCore.getPlanProject(project_id);
  if (!project) {
    return { error: 'Project not found' };
  }

  const tasks = projectConfigCore.getPlanProjectTasks(project_id);
  let paused = 0;

  for (const task of tasks) {
    if (['queued', 'waiting'].includes(task.status)) {
      taskCore.updateTaskStatus(task.task_id, 'paused');
      paused++;
    }
  }

  projectConfigCore.updatePlanProject(project_id, { status: 'paused' });

  return {
    success: true,
    project_id,
    tasks_paused: paused
  };
}


/**
 * Resume a paused plan project
 */
function handleResumePlanProject(args) {
  const { project_id } = args;

  const project = projectConfigCore.getPlanProject(project_id);
  if (!project) {
    return { error: 'Project not found' };
  }

  const tasks = projectConfigCore.getPlanProjectTasks(project_id);
  let resumed = 0;

  for (const task of tasks) {
    if (task.status === 'paused') {
      // Check if dependencies are met
      if (projectConfigCore.areAllPlanDependenciesComplete(task.task_id)) {
        taskCore.updateTaskStatus(task.task_id, 'queued');
      } else if (projectConfigCore.hasFailedPlanDependency(task.task_id)) {
        taskCore.updateTaskStatus(task.task_id, 'blocked');
      } else {
        taskCore.updateTaskStatus(task.task_id, 'waiting');
      }
      resumed++;
    }
  }

  projectConfigCore.updatePlanProject(project_id, { status: 'active' });

  return {
    success: true,
    project_id,
    tasks_resumed: resumed
  };
}


/**
 * Retry all failed tasks in a plan project
 */
function handleRetryPlanProject(args) {
  const { project_id } = args;

  const project = projectConfigCore.getPlanProject(project_id);
  if (!project) {
    return { error: 'Project not found' };
  }

  const tasks = projectConfigCore.getPlanProjectTasks(project_id);
  let retried = 0;
  let unblocked = 0;

  // First, retry failed tasks
  for (const task of tasks) {
    if (task.status === 'failed') {
      const failedTask = typeof taskCore.getTask === 'function'
        ? taskCore.getTask(task.task_id)
        : null;
      const resumeFields = failedTask?.resume_context
        ? {
            resume_context: failedTask.resume_context,
            task_description: prependResumeContextToPrompt(failedTask.task_description, failedTask.resume_context),
          }
        : {};
      taskCore.updateTaskStatus(task.task_id, 'queued', {
        error_output: null,
        started_at: null,
        completed_at: null,
        ...resumeFields,
      });
      retried++;
    }
  }

  // Then, unblock tasks that were blocked by the failed tasks
  for (const task of tasks) {
    if (task.status === 'blocked') {
      // Check if dependencies are now okay (retried tasks are queued, not failed)
      if (!projectConfigCore.hasFailedPlanDependency(task.task_id)) {
        if (projectConfigCore.areAllPlanDependenciesComplete(task.task_id)) {
          taskCore.updateTaskStatus(task.task_id, 'queued');
        } else {
          taskCore.updateTaskStatus(task.task_id, 'waiting');
        }
        unblocked++;
      }
    }
  }

  // Update project status
  projectConfigCore.updatePlanProject(project_id, {
    status: 'active',
    failed_tasks: 0
  });

  return {
    success: true,
    project_id,
    tasks_retried: retried,
    tasks_unblocked: unblocked
  };
}


function createIntegrationPlansHandlers(_deps) {
  return {
    handleImportPlan,
    handleListPlanProjects,
    handleGetPlanProject,
    handlePausePlanProject,
    handleResumePlanProject,
    handleRetryPlanProject,
  };
}

module.exports = {
  handleImportPlan,
  handleListPlanProjects,
  handleGetPlanProject,
  handlePausePlanProject,
  handleResumePlanProject,
  handleRetryPlanProject,
  createIntegrationPlansHandlers,
};
