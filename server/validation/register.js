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

function register(container) {
  safeguardGates.register(container);
  // TODO(phase 2 follow-up): register the remaining validation modules
  //   - validation/post-task.js
  //   - validation/output-safeguards.js
  //   - validation/close-phases.js
  //   - validation/build-verification.js
  //   - validation/auto-verify-retry.js
  //   - validation/hashline-verify.js
}

module.exports = { register };
