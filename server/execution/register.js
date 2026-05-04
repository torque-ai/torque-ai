'use strict';

/**
 * execution/register.js — register every execution module with the
 * DI container.
 *
 * Phase 3 of the universal-DI migration. Adds modules incrementally —
 * each commit registers one more migrated module. Once task-manager.js
 * stops calling each module's legacy init(), the legacy shape gets
 * deleted from the module file.
 *
 * Usage from container.js:
 *   require('./execution/register').register(_defaultContainer);
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

const planProjectResolver = require('./plan-project-resolver');
const workflowResume = require('./workflow-resume');
const retryFramework = require('./retry-framework');
const commandBuilders = require('./command-builders');
const fileContextBuilder = require('./file-context-builder');
const processStreams = require('./process-streams');
const debugLifecycle = require('./debug-lifecycle');
const providerRouter = require('./provider-router');
const completionPipeline = require('./completion-pipeline');
const slotPullScheduler = require('./slot-pull-scheduler');
const processLifecycle = require('./process-lifecycle');
const fallbackRetry = require('./fallback-retry');

function register(container) {
  planProjectResolver.register(container);
  workflowResume.register(container);
  retryFramework.register(container);
  commandBuilders.register(container);
  fileContextBuilder.register(container);
  processStreams.register(container);
  debugLifecycle.register(container);
  providerRouter.register(container);
  completionPipeline.register(container);
  slotPullScheduler.register(container);
  processLifecycle.register(container);
  fallbackRetry.register(container);
  // TODO(phase 3 cont.): register the remaining execution modules
  //   - task-finalizer.js          (1364 LOC)
  //   - queue-scheduler.js         (1570 LOC)
  //   - workflow-runtime.js        (1875 LOC)
  //   - task-startup.js            (2017 LOC)
}

module.exports = { register };
