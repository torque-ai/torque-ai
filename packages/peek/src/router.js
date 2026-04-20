'use strict';

const { createHealthHandler } = require('./health');

const PLANNED_RESPONSE = Object.freeze({
  success: false,
  error: 'Not implemented',
  phase: 'planned',
});

const PHASE1_ROUTES = Object.freeze([
  { method: 'GET', path: '/peek', handler: 'peek', aliases: ['capture'] },
  { method: 'GET', path: '/list', handler: 'list', aliases: ['listWindows', 'windows'] },
  { method: 'GET', path: '/windows', handler: 'windows', aliases: ['listWindows', 'list'] },
  { method: 'POST', path: '/click', handler: 'click' },
  { method: 'POST', path: '/drag', handler: 'drag' },
  { method: 'POST', path: '/type', handler: 'type' },
  { method: 'POST', path: '/scroll', handler: 'scroll' },
  { method: 'POST', path: '/hotkey', handler: 'hotkey' },
  { method: 'POST', path: '/focus', handler: 'focus' },
  { method: 'POST', path: '/resize', handler: 'resize' },
  { method: 'POST', path: '/move', handler: 'move' },
  { method: 'POST', path: '/maximize', handler: 'maximize' },
  { method: 'POST', path: '/minimize', handler: 'minimize' },
  { method: 'POST', path: '/clipboard', handler: 'clipboard' },
  { method: 'POST', path: '/process', handler: 'process', aliases: ['launchProcess'] },
  { method: 'GET', path: '/projects', handler: 'projects', aliases: ['discoverProjects'] },
  { method: 'POST', path: '/open-url', handler: 'openUrl', aliases: ['open-url'] },
  { method: 'POST', path: '/compare', handler: 'compare' },
  { method: 'POST', path: '/snapshot', handler: 'snapshot' },
]);

const PHASE2_ROUTES = Object.freeze([
  { method: 'POST', path: '/elements' },
  { method: 'POST', path: '/wait' },
  { method: 'POST', path: '/ocr' },
  { method: 'POST', path: '/assert' },
  { method: 'POST', path: '/hit-test' },
  { method: 'POST', path: '/color' },
  { method: 'POST', path: '/table' },
  { method: 'POST', path: '/summary' },
  { method: 'POST', path: '/cdp' },
  { method: 'POST', path: '/diagnose' },
  { method: 'POST', path: '/semantic-diff' },
  { method: 'POST', path: '/action-sequence' },
]);

const PHASE3_ROUTES = Object.freeze([
  { method: 'POST', path: '/recovery/is-allowed-action' },
  { method: 'POST', path: '/recovery/execute' },
  { method: 'GET', path: '/recovery/status' },
]);

function routeKey(method, routePath) {
  return `${String(method || '').toUpperCase()} ${routePath}`;
}

function createPlannedHandler() {
  return async function plannedHandler(ctx) {
    return ctx.json(501, PLANNED_RESPONSE);
  };
}

function resolveRouteHandler(handlers, route) {
  const candidates = [route.handler, ...(route.aliases || [])].filter(Boolean);

  for (const name of candidates) {
    if (typeof handlers[name] === 'function') {
      return handlers[name];
    }
  }

  return null;
}

function hasSentResponse(ctx) {
  return Boolean(ctx.res && (ctx.res.headersSent || ctx.res.writableEnded));
}

function sendHandlerResult(ctx, result) {
  if (hasSentResponse(ctx)) return undefined;

  if (result === undefined) {
    return ctx.empty(204);
  }

  if (result && typeof result === 'object' && Number.isInteger(result.statusCode)) {
    return ctx.json(result.statusCode, result.body === undefined ? null : result.body);
  }

  if (result && typeof result === 'object' && Number.isInteger(result.status)) {
    return ctx.json(result.status, result.body === undefined ? null : result.body);
  }

  return ctx.json(200, result);
}

function registerRoutes(routeMap, routes, handlers) {
  for (const route of routes) {
    const handler = resolveRouteHandler(handlers, route) || createPlannedHandler();
    routeMap.set(routeKey(route.method, route.path), handler);
  }
}

function createRouter(options = {}) {
  const handlers = options.handlers || {};
  const routeMap = new Map();

  routeMap.set(routeKey('GET', '/health'), options.healthHandler || createHealthHandler(options));

  if (typeof options.shutdownHandler === 'function') {
    routeMap.set(routeKey('POST', '/shutdown'), options.shutdownHandler);
  }

  registerRoutes(routeMap, PHASE1_ROUTES, handlers);
  registerRoutes(routeMap, PHASE2_ROUTES, {});
  registerRoutes(routeMap, PHASE3_ROUTES, {});

  return async function dispatch(ctx) {
    const handler = routeMap.get(routeKey(ctx.method, ctx.path));

    if (!handler) {
      return ctx.json(404, {
        success: false,
        error: `No route for ${ctx.method} ${ctx.path}`,
      });
    }

    const result = await handler(ctx);
    return sendHandlerResult(ctx, result);
  };
}

module.exports = {
  PHASE1_ROUTES,
  PHASE2_ROUTES,
  PHASE3_ROUTES,
  PLANNED_RESPONSE,
  createRouter,
  routeKey,
};
