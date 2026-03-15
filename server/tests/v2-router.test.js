/**
 * Unit Tests: api/v2-router.js
 *
 * Tests the V2 API router factory, route structure, provider handlers,
 * utility functions, and middleware wiring.
 */

'use strict';

const {
  V2_MOUNT_PATH,
  V2_PROVIDER_ROUTE_HANDLER_NAMES,
  escapeRegExp,
  normalizeMountPath,
  resolveRouteRequestId,
  createNotImplementedHandler,
  getRouteHandler,
  createV2Router,
} = require('../api/v2-router');


// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────
describe('V2 Router constants', () => {
  it('V2_MOUNT_PATH is /api/v2', () => {
    expect(V2_MOUNT_PATH).toBe('/api/v2');
  });

  it('V2_PROVIDER_ROUTE_HANDLER_NAMES is a Set of expected handler names', () => {
    expect(V2_PROVIDER_ROUTE_HANDLER_NAMES).toBeInstanceOf(Set);
    expect(V2_PROVIDER_ROUTE_HANDLER_NAMES.has('handleV2ListProviders')).toBe(true);
    expect(V2_PROVIDER_ROUTE_HANDLER_NAMES.has('handleV2ProviderDetail')).toBe(true);
    expect(V2_PROVIDER_ROUTE_HANDLER_NAMES.has('handleV2ProviderCapabilities')).toBe(true);
    expect(V2_PROVIDER_ROUTE_HANDLER_NAMES.has('handleV2ProviderModels')).toBe(true);
    expect(V2_PROVIDER_ROUTE_HANDLER_NAMES.has('handleV2ProviderHealth')).toBe(true);
  });
});


// ────────────────────────────────────────────────────────────────
// escapeRegExp
// ────────────────────────────────────────────────────────────────
describe('escapeRegExp', () => {
  it('escapes regex special characters', () => {
    expect(escapeRegExp('/api/v2')).toBe('/api/v2');
    expect(escapeRegExp('foo.bar')).toBe('foo\\.bar');
    expect(escapeRegExp('a*b+c?')).toBe('a\\*b\\+c\\?');
    expect(escapeRegExp('x[y]z')).toBe('x\\[y\\]z');
    expect(escapeRegExp('^$')).toBe('\\^\\$');
    expect(escapeRegExp('a{b}c')).toBe('a\\{b\\}c');
    expect(escapeRegExp('a|b')).toBe('a\\|b');
    expect(escapeRegExp('a(b)')).toBe('a\\(b\\)');
    expect(escapeRegExp('a\\b')).toBe('a\\\\b');
  });

  it('handles empty string', () => {
    expect(escapeRegExp('')).toBe('');
  });

  it('handles non-string input via String()', () => {
    expect(escapeRegExp(123)).toBe('123');
    expect(escapeRegExp(null)).toBe('null');
  });
});


// ────────────────────────────────────────────────────────────────
// normalizeMountPath
// ────────────────────────────────────────────────────────────────
describe('normalizeMountPath', () => {
  it('returns default V2_MOUNT_PATH for empty input', () => {
    expect(normalizeMountPath('')).toBe(V2_MOUNT_PATH);
    expect(normalizeMountPath('  ')).toBe(V2_MOUNT_PATH);
  });

  it('returns default for non-string input', () => {
    expect(normalizeMountPath(null)).toBe(V2_MOUNT_PATH);
    expect(normalizeMountPath(undefined)).toBe(V2_MOUNT_PATH);
    expect(normalizeMountPath(42)).toBe(V2_MOUNT_PATH);
  });

  it('adds leading slash if missing', () => {
    expect(normalizeMountPath('api/v2')).toBe('/api/v2');
  });

  it('keeps existing leading slash', () => {
    expect(normalizeMountPath('/api/v2')).toBe('/api/v2');
  });

  it('strips trailing slashes', () => {
    expect(normalizeMountPath('/api/v2/')).toBe('/api/v2');
    expect(normalizeMountPath('/api/v2///')).toBe('/api/v2');
  });

  it('trims whitespace', () => {
    expect(normalizeMountPath('  /api/v2  ')).toBe('/api/v2');
  });
});


// ────────────────────────────────────────────────────────────────
// resolveRouteRequestId
// ────────────────────────────────────────────────────────────────
describe('resolveRouteRequestId', () => {
  it('returns x-request-id header value if present', () => {
    const req = { headers: { 'x-request-id': 'test-request-123' } };
    expect(resolveRouteRequestId(req)).toBe('test-request-123');
  });

  it('trims whitespace from header value', () => {
    const req = { headers: { 'x-request-id': '  abc-def  ' } };
    expect(resolveRouteRequestId(req)).toBe('abc-def');
  });

  it('picks first non-empty value from array header', () => {
    const req = { headers: { 'x-request-id': ['', '  ', 'real-id'] } };
    expect(resolveRouteRequestId(req)).toBe('real-id');
  });

  it('generates UUID when no header present', () => {
    const req = { headers: {} };
    const id = resolveRouteRequestId(req);
    expect(id).toBeTruthy();
    // UUID format: 8-4-4-4-12 hex chars
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates UUID when req is null', () => {
    const id = resolveRouteRequestId(null);
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('generates UUID when headers is missing', () => {
    const id = resolveRouteRequestId({});
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('generates UUID when header value is empty string', () => {
    const req = { headers: { 'x-request-id': '' } };
    const id = resolveRouteRequestId(req);
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });
});


// ────────────────────────────────────────────────────────────────
// createNotImplementedHandler
// ────────────────────────────────────────────────────────────────
describe('createNotImplementedHandler', () => {
  it('returns a function', () => {
    const handler = createNotImplementedHandler('GET /test', resolveRouteRequestId);
    expect(typeof handler).toBe('function');
  });

  it('sends 501 with not_implemented error', () => {
    const handler = createNotImplementedHandler('GET /test', resolveRouteRequestId);
    const req = { headers: { 'x-request-id': 'req-1' } };
    let sentStatus, sentBody;
    const res = {
      writeHead: vi.fn((status) => { sentStatus = status; }),
      end: vi.fn((body) => { sentBody = body; }),
    };

    handler(req, res);

    expect(sentStatus).toBe(501);
    const parsed = JSON.parse(sentBody);
    expect(parsed.error.code).toBe('not_implemented');
    expect(parsed.error.message).toContain('GET /test');
    expect(parsed.error.request_id).toBe('req-1');
  });

  it('includes provider_id in details when provided', () => {
    const handler = createNotImplementedHandler('GET /models', resolveRouteRequestId);
    const req = { headers: {} };
    let sentBody;
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body) => { sentBody = body; }),
    };

    handler(req, res, {}, 'codex');

    const parsed = JSON.parse(sentBody);
    expect(parsed.error.details.provider_id).toBe('codex');
  });
});


// ────────────────────────────────────────────────────────────────
// getRouteHandler
// ────────────────────────────────────────────────────────────────
describe('getRouteHandler', () => {
  it('returns handler from handlers map when present', () => {
    const myHandler = vi.fn();
    const handlers = { listProviders: myHandler };
    const result = getRouteHandler(handlers, 'listProviders', 'GET /providers', resolveRouteRequestId);
    expect(result).toBe(myHandler);
  });

  it('returns fallback handler when key not in handlers', () => {
    const fallback = vi.fn();
    const result = getRouteHandler({}, 'missing', 'GET /missing', resolveRouteRequestId, fallback);
    expect(result).toBe(fallback);
  });

  it('returns not-implemented handler when no handlers and no fallback', () => {
    const result = getRouteHandler({}, 'missing', 'GET /missing', resolveRouteRequestId);
    expect(typeof result).toBe('function');
    // Verify it's the not-implemented handler by calling it
    const req = { headers: {} };
    let sentStatus;
    const res = {
      writeHead: vi.fn((s) => { sentStatus = s; }),
      end: vi.fn(),
    };
    result(req, res);
    expect(sentStatus).toBe(501);
  });

  it('returns not-implemented handler when handlers is null', () => {
    const result = getRouteHandler(null, 'any', 'GET /any', resolveRouteRequestId);
    expect(typeof result).toBe('function');
  });
});


// ────────────────────────────────────────────────────────────────
// createV2Router
// ────────────────────────────────────────────────────────────────
describe('createV2Router', () => {
  it('returns an array of 5 route definitions', () => {
    const routes = createV2Router();
    expect(Array.isArray(routes)).toBe(true);
    expect(routes).toHaveLength(5);
  });

  it('all routes have method, path, middleware, handler, handlerName', () => {
    const routes = createV2Router();
    for (const route of routes) {
      expect(route).toHaveProperty('method');
      expect(route).toHaveProperty('path');
      expect(route).toHaveProperty('middleware');
      expect(route).toHaveProperty('handler');
      expect(route).toHaveProperty('handlerName');
      expect(typeof route.handler).toBe('function');
      expect(Array.isArray(route.middleware)).toBe(true);
    }
  });

  it('first route is GET /api/v2/providers', () => {
    const routes = createV2Router();
    expect(routes[0].method).toBe('GET');
    expect(routes[0].path).toBe('/api/v2/providers');
    expect(routes[0].handlerName).toBe('handleV2ListProviders');
  });

  it('second route matches /api/v2/providers/:id', () => {
    const routes = createV2Router();
    expect(routes[1].method).toBe('GET');
    expect(routes[1].path).toBeInstanceOf(RegExp);
    expect(routes[1].path.test('/api/v2/providers/codex')).toBe(true);
    expect(routes[1].path.test('/api/v2/providers/hashline-ollama')).toBe(true);
    expect(routes[1].path.test('/api/v2/providers/')).toBe(false);
    expect(routes[1].handlerName).toBe('handleV2ProviderDetail');
    expect(routes[1].mapParams).toEqual(['provider_id']);
  });

  it('third route matches /api/v2/providers/:id/capabilities', () => {
    const routes = createV2Router();
    expect(routes[2].method).toBe('GET');
    expect(routes[2].path.test('/api/v2/providers/codex/capabilities')).toBe(true);
    expect(routes[2].path.test('/api/v2/providers/codex')).toBe(false);
    expect(routes[2].handlerName).toBe('handleV2ProviderCapabilities');
  });

  it('fourth route matches /api/v2/providers/:id/models', () => {
    const routes = createV2Router();
    expect(routes[3].path.test('/api/v2/providers/ollama/models')).toBe(true);
    expect(routes[3].handlerName).toBe('handleV2ProviderModels');
  });

  it('fifth route matches /api/v2/providers/:id/health', () => {
    const routes = createV2Router();
    expect(routes[4].path.test('/api/v2/providers/groq/health')).toBe(true);
    expect(routes[4].handlerName).toBe('handleV2ProviderHealth');
  });

  it('uses custom mount path', () => {
    const routes = createV2Router({ mountPath: '/custom/api' });
    expect(routes[0].path).toBe('/custom/api/providers');
    expect(routes[1].path.test('/custom/api/providers/codex')).toBe(true);
  });

  it('uses custom handlers when provided', () => {
    const myListHandler = vi.fn();
    const routes = createV2Router({
      handlers: { listProviders: myListHandler },
    });
    expect(routes[0].handler).toBe(myListHandler);
  });

  it('uses custom resolveRequestId when provided', () => {
    const customResolve = vi.fn().mockReturnValue('custom-id');
    const routes = createV2Router({ resolveRequestId: customResolve });

    // Call a not-implemented handler to verify custom resolver is used
    const req = { headers: {} };
    let sentBody;
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((body) => { sentBody = body; }),
    };

    // Provider models handler is not-implemented by default
    routes[3].handler(req, res, {}, 'codex');
    const parsed = JSON.parse(sentBody);
    expect(parsed.error.request_id).toBe('custom-id');
  });

  it('each route middleware has 2 functions (requestId + validateRequest)', () => {
    const routes = createV2Router();
    for (const route of routes) {
      expect(route.middleware).toHaveLength(2);
      expect(typeof route.middleware[0]).toBe('function');
      expect(typeof route.middleware[1]).toBe('function');
    }
  });
});
