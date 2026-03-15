const db = require('../database');
const adapterRegistry = require('../providers/adapter-registry');
const { createV2Router } = require('../api/v2-router');

let listProvidersSpy;
let getDefaultProviderSpy;
let getProviderSpy;
let countTasksSpy;
let getProviderHealthSpy;
let isProviderHealthySpy;
let getConfigSpy;
let getProviderCapabilityMatrixSpy;

function makeResponse() {
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      response.body = typeof body === 'string' ? body : String(body || '');
    }),
  };

  return response;
}

function getRoute(method, url) {
  return createV2Router().find((route) => {
    if (route.method !== method) {
      return false;
    }

    if (typeof route.path === 'string') {
      return route.path === url;
    }

    return route.path.test(url);
  });
}

async function dispatchRoute(route, { url, headers = {}, context = {} } = {}) {
  const req = { headers };
  const res = makeResponse();
  const match = typeof route.path === 'string' ? [] : url.match(route.path);
  const routeParams = [];

  if (route.mapParams && match) {
    route.mapParams.forEach((param, index) => {
      if (param) {
        routeParams.push(match[index + 1]);
      }
    });
  }

  await route.handler(req, res, context, ...routeParams, req);

  return {
    req,
    res,
    statusCode: res.statusCode,
    payload: JSON.parse(res.body),
  };
}

describe('v2 provider discovery routes', () => {
  beforeAll(() => {
    listProvidersSpy = vi.spyOn(db, 'listProviders').mockReturnValue([]);
    getDefaultProviderSpy = vi.spyOn(db, 'getDefaultProvider').mockReturnValue('codex');
    getProviderSpy = vi.spyOn(db, 'getProvider').mockReturnValue(null);
    countTasksSpy = vi.spyOn(db, 'countTasks').mockReturnValue(0);
    getProviderHealthSpy = vi.spyOn(db, 'getProviderHealth').mockReturnValue({ successes: 0, failures: 0 });
    isProviderHealthySpy = vi.spyOn(db, 'isProviderHealthy').mockReturnValue(true);
    getConfigSpy = vi.spyOn(db, 'getConfig').mockReturnValue(null);
    getProviderCapabilityMatrixSpy = vi.spyOn(adapterRegistry, 'getProviderCapabilityMatrix').mockReturnValue({});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    listProvidersSpy.mockReturnValue([]);
    getDefaultProviderSpy.mockReturnValue('codex');
    getProviderSpy.mockReturnValue(null);
    countTasksSpy.mockReturnValue(0);
    getProviderHealthSpy.mockReturnValue({ successes: 0, failures: 0 });
    isProviderHealthySpy.mockReturnValue(true);
    getConfigSpy.mockReturnValue(null);
    getProviderCapabilityMatrixSpy.mockReturnValue({});
  });

  it('lists configured providers with normalized descriptors and a meta request id', async () => {
    listProvidersSpy.mockReturnValue([
      { provider: 'codex', enabled: true, transport: 'hybrid', max_concurrent: 6 },
      { provider: 'ollama', enabled: true, max_concurrent: 4 },
    ]);
    countTasksSpy.mockImplementation(({ provider }) => (provider === 'codex' ? 2 : 1));
    getProviderHealthSpy.mockImplementation((providerId) => (
      providerId === 'ollama'
        ? { successes: 3, failures: 1 }
        : { successes: 4, failures: 0 }
    ));

    const route = getRoute('GET', '/api/v2/providers');
    expect(route).toBeTruthy();

    const { payload, statusCode, req } = await dispatchRoute(route, {
      url: '/api/v2/providers',
      headers: { 'x-request-id': 'req-list' },
    });

    expect(statusCode).toBe(200);
    expect(req.requestId).toBe('req-list');
    expect(payload.meta.request_id).toBe('req-list');
    expect(payload.data.providers).toHaveLength(2);

    const codex = payload.data.providers.find((provider) => provider.id === 'codex');
    expect(codex).toMatchObject({
      id: 'codex',
      name: 'OpenAI Codex',
      transport: 'hybrid',
      enabled: true,
      default: true,
      local: false,
      status: 'healthy',
    });
    expect(codex.features).toEqual([
      'chat',
      'embeddings',
      'file_edit',
      'reasoning',
      'stream',
    ]);
    expect(codex.limits).toMatchObject({
      max_concurrent: 6,
      timeout_ms_default: 30000,
      request_rate_per_minute: 120,
      queue_depth: 2,
    });

    const ollama = payload.data.providers.find((provider) => provider.id === 'ollama');
    expect(ollama).toMatchObject({
      id: 'ollama',
      transport: 'api',
      enabled: true,
      default: false,
      local: true,
      status: 'degraded',
    });
    expect(ollama.features).toEqual([
      'chat',
      'code_interpretation',
      'file_edit',
      'stream',
      'tools',
    ]);
    expect(ollama.limits).toMatchObject({
      max_concurrent: 4,
      timeout_ms_default: 10000,
      queue_depth: 1,
    });
  });

  it('returns an empty providers array when no providers are configured', async () => {
    listProvidersSpy.mockReturnValue(null);

    const route = getRoute('GET', '/api/v2/providers');
    const { payload, statusCode } = await dispatchRoute(route, {
      url: '/api/v2/providers',
      headers: { 'x-request-id': 'req-empty' },
    });

    expect(statusCode).toBe(200);
    expect(payload.meta.request_id).toBe('req-empty');
    expect(payload.data.providers).toEqual([]);
  });

  it('returns provider detail with capabilities', async () => {
    getProviderSpy.mockImplementation((providerId) => (
      providerId === 'ollama'
        ? { provider: 'ollama', enabled: true, max_concurrent: 4 }
        : null
    ));
    getConfigSpy.mockImplementation((key) => (key === 'ollama_max_ctx' ? '16384' : null));
    getProviderHealthSpy.mockReturnValue({ successes: 5, failures: 0 });
    getProviderCapabilityMatrixSpy.mockReturnValue({
      ollama: {
        supportsStream: true,
        supportsAsync: true,
        supportsCancellation: false,
      },
    });

    const route = getRoute('GET', '/api/v2/providers/ollama');
    expect(route).toBeTruthy();

    const { payload, statusCode } = await dispatchRoute(route, {
      url: '/api/v2/providers/ollama',
      headers: { 'x-request-id': 'req-detail' },
    });

    expect(statusCode).toBe(200);
    expect(payload.meta.request_id).toBe('req-detail');
    expect(payload.data.provider).toMatchObject({
      id: 'ollama',
      name: 'Ollama (Local)',
      transport: 'api',
      enabled: true,
      default: false,
      local: true,
      status: 'healthy',
    });
    expect(payload.data.provider.features).toEqual([
      'chat',
      'code_interpretation',
      'file_edit',
      'stream',
      'tools',
    ]);
    expect(payload.data.provider.limits).toMatchObject({
      max_concurrent: 4,
      timeout_ms_default: 10000,
      request_rate_per_minute: 120,
      queue_depth: 0,
    });
    expect(payload.data.provider.capabilities).toEqual({
      streaming: true,
      async: true,
      max_context: 16384,
      supported_formats: ['text'],
    });
  });

  it('returns a standardized not-found error for unknown provider detail requests', async () => {
    const route = getRoute('GET', '/api/v2/providers/ghost');
    expect(route).toBeTruthy();

    const { payload, statusCode } = await dispatchRoute(route, {
      url: '/api/v2/providers/ghost',
      headers: { 'x-request-id': 'req-missing' },
    });

    expect(statusCode).toBe(404);
    expect(payload.meta.request_id).toBe('req-missing');
    expect(payload.error).toEqual({
      code: 'provider_not_found',
      message: 'Provider not found: ghost',
      request_id: 'req-missing',
      details: {
        provider_id: 'ghost',
      },
    });
  });

  it('returns the provider capabilities matrix', async () => {
    getProviderSpy.mockImplementation((providerId) => (
      providerId === 'codex'
        ? { provider: 'codex', enabled: true, transport: 'hybrid', max_concurrent: 6 }
        : null
    ));
    getProviderCapabilityMatrixSpy.mockReturnValue({
      codex: {
        supportsStream: true,
        supportsAsync: false,
        supportsCancellation: false,
      },
    });

    const route = getRoute('GET', '/api/v2/providers/codex/capabilities');
    expect(route).toBeTruthy();

    const { payload, statusCode } = await dispatchRoute(route, {
      url: '/api/v2/providers/codex/capabilities',
      headers: { 'x-request-id': 'req-capabilities' },
    });

    expect(statusCode).toBe(200);
    expect(payload.meta.request_id).toBe('req-capabilities');
    expect(payload.data).toEqual({
      provider_id: 'codex',
      capabilities: {
        streaming: true,
        async: false,
        max_context: 0,
        supported_formats: ['embeddings', 'text'],
      },
    });
  });
});
