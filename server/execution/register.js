'use strict';

/**
 * execution/register.js — register execution modules with the DI container.
 *
 * Universal-DI migration. Each execution module exposes both a legacy
 * init({…}) shape and a new createXxx(deps) + register(container) shape.
 * This file controls which of those new shapes are *active* in the
 * container — i.e. which ones boot() instantiates so consumers can
 * resolve them via container.get(name).
 *
 * Usage from container.js:
 *   require('./execution/register').register(_defaultContainer);
 *
 * ── Wired vs deferred ────────────────────────────────────────────────
 *
 * Only modules whose declared deps are themselves container-managed
 * services or values can be wired now. Modules that pre-declare deps
 * that are utility functions or closures owned by task-manager.js
 * (e.g. processQueue, runningProcesses, attemptTaskStart, parseCommand)
 * cannot be eagerly resolved by container.boot() — those deps don't
 * exist as container entries, so registering them causes boot() to
 * throw `service depends on '<x>' which is not registered`.
 *
 * Those modules stay registered in source (their factory shape is
 * available for direct require + createXxx(...) use) but are NOT
 * activated in the container until either:
 *   (a) task-manager.js migrates the consumer call site to container.get(),
 *       at which point the shared closures it owns can be promoted to
 *       container values; OR
 *   (b) the module's dep list is pruned to only the truly-stateful
 *       services it consumes (the utility functions become plain
 *       require() at the top of the module).
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

// ── Wired (deps fully container-managed) ─────────────────────────────
const planProjectResolver = require('./plan-project-resolver');     // [db, dashboard]
const workflowResume = require('./workflow-resume');                // [db, eventBus, logger]
const workflowRuntime = require('./workflow-runtime');              // [db, dashboard, taskManager]
const fallbackRetry = require('./fallback-retry');                  // [db, dashboard, taskManager]
const retryFramework = require('./retry-framework');                // [db, taskManager]
const commandBuilders = require('./command-builders');              // [db]
const fileContextBuilder = require('./file-context-builder');       // [db]
const processStreams = require('./process-streams');                // [db, dashboard, taskManager]
const processLifecycle = require('./process-lifecycle');            // [dashboard, taskManager]
const debugLifecycle = require('./debug-lifecycle');                // [taskManager]
const completionPipeline = require('./completion-pipeline');        // [db]
const slotPullScheduler = require('./slot-pull-scheduler');         // [db, dashboard, sharedFactoryStore, taskManager]
const queueScheduler = require('./queue-scheduler');                // [db, taskManager, eventBus]
const providerRouter = require('./provider-router');                // [db, serverConfig, taskManager]
const taskCancellation = require('./task-cancellation');            // [db, logger, taskManager] — taskCanceller capability
const taskFinalizer = require('./task-finalizer');                  // [db, taskManager]
const taskStartup = require('./task-startup');                      // [db, dashboard, serverConfig, providerRegistry, gpuMetrics, taskManager]

// ── Deferred (deps include task-manager-owned closures / utilities) ──
// Empty — all execution/ modules are now wired. The "deferred" bucket
// existed during the universal-DI migration; if a future module needs
// to land deferred again, add the require() here so its register()
// function is loaded as a side effect without being activated.

function register(container) {
  // Activate only the modules whose deps are fully container-managed.
  // The remaining modules' register() functions are defined and ready;
  // they're simply not called until their consumer-side blockers clear.
  planProjectResolver.register(container);
  workflowResume.register(container);
  workflowRuntime.register(container);
  fallbackRetry.register(container);
  retryFramework.register(container);
  commandBuilders.register(container);
  fileContextBuilder.register(container);
  processStreams.register(container);
  processLifecycle.register(container);
  debugLifecycle.register(container);
  completionPipeline.register(container);
  slotPullScheduler.register(container);
  queueScheduler.register(container);
  providerRouter.register(container);
  taskCancellation.register(container);
  taskFinalizer.register(container);
  taskStartup.register(container);
}

module.exports = { register };
