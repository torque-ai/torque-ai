'use strict';

/**
 * Workflow Runtime — extracted from task-manager.js
 *
 * Handles workflow lifecycle: plan project completion/failure,
 * pipeline step advancement, workflow dependency evaluation,
 * task unblocking, failure actions, and workflow completion checks.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger').child({ component: 'workflow-runtime' });
const serverConfig = require('../config');
const { resolveWorkflowConflicts } = require('./conflict-resolver');
const { safeJsonParse } = require('../utils/json');
const { stripAnsiEscapes } = require('../utils/sanitize');
const eventBus = require('../event-bus');

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

let db = null;
let _startTask = null;
let _cancelTask = null;
let _processQueue = null;
let _dashboard = null;
const terminalGuards = new Map(); // workflowId -> boolean
const terminalPending = new Map(); // workflowId -> Set of taskIds waiting for re-evaluation

/**
 * Initialize the module with required dependencies.
 * @param {Object} deps
 * @param {Object} deps.db          - Database instance (required)
 * @param {Function} deps.startTask  - Start a task by ID
 * @param {Function} deps.cancelTask - Cancel a task by ID + reason
 * @param {Function} deps.processQueue - Process the task queue
 * @param {Object} deps.dashboard    - Dashboard server (notifyTaskUpdated)
 */
function init(deps) {
  db = deps.db;
  serverConfig.init({ db: deps.db });
  if (deps.startTask) _startTask = deps.startTask;
  if (deps.cancelTask) _cancelTask = deps.cancelTask;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.dashboard) _dashboard = deps.dashboard;
}

// ---------------------------------------------------------------------------
// Local utilities (copied from task-manager.js to avoid circular deps)
// ---------------------------------------------------------------------------

const MAX_SANITIZE_LENGTH = 100000; // 100KB

// Patterns that may indicate secrets in output (used for sanitization)
// SECURITY: Patterns are designed to avoid catastrophic backtracking:
// - Use anchored/bounded quantifiers where possible
// - Limit repetition lengths to prevent ReDoS
// - Avoid nested quantifiers like (a+)+
const SECRET_PATTERNS = [
  /api[_-]?key[=:\s]+['"]?[\w-]{20,64}/gi,        // API keys (bounded length)
  /secret[=:\s]+['"]?[\w-]{16,128}/gi,             // Secrets (bounded length)
  /password[=:\s]+['"]?[^\s'"]{8,64}/gi,           // Passwords (bounded length)
  /bearer\s+[\w\-_.]{10,500}/gi,                   // Bearer tokens (bounded, safe chars)
  /authorization[=:\s]+['"]?[\w\-_.=+/]{10,500}/gi, // Auth headers (bounded, safe chars)
  /token[=:\s]+['"]?[\w-]{20,256}/gi,              // Tokens (bounded length)
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,  // Private keys (no quantifiers on groups)
  /aws[_-]?(?:access[_-]?key|secret)[=:\s]+['"]?[\w]{16,64}/gi  // AWS keys (bounded, no nested groups)
];

/**
 * Sanitize output text by redacting potential secrets.
 * SECURITY: Implements length limit to prevent ReDoS attacks.
 * @param {string} text - The text to sanitize
 * @returns {string} Sanitized text with secrets redacted
 */
function sanitizeOutputForCondition(text) {
  if (typeof text !== 'string') return '';

  // SECURITY: Limit input length to prevent ReDoS attacks
  // For very long strings, truncate before pattern matching
  const truncated = text.length > MAX_SANITIZE_LENGTH
    ? text.substring(0, MAX_SANITIZE_LENGTH) + '\n[OUTPUT TRUNCATED FOR SECURITY SCANNING]'
    : text;

  let sanitized = truncated;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns to ensure consistent behavior
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Safely read an integer config value with bounds clamping.
 * @param {string} configKey - Config key name
 * @param {number} defaultVal - Default value if missing
 * @param {number} [minVal=1] - Minimum allowed value
 * @param {number} [maxVal=1000] - Maximum allowed value
 * @returns {number}
 */
function _safeConfigInt(configKey, defaultVal, minVal = 1, maxVal = 1000) {
  const rawValue = serverConfig.get(configKey);
  if (rawValue === null || rawValue === undefined) return defaultVal;
  const parsed = parseInt(rawValue, 10);
  if (isNaN(parsed)) return defaultVal;
  return Math.max(minVal, Math.min(parsed, maxVal));
}

function isQueuedStartResult(result) {
  return Boolean(result && typeof result === 'object' && result.queued === true);
}

function resolveWorkflowNodeId(task, workflowId) {
  if (task?.workflow_node_id) return task.workflow_node_id;
  if (!workflowId || !task?.id || typeof db?.getWorkflowTasks !== 'function') return null;

  const workflowTasks = db.getWorkflowTasks(workflowId) || [];
  const match = workflowTasks.find((workflowTask) => workflowTask?.id === task.id);
  return match?.workflow_node_id || null;
}

// ---------------------------------------------------------------------------
// Plan Project Functions
// ---------------------------------------------------------------------------

/**
 * Handle plan project task completion — queue dependent tasks if ready.
 * When a task belonging to a plan project completes, this function:
 * 1. Increments the project's completed task count
 * 2. Unblocks dependent tasks whose prerequisites are now all complete
 * 3. Marks the project as completed if all tasks are done
 * @param {string} taskId - ID of the completed task
 */
function handlePlanProjectTaskCompletion(taskId) {
  const projectTask = db.getPlanProjectTask(taskId);
  if (!projectTask) return; // Not a plan project task

  const projectId = projectTask.project_id;

  // Atomic read-modify-write for completed_tasks counter
  const rawDb = db.getDbInstance ? db.getDbInstance() : db;
  const incrementCompleted = rawDb.transaction(() => {
    const project = db.getPlanProject(projectId);
    if (!project) return null;
    const newCount = (project.completed_tasks || 0) + 1;
    db.updatePlanProject(projectId, { completed_tasks: newCount });
    return { ...project, completed_tasks: newCount };
  });
  const project = incrementCompleted();
  if (!project) return;

  // Find tasks that depend on this one
  const dependentTaskIds = db.getDependentPlanTasks(taskId);

  for (const depTaskId of dependentTaskIds) {
    const depTask = db.getTask(depTaskId);
    if (!depTask || depTask.status !== 'waiting') continue;

    // Check if ALL dependencies are now complete
    if (db.areAllPlanDependenciesComplete(depTaskId)) {
      db.updateTaskStatus(depTaskId, 'queued');
      if (_dashboard) _dashboard.notifyTaskUpdated(depTaskId);
    }
  }

  // Check if project is complete
  const updatedProject = db.getPlanProject(projectId);
  if (!updatedProject) return;
  if (updatedProject.completed_tasks >= updatedProject.total_tasks) {
    db.updatePlanProject(projectId, {
      status: 'completed',
      completed_at: new Date().toISOString()
    });
  }
}

/**
 * Handle plan project task failure — block dependent tasks.
 * When a task belonging to a plan project fails, this function:
 * 1. Increments the project's failed task count
 * 2. Recursively blocks all transitive dependents (BFS)
 * 3. Marks the project as failed if no tasks can proceed
 * @param {string} taskId - ID of the failed task
 */
function handlePlanProjectTaskFailure(taskId) {
  const projectTask = db.getPlanProjectTask(taskId);
  if (!projectTask) return; // Not a plan project task

  const projectId = projectTask.project_id;

  // Atomic read-modify-write for failed_tasks counter
  const rawDb = db.getDbInstance ? db.getDbInstance() : db;
  const incrementFailed = rawDb.transaction(() => {
    const project = db.getPlanProject(projectId);
    if (!project) return null;
    const newCount = (project.failed_tasks || 0) + 1;
    db.updatePlanProject(projectId, { failed_tasks: newCount });
    return { ...project, failed_tasks: newCount };
  });
  const project = incrementFailed();
  if (!project) return;

  // Find and block dependent tasks (recursively)
  const toBlock = new Set();
  const queue = [taskId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const dependentTaskIds = db.getDependentPlanTasks(currentId);

    for (const depTaskId of dependentTaskIds) {
      if (toBlock.has(depTaskId)) continue;

      const depTask = db.getTask(depTaskId);
      if (depTask && ['waiting', 'queued'].includes(depTask.status)) {
        toBlock.add(depTaskId);
        queue.push(depTaskId); // Check transitive dependencies
      }
    }
  }

  // Block all dependent tasks
  for (const depTaskId of toBlock) {
    db.updateTaskStatus(depTaskId, 'blocked');
    if (_dashboard) _dashboard.notifyTaskUpdated(depTaskId);
  }

  // Check if project should be marked failed (no tasks can proceed)
  const tasks = db.getPlanProjectTasks(projectId);
  const canProceed = tasks.some(t =>
    ['queued', 'running', 'waiting'].includes(t.status)
  );

  if (!canProceed && project.completed_tasks < project.total_tasks) {
    db.updatePlanProject(projectId, { status: 'failed' });
  }
}

// ---------------------------------------------------------------------------
// Pipeline Functions
// ---------------------------------------------------------------------------

/**
 * Generate documentation for a completed pipeline.
 * Creates a markdown file in the working directory with execution details
 * including step statuses, durations, outputs, and file modifications.
 * @param {string} pipelineId - Pipeline ID
 * @param {string} finalStatus - Final pipeline status ('completed' or 'failed')
 */
function generatePipelineDocumentation(pipelineId, finalStatus) {
  try {
    const pipeline = db.getPipeline(pipelineId);
    if (!pipeline) {
      logger.info(`[Pipeline Doc] Pipeline ${pipelineId} not found`);
      return;
    }

    const steps = db.getPipelineSteps(pipelineId);
    const startTime = pipeline.started_at ? new Date(pipeline.started_at) : null;
    const endTime = new Date();
    const duration = startTime ? Math.round((endTime - startTime) / 1000) : 0;

    // Build markdown content
    let markdown = `# Pipeline Report: ${pipeline.name}\n\n`;
    markdown += `**Status:** ${finalStatus === 'completed' ? '\u2705 Completed' : '\u274C Failed'}\n`;
    markdown += `**Pipeline ID:** \`${pipelineId}\`\n`;
    markdown += `**Started:** ${startTime ? startTime.toISOString() : 'N/A'}\n`;
    markdown += `**Completed:** ${endTime.toISOString()}\n`;
    markdown += `**Duration:** ${duration}s\n\n`;

    if (pipeline.description) {
      markdown += `## Description\n\n${pipeline.description}\n\n`;
    }

    markdown += `## Steps\n\n`;
    markdown += `| # | Step | Status | Duration |\n`;
    markdown += `|---|------|--------|----------|\n`;

    for (const step of steps) {
      const task = step.task_id ? db.getTask(step.task_id) : null;
      let stepDuration = 'N/A';
      if (task && task.started_at && task.completed_at) {
        const stepStart = new Date(task.started_at);
        const stepEnd = new Date(task.completed_at);
        stepDuration = `${Math.round((stepEnd - stepStart) / 1000)}s`;
      }
      const statusIcon = step.status === 'completed' ? '\u2705' :
                         step.status === 'failed' ? '\u274C' :
                         step.status === 'running' ? '\uD83D\uDD04' : '\u23F8\uFE0F';
      markdown += `| ${step.step_order} | ${step.name} | ${statusIcon} ${step.status} | ${stepDuration} |\n`;
    }

    markdown += `\n## Step Details\n\n`;

    for (const step of steps) {
      markdown += `### Step ${step.step_order}: ${step.name}\n\n`;
      markdown += `**Task Template:** ${step.task_template}\n\n`;

      const task = step.task_id ? db.getTask(step.task_id) : null;
      if (task) {
        markdown += `**Task ID:** \`${task.id}\`\n`;
        markdown += `**Exit Code:** ${task.exit_code ?? 'N/A'}\n\n`;

        if (task.output && task.output.trim()) {
          const outputPreview = task.output.slice(-2000);
          markdown += `<details>\n<summary>Output (last 2000 chars)</summary>\n\n\`\`\`\n${outputPreview}\n\`\`\`\n</details>\n\n`;
        }

        if (task.error_output && task.error_output.trim()) {
          const errorPreview = task.error_output.slice(-1000);
          markdown += `<details>\n<summary>Error Output (last 1000 chars)</summary>\n\n\`\`\`\n${errorPreview}\n\`\`\`\n</details>\n\n`;
        }

        if (task.files_modified && task.files_modified.length > 0) {
          let files = [];

          if (typeof task.files_modified === 'string') {
            try {
              files = JSON.parse(task.files_modified);
            } catch (err) {
              logger.debug(`[Pipeline Doc] Failed to parse files_modified JSON for task ${task.id}: ${err.message}`);
              files = [];
            }
          } else {
            files = task.files_modified;
          }

          if (!Array.isArray(files)) {
            files = [];
          }

          if (files.length > 0) {
            markdown += `**Files Modified:**\n`;
            for (const file of files.slice(0, 20)) {
              markdown += `- \`${file}\`\n`;
            }
            if (files.length > 20) {
              markdown += `- ... and ${files.length - 20} more\n`;
            }
            markdown += `\n`;
          }
        }
      } else {
        markdown += `*Step not executed*\n\n`;
      }
    }

    if (finalStatus === 'failed' && pipeline.error) {
      markdown += `## Error\n\n\`\`\`\n${pipeline.error}\n\`\`\`\n\n`;
    }

    markdown += `---\n*Generated by TORQUE at ${endTime.toISOString()}*\n`;

    // Determine output directory
    const outputDir = pipeline.working_directory || process.cwd();
    const torqueDir = path.join(outputDir, '.torque', 'pipeline-reports');

    // Create directory if it doesn't exist
    if (!fs.existsSync(torqueDir)) {
      fs.mkdirSync(torqueDir, { recursive: true });
    }

    // Generate filename with timestamp
    const timestamp = endTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = pipeline.name.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 50);
    const filename = `${safeName}-${timestamp}.md`;
    const filepath = path.join(torqueDir, filename);

    fs.writeFileSync(filepath, markdown, 'utf8');
    logger.info(`[Pipeline Doc] Generated documentation: ${filepath}`);

    // Record event with doc path
    db.recordEvent('pipeline_documented', pipelineId, {
      name: pipeline.name,
      doc_path: filepath,
      status: finalStatus
    });

  } catch (err) {
    logger.info(`[Pipeline Doc] Failed to generate documentation: ${err.message}`);
  }
}

/**
 * Handle pipeline step completion — advance to next step or mark pipeline complete.
 * When a pipeline step's task finishes, this function:
 * 1. Updates the step status (completed/failed)
 * 2. If completed, creates and starts the next step's task (with ${prev_output} substitution)
 * 3. If failed, marks the entire pipeline as failed
 * 4. Generates pipeline documentation on completion or failure
 * @param {string} taskId - ID of the completed/failed task
 * @param {string} status - Task status ('completed' or 'failed')
 */
function handlePipelineStepCompletion(taskId, status) {
  const task = db.getTask(taskId);

  // Debug logging
  logger.info(`[Pipeline] Checking task ${taskId} for pipeline context`);
  logger.info(`[Pipeline] Task context: ${JSON.stringify(task?.context)}`);

  if (!task || !task.context || !task.context.pipeline_id) {
    logger.info(`[Pipeline] Task ${taskId} is not a pipeline task (no context.pipeline_id)`);
    return; // Not a pipeline task
  }

  const pipelineId = task.context.pipeline_id;
  const stepId = task.context.step_id;

  logger.info(`[Pipeline] Task ${taskId} belongs to pipeline ${pipelineId}, step ${stepId}`);

  const pipeline = db.getPipeline(pipelineId);
  if (!pipeline) {
    logger.info(`[Pipeline] ERROR: Pipeline ${pipelineId} not found!`);
    return;
  }

  logger.info(`[Pipeline] Found pipeline: ${pipeline.name}, current_step: ${pipeline.current_step}, status: ${pipeline.status}`);

  // Update the current step status
  const stepStatus = status === 'completed' ? 'completed' : 'failed';
  try {
    db.updatePipelineStep(stepId, {
      status: stepStatus,
      task_id: taskId
    });
    logger.info(`[Pipeline] Updated step ${stepId} status to: ${stepStatus}`);
  } catch (err) {
    logger.info(`[Pipeline] ERROR updating step ${stepId}:`, err.message);
  }

  logger.info(`[Pipeline] Task ${taskId} is part of pipeline ${pipelineId}, step ${stepId}`);
  logger.info(`[Pipeline] Step status updated to: ${stepStatus}`);

  if (status === 'completed') {
    // Check for next step
    const nextStep = db.getNextPipelineStep(pipelineId);
    logger.info(`[Pipeline] Next step: ${nextStep ? nextStep.name : 'none (pipeline complete)'}`);

    if (nextStep) {
      // Start next step
      let taskDescription = nextStep.task_template;

      // Pass output from previous step if configured (${prev_output} variable)
      if (task.output && taskDescription.includes('${prev_output}')) {
        // Limit output size to prevent huge task descriptions
        const prevOutput = task.output.slice(-5000);
        taskDescription = taskDescription.replace(/\$\{prev_output\}/g, () => prevOutput);
      }

      const newTaskId = uuidv4();
      db.createTask({
        id: newTaskId,
        status: 'pending',
        task_description: taskDescription,
        working_directory: pipeline.working_directory,
        timeout_minutes: nextStep.timeout_minutes,
        context: { pipeline_id: pipelineId, step_id: nextStep.id }
      });

      db.updatePipelineStatus(pipelineId, 'running', { current_step: nextStep.step_order });

      logger.info(`[Pipeline] Created task ${newTaskId} for step ${nextStep.step_order}: ${nextStep.name}`);

      // Start the next task
      try {
        const startResult = _startTask(newTaskId);
        const stepStatus = isQueuedStartResult(startResult) ? 'queued' : 'running';
        db.updatePipelineStep(nextStep.id, { task_id: newTaskId, status: stepStatus });
        logger.info(`[Pipeline] ${stepStatus === 'queued' ? 'Queued' : 'Started'} task ${newTaskId} for step ${nextStep.step_order}`);
      } catch (err) {
        logger.info(`[Pipeline] Failed to start pipeline step ${nextStep.step_order}:`, err.message);
        db.updatePipelineStatus(pipelineId, 'failed', { error: err.message });
      }
    } else {
      // No more steps - pipeline completed
      logger.info(`[Pipeline] Pipeline ${pipelineId} completed successfully`);
      db.updatePipelineStatus(pipelineId, 'completed');
      db.recordEvent('pipeline_completed', pipelineId, { name: pipeline.name });
      generatePipelineDocumentation(pipelineId, 'completed');
      if (_dashboard && _dashboard.notifyStatsUpdated) _dashboard.notifyStatsUpdated();
    }
  } else {
    // Step failed - mark pipeline as failed
    db.updatePipelineStatus(pipelineId, 'failed', {
      error: `Step ${task.context.step_id} failed: ${task.error_output?.slice(0, 500) || 'Unknown error'}`
    });
    db.recordEvent('pipeline_failed', pipelineId, { name: pipeline.name, step_id: stepId });
    generatePipelineDocumentation(pipelineId, 'failed');
    if (_dashboard && _dashboard.notifyStatsUpdated) _dashboard.notifyStatsUpdated();
  }
}

// ---------------------------------------------------------------------------
// Output Injection Helpers
// ---------------------------------------------------------------------------

const OUTPUT_CAP_BYTES = 5120; // 5KB cap for injected outputs

function sanitizeInjectedOutput(text, maxLen = 5000) {
  if (!text) return '';
  let sanitized = String(text).slice(0, maxLen);
  // Escape template delimiters to prevent re-injection.
  // NOTE: `{{` is replaced with `{ {` (space-separated) so injected output cannot
  // accidentally trigger another round of {{node_id.field}} template substitution.
  // This is intentional: the space breaks the `{{word.word}}` pattern the regex matches.
  sanitized = sanitized.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
  sanitized = stripAnsiEscapes(sanitized);
  // Strip remaining control characters but keep \n, \r, and \t for readability.
  return [...sanitized]
    .filter((char) => {
      if (char === '\n' || char === '\r' || char === '\t') return true;
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
}

/**
 * Replace {{node_id.output}}, {{node_id.error_output}}, {{node_id.exit_code}}
 * template variables in a task description with actual values from completed
 * dependency tasks.
 * @param {string} description - Task description potentially containing template vars
 * @param {Object} depTasks - Map of node_id -> { output, error_output, exit_code }
 * @returns {string} Transformed description
 */
function injectDependencyOutputs(description, depTasks) {
  if (!description || typeof description !== 'string') return description || '';
  if (!depTasks || typeof depTasks !== 'object') return description;

  return description.replace(/\{\{([\w-]+)\.(output|error_output|exit_code)\}\}/g, (match, nodeId, field) => {
    const dep = depTasks[nodeId];
    if (!dep) {
      return `[ERROR: output unavailable from node '${nodeId}' — dependency missing or failed]`;
    }

    if (field === 'exit_code') {
      const exitCode = dep.exit_code !== undefined && dep.exit_code !== null ? dep.exit_code : 0;
      return sanitizeInjectedOutput(String(exitCode), OUTPUT_CAP_BYTES);
    }

    const rawValue = dep[field];
    // For failed/cancelled dependencies that produced no output, inject a clear placeholder
    // so downstream tasks know the dependency ran but produced nothing (vs. template not resolved).
    if ((rawValue === null || rawValue === undefined || rawValue === '') && dep.status && !['completed', 'skipped'].includes(dep.status)) {
      return `[no output — dependency '${nodeId}' ${dep.status || 'did not complete'}]`;
    }
    return sanitizeInjectedOutput(rawValue ?? '', OUTPUT_CAP_BYTES);
  });
}

/**
 * Prepend a "Prior step results:" section to a task description with outputs
 * from specified dependency nodes.
 * @param {string} description - Original task description
 * @param {string[]} contextFrom - Array of node_ids whose outputs to inject
 * @param {Object} depTasks - Map of node_id -> { output, error_output, exit_code }
 * @returns {string} Transformed description with prepended context
 */
function applyContextFrom(description, contextFrom, depTasks) {
  if (!description || typeof description !== 'string') return description || '';
  if (!Array.isArray(contextFrom) || contextFrom.length === 0) return description;
  if (!depTasks || typeof depTasks !== 'object') return description;

  const sections = [];
  for (const nodeId of contextFrom) {
    const dep = depTasks[nodeId];
    if (!dep) continue;

    const output = sanitizeInjectedOutput(dep.output ?? '', OUTPUT_CAP_BYTES);
    if (output) {
      sections.push(`### ${nodeId}\n${output}`);
    }
  }

  if (sections.length === 0) return description;

  return `Prior step results:\n\n${sections.join('\n\n')}\n\n---\n\n${description}`;
}

/**
 * Build the depTasks map from workflow tasks keyed by node_id.
 * @param {string} workflowId - Workflow ID
 * @param {string} taskId - The task being unblocked (to find its dependencies)
 * @returns {Object} Map of node_id -> { output, error_output, exit_code }
 */
function buildDepTasksMap(workflowId, taskId) {
  const depTasks = {};
  const allDeps = db.getTaskDependencies(taskId);
  const workflowTasks = db.getWorkflowTasks(workflowId);

  // Build a taskId -> node_id map
  const taskIdToNodeId = {};
  for (const wt of workflowTasks) {
    if (wt.workflow_node_id) {
      taskIdToNodeId[wt.id] = wt.workflow_node_id;
    }
  }

  for (const dep of allDeps) {
    const prereqId = dep.depends_on_task_id;
    const nodeId = taskIdToNodeId[prereqId];
    if (!nodeId) continue;

    // dep already has depends_on_output, depends_on_error_output, depends_on_exit_code,
    // and depends_on_status from the JOIN.
    depTasks[nodeId] = {
      output: dep.depends_on_output || '',
      error_output: dep.depends_on_error_output || '',
      exit_code: dep.depends_on_exit_code !== undefined ? dep.depends_on_exit_code : 0,
      status: dep.depends_on_status || null,
    };
  }

  return depTasks;
}

/**
 * Apply output injection to a task's description before unblocking it.
 * Handles both {{node_id.field}} template replacement and context_from prepending.
 * @param {string} taskId - Task ID to transform
 * @param {string} workflowId - Workflow ID
 */
function applyOutputInjection(taskId, workflowId) {
  const task = db.getTask(taskId);
  if (!task || !task.workflow_id) return;

  const depTasks = buildDepTasksMap(workflowId, taskId);
  if (Object.keys(depTasks).length === 0) return;

  let description = task.task_description;

  // Apply template variable injection
  description = injectDependencyOutputs(description, depTasks);

  // Apply context_from if stored in metadata
  let contextFrom = null;
  if (task.metadata) {
    try {
      const meta = typeof task.metadata === 'string' ? safeJsonParse(task.metadata, {}) : task.metadata;
      if (Array.isArray(meta.context_from)) {
        contextFrom = meta.context_from;
      }
    } catch {
      // Invalid metadata JSON — skip
    }
  }

  if (contextFrom) {
    description = applyContextFrom(description, contextFrom, depTasks);
  }

  // Only update if description actually changed
  if (description !== task.task_description) {
    // Use raw DB update to avoid triggering status transition guards
    const rawDb = db.getDbInstance ? db.getDbInstance() : db.getDb ? db.getDb() : null;
    if (rawDb) {
      rawDb.prepare('UPDATE tasks SET task_description = ? WHERE id = ?').run(description, taskId);
    }
  }
}

/**
 * Return a stuck-parent diagnostic for continue-on-fail deadlock handling.
 * If all non-terminal dependencies are effectively blocked and there is no
 * running/queued work in the workflow, returns info for the first stuck parent.
 * @param {string} taskId - Dependent task ID being evaluated
 * @param {string} failingParentTaskId - Parent task that just transitioned terminal
 * @param {string} workflowId - Workflow ID
 * @returns {{parentNodeId: string, parentTaskId: string, status: string}|null}
 */
function detectContinueDeadlock(taskId, failingParentTaskId, workflowId) {
  const deps = db.getTaskDependencies(taskId) || [];
  if (!Array.isArray(deps) || deps.length === 0) return null;

  const workflowTasks = db.getWorkflowTasks(workflowId) || [];
  const hasActiveWork = workflowTasks.some((workflowTask) =>
    workflowTask && ['running', 'queued', 'pending_provider_switch'].includes(workflowTask.status)
  );
  if (hasActiveWork) return null;

  const stuckCandidates = [];
  let failingParentCandidate = null;

  for (const dep of deps) {
    const depTask = dep.depends_on_task_id ? db.getTask(dep.depends_on_task_id) : null;
    const depStatus = (dep.depends_on_status || depTask?.status || 'unknown').toLowerCase();

    if (['completed', 'skipped', 'failed', 'cancelled'].includes(depStatus)) {
      continue;
    }

    // If any dependency can still progress, wait for the normal re-evaluation path.
    if (['running', 'queued', 'pending', 'pending_provider_switch'].includes(depStatus)) {
      return null;
    }

    const candidate = {
      parentTaskId: dep.depends_on_task_id,
      parentNodeId: depTask?.workflow_node_id || dep.depends_on_task_id,
      status: depStatus
    };

    if (dep.depends_on_task_id === failingParentTaskId) {
      failingParentCandidate = candidate;
    } else {
      stuckCandidates.push(candidate);
    }
  }

  if (stuckCandidates.length === 0 && !failingParentCandidate) return null;
  return failingParentCandidate || stuckCandidates[0];
}

// ---------------------------------------------------------------------------
// Workflow DAG Functions
// ---------------------------------------------------------------------------

/**
 * Handle workflow-related bookkeeping when a task reaches a terminal state.
 * This must be called from ALL code paths that transition a task to a terminal
 * status (completed, failed, cancelled, skipped) — not just the primary close handler.
 * @param {string} taskId - Task ID that reached terminal state
 */
function handleWorkflowTermination(taskId) {
  let workflowId;
  try {
    const task = db.getTask(taskId);
    workflowId = task?.workflow_id;
    if (!workflowId) return;

    const workflow = db.getWorkflow(workflowId);
    if (!workflow || ['completed', 'failed', 'cancelled', 'paused'].includes(workflow.status)) {
      return;
    }

    // If another task is already being evaluated for this workflow,
    // queue this taskId for re-evaluation when the guard clears.
    if (terminalGuards.get(workflowId)) {
      if (!terminalPending.has(workflowId)) {
        terminalPending.set(workflowId, new Set());
      }
      terminalPending.get(workflowId).add(taskId);
      return;
    }
    terminalGuards.set(workflowId, true);

    try {
      evaluateWorkflowDependencies(taskId, workflowId);

      // Drain any tasks that arrived while we held the guard.
      // evaluateWorkflowDependencies re-reads full workflow state from DB,
      // so one call covers all queued completions.
      while (terminalPending.has(workflowId) && terminalPending.get(workflowId).size > 0) {
        const pending = terminalPending.get(workflowId);
        const nextTaskId = pending.values().next().value;
        pending.delete(nextTaskId);
        if (pending.size === 0) terminalPending.delete(workflowId);
        evaluateWorkflowDependencies(nextTaskId, workflowId);
      }
    } finally {
      terminalGuards.delete(workflowId);
      terminalPending.delete(workflowId);
    }
  } catch (err) {
    logger.info(`handleWorkflowTermination error for ${taskId}: ${err.message}`);
  }
}

/**
 * Evaluate workflow dependencies after a task completes.
 * Checks all dependent tasks and either unblocks them (if all prerequisites
 * are satisfied) or applies the configured failure action.
 * Also triggers workflow completion check at the end.
 * @param {string} taskId - Completed task ID
 * @param {string} workflowId - Workflow ID
 */
function evaluateWorkflowDependencies(taskId, workflowId, _skipDepth = 0) {
  const workflow = db.getWorkflow(workflowId);
  if (!workflow || ['completed', 'failed', 'cancelled', 'paused'].includes(workflow.status)) {
    return;
  }

  const completedTask = db.getTask(taskId);
  if (!completedTask) return;

  const completedMetadata = typeof completedTask.metadata === 'string'
    ? safeJsonParse(completedTask.metadata, {})
    : (completedTask.metadata && typeof completedTask.metadata === 'object' ? completedTask.metadata : {});
  if (
    workflowId
    && completedMetadata.adversarial_review_pending
    && completedMetadata.adversarial_review_task_id
    && typeof db.injectReviewDependency === 'function'
  ) {
    const completedNodeId = resolveWorkflowNodeId(completedTask, workflowId);
    if (completedNodeId) {
      db.injectReviewDependency(workflowId, completedNodeId, completedMetadata.adversarial_review_task_id);
    } else {
      logger.info(`[workflow-runtime] Skipping adversarial review DAG injection for task ${taskId}: missing workflow node id`);
    }
  }

  // Get all dependencies where this task is the prerequisite
  const dependents = db.getTaskDependents(taskId);

  for (const dep of dependents) {
    // Build context for condition evaluation
    // Security: Sanitize output to redact potential secrets before condition evaluation
    const context = {
      exit_code: completedTask.exit_code || 0,
      output: sanitizeOutputForCondition((completedTask.output || '').slice(-10240)), // Last 10KB, sanitized
      error_output: sanitizeOutputForCondition((completedTask.error_output || '').slice(-5120)), // Last 5KB, sanitized
      duration_seconds: completedTask.completed_at && completedTask.started_at
        ? Math.round((new Date(completedTask.completed_at) - new Date(completedTask.started_at)) / 1000)
        : 0,
      status: completedTask.status
    };

    // Evaluate condition — if no explicit condition, prerequisite must have succeeded
    let conditionPassed;
    if (dep.condition_expr) {
      conditionPassed = db.evaluateCondition(dep.condition_expr, context);
    } else {
      // Default: only pass if prerequisite completed successfully (not failed)
      conditionPassed = ['completed', 'skipped'].includes(completedTask.status);
    }

    if (conditionPassed) {
      // Check if all dependencies for this task are now satisfied
      const allDeps = db.getTaskDependencies(dep.task_id);
      let allSatisfied = true;

      for (const otherDep of allDeps) {
        if (otherDep.depends_on_task_id === taskId) continue; // Already checked this one

        const prereqTask = db.getTask(otherDep.depends_on_task_id);
        const prereqStatus = prereqTask?.status || otherDep.depends_on_status;
        // A dep is satisfied if it completed/was skipped, OR if it failed/was
        // cancelled but the dependency edge's on_fail policy is 'continue'.
        const depSatisfied = ['completed', 'skipped'].includes(prereqStatus)
          || (['failed', 'cancelled'].includes(prereqStatus) && otherDep.on_fail === 'continue');
        if (!depSatisfied) {
          allSatisfied = false;
          break;
        }
        // Also check condition for other dependencies
        if (otherDep.condition_expr) {
          // Security: Sanitize output to redact potential secrets
          const otherContext = {
            exit_code: otherDep.depends_on_exit_code || 0,
            output: sanitizeOutputForCondition((otherDep.depends_on_output || '').slice(-10240)),
            error_output: sanitizeOutputForCondition((otherDep.depends_on_error_output || '').slice(-5120)),
            duration_seconds: otherDep.depends_on_completed_at && otherDep.depends_on_started_at
              ? Math.round((new Date(otherDep.depends_on_completed_at) - new Date(otherDep.depends_on_started_at)) / 1000)
              : 0,
            status: prereqStatus
          };
          if (!db.evaluateCondition(otherDep.condition_expr, otherContext)) {
            allSatisfied = false;
            break;
          }
        }
      }

      if (allSatisfied) {
        // Inject dependency outputs into the task description before unblocking
        applyOutputInjection(dep.task_id, workflowId);
        unblockTask(dep.task_id);
      }
    } else {
      // Condition failed — apply failure action
      if (dep.on_fail === 'continue') {
        const stuckParent = detectContinueDeadlock(dep.task_id, taskId, workflowId);
        if (stuckParent) {
          const note = `Dependency continue deadlock on node '${stuckParent.parentNodeId}' (${stuckParent.status}) — forcing unblock because no running/queued workflow work can resolve it.`;
          const dependentTask = db.getTask(dep.task_id);
          const holdStatus = dependentTask && ['blocked', 'waiting'].includes(dependentTask.status)
            ? dependentTask.status
            : 'blocked';
          db.updateTaskStatus(dep.task_id, holdStatus, { error_output: note });
          applyOutputInjection(dep.task_id, workflowId);
          unblockTask(dep.task_id);
          continue;
        }
      }

      applyFailureAction(dep.task_id, dep.on_fail, dep.alternate_task_id, workflowId);
    }
  }

  // Process audit task results when a completed task has audit tags
  if (completedTask.status === 'completed') {
    maybeProcessAuditTaskResult(completedTask);
  }

  // Notify dashboard that workflow progressed (a task finished, dependents may have unblocked)
  if (_dashboard && _dashboard.notifyWorkflowUpdated) {
    _dashboard.notifyWorkflowUpdated(workflowId);
  }

  // Check if workflow is complete
  checkWorkflowCompletion(workflowId);
}

/**
 * Unblock a task — change status from blocked/waiting to pending and potentially start it.
 * If there is capacity (running < max_concurrent), the task is started immediately.
 * Otherwise it is queued for later execution.
 * @param {string} taskId - Task ID to unblock
 * @returns {boolean} True if the task was unblocked
 */
function unblockTask(taskId) {
  const task = db.getTask(taskId);
  // Handle both 'blocked' and 'waiting' statuses (waiting is used by auto-decomposed tasks)
  if (!task || !['blocked', 'waiting'].includes(task.status)) return false;

  try {
    db.updateTaskStatus(taskId, 'queued');
    eventBus.emitQueueChanged();
    return true;
  } catch (err) {
    logger.info(`unblockTask failed for ${taskId}: ${err.message}`);
    return false;
  }

}

/**
 * Apply failure action when a dependency condition fails.
 * Supports four failure modes:
 * - cancel: Cancel task and all downstream dependents
 * - skip: Mark as skipped and continue evaluating dependents
 * - continue: Unblock if all other deps are satisfied (including failed ones)
 * - run_alternate: Skip original and run an alternate task instead
 * @param {string} taskId - Task ID to apply action to
 * @param {string} action - Failure action (cancel|skip|continue|run_alternate)
 * @param {string|null} alternateTaskId - Alternate task ID when action is run_alternate
 * @param {string} workflowId - Workflow ID
 */
function applyFailureAction(taskId, action, alternateTaskId, workflowId, _skipDepth = 0) {
  switch (action) {
    case 'cancel':
      // Cancel this task and propagate cancellation to all dependents
      db.updateTaskStatus(taskId, 'cancelled', {
        error_output: 'Cancelled due to dependency failure',
        cancel_reason: 'workflow_cascade',
      });
      cancelDependentTasks(taskId, workflowId, 'Dependency cancelled');
      break;

    case 'skip':
      // Skip this task (mark as skipped, continue workflow)
      db.updateTaskStatus(taskId, 'skipped', {
        error_output: 'Skipped due to dependency condition not met'
      });
      // Trigger evaluation for tasks depending on this one
      if (_skipDepth > 50) {
        logger.warn(`[workflow] Skip propagation depth limit reached at task ${taskId}`);
        break;
      }
      evaluateWorkflowDependencies(taskId, workflowId, _skipDepth + 1);
      break;

    case 'continue':
      // Continue despite failed dependency — but only if ALL other deps are also satisfied
      {
        const allDeps = db.getTaskDependencies(taskId);
        let allSatisfied = true;
        for (const otherDep of allDeps) {
          const prereqTask = db.getTask(otherDep.depends_on_task_id);
          const prereqStatus = prereqTask?.status || otherDep.depends_on_status;
          if (!['completed', 'skipped', 'failed'].includes(prereqStatus)) {
            allSatisfied = false;
            break;
          }
        }
        if (allSatisfied) {
          applyOutputInjection(taskId, workflowId);
          unblockTask(taskId);
        }
        // If not all satisfied, task stays blocked — it will be re-evaluated
        // when the remaining dependencies complete
      }
      break;

    case 'run_alternate':
      // Skip original task and run alternate if specified
      db.updateTaskStatus(taskId, 'skipped', {
        error_output: 'Skipped - running alternate task'
      });
      if (alternateTaskId) {
        unblockTask(alternateTaskId);
      }
      // Evaluate dependents of the skipped task — they proceed once this task
      // is terminal (skipped counts as terminal). If downstream tasks should also
      // wait for the alternate, add an explicit dependency on the alternate node.
      evaluateWorkflowDependencies(taskId, workflowId);
      break;

    default:
      // Default to skip
      db.updateTaskStatus(taskId, 'skipped', {
        error_output: 'Skipped due to dependency condition not met'
      });
      evaluateWorkflowDependencies(taskId, workflowId);
  }
}

/**
 * Cancel all tasks that depend on a cancelled/failed task (recursive).
 * Running tasks are terminated via cancelTask(); pending/blocked/queued tasks
 * are marked cancelled directly. Already-terminal tasks are skipped.
 * @param {string} taskId - Task ID that failed/cancelled
 * @param {string} workflowId - Workflow ID
 * @param {string} reason - Cancellation reason
 */
function cancelDependentTasks(taskId, workflowId, reason, visited = new Set()) {
  if (visited.has(taskId)) return;
  visited.add(taskId);

  // Use getTaskDependents (task_dependencies table) for correct workflow DAG traversal.
  // Previously used getDependentTasks (depends_on LIKE scan) which missed DAG edges
  // and returned rows with .id instead of .task_id, making cascade a no-op.
  const dependents = db.getTaskDependents(taskId);

  for (const dep of dependents) {
    const depTaskId = dep.task_id;
    const task = db.getTask(depTaskId);
    if (!task) continue;

    if (task.status === 'running') {
      try {
        _cancelTask(depTaskId, reason, { cancel_reason: 'workflow_cascade' });
      } catch (err) {
        logger.info(`cancelDependentTasks: failed to cancel running task ${depTaskId}: ${err.message}`);
      }
    } else if (['pending', 'blocked', 'queued', 'pending_provider_switch'].includes(task.status)) {
      db.updateTaskStatus(depTaskId, 'cancelled', {
        error_output: reason,
        cancel_reason: 'workflow_cascade',
      });
    } else {
      // Already in terminal state — skip
      continue;
    }
    // Recursively cancel dependents
    cancelDependentTasks(depTaskId, workflowId, reason, visited);
  }
}

/**
 * Check if a workflow is complete (all tasks in terminal state).
 * Updates workflow counters and determines final status:
 * - 'completed' if all tasks completed/skipped
 * - 'failed' if any tasks failed
 * - 'cancelled' if tasks were cancelled but none failed
 * Also performs deadlock detection: if no tasks are runnable but
 * blocked tasks remain, the workflow is marked as failed.
 * @param {string} workflowId - Workflow ID
 */
function checkWorkflowCompletion(workflowId) {
  const workflow = db.getWorkflow(workflowId);
  if (!workflow || workflow.status === 'completed' || workflow.status === 'completed_with_errors' || workflow.status === 'failed' || workflow.status === 'cancelled') {
    return;
  }

  const tasks = db.getWorkflowTasks(workflowId);
  const isSuperseded = (task) => {
    if (task.status !== 'cancelled') return false;
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
      return !!meta.resubmitted_as;
    } catch {
      return false;
    }
  };
  const effectiveTasks = tasks.filter(t => !isSuperseded(t));
  const stats = {
    total: tasks.length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    cancelled: tasks.filter(t => t.status === 'cancelled').length,
    skipped: tasks.filter(t => t.status === 'skipped').length
  };
  const effectiveCompleted = effectiveTasks.filter(t => t.status === 'completed').length;
  const effectiveFailed = effectiveTasks.filter(t => t.status === 'failed').length;
  const effectiveCancelled = effectiveTasks.filter(t => t.status === 'cancelled').length;

  // Update workflow counters
  db.updateWorkflow(workflowId, {
    total_tasks: stats.total,
    completed_tasks: stats.completed,
    failed_tasks: stats.failed,
    skipped_tasks: stats.skipped
  });

  // Check if all tasks are in terminal state
  const terminalCount = stats.completed + stats.failed + stats.cancelled + stats.skipped;

  if (terminalCount >= stats.total) {
    // Workflow is complete
    let finalStatus;
    if (effectiveFailed === 0 && effectiveCancelled === 0) {
      finalStatus = 'completed';
    } else if (effectiveCompleted > 0) {
      finalStatus = 'completed_with_errors';
    } else {
      finalStatus = 'failed';
    }
    db.updateWorkflow(workflowId, {
      status: finalStatus,
      completed_at: new Date().toISOString()
    });
    // Finalize audit run status when audit workflow completes
    maybeFinalizeAuditRun(workflowId, finalStatus);

    if (finalStatus === 'completed' || finalStatus === 'completed_with_errors') {
      try {
        const conflictResult = resolveWorkflowConflicts(workflowId);
        // Surface unresolved conflicts: store them in workflow context so callers
        // (e.g. await_workflow) can inspect and report them rather than silently dropping.
        if (conflictResult && conflictResult.conflicts && conflictResult.conflicts.length > 0) {
          try {
            const wf = db.getWorkflow ? db.getWorkflow(workflowId) : null;
            const existingCtx = (wf && typeof wf.context === 'object' && wf.context) ? wf.context : {};
            db.updateWorkflow(workflowId, {
              context: {
                ...existingCtx,
                unresolved_conflicts: conflictResult.conflicts,
                auto_merged: conflictResult.merged || []
              }
            });
          } catch (ctxErr) {
            logger.warn(`[Workflow] Failed to store conflict info in context for ${workflowId}: ${ctxErr.message}`);
          }
          logger.warn(`[Workflow] ${conflictResult.conflicts.length} unresolved conflict(s) in workflow ${workflowId}: ${conflictResult.conflicts.map(c => c.file_path).join(', ')}`);
        }
      } catch (err) {
        logger.warn(`[Workflow] Conflict auto-merge failed for ${workflowId}: ${err.message}`);
      }
    }
    // Clean up terminal guards now that the workflow has reached a final state
    terminalGuards.delete(workflowId);
    terminalPending.delete(workflowId);
    // Notify dashboard of workflow completion
    if (_dashboard) {
      if (_dashboard.notifyWorkflowUpdated) _dashboard.notifyWorkflowUpdated(workflowId);
      if (_dashboard.notifyStatsUpdated) _dashboard.notifyStatsUpdated();
    }
  } else {
    // Deadlock detection: if no tasks are running/queued/pending but blocked tasks remain,
    // the workflow is stuck and will never complete
    const runnableCount = tasks.filter(t =>
      ['running', 'queued', 'pending', 'pending_provider_switch'].includes(t.status)
    ).length;

    if (runnableCount === 0 && terminalCount < stats.total) {
      const blockedCount = stats.total - terminalCount;
      logger.info(`[Workflow] Deadlock detected in workflow ${workflowId}: ${blockedCount} blocked tasks with no runnable prerequisites`);
      db.updateWorkflow(workflowId, {
        status: 'failed',
        completed_at: new Date().toISOString()
      });
      // Clean up terminal guards now that the workflow has reached a final state (deadlock)
      terminalGuards.delete(workflowId);
      terminalPending.delete(workflowId);
      // Notify dashboard of workflow deadlock
      if (_dashboard && _dashboard.notifyWorkflowUpdated) {
        _dashboard.notifyWorkflowUpdated(workflowId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Audit task result processing
// ---------------------------------------------------------------------------

function maybeProcessAuditTaskResult(task) {
  const tags = typeof task.tags === 'string' ? safeJsonParse(task.tags, []) : (task.tags || []);
  const auditTag = Array.isArray(tags) ? tags.find((tag) => typeof tag === 'string' && tag.startsWith('audit:')) : undefined;

  if (!auditTag) return;

  const auditRunId = auditTag.slice('audit:'.length);
  if (!auditRunId) return;

  try {
    const aggregator = require('../audit/aggregator');
    const auditStore = require('../db/audit-store');

    const filePaths = [];
    if (task.metadata) {
      const meta = typeof task.metadata === 'string'
        ? JSON.parse(task.metadata)
        : task.metadata;
      if (Array.isArray(meta.file_paths)) {
        filePaths.push(...meta.file_paths);
      }
    }

    aggregator.processTaskResult({
      taskId: task.id,
      output: task.output || '',
      provider: task.provider || null,
      model: task.model || null,
      auditRunId,
      filePaths,
    }, auditStore).catch((err) => {
      logger.warn({ err, taskId: task.id, auditRunId }, 'Failed to process audit task result');
    });
  } catch (err) {
    logger.warn({ err, taskId: task.id, auditRunId }, 'Failed to load audit modules for task result processing');
  }
}

function maybeFinalizeAuditRun(workflowId, finalStatus) {
  try {
    const auditStore = require('../db/audit-store');
    const runs = auditStore.listAuditRuns({ workflow_id: workflowId, limit: 1 });
    if (!Array.isArray(runs) || runs.length === 0) return;

    const run = runs[0];
    const auditStatus = finalStatus === 'completed' ? 'completed'
      : finalStatus === 'cancelled' ? 'cancelled'
      : 'failed';

    auditStore.updateAuditRun(run.id, {
      status: auditStatus,
      completed_at: new Date().toISOString(),
    });

    logger.info({ workflowId, auditRunId: run.id, auditStatus }, 'Audit run finalized');
  } catch (err) {
    logger.warn({ err, workflowId }, 'Failed to finalize audit run');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createWorkflowRuntime(_deps) {
  // _deps reserved for Phase 5 when database.js facade is removed
  return {
    init,
    handlePlanProjectTaskCompletion,
    handlePlanProjectTaskFailure,
    generatePipelineDocumentation,
    handlePipelineStepCompletion,
    handleWorkflowTermination,
    evaluateWorkflowDependencies,
    unblockTask,
    applyFailureAction,
    cancelDependentTasks,
    checkWorkflowCompletion,
    injectDependencyOutputs,
    applyContextFrom,
    applyOutputInjection,
    buildDepTasksMap,
    OUTPUT_CAP_BYTES,
  };
}

module.exports = {
  init,
  handlePlanProjectTaskCompletion,
  handlePlanProjectTaskFailure,
  generatePipelineDocumentation,
  handlePipelineStepCompletion,
  handleWorkflowTermination,
  evaluateWorkflowDependencies,
  unblockTask,
  applyFailureAction,
  cancelDependentTasks,
  checkWorkflowCompletion,
  // Output injection (exported for testing)
  injectDependencyOutputs,
  applyContextFrom,
  applyOutputInjection,
  buildDepTasksMap,
  OUTPUT_CAP_BYTES,
  createWorkflowRuntime,
};
