'use strict';

/**
 * factory/register.js — register every factory module with the
 * DI container.
 *
 * Phase 4 of the universal-DI migration. Unlike validation/ and execution/,
 * the factory/ subsystem turned out to need very little migration: most
 * factory modules already either (a) use defaultContainer.get(...) directly
 * inline (the target shape) or (b) are pure modules without state. Only
 * cost-metrics.js and feedback.js used the imperative init({…}) pattern;
 * both are migrated here.
 *
 * loop-controller.js (the 14k-line elephant) is not registered as a
 * service because its consumers (factory-tick, etc.) call its functions
 * via ordinary require — it does not route deps through init({…}). Its
 * inline defaultContainer.get('circuitBreaker') and similar calls already
 * follow the spec's target pattern.
 *
 * Usage from container.js:
 *   require('./factory/register').register(_defaultContainer);
 *
 * See docs/superpowers/specs/2026-05-04-universal-di-design.md.
 */

const costMetrics = require('./cost-metrics');
const feedback = require('./feedback');

function register(container) {
  costMetrics.register(container);
  feedback.register(container);
}

module.exports = { register };
