'use strict';

/**
 * validation/register.js — register every validation module with the
 * DI container.
 *
 * Phase 2 of the universal-DI migration. The first migrated citizen is
 * `safeguardGates`; subsequent commits add the rest of the validation
 * subsystem (post-task, output-safeguards, close-phases, build-verification,
 * auto-verify-retry, hashline-verify) one at a time.
 *
 * Usage from container.js:
 *   require('./validation/register').register(_defaultContainer);
 *
 * Usage from tests:
 *   const { createContainer } = require('../container');
 *   const container = createContainer();
 *   container.registerValue('db', mockDb);
 *   require('../validation/register').register(container);
 *   container.boot();
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

const safeguardGates = require('./safeguard-gates');
const hashlineVerify = require('./hashline-verify');
const buildVerification = require('./build-verification');
const closePhases = require('./close-phases');
const autoVerifyRetry = require('./auto-verify-retry');
const outputSafeguards = require('./output-safeguards');
const postTask = require('./post-task');

function register(container) {
  safeguardGates.register(container);
  hashlineVerify.register(container);
  buildVerification.register(container);
  closePhases.register(container);
  autoVerifyRetry.register(container);
  outputSafeguards.register(container);
  postTask.register(container);
  // All validation/ modules registered. The container path is now ready
  // for consumers; task-manager.js still uses the legacy init() shape and
  // migrates in Phase 3 (execution/ subsystem).
}

module.exports = { register };
