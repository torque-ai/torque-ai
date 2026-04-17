'use strict';

// Factory tick owns the project-scoped scheduler that keeps factory loops
// moving after start_factory_loop. It advances active instances on a periodic
// cadence, wakes immediately on terminal batch-task updates, and starts fresh
// instances after persisted LEARN cooldowns.

const eventBus = require('../event-bus');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryLoopInstances = require('../db/factory-loop-instances');
const loopController = require('./loop-controller');
const logger = require('../logger').child({ component: 'factory-tick' });
const taskCore = require('../db/task-core');
const timerRegistry = require('../timer-registry');

const DEFAULT_TICK_INTERVAL_MINUTES = 5;
const DEFAULT_TICK_INTERVAL_MS = DEFAULT_TICK_INTERVAL_MINUTES * 60 * 1000;
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const activeTimers = new Map(); // project_id -> { timer, interval_ms }
const scheduledProjectTicks = new Map(); // project_id -> { timer, due_at, reason }

let taskUpdateListenerRegistered = false;
let factoryLoopListenerRegistered = false;

function getProjectConfig(project) {
  if (!project?.config_json) {
    return {};
  }
  try {
    return JSON.parse(project.config_json);
  } catch (_e) {
    void _e;
    return {};
  }
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getTickIntervalMs(project) {
  const loopConfig = getProjectConfig(project)?.loop || {};
  const intervalMinutes = toPositiveNumber(loopConfig.tick_interval_minutes);
  if (intervalMinutes !== null) {
    return intervalMinutes * 60 * 1000;
  }
  const compatibilityIntervalMs = toPositiveNumber(loopConfig.tick_interval_ms);
  return compatibilityIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAutoContinueAfterMs(project) {
  return parseIsoTimestamp(getProjectConfig(project)?.loop?.auto_continue_after);
}

function clearAutoContinueAfter(project) {
  if (!project?.id) {
    return false;
  }
  const config = getProjectConfig(project);
  if (!config.loop || !Object.prototype.hasOwnProperty.call(config.loop, 'auto_continue_after')) {
    return false;
  }
  const nextLoop = { ...config.loop };
  delete nextLoop.auto_continue_after;
  factoryHealth.updateProject(project.id, {
    config_json: JSON.stringify({
      ...config,
      loop: nextLoop,
    }),
  });
  return true;
}

function getFreshProject(projectOrId) {
  if (!projectOrId) {
    return null;
  }
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId.id;
  if (!projectId) {
    return null;
  }
  return factoryHealth.getProject(projectId) || (typeof projectOrId === 'object' ? projectOrId : null);
}

function getLatestStageDecision(projectId, stage) {
  try {
    return factoryDecisions.listDecisions(projectId, {
      stage,
      limit: 1,
    })[0] || null;
  } catch (err) {
    logger.debug('Factory tick: latest decision lookup failed', {
      project_id: projectId,
      stage,
      err: err.message,
    });
    return null;
  }
}

function normalizeTaskTags(task) {
  if (Array.isArray(task?.tags)) {
    return task.tags;
  }
  if (typeof task?.tags !== 'string' || !task.tags.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(task.tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractFactoryBatchId(task) {
  const batchTag = normalizeTaskTags(task).find((tag) => typeof tag === 'string' && tag.startsWith('factory:batch_id='));
  return batchTag ? batchTag.slice('factory:batch_id='.length) : null;
}

function clearTrackedInterval(timer) {
  if (!timer) {
    return;
  }
  timerRegistry.remove(timer);
  clearInterval(timer);
}

function clearTrackedTimeout(timer) {
  if (!timer) {
    return;
  }
  timerRegistry.remove(timer);
  clearTimeout(timer);
}

function clearScheduledProjectTick(projectId) {
  const scheduled = scheduledProjectTicks.get(projectId);
  if (!scheduled) {
    return;
  }
  clearTrackedTimeout(scheduled.timer);
  scheduledProjectTicks.delete(projectId);
}

function scheduleProjectTick(projectId, delayMs = 0, reason = 'scheduled_tick') {
  if (!projectId) {
    return;
  }
  const normalizedDelayMs = Math.max(Math.floor(delayMs), 0);
  const dueAt = Date.now() + normalizedDelayMs;
  const existing = scheduledProjectTicks.get(projectId);
  if (existing && existing.due_at <= dueAt) {
    return;
  }
  clearScheduledProjectTick(projectId);
  const timer = timerRegistry.trackTimeout(setTimeout(() => {
    timerRegistry.remove(timer);
    scheduledProjectTicks.delete(projectId);
    const project = getFreshProject(projectId);
    if (project) {
      tickProject(project);
    }
  }, normalizedDelayMs));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  scheduledProjectTicks.set(projectId, {
    timer,
    due_at: dueAt,
    reason,
  });
}

function scheduleProjectWakeForBatch(batchId, reason = 'task_terminal') {
  if (!batchId) {
    return;
  }
  const activeInstances = factoryLoopInstances.listInstances({ active_only: true });
  const matchingProjectIds = new Set();
  for (const instance of activeInstances) {
    if (instance.terminated_at || instance.batch_id !== batchId) {
      continue;
    }
    matchingProjectIds.add(instance.project_id);
  }
  for (const projectId of matchingProjectIds) {
    scheduleProjectTick(projectId, 0, reason);
  }
}

function ensureTaskUpdateListener() {
  if (taskUpdateListenerRegistered) {
    return;
  }
  eventBus.onTaskUpdated((payload) => {
    const taskId = payload?.taskId;
    if (!taskId) {
      return;
    }
    let task = payload?.updated_task || null;
    const status = payload?.status || task?.status || null;
    if (!TERMINAL_TASK_STATUSES.has(status)) {
      return;
    }
    if (!task) {
      try {
        task = taskCore.getTask(taskId);
      } catch (err) {
        logger.debug('Factory tick: terminal task lookup failed', {
          task_id: taskId,
          status,
          err: err.message,
        });
        return;
      }
    }
    const batchId = extractFactoryBatchId(task);
    if (!batchId) {
      return;
    }
    scheduleProjectWakeForBatch(batchId, `task_${status}`);
  });
  taskUpdateListenerRegistered = true;
}

function ensureFactoryLoopListener() {
  if (factoryLoopListenerRegistered) {
    return;
  }
  eventBus.onFactoryLoopChanged((payload) => {
    if (!payload?.project_id || payload.type !== 'terminated') {
      return;
    }
    scheduleProjectTick(payload.project_id, 0, 'loop_terminated');
  });
  factoryLoopListenerRegistered = true;
}

function ensureEventDrivers() {
  ensureTaskUpdateListener();
  ensureFactoryLoopListener();
}

function shouldAttemptPausedAdvance(project, instance) {
  const pausedAtStage = instance?.paused_at_stage;
  if (!pausedAtStage) {
    return true;
  }
  if (pausedAtStage.startsWith('READY_FOR_')) {
    return true;
  }
  if (pausedAtStage === 'VERIFY') {
    return getLatestStageDecision(project.id, 'verify')?.action === 'waiting_for_batch_tasks';
  }
  return false;
}

function tickProject(projectOrId) {
  ensureEventDrivers();
  const project = getFreshProject(projectOrId);
  if (!project) {
    return;
  }
  if (project.status !== 'running') {
    clearScheduledProjectTick(project.id);
    return;
  }
  try {
    const cfg = getProjectConfig(project);
    const instances = factoryLoopInstances.listInstances({
      project_id: project.id,
      active_only: true,
    });

    if (instances.length > 0) {
      clearScheduledProjectTick(project.id);
      clearAutoContinueAfter(project);
    }

    for (const instance of instances) {
      if (instance.terminated_at) continue;
      const state = instance.loop_state;
      const paused = instance.paused_at_stage;

      // Skip terminated or idle instances.
      if (state === 'IDLE') continue;

      // Recover stuck PAUSED-at-EXECUTE with empty batch: if the EXECUTE
      // stage paused (worktree failure, empty plan, etc.) but there are no
      // running or queued tasks for the batch, terminate and let the
      // scheduler start a fresh cycle later if auto_continue is enabled.
      if (paused === 'EXECUTE' && instance.batch_id) {
        try {
          const batchTag = `factory:batch_id=${instance.batch_id}`;
          const batchTasks = taskCore.listTasks({
            tags: [batchTag],
            status: 'running',
          });
          const queuedTasks = taskCore.listTasks({
            tags: [batchTag],
            status: 'queued',
          });
          if (batchTasks.length === 0 && queuedTasks.length === 0) {
            logger.warn('Factory tick: recovering PAUSED-at-EXECUTE with empty batch', {
              project_id: project.id,
              instance_id: instance.id,
              batch_id: instance.batch_id,
            });
            loopController.terminateInstanceAndSync(instance.id, { abandonWorktree: true });
            continue;
          }
        } catch (checkErr) {
          logger.debug('Factory tick: batch check failed', { err: checkErr.message });
        }
      }

      // Approval pauses stay parked. The only paused state the scheduler may
      // re-drive is VERIFY waiting on non-terminal batch tasks.
      if (!shouldAttemptPausedAdvance(project, instance)) {
        continue;
      }

      try {
        loopController.advanceLoopAsync(instance.id, { autoAdvance: true });
        logger.debug('Factory tick: advanced instance', {
          project_id: project.id,
          instance_id: instance.id,
          state,
          paused_at_stage: paused || null,
        });
      } catch (err) {
        // Expected when an advance job is already running — not an error.
        if (err.message && err.message.includes('already running')) return;
        logger.debug('Factory tick: advance skipped', {
          project_id: project.id,
          instance_id: instance.id,
          err: err.message,
        });
      }
    }

    if (!cfg?.loop?.auto_continue) {
      clearAutoContinueAfter(project);
      clearScheduledProjectTick(project.id);
      return;
    }

    const activeInstanceCount = instances.filter((instance) => !instance.terminated_at).length;
    if (activeInstanceCount > 0) {
      return;
    }

    const autoContinueAfterMs = getAutoContinueAfterMs(project);
    if (autoContinueAfterMs && autoContinueAfterMs > Date.now()) {
      scheduleProjectTick(project.id, autoContinueAfterMs - Date.now(), 'cooldown_restart');
      return;
    }

    try {
      loopController.startLoopAutoAdvance(project.id);
      clearScheduledProjectTick(project.id);
      clearAutoContinueAfter(project);
      logger.info('Factory tick: started new auto-advance loop', {
        project_id: project.id,
      });
    } catch (err) {
      logger.debug('Factory tick: could not start new loop', {
        project_id: project.id,
        err: err.message,
      });
    }
  } catch (err) {
    logger.warn('Factory tick failed for project', {
      project_id: project.id,
      err: err.message,
    });
  }
}

function startTick(project, intervalMs = getTickIntervalMs(project)) {
  ensureEventDrivers();
  const freshProject = getFreshProject(project) || project;
  const nextIntervalMs = toPositiveNumber(intervalMs) || getTickIntervalMs(freshProject);
  const active = activeTimers.get(freshProject.id);
  if (active) {
    if (active.interval_ms === nextIntervalMs) {
      return;
    }
    clearTrackedInterval(active.timer);
    activeTimers.delete(freshProject.id);
  }

  const timer = timerRegistry.trackInterval(setInterval(() => tickProject(freshProject.id), nextIntervalMs));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  activeTimers.set(freshProject.id, {
    timer,
    interval_ms: nextIntervalMs,
  });
  logger.info('Factory tick started', {
    project_id: freshProject.id,
    project_name: freshProject.name,
    interval_ms: nextIntervalMs,
  });

  // Also tick immediately on start so auto_continue projects do not wait for
  // their first interval before resuming work.
  tickProject(freshProject.id);
}

function stopTick(projectId) {
  const active = activeTimers.get(projectId);
  if (active) {
    clearTrackedInterval(active.timer);
    activeTimers.delete(projectId);
    logger.info('Factory tick stopped', { project_id: projectId });
  }
  clearScheduledProjectTick(projectId);
}

function stopAll(reason = 'shutdown') {
  for (const [projectId, active] of activeTimers.entries()) {
    clearTrackedInterval(active.timer);
    logger.info(`Factory tick stopped (${reason})`, { project_id: projectId });
  }
  activeTimers.clear();
  for (const [projectId, scheduled] of scheduledProjectTicks.entries()) {
    clearTrackedTimeout(scheduled.timer);
    logger.info(`Factory tick scheduled wake cleared (${reason})`, { project_id: projectId });
  }
  scheduledProjectTicks.clear();
}

// Called on server startup — scan for running projects and start ticking.
function initFactoryTicks() {
  ensureEventDrivers();
  let started = 0;
  try {
    const projects = factoryHealth.listProjects();
    for (const project of projects) {
      if (project.status !== 'running') continue;
      startTick(project, getTickIntervalMs(project));
      started++;
    }
  } catch (err) {
    logger.warn('initFactoryTicks failed', { err: err.message });
  }
  return started;
}

module.exports = {
  getProjectConfig,
  tickProject,
  startTick,
  stopTick,
  stopAll,
  initFactoryTicks,
};
