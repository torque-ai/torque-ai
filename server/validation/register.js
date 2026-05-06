'use strict';

/**
 * validation/register.js — register validation modules with the DI container.
 *
 * Each validation module exposes both a legacy init({…}) shape and the new
 * createXxx(deps) + register(container) shape. After the universal-DI
 * migration, all 7 modules resolve their utility deps internally via
 * require() and bind taskManager methods through the registered
 * taskManager handle, so the only deps they declare are true container
 * services. They can all be wired at boot.
 *
 * Usage from container.js:
 *   require('./validation/register').register(_defaultContainer);
 *
 * Usage from tests:
 *   const { createContainer } = require('../container');
 *   const container = createContainer();
 *   container.registerValue('db', mockDb);
 *   container.registerValue('taskManager', mockTaskManager);
 *   require('../validation/register').register(container);
 *   container.boot();
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

const safeguardGates = require('./safeguard-gates');           // [db, dashboard, taskManager]
const hashlineVerify = require('./hashline-verify');           // []
const buildVerification = require('./build-verification');     // [db, testRunnerRegistry]
const closePhases = require('./close-phases');                 // [db, dashboard, taskManager]
const autoVerifyRetry = require('./auto-verify-retry');        // [db, taskManager, testRunnerRegistry]
const outputSafeguards = require('./output-safeguards');       // [db]
const postTask = require('./post-task');                       // [db, testRunnerRegistry]

function register(container) {
  safeguardGates.register(container);
  hashlineVerify.register(container);
  buildVerification.register(container);
  closePhases.register(container);
  autoVerifyRetry.register(container);
  outputSafeguards.register(container);
  postTask.register(container);
}

module.exports = { register };
