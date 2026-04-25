'use strict';

// Metric modules will register themselves here as they are added.
// Each metric module exports: { id, name, category, runs, warmup, units, run() }
const metrics = [];

function register(metric) {
  if (!metric || typeof metric.id !== 'string') {
    throw new Error('register(): metric.id required');
  }
  if (typeof metric.run !== 'function') {
    throw new Error('register(): metric.run() required');
  }
  if (metrics.some((m) => m.id === metric.id)) {
    throw new Error(`register(): duplicate metric id ${metric.id}`);
  }
  metrics.push(metric);
}

function list() {
  return metrics.slice();
}

// Test-only: drop all registered metrics so each test starts clean.
// Production code should never call this.
function _reset() {
  metrics.length = 0;
}

module.exports = { register, list, _reset };
