'use strict';

const { v4: uuidv4 } = require('uuid');

function getLogger(options) {
  if (options?.logger) {
    return options.logger;
  }
  return require('../logger').child({ component: 'schedule-runner' });
}

function getDebugLog(options) {
  return typeof options?.debugLog === 'function' ? options.debugLog : () => {};
}

function extractErrorMessage(result, fallback) {
  return result?.content?.[0]?.text || fallback;
}

function extractOutputMessage(result, fallback = '') {
  const text = result?.content?.[0]?.text;
  if (typeof text === 'string' && text.trim()) {
    return text.trim();
  }
  return fallback;
}

function extractFilesModified(result) {
  const candidate = result?.structuredData?.files_modified;
  if (!Array.isArray(candidate)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const value of candidate) {
    const filePath = String(value || '').trim().replace(/\\/g, '/');
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    normalized.push(filePath);
  }
  return normalized;
}

function getWorkflowStatusReader(options) {
  if (typeof options?.getWorkflowStatus === 'function') {
    return options.getWorkflowStatus;
  }
  return (workflowId) => {
    try {
      const workflowEngine = require('../db/workflow-engine');
      if (typeof workflowEngine.getWorkflowStatus === 'function') {
        return workflowEngine.getWorkflowStatus(workflowId);
      }
      if (typeof workflowEngine.getWorkflow === 'function') {
        return workflowEngine.getWorkflow(workflowId);
      }
    } catch {
      return null;
    }
    return null;
  };
}

function getWorkflowSpecRunner(options) {
  if (typeof options?.runWorkflowSpec === 'function') {
    return options.runWorkflowSpec;
  }

  return (specArgs) => {
    try {
      const workflowSpecHandlers = require('../handlers/workflow-spec-handlers');
      if (typeof workflowSpecHandlers.handleRunWorkflowSpec === 'function') {
        return workflowSpecHandlers.handleRunWorkflowSpec(specArgs);
      }
    } catch (error) {
      return {
        isError: true,
        error_code: 'OPERATION_FAILED',
        content: [{
          type: 'text',
          text: `Workflow spec execution is not available: ${error.message}`,
        }],
      };
    }

    return {
      isError: true,
      error_code: 'OPERATION_FAILED',
      content: [{
        type: 'text',
        text: 'Workflow spec execution is not available',
      }],
    };
  };
}

function getScheduledTaskReader(options, db) {
  if (typeof options?.getScheduledTask === 'function') {
    return options.getScheduledTask;
  }
  if (typeof db?.getScheduledTask === 'function') {
    return db.getScheduledTask.bind(db);
  }
  return (scheduleId, readerOptions) => {
    try {
      const schedulingAutomation = require('../db/cron-scheduling');
      if (typeof schedulingAutomation.getScheduledTask === 'function') {
        return schedulingAutomation.getScheduledTask(scheduleId, readerOptions);
      }
    } catch {
      return null;
    }
    return null;
  };
}

function getWorkflowLockHelpers(options, db) {
  let coordination = null;
  try {
    coordination = require('../db/coordination');
  } catch {
    coordination = null;
  }

  return {
    acquireLock: typeof options?.acquireLock === 'function'
      ? options.acquireLock
      : (typeof db?.acquireLock === 'function'
        ? db.acquireLock.bind(db)
        : coordination?.acquireLock),
    releaseLock: typeof options?.releaseLock === 'function'
      ? options.releaseLock
      : (typeof db?.releaseLock === 'function'
        ? db.releaseLock.bind(db)
        : coordination?.releaseLock),
  };
}

function getWorkflowTaskCounts(workflow) {
  const summaryCounts = {
    total: Number(workflow?.summary?.total) || 0,
    completed: Number(workflow?.summary?.completed) || 0,
    failed: Number(workflow?.summary?.failed) || 0,
    running: Number(workflow?.summary?.running) || 0,
    blocked: Number(workflow?.summary?.blocked) || 0,
    pending: Number(workflow?.summary?.pending) || 0,
    queued: Number(workflow?.summary?.queued) || 0,
    skipped: Number(workflow?.summary?.skipped) || 0,
    cancelled: Number(workflow?.summary?.cancelled) || 0,
    pending_provider_switch: Number(workflow?.summary?.pending_provider_switch) || 0,
  };
  const taskEntries = Array.isArray(workflow?.tasks)
    ? workflow.tasks
    : (workflow?.tasks && typeof workflow.tasks === 'object' ? Object.values(workflow.tasks) : []);

  if (taskEntries.length > 0) {
    const taskCounts = {
      total: taskEntries.length,
      completed: 0,
      failed: 0,
      running: 0,
      blocked: 0,
      pending: 0,
      queued: 0,
      skipped: 0,
      cancelled: 0,
      pending_provider_switch: 0,
    };

    for (const task of taskEntries) {
      const key = typeof task?.status === 'string' ? task.status : '';
      if (Object.prototype.hasOwnProperty.call(taskCounts, key)) {
        taskCounts[key] += 1;
      }
    }

    const counts = {
      total: Math.max(summaryCounts.total, taskCounts.total),
      completed: Math.max(summaryCounts.completed, taskCounts.completed),
      failed: Math.max(summaryCounts.failed, taskCounts.failed),
      running: Math.max(summaryCounts.running, taskCounts.running),
      blocked: Math.max(summaryCounts.blocked, taskCounts.blocked),
      pending: Math.max(summaryCounts.pending, taskCounts.pending),
      queued: Math.max(summaryCounts.queued, taskCounts.queued),
      skipped: Math.max(summaryCounts.skipped, taskCounts.skipped),
      cancelled: Math.max(summaryCounts.cancelled, taskCounts.cancelled),
      pending_provider_switch: Math.max(summaryCounts.pending_provider_switch, taskCounts.pending_provider_switch),
    };
    counts.open = counts.running + counts.pending + counts.queued + counts.blocked + counts.pending_provider_switch;
    return counts;
  }

  return {
    ...summaryCounts,
    open: summaryCounts.running + summaryCounts.pending + summaryCounts.queued + summaryCounts.blocked + summaryCounts.pending_provider_switch,
  };
}

function resolveScheduledWorkflowConfig(config) {
  if (config?.workflow_source_id) {
    return {
      mode: 'clone',
      source_workflow_id: String(config.workflow_source_id),
    };
  }
  if (config?.workflow_id) {
    return {
      mode: 'existing',
      workflow_id: String(config.workflow_id),
    };
  }
  return null;
}

function getScheduledWorkflowIdentity(schedule, workflowConfig) {
  if (!workflowConfig) {
    return {
      lock_name: `scheduled_workflow_launch:${schedule.id}`,
      display_workflow_id: null,
      summary_target: `schedule ${schedule.id}`,
      debug_target: `schedule ${schedule.id}`,
    };
  }

  if (workflowConfig.mode === 'clone') {
    return {
      lock_name: `scheduled_workflow_launch:schedule:${schedule.id}`,
      display_workflow_id: workflowConfig.source_workflow_id,
      summary_target: `Workflow source ${workflowConfig.source_workflow_id}`,
      debug_target: `schedule ${schedule.id} source workflow ${workflowConfig.source_workflow_id}`,
    };
  }

  return {
    lock_name: `scheduled_workflow_launch:${workflowConfig.workflow_id}`,
    display_workflow_id: workflowConfig.workflow_id,
    summary_target: `Workflow ${workflowConfig.workflow_id}`,
    debug_target: `workflow ${workflowConfig.workflow_id}`,
  };
}

function getActiveWorkflowSkipState(workflow) {
  if (!workflow) {
    return null;
  }

  const counts = getWorkflowTaskCounts(workflow);
  const status = workflow.status || 'pending';
  const freshPendingStart = status === 'pending'
    && !workflow.started_at
    && !workflow.completed_at
    && counts.running === 0
    && counts.queued === 0
    && counts.pending_provider_switch === 0;

  if (freshPendingStart) {
    return null;
  }

  if (counts.open > 0 || status === 'running' || status === 'paused') {
    return {
      status,
      counts,
      skip_reason: status === 'running' ? 'workflow_running' : 'workflow_active',
      summary: status === 'running'
        ? `Workflow ${workflow.id} already running`
        : `Workflow ${workflow.id} still active (${status})`,
    };
  }

  return null;
}

function findActiveScheduledWorkflowRun(schedule, workflowConfig, options, db, getWorkflowStatus) {
  if (!schedule?.id || !workflowConfig || workflowConfig.mode !== 'clone') {
    return null;
  }

  const readScheduledTask = getScheduledTaskReader(options, db);
  if (typeof readScheduledTask !== 'function') {
    return null;
  }

  const hydratedSchedule = readScheduledTask(schedule.id, {
    include_runs: true,
    run_limit: 10,
    hydrateRuns: false,
  });
  const recentRuns = Array.isArray(hydratedSchedule?.recent_runs) ? hydratedSchedule.recent_runs : [];

  for (const run of recentRuns) {
    if (run?.execution_type !== 'workflow') {
      continue;
    }
    const workflowId = run?.details_json?.workflow_id;
    if (!workflowId || workflowId === workflowConfig.source_workflow_id) {
      continue;
    }
    const workflow = getWorkflowStatus(workflowId);
    const activeWorkflow = getActiveWorkflowSkipState(workflow);
    if (activeWorkflow) {
      return {
        workflow_id: workflowId,
        ...activeWorkflow,
      };
    }
  }

  return null;
}

function executeScheduledTask(schedule, options = {}) {
  if (!schedule?.id) {
    throw new Error('SCHEDULE_REQUIRED: schedule is required');
  }

  const db = options.db;
  if (!db || typeof db.markScheduledTaskRun !== 'function' || typeof db.createTask !== 'function') {
    throw new Error('DB_REQUIRED: db with scheduling helpers is required');
  }

  const logger = getLogger(options);
  const debugLog = getDebugLog(options);
  const config = schedule.task_config || {};
  const originMetadata = {
    scheduled_by: schedule.id,
    schedule_name: schedule.name,
    schedule_type: schedule.schedule_type || 'cron',
    scheduled: true,
  };
  const scheduleConsumed = (schedule.schedule_type || 'cron') === 'once';

  if (schedule.payload_kind === 'workflow_spec') {
    if (!schedule.spec_path) {
      logger.warn?.(`[schedule] Row ${schedule.id} has payload_kind=workflow_spec but no spec_path; skipping`);
      db.markScheduledTaskRun(schedule.id, {
        execution_type: 'workflow',
        status: 'skipped',
        skip_reason: 'workflow_spec_missing_path',
        summary: 'Workflow spec schedule is missing spec_path',
      });
      debugLog(`Skipped scheduled workflow spec "${schedule.name}" because spec_path is missing`);
      return {
        started: false,
        skipped: true,
        execution_type: 'workflow',
        workflow_id: null,
        spec_path: null,
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        schedule_consumed: scheduleConsumed,
        skip_reason: 'workflow_spec_missing_path',
      };
    }

    const runWorkflowSpec = getWorkflowSpecRunner(options);
    let runResult;
    try {
      const workflowSpecArgs = { spec_path: schedule.spec_path };
      const workflowSpecWorkingDir = config.working_directory || schedule.working_directory || null;
      if (workflowSpecWorkingDir) {
        workflowSpecArgs.working_directory = workflowSpecWorkingDir;
      }
      runResult = runWorkflowSpec(workflowSpecArgs);
    } catch (error) {
      db.markScheduledTaskRun(schedule.id, {
        execution_type: 'workflow',
        status: 'failed',
        summary: error.message,
        details: {
          spec_path: schedule.spec_path,
        },
      });
      throw error;
    }

    if (runResult && typeof runResult.then === 'function') {
      const errorMessage = `Workflow spec runner for ${schedule.spec_path} must complete synchronously`;
      db.markScheduledTaskRun(schedule.id, {
        execution_type: 'workflow',
        status: 'failed',
        summary: errorMessage,
        details: {
          spec_path: schedule.spec_path,
        },
      });
      throw new Error(errorMessage);
    }

    if (runResult?.isError || runResult?.error_code) {
      const errorMessage = extractErrorMessage(runResult, `Failed to run workflow spec ${schedule.spec_path}`);
      db.markScheduledTaskRun(schedule.id, {
        execution_type: 'workflow',
        status: 'failed',
        summary: errorMessage,
        details: {
          spec_path: schedule.spec_path,
        },
      });
      throw new Error(errorMessage);
    }

    const workflowId = runResult?.workflow_id
      || runResult?.structuredData?.workflow_id
      || null;

    db.markScheduledTaskRun(schedule.id, {
      execution_type: 'workflow',
      status: 'completed',
      summary: workflowId
        ? `Workflow ${workflowId} started`
        : `Workflow spec ${schedule.spec_path} started`,
      details: {
        workflow_status: 'running',
        workflow_id: workflowId,
        spec_path: schedule.spec_path,
      },
    });

    debugLog(
      workflowId
        ? `Executed scheduled workflow spec "${schedule.name}" -> workflow ${workflowId}`
        : `Executed scheduled workflow spec "${schedule.name}" -> spec ${schedule.spec_path}`
    );
    return {
      started: true,
      execution_type: 'workflow',
      workflow_id: workflowId,
      spec_path: schedule.spec_path,
      schedule_id: schedule.id,
      schedule_name: schedule.name,
      schedule_consumed: scheduleConsumed,
    };
  }

  if (config.tool_name) {
    const taskId = uuidv4();
    const markedSchedule = db.markScheduledTaskRun(schedule.id);
    const scheduledRunId = markedSchedule?.last_run_record_id || null;
    const updateTaskStatus = typeof db.updateTaskStatus === 'function'
      ? db.updateTaskStatus.bind(db)
      : require('../db/task-core').updateTaskStatus;

    db.createTask({
      id: taskId,
      status: 'pending',
      task_description: config.task || schedule.task_description || `Scheduled tool: ${config.tool_name}`,
      working_directory: config.working_directory || schedule.working_directory || null,
      provider: 'tool',
      model: null,
      tags: config.tags || ['scheduled-tool'],
      timeout_minutes: config.timeout_minutes || schedule.timeout_minutes || 30,
      auto_approve: true,
      priority: config.priority || 0,
      metadata: {
        ...originMetadata,
        execution_type: 'tool',
        scheduled_tool_name: config.tool_name,
      },
    });
    updateTaskStatus(taskId, 'running', {
      progress_percent: 0,
    });

    const toolArgs = (config.tool_args && typeof config.tool_args === 'object' && !Array.isArray(config.tool_args))
      ? { ...config.tool_args }
      : {};
    toolArgs.__scheduledScheduleId = schedule.id;
    toolArgs.__scheduledScheduleName = schedule.name;
    if (scheduledRunId) {
      toolArgs.__scheduledRunId = scheduledRunId;
    }
    toolArgs.__scheduledTaskId = taskId;
    if (options.manualRunNow) {
      toolArgs.__manualRunNow = true;
    }

    const { handleToolCall } = require('../tools');
    Promise.resolve(handleToolCall(config.tool_name, toolArgs))
      .then((toolResult) => {
        if (toolResult?.isError) {
          updateTaskStatus(taskId, 'failed', {
            error_output: extractErrorMessage(toolResult, `Scheduled tool ${config.tool_name} failed`),
            exit_code: 1,
            progress_percent: 100,
          });
          logger.warn?.(`Scheduled tool ${config.tool_name} returned an error for ${schedule.name}`);
          return;
        }
        updateTaskStatus(taskId, 'completed', {
          output: extractOutputMessage(toolResult, `Scheduled tool ${config.tool_name} completed.`),
          exit_code: 0,
          progress_percent: 100,
          files_modified: extractFilesModified(toolResult),
        });
      })
      .catch((toolErr) => {
        updateTaskStatus(taskId, 'failed', {
          error_output: toolErr.message,
          exit_code: 1,
          progress_percent: 100,
        });
        logger.error?.(`Scheduled tool execution failed for ${schedule.name}: ${toolErr.message}`);
        debugLog(`Failed scheduled tool "${schedule.name}": ${toolErr.message}`);
      });

    debugLog(`Executed scheduled tool "${schedule.name}" -> task ${taskId} (tool ${config.tool_name})`);
    return {
      started: true,
      execution_type: 'tool',
      tool_name: config.tool_name,
      task_id: taskId,
      schedule_id: schedule.id,
      schedule_name: schedule.name,
      schedule_consumed: scheduleConsumed,
    };
  }

  const scheduledWorkflowConfig = resolveScheduledWorkflowConfig(config);
  if (scheduledWorkflowConfig) {
    const getWorkflowStatus = getWorkflowStatusReader(options);
    const { acquireLock, releaseLock } = getWorkflowLockHelpers(options, db);
    const workflowIdentity = getScheduledWorkflowIdentity(schedule, scheduledWorkflowConfig);
    const workflowLockName = workflowIdentity.lock_name;
    const workflowLockHolder = `schedule:${schedule.id}:${uuidv4()}`;
    let keepLaunchLock = false;

    if (typeof acquireLock === 'function') {
      const lockResult = acquireLock(
        workflowLockName,
        workflowLockHolder,
        30,
        JSON.stringify({
          schedule_id: schedule.id,
          schedule_name: schedule.name,
          workflow_id: scheduledWorkflowConfig.workflow_id || null,
          workflow_source_id: scheduledWorkflowConfig.source_workflow_id || null,
        }),
      );
      if (lockResult?.acquired === false) {
        db.markScheduledTaskRun(schedule.id, {
          execution_type: 'workflow',
          status: 'skipped',
          skip_reason: 'workflow_launch_locked',
          summary: `${workflowIdentity.summary_target} launch already in progress`,
          details: {
            workflow_lock_name: workflowLockName,
            workflow_lock_holder: lockResult.holder || null,
            workflow_lock_expires_at: lockResult.expiresAt || null,
          },
        });
        debugLog(`Skipped scheduled workflow "${schedule.name}" because ${workflowIdentity.debug_target} launch lock is already held`);
        return {
          started: false,
          skipped: true,
          execution_type: 'workflow',
          workflow_id: scheduledWorkflowConfig.workflow_id || null,
          workflow_source_id: scheduledWorkflowConfig.source_workflow_id || null,
          schedule_id: schedule.id,
          schedule_name: schedule.name,
          schedule_consumed: scheduleConsumed,
          skip_reason: 'workflow_launch_locked',
        };
      }
    }

    try {
      let activeWorkflow = null;
      if (scheduledWorkflowConfig.mode === 'existing') {
        const currentWorkflow = getWorkflowStatus(scheduledWorkflowConfig.workflow_id);
        activeWorkflow = getActiveWorkflowSkipState(currentWorkflow);
      } else {
        activeWorkflow = findActiveScheduledWorkflowRun(schedule, scheduledWorkflowConfig, options, db, getWorkflowStatus);
      }
      if (activeWorkflow) {
        db.markScheduledTaskRun(schedule.id, {
          execution_type: 'workflow',
          status: 'skipped',
          skip_reason: activeWorkflow.skip_reason,
          summary: activeWorkflow.summary,
          details: {
            workflow_status: activeWorkflow.status,
            workflow_counts: activeWorkflow.counts,
          },
        });
        debugLog(`Skipped scheduled workflow "${schedule.name}" because workflow ${activeWorkflow.workflow_id || scheduledWorkflowConfig.workflow_id} is still active (${activeWorkflow.status})`);
        return {
          started: false,
          skipped: true,
          execution_type: 'workflow',
          workflow_id: activeWorkflow.workflow_id || scheduledWorkflowConfig.workflow_id || null,
          workflow_source_id: scheduledWorkflowConfig.source_workflow_id || null,
          schedule_id: schedule.id,
          schedule_name: schedule.name,
          schedule_consumed: scheduleConsumed,
          skip_reason: activeWorkflow.skip_reason,
        };
      }

      const workflowRunner = typeof options.runWorkflow === 'function'
        ? options.runWorkflow
        : (workflowId) => {
          const workflowHandler = require('../handlers/workflow/index');
          return workflowHandler.handleRunWorkflow({ workflow_id: workflowId });
        };
      const workflowCloner = typeof options.cloneWorkflow === 'function'
        ? options.cloneWorkflow
        : (cloneArgs) => {
          const workflowHandler = require('../handlers/workflow/index');
          if (typeof workflowHandler.handleCloneWorkflow !== 'function') {
            return {
              isError: true,
              error_code: 'OPERATION_FAILED',
              content: [{ type: 'text', text: 'Workflow cloning is not available' }],
            };
          }
          return workflowHandler.handleCloneWorkflow(cloneArgs);
        };

      let launchedWorkflowId = scheduledWorkflowConfig.workflow_id;
      if (scheduledWorkflowConfig.mode === 'clone') {
        const cloneResult = workflowCloner({
          source_workflow_id: scheduledWorkflowConfig.source_workflow_id,
          auto_run: false,
          working_directory: config.working_directory || schedule.working_directory || null,
          project: config.project || schedule.project || null,
          context: {
            _scheduled_origin: {
              schedule_id: schedule.id,
              schedule_name: schedule.name,
              source_workflow_id: scheduledWorkflowConfig.source_workflow_id,
              scheduled_at: new Date().toISOString(),
            },
          },
        });
        if (cloneResult?.isError || cloneResult?.error_code) {
          const cloneError = extractErrorMessage(cloneResult, `Failed to clone workflow ${scheduledWorkflowConfig.source_workflow_id}`);
          db.markScheduledTaskRun(schedule.id, {
            execution_type: 'workflow',
            status: 'failed',
            summary: cloneError,
            details: {
              workflow_source_id: scheduledWorkflowConfig.source_workflow_id,
            },
          });
          throw new Error(cloneError);
        }
        launchedWorkflowId = cloneResult?.workflow_id
          || cloneResult?.structuredData?.workflow_id
          || null;
        if (!launchedWorkflowId) {
          const cloneError = `Failed to resolve cloned workflow id for source ${scheduledWorkflowConfig.source_workflow_id}`;
          db.markScheduledTaskRun(schedule.id, {
            execution_type: 'workflow',
            status: 'failed',
            summary: cloneError,
            details: {
              workflow_source_id: scheduledWorkflowConfig.source_workflow_id,
            },
          });
          throw new Error(cloneError);
        }
      }

      const runResult = workflowRunner(launchedWorkflowId, originMetadata);
      if (runResult?.isError || runResult?.error_code) {
        const errorMessage = extractErrorMessage(runResult, `Failed to run workflow ${launchedWorkflowId}`);
        if (/already running/i.test(errorMessage)) {
          db.markScheduledTaskRun(schedule.id, {
            execution_type: 'workflow',
            status: 'skipped',
            skip_reason: 'workflow_running',
            summary: `Workflow ${launchedWorkflowId} already running`,
            details: {
              workflow_status: 'running',
              workflow_source_id: scheduledWorkflowConfig.source_workflow_id || null,
            },
          });
          debugLog(`Skipped scheduled workflow "${schedule.name}" because workflow ${launchedWorkflowId} is already running`);
          return {
            started: false,
            skipped: true,
            execution_type: 'workflow',
            workflow_id: launchedWorkflowId,
            workflow_source_id: scheduledWorkflowConfig.source_workflow_id || null,
            schedule_id: schedule.id,
            schedule_name: schedule.name,
            schedule_consumed: scheduleConsumed,
            skip_reason: 'workflow_running',
          };
        }
        db.markScheduledTaskRun(schedule.id, {
          execution_type: 'workflow',
          status: 'failed',
          summary: errorMessage,
        });
        throw new Error(errorMessage);
      }

      db.markScheduledTaskRun(schedule.id, {
        execution_type: 'workflow',
        status: 'completed',
        summary: `Workflow ${launchedWorkflowId} started`,
        details: {
          workflow_status: 'running',
          workflow_id: launchedWorkflowId,
          workflow_source_id: scheduledWorkflowConfig.source_workflow_id || null,
        },
      });
      keepLaunchLock = true;

      debugLog(
        scheduledWorkflowConfig.mode === 'clone'
          ? `Executed scheduled workflow "${schedule.name}" -> workflow ${launchedWorkflowId} (cloned from ${scheduledWorkflowConfig.source_workflow_id})`
          : `Executed scheduled workflow "${schedule.name}" -> workflow ${launchedWorkflowId}`
      );
      return {
        started: true,
        execution_type: 'workflow',
        workflow_id: launchedWorkflowId,
        workflow_source_id: scheduledWorkflowConfig.source_workflow_id || null,
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        schedule_consumed: scheduleConsumed,
      };
    } finally {
      if (!keepLaunchLock && typeof releaseLock === 'function') {
        try {
          releaseLock(workflowLockName, workflowLockHolder);
        } catch (lockReleaseError) {
          logger.warn?.(`Failed to release workflow launch lock for ${workflowIdentity.summary_target}: ${lockReleaseError.message}`);
        }
      }
    }
  }

  const taskId = uuidv4();
  const taskMeta = { ...originMetadata };
  if (config.version_intent) {
    taskMeta.version_intent = config.version_intent;
  }

  db.createTask({
    id: taskId,
    task_description: config.task || schedule.task_description || 'Scheduled task',
    working_directory: config.working_directory || schedule.working_directory || null,
    project: config.project || schedule.project || null,
    provider: config.provider || null,
    model: config.model || null,
    tags: config.tags || null,
    timeout_minutes: config.timeout_minutes || schedule.timeout_minutes || 30,
    auto_approve: config.auto_approve || false,
    priority: config.priority || 0,
    metadata: taskMeta,
  });
  db.markScheduledTaskRun(schedule.id);

  const taskManager = options.taskManager || require('../task-manager');
  const startPromise = taskManager.startTask(taskId);
  if (startPromise && typeof startPromise.catch === 'function') {
    startPromise.catch(err => logger.info?.(`Scheduled task async start failure for ${taskId}: ${err.message}`));
  }

  debugLog(`Executed scheduled task "${schedule.name}" -> task ${taskId}`);
  return {
    started: true,
    execution_type: 'task',
    task_id: taskId,
    schedule_id: schedule.id,
    schedule_name: schedule.name,
    schedule_consumed: scheduleConsumed,
  };
}

module.exports = {
  executeScheduledTask,
};
