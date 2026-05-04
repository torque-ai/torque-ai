'use strict';

/**
 * validation/register.js — register validation modules with the DI container.
 *
 * Universal-DI migration. Each validation module exposes both a legacy
 * init({…}) shape and a new createXxx(deps) + register(container) shape.
 * This file controls which of those new shapes are *active* in the
 * container — i.e. which ones boot() instantiates so consumers can
 * resolve them via container.get(name).
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
 * ── Status: all 7 modules deferred ───────────────────────────────────
 *
 * Every validation module pre-declares a dep list that includes
 * utility functions and closures owned by task-manager.js
 * (e.g. checkFileQuality, scopedRollback, getFileChangesForValidation,
 * runBuildVerification, sanitizeLLMOutput, parseCommand). Those aren't
 * (and shouldn't be) container-managed services — they're either pure
 * helpers or task-manager-owned closures.
 *
 * Wiring this aggregator before consumer-side cleanup would crash
 * container.boot() on the first missing-dep validation. The modules
 * stay loadable via direct require() + createXxx(...) call — the
 * factory shape is fully functional — but they are not yet activated
 * in the container.
 *
 * Each module is unblocked when either:
 *   (a) task-manager.js migrates the consumer call site to container.get(),
 *       at which point the shared closures it owns can be promoted to
 *       container values; OR
 *   (b) the module's dep list is pruned to only the truly-stateful
 *       services it consumes (the utility functions become plain
 *       require() at the top of the module).
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

// Required for side effects (each module's register() function is
// available on its export) but NOT called until consumer migration
// promotes their utility-function deps to container values.
require('./safeguard-gates');
require('./hashline-verify');
require('./build-verification');
require('./close-phases');
require('./auto-verify-retry');
require('./output-safeguards');
require('./post-task');

function register(_container) {
  // No-op for now. All 7 validation modules' register() functions are
  // defined and ready; they're simply not called until their
  // consumer-side blockers clear (see file header).
}

module.exports = { register };
