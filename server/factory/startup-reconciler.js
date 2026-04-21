'use strict';

const database = require('../database');
const factoryHealth = require('../db/factory-health');
const factoryLoopInstances = require('../db/factory-loop-instances');
const taskCore = require('../db/task-core');
const eventBus = require('../event-bus');
const defaultLogger = require('../logger').child({ component: 'factory-startup-reconciler' });
const loopController = require('./loop-controller');
const { LOOP_STATES } = require('./loop-states');
const worktreeReconcile = require('./worktree-reconcile');

let alreadyReconciled = false;

function safeLog(logger, level, message, payload) {
  const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (!fn) return;
  try {
    fn.call(logger, message, payload);
  } catch {
    // Logging must not make startup reconciliation fail.
  }
}

function getProjectConfig(project) {
  if (project && project.config && typeof project.config === 'object') {
    return project.config;
  }
  if (!project || !project.config_json) {
    return {};
  }
  try {
    return JSON.parse(project.config_json) || {};
  } catch {
    return {};
  }
}

function getLoopState(loopRecord) {
  const raw = loopRecord && loopRecord.loop_state ? loopRecord.loop_state : LOOP_STATES.IDLE;
  return String(raw).toUpperCase();
}

function getPausedStage(loopRecord) {
  return (loopRecord && (loopRecord.paused_at_stage || loopRecord.loop_paused_at_stage)) || null;
}

function isReadyGate(pausedStage) {
  return typeof pausedStage === 'string' && pausedStage.startsWith('READY_FOR_');
}

function countRunningOrQueuedTasksForBatch(batchId, logger = defaultLogger) {
  if (!batchId) {
    return 0;
  }

  try {
    const tasks = taskCore.listTasks({
      tags: [`factory:batch_id=${batchId}`],
      limit: 200,
      includeArchived: true,
    });
    return tasks.filter((task) => task.status === 'running' || task.status === 'queued').length;
  } catch (err) {
    safeLog(logger, 'debug', 'startup reconciler batch task count failed', {
      batch_id: batchId,
      err: err.message,
    });
    return 0;
  }
}

function scheduleStart(projectId, logger) {
  setImmediate(() => {
    try {
      loopController.startLoopAutoAdvance(projectId);
    } catch (err) {
      safeLog(logger, 'debug', 'startup reconciler start failed', {
        project_id: projectId,
        err: err.message,
      });
    }
  });
}

function scheduleAdvance(projectId, instance, state, logger) {
  setImmediate(() => {
    try {
      loopController.advanceLoopAsync(instance.id, { autoAdvance: true });
    } catch (err) {
      safeLog(logger, 'debug', 'startup reconciler advance failed', {
        project_id: projectId,
        instance_id: instance.id,
        state,
        err: err.message,
      });
    }
  });
}

function emitVerifyNeedsRetry(project, instance, logger) {
  const payload = {
    event: 'factory_verify_needs_retry',
    project_id: project.id,
    instance_id: instance.id,
    batch_id: instance.batch_id || null,
  };

  if (eventBus && typeof eventBus.emitFactoryVerifyNeedsRetry === 'function') {
    eventBus.emitFactoryVerifyNeedsRetry(payload);
    return;
  }

  safeLog(logger, 'info', 'Factory VERIFY-state instance deferred on startup', payload);
}

function reconcileWorktreesBeforeAdvance(project, logger, actions) {
  if (!worktreeReconcile || typeof worktreeReconcile.reconcileProject !== 'function') {
    safeLog(logger, 'debug', 'startup reconciler worktree reconcile unavailable', {
      project_id: project.id,
    });
    return;
  }

  try {
    const db = database.getDbInstance();
    if (!db || !project.path) {
      return;
    }

    const result = worktreeReconcile.reconcileProject({
      db,
      project_id: project.id,
      project_path: project.path,
    });
    actions.worktrees_reconciled += result && Array.isArray(result.cleaned)
      ? result.cleaned.length
      : 0;
  } catch (err) {
    safeLog(logger, 'debug', 'startup reconciler worktree reconcile failed', {
      project_id: project.id,
      err: err.message,
    });
  }
}

function createActionCounters() {
  return {
    projects_scanned: 0,
    advanced: 0,
    restarted: 0,
    skipped: 0,
    deferred_verify: 0,
    worktrees_reconciled: 0,
  };
}

function reconcileFactoryProjectsOnStartup({ logger = defaultLogger } = {}) {
  if (alreadyReconciled) {
    return {
      reconciled: false,
      reason: 'already_reconciled',
      actions: createActionCounters(),
    };
  }

  const actions = createActionCounters();

  let projects;
  try {
    projects = factoryHealth.listProjects({ status: 'running' });
  } catch (err) {
    safeLog(logger, 'warn', 'startup factory reconciler scan failed', { err: err.message });
    return {
      reconciled: false,
      reason: 'scan_failed',
      error: err.message,
      actions,
    };
  }

  for (const project of projects) {
    actions.projects_scanned += 1;
    const preSyncState = {
      loop_state: project.loop_state,
      loop_batch_id: project.loop_batch_id,
      loop_paused_at_stage: project.loop_paused_at_stage,
    };

    try {
      reconcileWorktreesBeforeAdvance(project, logger, actions);
      loopController.syncLegacyProjectLoopState(project.id);

      const instances = factoryLoopInstances.listInstances({
        project_id: project.id,
        active_only: true,
      }).filter((instance) => !instance.terminated_at);

      if (instances.length === 0) {
        const config = getProjectConfig(project);
        const preSyncLoopState = preSyncState.loop_state == null
          ? null
          : String(preSyncState.loop_state).toUpperCase();
        const wasRunningBeforeRestart = (
          preSyncLoopState !== null
          && preSyncLoopState !== LOOP_STATES.IDLE
        )
          || config?.loop?.auto_advance === true
          || config?.loop?.auto_continue === true;

        if (wasRunningBeforeRestart) {
          scheduleStart(project.id, logger);
          actions.restarted += 1;
        } else {
          actions.skipped += 1;
        }
        continue;
      }

      for (const instance of instances) {
        const state = getLoopState(instance);
        const paused = getPausedStage(instance);

        if (isReadyGate(paused)) {
          actions.skipped += 1;
          continue;
        }

        if (paused === 'VERIFY_FAIL') {
          actions.skipped += 1;
          continue;
        }

        if (paused === LOOP_STATES.EXECUTE) {
          if (countRunningOrQueuedTasksForBatch(instance.batch_id, logger) === 0) {
            loopController.terminateInstanceAndSync(instance.id, { abandonWorktree: true });
            scheduleStart(project.id, logger);
            actions.restarted += 1;
          } else {
            actions.skipped += 1;
          }
          continue;
        }

        if (state === LOOP_STATES.VERIFY) {
          emitVerifyNeedsRetry(project, instance, logger);
          actions.deferred_verify += 1;
          continue;
        }

        if (state === LOOP_STATES.IDLE || paused) {
          actions.skipped += 1;
          continue;
        }

        scheduleAdvance(project.id, instance, state, logger);
        actions.advanced += 1;
      }
    } catch (err) {
      actions.skipped += 1;
      safeLog(logger, 'warn', 'startup factory project reconcile failed', {
        project_id: project.id,
        err: err.message,
      });
    }
  }

  alreadyReconciled = true;

  // Auto-recovery engine startup reconcile — resets stuck instances, clears
  // exhausted flags for projects whose loop_state recovered externally, etc.
  // Fire-and-forget because this function is synchronous; the engine reports
  // via its own decision log.
  try {
    const container = require('../container').defaultContainer;
    const autoRecoveryEngine = container.get('autoRecoveryEngine');
    if (autoRecoveryEngine && typeof autoRecoveryEngine.reconcileOnStartup === 'function') {
      Promise.resolve(autoRecoveryEngine.reconcileOnStartup())
        .then((summary) => {
          safeLog(logger, 'info', 'auto-recovery startup reconcile completed', summary || {});
        })
        .catch((err) => {
          safeLog(logger, 'warn', 'auto-recovery startup reconcile failed', { err: err.message });
        });
    }
  } catch (err) {
    safeLog(logger, 'warn', 'auto-recovery startup reconcile dispatch failed', { err: err.message });
  }

  return {
    reconciled: true,
    actions,
  };
}

/**
 * @deprecated Use reconcileFactoryProjectsOnStartup().
 */
const resumeAutoAdvanceOnStartup = reconcileFactoryProjectsOnStartup;

module.exports = {
  reconcileFactoryProjectsOnStartup,
  resumeAutoAdvanceOnStartup,
};
