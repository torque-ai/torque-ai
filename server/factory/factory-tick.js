'use strict';

// Factory tick — server-side timer that periodically advances active factory
// loop instances. Complements the auto_advance event chain: auto_advance fires
// instantly on stage completion for zero-latency progression, while the tick
// catches anything the chain missed (crashes, timeouts, unhandled states).
//
// Registered via timer-registry so it's tracked alongside other server timers.
// Starts when a project has status=running, stops on pause/stop.

const factoryHealth = require('../db/factory-health');
const factoryLoopInstances = require('../db/factory-loop-instances');
const database = require('../database');
const eventBus = require('../event-bus');
const { handleRetryFactoryVerify } = require('../handlers/factory-handlers');
const loopController = require('./loop-controller');
const { detectStuckLoops } = require('./stuck-loop-detector');
const { recoverStalledVerifyLoops } = require('./verify-stall-recovery');
const logger = require('../logger').child({ component: 'factory-tick' });

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const activeTimers = new Map(); // project_id → intervalId

function getProjectConfig(project) {
  if (!project.config_json) return {};
  try { return JSON.parse(project.config_json); } catch (_e) { void _e; return {}; }
}

async function tickProject(project) {
  try {
    // Auto-resume: if the project is paused but has auto_continue, the
    // operator didn't explicitly pause it — it drifted (restart, reset,
    // instance termination set status=paused). Resume it so the tick
    // can do its job. Explicit operator pauses use pause_project which
    // also calls stopTick — so if the tick IS running, the pause wasn't
    // intentional.
    const freshProject = factoryHealth.getProject(project.id);
    if (freshProject && freshProject.status === 'paused') {
      const cfg = getProjectConfig(freshProject);
      if (cfg?.loop?.auto_continue) {
        factoryHealth.updateProject(project.id, { status: 'running' });
        logger.info('Factory tick: auto-resumed paused auto_continue project', {
          project_id: project.id,
          project_name: freshProject.name,
        });
      } else {
        return; // genuinely paused, no auto_continue — skip
      }
    }

    const instances = factoryLoopInstances.listInstances({
      project_id: project.id,
      active_only: true,
    });

    for (const instance of instances) {
      if (instance.terminated_at) continue;
      const state = instance.loop_state;
      const paused = instance.paused_at_stage;

      // Skip terminated or idle instances
      if (state === 'IDLE') continue;

      // Recover stuck PAUSED-at-EXECUTE with empty batch: if the EXECUTE
      // stage paused (worktree failure, empty plan, etc.) but there are no
      // running or queued tasks for the batch, terminate and let the tick's
      // auto-start logic begin a fresh cycle with the next work item.
      if (paused === 'EXECUTE' && instance.batch_id) {
        try {
          const taskCore = require('../db/task-core');
          const batchTasks = taskCore.listTasks({
            tags: [`factory:batch_id=${instance.batch_id}`],
            status: 'running',
          });
          const queuedTasks = taskCore.listTasks({
            tags: [`factory:batch_id=${instance.batch_id}`],
            status: 'queued',
          });
          if (batchTasks.length === 0 && queuedTasks.length === 0) {
            logger.warn('Factory tick: recovering PAUSED-at-EXECUTE with empty batch', {
              project_id: project.id,
              instance_id: instance.id,
              batch_id: instance.batch_id,
            });
            loopController.terminateInstanceAndSync(instance.id, { abandonWorktree: true });
            continue; // auto-start below will create a fresh instance
          }
        } catch (checkErr) {
          logger.debug('Factory tick: batch check failed', { err: checkErr.message });
        }
      }

      // Skip paused-at-gate instances (need operator approval, not a tick)
      if (paused && !paused.startsWith('READY_FOR_') && paused !== 'EXECUTE') continue;

      try {
        loopController.advanceLoopAsync(instance.id, { autoAdvance: true });
        logger.debug('Factory tick: advanced instance', {
          project_id: project.id,
          instance_id: instance.id,
          state,
        });
      } catch (err) {
        // Expected when an advance job is already running — not an error
        if (err.message && err.message.includes('already running')) return;
        logger.debug('Factory tick: advance skipped', {
          project_id: project.id,
          instance_id: instance.id,
          err: err.message,
        });
      }
    }

    // If no active instances exist for a running + auto_continue project,
    // start a new loop automatically.
    const cfg = getProjectConfig(project);
    if (cfg?.loop?.auto_continue && instances.filter(i => !i.terminated_at).length === 0) {
      try {
        loopController.startLoopAutoAdvance(project.id);
        logger.info('Factory tick: started new auto-advance loop', {
          project_id: project.id,
        });
      } catch (err) {
        logger.debug('Factory tick: could not start new loop', {
          project_id: project.id,
          err: err.message,
        });
      }
    }

    // Drift reconciliation: sync the legacy project-level loop_state
    // columns from the active instance every tick. Idempotent. Closes
    // the dual-source-of-truth gap where project_row.loop_state can
    // lie about a dead loop (e.g. when restart barrier terminates an
    // instance but nothing updates the project row). Without this,
    // factory_status can report EXECUTE for a project with zero
    // active instances for hours — exactly the pattern that hid two
    // of three projects sitting idle on 2026-04-18.
    try {
      loopController.syncLegacyProjectLoopState(project.id);
    } catch (err) {
      logger.debug('Factory tick: legacy state sync failed', {
        project_id: project.id,
        err: err.message,
      });
    }

    const db = database.getDbInstance();
    if (db) {
      for (const stuckLoop of detectStuckLoops(db)) {
        const payload = {
          event: 'factory_loop_stalled',
          project_id: stuckLoop.project_id,
          project_name: stuckLoop.project_name,
          loop_state: stuckLoop.loop_state,
          stalled_minutes: stuckLoop.stalled_minutes,
        };
        logger.warn('Factory tick detected stalled loop', payload);
        eventBus.emitFactoryLoopStalled(payload);
      }

      await recoverStalledVerifyLoops({
        db,
        logger,
        eventBus,
        retryFactoryVerify: ({ project_id }) => handleRetryFactoryVerify({ project: project_id }),
      });
    }
  } catch (err) {
    logger.warn('Factory tick failed for project', {
      project_id: project.id,
      err: err.message,
    });
  }
}

function startTick(project, intervalMs = DEFAULT_TICK_INTERVAL_MS) {
  if (activeTimers.has(project.id)) return; // already ticking

  const timer = setInterval(() => { void tickProject(project); }, intervalMs);
  activeTimers.set(project.id, timer);
  logger.info('Factory tick started', {
    project_id: project.id,
    project_name: project.name,
    interval_ms: intervalMs,
  });

  // Also tick immediately on start (don't wait for first interval).
  // Defer via setImmediate so the tick can't block the event loop during
  // startup — tickProject uses spawnSync for git worktree ops, and if those
  // hang (filesystem lock, stale lockfile) the entire server would stall
  // after binding its ports but before serving any HTTP requests.
  setImmediate(() => {
    void tickProject(project);
  });
}

function stopTick(projectId) {
  const timer = activeTimers.get(projectId);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(projectId);
    logger.info('Factory tick stopped', { project_id: projectId });
  }
}

function stopAll() {
  for (const [projectId, timer] of activeTimers) {
    clearInterval(timer);
    logger.info('Factory tick stopped (shutdown)', { project_id: projectId });
  }
  activeTimers.clear();
}

// Called on server startup — scan for projects that should be ticking.
// Includes running projects AND paused projects with auto_continue
// (the tick's auto-resume logic will set them back to running).
function initFactoryTicks() {
  let started = 0;
  try {
    const projects = factoryHealth.listProjects();
    for (const project of projects) {
      const cfg = getProjectConfig(project);
      const shouldTick = project.status === 'running'
        || (project.status === 'paused' && cfg?.loop?.auto_continue);
      if (!shouldTick) continue;
      const intervalMs = cfg?.loop?.tick_interval_ms || DEFAULT_TICK_INTERVAL_MS;
      startTick(project, intervalMs);
      started++;
    }
  } catch (err) {
    logger.warn('initFactoryTicks failed', { err: err.message });
  }
  return started;
}

module.exports = {
  initFactoryTicks,
  startTick,
  stopTick,
  stopAll,
  tickProject,
};
