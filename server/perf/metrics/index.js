'use strict';

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

module.exports = { register, list };
