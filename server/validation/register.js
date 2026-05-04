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

function register(container) {
  safeguardGates.register(container);
  hashlineVerify.register(container);
  // TODO(phase 2b cont.): register the remaining validation modules
  //   - validation/build-verification.js   (this branch — coming up)
  //   - validation/close-phases.js         (this branch — coming up)
  //   - validation/auto-verify-retry.js    (separate session — 729 LOC)
  //   - validation/output-safeguards.js    (separate session — 868 LOC)
  //   - validation/post-task.js            (separate session — 1494 LOC)
}

module.exports = { register };
