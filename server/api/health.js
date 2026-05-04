'use strict';

const { createHealthProbes } = require('./health-probes');

const UNAUTHENTICATED_HEALTH_ROUTES = ['/healthz', '/readyz', '/livez'];

// Wire the route table through createHealthProbes(deps) so an injected
// `db` / `container` flows into the probe's resolver. Without this, the
// raw module exports always fell back to `defaultContainer.get('db')`,
// which left api-server.test.js / api-server-core.test.js producing 500s
// because their setup mocks `database.getDbInstance` directly instead of
// registering a service in the default container.
function createHealthRoutes(deps = {}) {
  const probes = createHealthProbes(deps);
  return [
    { method: 'GET', path: '/healthz', handler: probes.handleHealthz, skipAuth: UNAUTHENTICATED_HEALTH_ROUTES },
    { method: 'GET', path: '/readyz', handler: probes.handleReadyz, skipAuth: UNAUTHENTICATED_HEALTH_ROUTES },
    { method: 'GET', path: '/livez', handler: probes.handleLivez, skipAuth: UNAUTHENTICATED_HEALTH_ROUTES },
  ];
}

module.exports = {
  createHealthRoutes,
  UNAUTHENTICATED_HEALTH_ROUTES,
};
