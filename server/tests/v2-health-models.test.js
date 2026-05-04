const { EventEmitter } = require('events');
const http = require('http');
const db = require('../database');
const configCore = require('../db/config-core');
const fileTracking = require('../db/file/tracking');
const taskCore = require('../db/task-core');
const providerRoutingCore = require('../db/provider/routing-core');
const hostManagement = require('../db/host/management');
const modelRegistry = require('../models/registry');
const adapterRegistry = require('../providers/adapter-registry');
const serverConfig = require('../config');
const { createConfigMock } = require('./test-helpers');

function createMockResponse() {
  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const responseHeaders = {};
  const listeners = {};
  const writtenChunks = [];

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    }),
    setHeader: vi.fn((name, value) => {
      responseHeaders[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      if (body) {
        writtenChunks.push(typeof body === 'string' ? body : String(body));
      }
      response.body = writtenChunks.join('');
      resolve();
    }),
  };

  return { response, done };
}

async function dispatchRequest(handler, { method, url, headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress: '127.0.0.1' };
  req.connection = { remoteAddress: '127.0.0.1' };

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', payload);
    }
    req.emit('end');
  });

  await handlerPromise;
  await done;
  return response;
}

function createHttpGetMock(routeMap) {
  return vi.fn((url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = vi.fn();

    const targetUrl = typeof url === 'string' ? url : url?.toString?.() || String(url);
    const route = routeMap.get(targetUrl);
    if (!route) {
      throw new Error(`Unexpected http.get URL in test: ${targetUrl}`);
    }

    process.nextTick(() => {
      if (route.error) {
        request.emit('error', route.error instanceof Error ? route.error : new Error(String(route.error)));
        return;
      }

      if (route.timeout) {
        request.emit('timeout');
        return;
      }

      const response = new EventEmitter();
      response.statusCode = route.statusCode ?? 200;
      callback(response);

      const emitResponse = () => {
        if (route.body !== undefined) {
          const payload = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
          response.emit('data', payload);
        }
        response.emit('end');
      };

      if (route.delayMs && route.delayMs > 0) {
        setTimeout(emitResponse, route.delayMs);
      } else {
        emitResponse();
      }
    });

    return request;
  });
}

describe('v2 provider health and model inventory endpoints', () => {
  let apiServer;
  let requestHandler;
  let mockServer;
  let createServerSpy;
  let getConfigSpy;
  let getProviderHealthSpy;
  let isProviderHealthySpy;
  let getProviderStatsSpy;
  let listOllamaHostsSpy;
  let recordHostHealthCheckSpy;
  let countTasksSpy;
  let getApprovedModelsSpy;
  let getProviderAdapterSpy;
  let providerRows;
  let configValues;
  let httpGetSpy;
  let originalGetProviderAdapter;
  const originalEnv = {};
  const cloudEnvKeys = [
    'ANTHROPIC_API_KEY',
    'GROQ_API_KEY',
    'DEEPINFRA_API_KEY',
    'HYPERBOLIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ];

  beforeAll(async () => {
    for (const key of cloudEnvKeys) {
      originalEnv[key] = process.env[key];
    }

    providerRows = new Map();
    configValues = {};
    originalGetProviderAdapter = adapterRegistry.getProviderAdapter;
    mockServer = {
      on: vi.fn(),
      listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
      close: vi.fn(),
    };

    getConfigSpy = vi.spyOn(configCore, 'getConfig').mockImplementation(createConfigMock(configValues));
    vi.spyOn(providerRoutingCore, 'getProvider').mockImplementation((providerId) => providerRows.get(providerId) || null);
    getProviderHealthSpy = vi.spyOn(providerRoutingCore, 'getProviderHealth').mockReturnValue({
      successes: 0,
      failures: 0,
      failureRate: 0,
    });
    isProviderHealthySpy = vi.spyOn(providerRoutingCore, 'isProviderHealthy').mockReturnValue(true);
    getProviderStatsSpy = vi.spyOn(fileTracking, 'getProviderStats').mockReturnValue({
      provider: 'groq',
      total_tasks: 0,
      successful_tasks: 0,
      failed_tasks: 0,
      avg_duration_seconds: 0,
      success_rate: 0,
    });
    listOllamaHostsSpy = vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    recordHostHealthCheckSpy = vi.spyOn(hostManagement, 'recordHostHealthCheck').mockImplementation(() => {});
    countTasksSpy = vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);
    vi.spyOn(providerRoutingCore, 'getDefaultProvider').mockReturnValue('codex');
    vi.spyOn(providerRoutingCore, 'listProviders').mockReturnValue([]);
    vi.spyOn(db, 'getDbInstance').mockReturnValue({});
    getApprovedModelsSpy = vi.spyOn(modelRegistry, 'getApprovedModels').mockReturnValue([]);
    getProviderAdapterSpy = vi.spyOn(adapterRegistry, 'getProviderAdapter')
      .mockImplementation((providerId) => originalGetProviderAdapter(providerId));

    createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    apiServer = require('../api-server');
    await apiServer.start({ port: 4311 });
  });

  beforeEach(() => {
    providerRows.clear();
    configValues = {};
    getConfigSpy.mockImplementation(createConfigMock(configValues));
    getProviderHealthSpy.mockReturnValue({
      successes: 0,
      failures: 0,
      failureRate: 0,
    });
    isProviderHealthySpy.mockReturnValue(true);
    getProviderStatsSpy.mockReturnValue({
      provider: 'groq',
      total_tasks: 0,
      successful_tasks: 0,
      failed_tasks: 0,
      avg_duration_seconds: 0,
      success_rate: 0,
    });
    listOllamaHostsSpy.mockReturnValue([]);
    recordHostHealthCheckSpy.mockClear();
    countTasksSpy.mockReturnValue(0);
    getApprovedModelsSpy.mockReturnValue([]);
    getProviderAdapterSpy.mockImplementation((providerId) => originalGetProviderAdapter(providerId));

    if (httpGetSpy) {
      httpGetSpy.mockRestore();
      httpGetSpy = null;
    }

    for (const key of cloudEnvKeys) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    if (httpGetSpy) {
      httpGetSpy.mockRestore();
    }

    apiServer.stop();
    createServerSpy.mockRestore();

    for (const key of cloudEnvKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }

    vi.restoreAllMocks();
  });

  function setProvider(providerId, overrides = {}) {
    providerRows.set(providerId, {
      provider: providerId,
      enabled: 1,
      transport: 'api',
      max_concurrent: 3,
      ...overrides,
    });
  }

  it('returns cloud model inventory in the v2 envelope with empty models when none are configured', async () => {
    setProvider('groq');

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/groq/models',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.meta.request_id).toEqual(expect.any(String));
    expect(payload.data.provider_id).toBe('groq');
    expect(payload.data.refreshed_at).toEqual(expect.any(String));
    expect(payload.data.models).toEqual([]);

    // Legacy top-level fields stay available for older callers.
    expect(payload.provider_id).toBe('groq');
    expect(payload.models).toEqual([]);
  });

  it('returns approved OpenRouter registry models before live provider discovery', async () => {
    setProvider('openrouter');
    const listModels = vi.fn(async () => ['live/model:free']);
    getProviderAdapterSpy.mockImplementation((providerId) => (
      providerId === 'openrouter'
        ? { listModels }
        : originalGetProviderAdapter(providerId)
    ));
    getApprovedModelsSpy.mockReturnValue([
      {
        model_name: 'minimax/minimax-m2.5:free',
        provider: 'openrouter',
        family: 'minimax',
        parameter_size_b: 7,
        size_bytes: 123456,
      },
    ]);

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/openrouter/models',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.source).toBe('registry');
    expect(payload.models).toEqual(['minimax/minimax-m2.5:free']);
    expect(payload.data.models).toEqual([
      expect.objectContaining({
        id: 'minimax/minimax-m2.5:free',
        provider_id: 'openrouter',
        source: 'registry',
        parameters: expect.objectContaining({
          family: 'minimax',
          parameter_count_b: 7,
          size_bytes: 123456,
        }),
      }),
    ]);
    expect(getApprovedModelsSpy).toHaveBeenCalledWith('openrouter', undefined);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('falls back to live OpenRouter free model metadata when no registry models are approved', async () => {
    setProvider('openrouter');
    const listModels = vi.fn(async () => [
      'google/gemma-3-12b-it:free',
      'qwen/qwen3-coder:free',
    ]);
    getProviderAdapterSpy.mockImplementation((providerId) => (
      providerId === 'openrouter'
        ? { listModels }
        : originalGetProviderAdapter(providerId)
    ));

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/openrouter/models',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.source).toBe('provider_api_live');
    expect(payload.models).toEqual([
      'google/gemma-3-12b-it:free',
      'qwen/qwen3-coder:free',
    ]);
    expect(payload.data.models).toEqual([
      expect.objectContaining({
        id: 'google/gemma-3-12b-it:free',
        source: 'provider_api_live',
      }),
      expect.objectContaining({
        id: 'qwen/qwen3-coder:free',
        source: 'provider_api_live',
      }),
    ]);
    expect(listModels).toHaveBeenCalledWith({
      freeOnly: true,
      toolsOnly: false,
    });
  });

  it('serves live OpenRouter free models even when no API key is configured', async () => {
    // OpenRouter's free model catalog is public, so the v2 discovery endpoint
    // must not gate live adapter discovery on a configured key. This test
    // explicitly clears the env var so an accidental future "require key
    // before live discovery" check would fail loudly.
    delete process.env.OPENROUTER_API_KEY;
    setProvider('openrouter');
    const listModels = vi.fn(async () => [
      'google/gemma-4-31b-it',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ]);
    getProviderAdapterSpy.mockImplementation((providerId) => (
      providerId === 'openrouter'
        ? { listModels }
        : originalGetProviderAdapter(providerId)
    ));

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/openrouter/models',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.data.provider_id).toBe('openrouter');
    expect(payload.source).toBe('provider_api_live');
    expect(payload.data.models.map((model) => model.id)).toEqual([
      'google/gemma-4-31b-it',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ]);
    expect(payload.data.models.every((model) => model.source === 'provider_api_live')).toBe(true);
    expect(listModels).toHaveBeenCalledWith({
      freeOnly: true,
      toolsOnly: false,
    });
  });

  it('queries live Ollama hosts for model inventory and aggregates unique descriptors', async () => {
    setProvider('ollama', { transport: 'api' });
    listOllamaHostsSpy.mockReturnValue([
      { id: 'host-a', name: 'alpha', url: 'http://alpha.local:11434', enabled: 1 },
      { id: 'host-b', name: 'beta', url: 'http://beta.local:11434', enabled: 1 },
    ]);
    httpGetSpy = vi.spyOn(http, 'get').mockImplementation(createHttpGetMock(new Map([
      ['http://alpha.local:11434/api/tags', {
        body: {
          models: [
            {
              name: 'phi4:14b',
              size: 7500000000,
              details: { parameter_size: '14B', quantization_level: 'Q4_K_M' },
            },
          ],
        },
      }],
      ['http://beta.local:11434/api/tags', {
        body: {
          models: [
            {
              name: 'deepseek-r1:14b',
              size: 9100000000,
              details: { parameter_size: '14B' },
            },
            {
              name: 'phi4:14b',
              size: 7500000000,
              details: { parameter_size: '14B' },
            },
          ],
        },
      }],
    ])));

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/ollama/models',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.meta.request_id).toEqual(expect.any(String));
    expect(payload.data.provider_id).toBe('ollama');
    expect(payload.data.refreshed_at).toEqual(expect.any(String));
    expect(payload.data.models.map((model) => model.id)).toEqual([
      'deepseek-r1:14b',
      'phi4:14b',
    ]);
    expect(payload.data.models[1]).toEqual(expect.objectContaining({
      id: 'phi4:14b',
      source: 'runtime',
      parameters: expect.objectContaining({
        parameter_count_b: 14,
        size_bytes: 7500000000,
        quantization: 'Q4_K_M',
      }),
    }));
    expect(payload.freshness).toEqual({
      checked_at: payload.data.refreshed_at,
    });
    expect(recordHostHealthCheckSpy).toHaveBeenCalledWith('host-a', true, expect.any(Array));
    expect(recordHostHealthCheckSpy).toHaveBeenCalledWith('host-b', true, expect.any(Array));
  });

  it('returns cloud health using the v2 envelope and normalized success ratio', async () => {
    setProvider('groq');
    process.env.GROQ_API_KEY = 'groq-test-key';
    getProviderHealthSpy.mockReturnValue({
      successes: 9,
      failures: 1,
      failureRate: 0.1,
    });
    isProviderHealthySpy.mockReturnValue(true);
    getProviderStatsSpy.mockReturnValue({
      provider: 'groq',
      total_tasks: 10,
      successful_tasks: 9,
      failed_tasks: 1,
      avg_duration_seconds: 1.8,
      success_rate: 90,
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/groq/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.meta.request_id).toEqual(expect.any(String));
    expect(payload.data).toEqual(expect.objectContaining({
      provider_id: 'groq',
      status: 'warning',
      latency_ms: 1800,
      success_ratio: 0.9,
      last_error: 'provider has recent failures',
      checked_at: expect.any(String),
    }));

    // Legacy fields are still present on the top level.
    expect(payload.provider_id).toBe('groq');
    expect(payload.success_ratio).toBe(0.9);
  });

  it('reports missing cloud API keys as unavailable', async () => {
    setProvider('deepinfra');

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/deepinfra/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.data).toEqual(expect.objectContaining({
      provider_id: 'deepinfra',
      status: 'unavailable',
      latency_ms: 0,
      success_ratio: 1,
      last_error: 'No API key configured',
      checked_at: expect.any(String),
    }));
  });

  it('treats provider-config OpenRouter API keys as configured for health', async () => {
    setProvider('openrouter');
    const getApiKeySpy = vi.spyOn(serverConfig, 'getApiKey')
      .mockImplementation((providerId) => (providerId === 'openrouter' ? 'openrouter-test-key' : null));

    try {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/v2/providers/openrouter/health',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);

      expect(getApiKeySpy).toHaveBeenCalledWith('openrouter');
      expect(payload.data).toEqual(expect.objectContaining({
        provider_id: 'openrouter',
        status: 'healthy',
        last_error: null,
      }));
    } finally {
      getApiKeySpy.mockRestore();
    }
  });

  it('pings Ollama hosts for health and reports measured latency with degraded status on partial failure', async () => {
    setProvider('ollama', { transport: 'api' });
    listOllamaHostsSpy.mockReturnValue([
      { id: 'host-a', name: 'alpha', url: 'http://alpha.local:11434', enabled: 1 },
      { id: 'host-b', name: 'beta', url: 'http://beta.local:11434', enabled: 1 },
    ]);
    getProviderHealthSpy.mockReturnValue({
      successes: 3,
      failures: 1,
      failureRate: 0.25,
    });
    getProviderStatsSpy.mockReturnValue({
      provider: 'ollama',
      total_tasks: 4,
      successful_tasks: 3,
      failed_tasks: 1,
      avg_duration_seconds: 2.4,
      success_rate: 75,
    });
    httpGetSpy = vi.spyOn(http, 'get').mockImplementation(createHttpGetMock(new Map([
      ['http://alpha.local:11434/api/tags', {
        delayMs: 25,
        body: {
          models: [{ name: 'phi4:14b' }],
        },
      }],
      ['http://beta.local:11434/api/tags', {
        statusCode: 503,
        body: { error: 'down' },
      }],
    ])));

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/ollama/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.meta.request_id).toEqual(expect.any(String));
    expect(payload.data.provider_id).toBe('ollama');
    expect(payload.data.status).toBe('degraded');
    expect(payload.data.latency_ms).toBeGreaterThanOrEqual(20);
    expect(payload.data.success_ratio).toBe(0.75);
    expect(payload.data.last_error).toContain('beta: HTTP 503');
    expect(payload.data.checked_at).toEqual(expect.any(String));
    expect(recordHostHealthCheckSpy).toHaveBeenCalledWith('host-a', true, expect.any(Array));
    expect(recordHostHealthCheckSpy).toHaveBeenCalledWith('host-b', false, null);
  });

  it('returns discovery-style errors for unknown providers', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/ghost/health',
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.body);

    expect(payload.error.code).toBe('provider_not_found');
    expect(payload.error.request_id).toEqual(expect.any(String));
    expect(payload.meta.request_id).toEqual(expect.any(String));
  });
});
