const routes = require('./api/routes');
const middleware = require('./api/middleware');
const { createHealthRoutes } = require('./api/health');

void routes;
void middleware;
void createHealthRoutes;

module.exports = require('./api-server.core');
