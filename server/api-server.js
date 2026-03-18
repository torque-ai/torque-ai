const routes = require('./api/routes');
const middleware = require('./api/middleware');
const { createHealthRoutes } = require('./api/health');

module.exports = require('./api-server.core');
