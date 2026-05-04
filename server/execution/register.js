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

function register(container) {
  planProjectResolver.register(container);
  workflowResume.register(container);
  retryFramework.register(container);
  commandBuilders.register(container);
  fileContextBuilder.register(container);
  // TODO(phase 3 cont.): register the remaining execution modules
  //   - process-streams.js          (343 LOC)
  //   - debug-lifecycle.js          (430 LOC)
  //   - provider-router.js          (535 LOC)
  //   - completion-pipeline.js      (561 LOC)
  //   - slot-pull-scheduler.js      (645 LOC)
  //   - process-lifecycle.js        (949 LOC)
  //   - fallback-retry.js          (1132 LOC)
  //   - task-finalizer.js          (1364 LOC)
  //   - queue-scheduler.js         (1570 LOC)
  //   - workflow-runtime.js        (1875 LOC)
  //   - task-startup.js            (2017 LOC)
}

module.exports = { register };
