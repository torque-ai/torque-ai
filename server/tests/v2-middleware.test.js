const routes = require('../api/routes');
const { createV2Router } = require('../api/v2-router');
const { validateInferenceRequest } = require('../api/v2-schemas');
const {
  validateRequest,
  normalizeError,
  requestId,
} = require('../api/v2-middleware');

function createMockResponse() {
  const headers = {};

  return {
    headers,
    setHeader: vi.fn((name, value) => {
      headers[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => headers[name.toLowerCase()]),
  };
}

function createRequest(overrides = {}) {
  return {
    headers: {},
    params: {},
    query: {},
    ...overrides,
  };
}

async function runMiddleware(middlewareFn, req, res) {
  return new Promise((resolve, reject) => {
    const next = (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    };

    Promise.resolve(middlewareFn(req, res, next)).catch(reject);
  });
}

async function runMiddlewareChain(middlewares, req, res) {
  for (const middlewareFn of middlewares) {
    await runMiddleware(middlewareFn, req, res);
  }
}

function getAllV2Routes() {
  // Exclude tool-passthrough routes (they use handleToolCall, not v2 middleware)
  const staticV2Routes = routes.filter((route) => String(route.path).includes('/api/v2') && !route.tool);
  return staticV2Routes.concat(createV2Router());
}

describe('requestId', () => {
  it('reuses the inbound x-request-id header', async () => {
    const req = createRequest({
      headers: {
        'x-request-id': 'req-from-client',
      },
    });
    const res = createMockResponse();

    await runMiddleware(requestId, req, res);

    expect(req.requestId).toBe('req-from-client');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'req-from-client');
  });

  it('generates a uuid when the request header is missing', async () => {
    const req = createRequest();
    const res = createMockResponse();

    await runMiddleware(requestId, req, res);

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(res.getHeader('x-request-id')).toBe(req.requestId);
  });
});

describe('validateRequest', () => {
  it('normalizes validated params and body onto the request', async () => {
    const req = createRequest({
      params: { provider_id: 'codex' },
      body: {
        prompt: '  Ship the patch  ',
        transport: ' HYBRID ',
      },
    });
    const res = createMockResponse();
    const middlewareFn = validateRequest({
      params: () => ({
        valid: true,
        errors: [],
        value: { provider_id: 'codex' },
      }),
      body: {
        validator: validateInferenceRequest,
        options: { defaultProvider: 'codex' },
      },
    });

    await runMiddleware(middlewareFn, req, res);

    expect(req.params).toEqual({ provider_id: 'codex' });
    expect(req.body).toEqual({
      prompt: 'Ship the patch',
      provider: 'codex',
      transport: 'hybrid',
    });
    expect(req.validated).toEqual({
      params: { provider_id: 'codex' },
      body: {
        prompt: 'Ship the patch',
        provider: 'codex',
        transport: 'hybrid',
      },
    });
  });

  it('surfaces standardized validation errors through normalizeError', async () => {
    const req = createRequest({
      requestId: 'req-invalid',
      body: { model: 'gpt-5.3-codex-spark' },
    });
    const res = createMockResponse();
    const middlewareFn = validateRequest({
      body: {
        validator: validateInferenceRequest,
      },
    });

    let error = null;
    try {
      await runMiddleware(middlewareFn, req, res);
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      v2: true,
      code: 'validation_error',
      status: 400,
    });

    const normalized = normalizeError(error, req);
    expect(normalized.status).toBe(400);
    expect(normalized.body.error).toMatchObject({
      code: 'validation_error',
      message: 'Request validation failed',
      request_id: 'req-invalid',
    });
    expect(normalized.body.error.details.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'messages',
          code: 'missing',
        }),
        expect.objectContaining({
          field: 'provider',
          code: 'missing',
        }),
      ]),
    );
    expect(normalized.body.meta.request_id).toBe('req-invalid');
  });
});

describe('normalizeError', () => {
  it('maps body parsing failures into the standardized v2 envelope', () => {
    const normalized = normalizeError(new Error('Invalid JSON'), {
      headers: { 'x-request-id': 'req-json' },
    });

    expect(normalized).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'validation_error',
          message: 'Invalid JSON',
          request_id: 'req-json',
          details: {
            context: 'request_body',
          },
        },
        meta: {
          request_id: 'req-json',
        },
      },
    });
  });

  it('does not pass child process exit codes through as HTTP status codes', () => {
    const error = new Error('git exited 128');
    error.code = 128;
    error.status = 128;

    const normalized = normalizeError(error, {
      headers: { 'x-request-id': 'req-exit-code' },
    });

    expect(normalized).toMatchObject({
      status: 500,
      body: {
        error: {
          code: 'provider_unavailable',
          message: 'Internal server error',
          request_id: 'req-exit-code',
        },
      },
    });
  });
});

describe('v2 route middleware wiring', () => {
  it('attaches request id and validation middleware to every v2 route', () => {
    for (const route of getAllV2Routes()) {
      expect(route.middleware).toBeTruthy();
      expect(route.middleware[0]).toBe(requestId);
      expect(route.middleware).toHaveLength(2);
      expect(typeof route.middleware[1]).toBe('function');
    }
  });

  it('rejects invalid encoded provider ids through the attached route middleware', async () => {
    const route = createV2Router().find((entry) => entry.handlerName === 'handleV2ProviderModels');
    expect(route).toBeTruthy();

    const req = createRequest({
      headers: { 'x-request-id': 'req-provider-encoding' },
      params: { provider_id: '%E0%A4%A' },
    });
    const res = createMockResponse();

    let error = null;
    try {
      await runMiddlewareChain(route.middleware, req, res);
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: 'validation_error',
      status: 400,
    });

    const normalized = normalizeError(error, req);
    expect(normalized.body.error.details.errors).toEqual([
      expect.objectContaining({
        field: 'provider_id',
        code: 'encoding',
      }),
    ]);
    expect(normalized.body.error.request_id).toBe('req-provider-encoding');
  });
});
