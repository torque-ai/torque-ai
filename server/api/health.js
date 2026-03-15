'use strict';

const { handleHealthz, handleReadyz, handleLivez } = require('./health-probes');

const UNAUTHENTICATED_HEALTH_ROUTES = ['/healthz', '/readyz', '/livez'];

function createHealthRoutes(_deps = {}) {
  void _deps;
  return [
    { method: 'GET', path: '/healthz', handler: handleHealthz, skipAuth: UNAUTHENTICATED_HEALTH_ROUTES },
    { method: 'GET', path: '/readyz', handler: handleReadyz, skipAuth: UNAUTHENTICATED_HEALTH_ROUTES },
    { method: 'GET', path: '/livez', handler: handleLivez, skipAuth: UNAUTHENTICATED_HEALTH_ROUTES },
  ];
}

module.exports = {
  createHealthRoutes,
  UNAUTHENTICATED_HEALTH_ROUTES,
};
