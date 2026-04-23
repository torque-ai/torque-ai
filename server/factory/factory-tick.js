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
const { getRejectRecoveryConfig } = require('../db/config-core');
const database = require('../database');
const eventBus = require('../event-bus');
const { handleRetryFactoryVerify } = require('../handlers/factory-handlers');
const loopController = require('./loop-controller');
const { detectStuckLoops } = require('./stuck-loop-detector');
const { runRejectedRecoverySweep } = require('./rejected-recovery');
const { recoverStalledVerifyLoops } = require('./verify-stall-recovery');
const { reconcileProject: reconcileOrphanWorktrees } = require('./worktree-reconcile');
const factoryNotifications = require('./notifications');
const { LOOP_STATES } = require('./loop-states');
const logger = require('../logger').child({ component: 'factory-tick' });

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const activeTimers = new Map(); // project_id → intervalId

function getProjectConfig(project) {
  if (!project.config_json) return {};
  try { return JSON.parse(project.config_json); } catch (_e) { void _e; return {}; }
}

async function maybeRecoverStarvedProject(project) {
  try {
    const container = require('../container').defaultContainer;
    const starvationRecovery = container.get('starvationRecovery');
    if (!starvationRecovery || typeof starvationRecovery.maybeRecover !== 'function') {
      return null;
    }
    const result = await starvationRecovery.maybeRecover(project);
    if (result?.recovered) {
      logger.info('Factory tick recovered STARVED project', {
        project_id: project.id,
        reason: result.reason,
      });
    } else if (result?.reason && result.reason !== 'not_starved') {
      logger.debug('Factory tick left STARVED project parked', {
        project_id: project.id,
        reason: result.reason,
      });
    }
    return result;
  } catch (err) {
    logger.warn('Factory tick: STARVED recovery failed', {
      project_id: project?.id,
      err: err.message,
    });
    return null;
  }
}

async function tickProject(project) {
  try {
    const freshProject = factoryHealth.getProject(project.id);

    // Baseline probe phase — for projects paused by the verify-review
    // classifier when a baseline (main) was already broken. Task 9 sets
    // baseline_broken_since + baseline_broken_probe_attempts=0 +
    // baseline_broken_tick_count=0. We re-run verify_command on an
    // exponential-backoff schedule (gaps: 1, 2, 4, 8, 12, 12, 12 ticks).
    // Green probe → clear flag and resume. Red probe → increment attempts
    // and wait the next backoff slot.
    if (freshProject && freshProject.status === 'paused') {
      const cfg = getProjectConfig(freshProject);
      if (cfg.baseline_broken_since) {
        const prevTickCount = Number.isFinite(cfg.baseline_broken_tick_count) ? cfg.baseline_broken_tick_count : 0;
        const nextTickCount = prevTickCount + 1;
        const attempts = Number.isFinite(cfg.baseline_broken_probe_attempts) ? cfg.baseline_broken_probe_attempts : 0;
        // targetTick = cumulative ticks needed to hit probe N+1 where N = attempts.
        // gaps: gap[0]=1 (first probe), gap[i]=min(2^i, 12) for i>=1.
        let targetTick = 0;
        for (let i = 0; i <= attempts; i += 1) {
          targetTick += i === 0 ? 1 : Math.min(Math.pow(2, i), 12);
        }
        const shouldProbe = nextTickCount > targetTick;

        if (shouldProbe) {
          const baselineProbe = require('./baseline-probe');
          let verifyCommand = cfg.verify_command || null;
          if (!verifyCommand) {
            try {
              const projectConfigCore = require('../db/project-config-core');
              const defaults = projectConfigCore.getProjectDefaults(project.path || project.id);
              if (defaults && defaults.verify_command) verifyCommand = defaults.verify_command;
            } catch (_e) { void _e; }
          }
          const runnerRegistry = require('../test-runner-registry').createTestRunnerRegistry();
          const runner = async ({ command, cwd, timeoutMs }) => {
            const r = await runnerRegistry.runVerifyCommand(command, cwd, { timeout: timeoutMs });
            return {
              exitCode: r.exitCode,
              stdout: r.output || '',
              stderr: r.error || '',
              durationMs: r.durationMs,
              timedOut: !!r.timedOut,
            };
          };

          let probe;
          try {
            const timeoutMs = baselineProbe.resolveBaselineProbeTimeoutMs({ config: cfg });
            probe = await baselineProbe.probeProjectBaseline({
              project: freshProject,
              verifyCommand,
              runner,
              timeoutMs,
            });
          } catch (err) {
            probe = { passed: false, error: 'runner_threw', exitCode: null, output: err.message, durationMs: 0 };
          }

          if (probe.passed) {
            const pausedSince = Date.parse(cfg.baseline_broken_since) || Date.now();
            cfg.baseline_broken_since = null;
            cfg.baseline_broken_reason = null;
            cfg.baseline_broken_evidence = null;
            cfg.baseline_broken_probe_attempts = 0;
            cfg.baseline_broken_tick_count = 0;
            factoryHealth.updateProject(project.id, {
              status: 'running',
              config_json: JSON.stringify(cfg),
            });
            try {
              eventBus.emitFactoryProjectBaselineCleared({
                project_id: project.id,
                cleared_after_ms: Date.now() - pausedSince,
              });
            } catch (_e) { void _e; }
            logger.info('Factory tick: baseline cleared by probe', {
              project_id: project.id,
              attempts_before_clear: attempts + 1,
            });
          } else {
            cfg.baseline_broken_probe_attempts = attempts + 1;
            cfg.baseline_broken_tick_count = nextTickCount;
            factoryHealth.updateProject(project.id, { config_json: JSON.stringify(cfg) });
            logger.info('Factory tick: baseline probe still red', {
              project_id: project.id,
              attempts: cfg.baseline_broken_probe_attempts,
              reason: probe.error || 'non_zero_exit',
            });
          }
        } else {
          cfg.baseline_broken_tick_count = nextTickCount;
          factoryHealth.updateProject(project.id, { config_json: JSON.stringify(cfg) });
        }
        return;
      }
      return; // paused projects stay paused until explicitly resumed
    }

    if (freshProject && freshProject.loop_state === LOOP_STATES.STARVED) {
      await maybeRecoverStarvedProject(freshProject);
      return;
    }

    // Reconcile orphan worktrees left behind by prior crashed/restarted
    // instances. If a .worktrees/feat-factory-* dir exists with its
    // factory_worktrees row marked abandoned/shipped/merged (or missing
    // entirely for a factory-named branch), `git worktree add` will later
    // fail with "already exists" and pause the loop at EXECUTE. Clean these
    // up now so the subsequent auto-start finds a usable disk state. Fail
    // soft — reconciliation is best-effort and must not stall the tick.
    try {
      const db = database.getDbInstance();
      if (db && project.path) {
        const result = reconcileOrphanWorktrees({
          db,
          project_id: project.id,
          project_path: project.path,
        });
        if (result.cleaned.length > 0 || result.failed.length > 0) {
          logger.info('Factory tick: worktree reconcile', {
            project_id: project.id,
            scanned: result.scanned,
            cleaned: result.cleaned.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
          });
        }
      }
    } catch (err) {
      logger.debug('Factory tick: worktree reconcile failed', {
        project_id: project.id,
        err: err.message,
      });
    }

    const instances = factoryLoopInstances.listInstances({
      project_id: project.id,
      active_only: true,
    });

    for (const instance of instances) {
      if (instance.terminated_at) continue;
      const state = instance.loop_state;
      const paused = instance.paused_at_stage;

      const latestProject = factoryHealth.getProject(project.id);
      if (!latestProject || latestProject.status !== 'running') {
        return;
      }

      // Skip terminated or idle instances
      if (state === LOOP_STATES.IDLE) continue;

      if (state === LOOP_STATES.STARVED) {
        await maybeRecoverStarvedProject({
          ...latestProject,
          loop_state: LOOP_STATES.STARVED,
          loop_last_action_at: instance.last_action_at || latestProject.loop_last_action_at,
        });
        continue;
      }

      // Self-heal: VERIFY gate pauses with reason `batch_tasks_not_terminal`
      // don't clear on their own when the blocking batch tasks finish, because
      // no stage runs while paused-at-gate. Re-check the batch; if it's now
      // fully terminal, auto-approve the gate so the next tick advances.
      // Narrowly scoped: only `paused_at_stage === VERIFY` AND the latest
      // VERIFY decision's outcome.reason confirms the bug shape, so other
      // VERIFY pause causes (human approval, VERIFY_FAIL) are untouched.
      if (paused === 'VERIFY' && instance.batch_id) {
        try {
          const latest = loopController.getLatestStageDecision(project.id, 'VERIFY');
          const latestReason = latest?.outcome?.reason || null;
          const isBatchWaitPause = latestReason === 'batch_tasks_not_terminal'
            || latest?.action === 'waiting_for_batch_tasks';
          if (isBatchWaitPause) {
            const batchTasks = loopController.listTasksForFactoryBatch(instance.batch_id);
            const nonTerminal = batchTasks.filter(
              (t) => !['completed', 'shipped', 'cancelled', 'failed'].includes(t.status),
            );
            if (batchTasks.length > 0 && nonTerminal.length === 0) {
              logger.info('Factory tick: auto-clearing VERIFY gate — batch now terminal', {
                project_id: project.id,
                instance_id: instance.id,
                batch_id: instance.batch_id,
                batch_task_count: batchTasks.length,
              });
              try {
                loopController.approveGateForProject(project.id, 'VERIFY');
              } catch (approveErr) {
                logger.debug('Factory tick: auto-approve VERIFY gate failed', {
                  project_id: project.id,
                  instance_id: instance.id,
                  err: approveErr.message,
                });
              }
              continue; // next tick picks up the now-cleared instance
            }
          }
        } catch (checkErr) {
          logger.debug('Factory tick: VERIFY gate recheck failed', { err: checkErr.message });
        }
      }

      // Skip paused-at-gate instances (need operator approval, not a tick).
      // READY_FOR_* and paused EXECUTE still participate because the tick can
      // either advance or recover those states.
      const pausedAtGate = paused && !paused.startsWith('READY_FOR_') && paused !== 'EXECUTE';
      if (pausedAtGate) continue;

      try {
        const stallAlert = factoryNotifications.recordFactoryTickState({
          project_id: project.id,
          project_status: latestProject.status,
          stage: state,
          paused_at_stage: paused,
          instance_id: instance.id,
          batch_id: instance.batch_id,
          last_action_at: instance.last_action_at,
        });
        if (stallAlert.alerted) {
          logger.warn('Factory tick emitted stalled alert', {
            project_id: project.id,
            instance_id: instance.id,
            loop_state: state,
            stalled_minutes: stallAlert.alert?.stalled_minutes,
          });
        }
      } catch (alertErr) {
        logger.debug('Factory tick stalled alert check failed', {
          project_id: project.id,
          instance_id: instance.id,
          err: alertErr.message,
        });
      }

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
    const projectBeforeAutoStart = factoryHealth.getProject(project.id);
    if (!projectBeforeAutoStart || projectBeforeAutoStart.status !== 'running') {
      return;
    }
    const cfg = getProjectConfig(projectBeforeAutoStart);
    if (
      cfg?.loop?.auto_continue
      && projectBeforeAutoStart.loop_state !== LOOP_STATES.STARVED
      && instances.filter(i => !i.terminated_at).length === 0
    ) {
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

      const rejectRecoveryConfig = getRejectRecoveryConfig();
      if (rejectRecoveryConfig.enabled) {
        await runRejectedRecoverySweep({
          db,
          logger,
          config: rejectRecoveryConfig,
        });
      }

      // Auto-recovery sweep — once per tick, across all eligible projects.
      // Loaded from auto-recovery engine registered in DI container at startup.
      try {
        const container = require('../container').defaultContainer;
        const autoRecoveryEngine = container.get('autoRecoveryEngine');
        if (autoRecoveryEngine && typeof autoRecoveryEngine.tick === 'function') {
          const summary = await autoRecoveryEngine.tick();
          if (summary && summary.attempts > 0) {
            logger.info('auto-recovery tick ran recovery attempts', summary);
          }
        }
      } catch (err) {
        logger.warn('auto-recovery tick failed', { err: err.message });
      }
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
// Running projects tick normally. Paused baseline-probe projects keep ticking
// only to check whether the broken baseline has recovered.
function initFactoryTicks() {
  let started = 0;
  try {
    const projects = factoryHealth.listProjects();
    for (const project of projects) {
      const cfg = getProjectConfig(project);
      const shouldTick = project.status === 'running'
        || (project.status === 'paused' && cfg?.baseline_broken_since);
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
