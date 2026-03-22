const { EventEmitter } = require('events');
const http = require('http');
const db = require('../database');
const providerRoutingCore = require('../db/provider-routing-core');
const tools = require('../tools');
const adapterRegistry = require('../providers/adapter-registry');
const eventBus = require('../event-bus');
const authMiddleware = require('../auth/middleware');

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
    writtenChunks,
    on: vi.fn((event, cb) => { listeners[event] = listeners[event] || []; listeners[event].push(cb); }),
    emit: vi.fn((event, ...args) => { (listeners[event] || []).forEach(cb => cb(...args)); }),
    setHeader: vi.fn((name, value) => { responseHeaders[name.toLowerCase()] = value; }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
    write: vi.fn((chunk) => {
      writtenChunks.push(typeof chunk === 'string' ? chunk : String(chunk || ''));
      response.body = writtenChunks.join('');
    }),
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

async function dispatchRequest(handler, { method, url, headers = {}, body, remoteAddress } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  // Provide socket with remoteAddress for rate limiting
  req.socket = { remoteAddress: remoteAddress || '127.0.0.1' };
  req.connection = { remoteAddress: remoteAddress || '127.0.0.1' };

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

function parseSseEvents(response) {
  const payload = response.body || '';
  const lines = payload.split(/\r?\n/);
  const events = [];
  let currentEvent = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = {
        event: line.slice(7).trim(),
        data: null,
      };
      continue;
    }

    if (line.startsWith('data: ')) {
      if (!currentEvent) {
        currentEvent = { event: 'message', data: null };
      }

      const data = line.slice(6).trim();
      try {
        currentEvent.data = JSON.parse(data);
      } catch {
        currentEvent.data = data;
      }
      continue;
    }

    if (line === '') {
      if (currentEvent) {
        events.push(currentEvent);
        currentEvent = null;
      }
    }
  }

  if (currentEvent) {
    events.push(currentEvent);
  }

  return events;
}

describe('API Server endpoints', () => {
  let requestHandler;
  let handleToolCallSpy;
  let getConfigSpy;
  let countTasksSpy;
  let _createTaskSpy;
  let _getTaskSpy;
  let _updateTaskStatusSpy;
  let _getTaskEventsSpy;
  let _recordTaskEventSpy;
  let listProvidersSpy;
  let getProviderSpy;
  let getDefaultProviderSpy;
  let getProviderHealthSpy;
  let isProviderHealthySpy;
  let getProviderStatsSpy;
  let listOllamaHostsSpy;
  let getProviderAdapterDefaultSpy;
  let _getProviderCapabilityMatrixSpy;
  let inferenceSubmitSpy;
  let recordProviderUsageSpy;
  let mockTaskStore;
  let mockTaskEventsStore;
  const cloudProviderModelCatalog = {
    anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514', 'claude-opus-4-20250514'],
    groq: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    deepinfra: [
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Llama-3.1-70B-Instruct',
      'meta-llama/Llama-3.1-405B-Instruct',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
    ],
    hyperbolic: [
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Llama-3.1-70B-Instruct',
      'meta-llama/Llama-3.1-405B-Instruct',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-Coder-480B-A35B',
    ],
  };
  const cloudProviderIds = Object.keys(cloudProviderModelCatalog);
  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
    close: vi.fn(),
  };

  function createTaskRow(task) {
    return {
      id: task.id,
      status: task.status || 'queued',
      provider: task.provider || 'codex',
      model: task.model || null,
      output: task.output || null,
      error_output: task.error_output || null,
      task_description: task.task_description || '',
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      ...task,
    };
  }

  function ensureTaskStore() {
    if (!mockTaskStore) {
      mockTaskStore = new Map();
      mockTaskEventsStore = new Map();
    }
  }

  function getRecordProviderUsageCalls() {
    return recordProviderUsageSpy.mock.calls.map((call) => {
      const [provider, taskId, optionsOrTokensUsed, costEstimate, durationSeconds, success, errorType] = call;
      if (optionsOrTokensUsed && typeof optionsOrTokensUsed === 'object' && !Array.isArray(optionsOrTokensUsed)) {
        return {
          provider,
          taskId,
          ...optionsOrTokensUsed,
        };
      }

      return {
        provider,
        taskId,
        tokens_used: optionsOrTokensUsed,
        cost_estimate: costEstimate,
        duration_seconds: durationSeconds,
        success,
        error_type: errorType,
      };
    });
  }

  function emitTaskEvent(taskId, eventType, oldValue, newValue, eventData = {}) {
    ensureTaskStore();
    const events = mockTaskEventsStore.get(taskId) || [];
    events.push({
      id: `${taskId}-${events.length + 1}`,
      task_id: taskId,
      event_type: eventType,
      old_value: oldValue,
      new_value: newValue,
      event_data: typeof eventData === 'string' ? eventData : JSON.stringify(eventData),
      created_at: new Date().toISOString(),
    });
    mockTaskEventsStore.set(taskId, events);
  }

  function buildTestProviderCapabilityMatrix() {
    const providers = [
      'anthropic',
      'claude-cli',
      'codex',
      'deepinfra',
      'groq',
      'hashline-ollama',
      'hyperbolic',
      'ollama',
    ];

    return providers.reduce((acc, providerId) => {
      const adapter = getProviderAdapterDefaultSpy(providerId);
      if (!adapter) return acc;
      acc[providerId] = {
        supportsStream: Boolean(adapter.supportsStream),
        supportsAsync: Boolean(adapter.supportsAsync),
        supportsCancellation: Boolean(adapter.supportsCancellation),
      };
      return acc;
    }, {});
  }

  beforeAll(() => {
    // Bypass auth so test requests aren't rejected with 401
    vi.spyOn(authMiddleware, 'authenticate').mockReturnValue({ id: 'test-admin', name: 'Test', role: 'admin', type: 'api_key' });
    vi.spyOn(authMiddleware, 'isOpenMode').mockReturnValue(true);

    // Spy on database and tools before loading api-server
    getConfigSpy = vi.spyOn(db, 'getConfig').mockReturnValue(null);
    countTasksSpy = vi.spyOn(db, 'countTasks').mockReturnValue(0);
    // Mock DB instance check for probeDatabase() — return truthy so probes see DB as initialized
    vi.spyOn(db, 'getDbInstance').mockReturnValue({});
    if (typeof db.isDbClosed === 'function') {
      vi.spyOn(db, 'isDbClosed').mockReturnValue(false);
    }
    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    listProvidersSpy = vi.spyOn(providerRoutingCore, 'listProviders').mockReturnValue([]);
    getProviderSpy = vi.spyOn(providerRoutingCore, 'getProvider').mockReturnValue(null);
    getDefaultProviderSpy = vi.spyOn(providerRoutingCore, 'getDefaultProvider').mockReturnValue('codex');
    getProviderHealthSpy = vi.spyOn(providerRoutingCore, 'getProviderHealth').mockReturnValue({
      provider: 'codex',
      total_tasks: 0,
      successful_tasks: 0,
      failed_tasks: 0,
      success_rate: 100,
      avg_duration_seconds: 0,
      total_tokens: 0,
      total_cost: 0,
    });
    isProviderHealthySpy = vi.spyOn(providerRoutingCore, 'isProviderHealthy').mockReturnValue(true);
    getProviderStatsSpy = vi.spyOn(db, 'getProviderStats').mockReturnValue({
      provider: 'codex',
      total_tasks: 10,
      successful_tasks: 9,
      failed_tasks: 1,
      success_rate: 90,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_seconds: 2.4,
    });
    listOllamaHostsSpy = vi.spyOn(db, 'listOllamaHosts').mockReturnValue([]);
    getProviderAdapterDefaultSpy = vi.fn(() => null);
    vi.spyOn(adapterRegistry, 'getProviderAdapter').mockImplementation(
      getProviderAdapterDefaultSpy,
    );
    _getProviderCapabilityMatrixSpy = vi.spyOn(adapterRegistry, 'getProviderCapabilityMatrix').mockImplementation(
      buildTestProviderCapabilityMatrix,
    );
    mockTaskStore = new Map();
    mockTaskEventsStore = new Map();

    _createTaskSpy = vi.spyOn(db, 'createTask').mockImplementation((task) => {
      ensureTaskStore();
      const row = createTaskRow({
        ...task,
      });
      mockTaskStore.set(task.id, row);
      return row;
    });

    _getTaskSpy = vi.spyOn(db, 'getTask').mockImplementation((taskId) => {
      ensureTaskStore();
      return mockTaskStore.get(taskId) || null;
    });

    _updateTaskStatusSpy = vi.spyOn(db, 'updateTaskStatus').mockImplementation((taskId, status, additionalFields = {}) => {
      ensureTaskStore();
      const row = mockTaskStore.get(taskId);
      if (!row) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const previousStatus = row.status;
      row.status = status;
      if (status === 'running' && !row.started_at) {
        row.started_at = new Date().toISOString();
      }
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        row.completed_at = new Date().toISOString();
      }
      Object.keys(additionalFields).forEach((key) => {
        if (key === '_softFail') return;
        row[key] = additionalFields[key];
      });

      emitTaskEvent(taskId, 'status', previousStatus, status, {
        request_id: row?.metadata?.request_id || 'test',
        provider: row.provider,
        model: row.model,
      });
      mockTaskStore.set(taskId, row);
      return row;
    });

    _getTaskEventsSpy = vi.spyOn(db, 'getTaskEvents').mockImplementation((taskId, options = {}) => {
      ensureTaskStore();
      const events = mockTaskEventsStore.get(taskId) || [];
      const filtered = events.filter((event) => {
        if (options.eventType && event.event_type !== options.eventType) {
          return false;
        }
        if (options.since && event.created_at <= options.since) {
          return false;
        }
        return true;
      });
      return filtered
        .sort((a, b) => {
          if (!a.created_at || !b.created_at) return 0;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        })
        .slice(0, options.limit || 100);
    });

    _recordTaskEventSpy = vi.spyOn(db, 'recordTaskEvent').mockImplementation((...args) => {
      const [taskId, eventType, oldValue, newValue, eventData] = args;
      emitTaskEvent(taskId, eventType, oldValue, newValue, eventData);
    });
    recordProviderUsageSpy = vi.spyOn(db, 'recordProviderUsage').mockImplementation(() => {});

    // Capture the request handler when api-server creates the http server
    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    // Now load api-server (it will use our spied modules)
    const apiServer = require('../api-server');
    apiServer.start({ port: 4001 });
  });

  function mockV2Adapter({
    providerId,
    capabilities = {},
    submitResult = {
      output: 'placeholder',
      status: 'completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        model: `${providerId}-model`,
      },
    },
  } = {}) {
    return {
      id: providerId,
      capabilities: {
        supportsStream: false,
        supportsAsync: false,
        supportsCancellation: false,
        ...capabilities,
      },
      supportsStream: capabilities.supportsStream || false,
      supportsAsync: capabilities.supportsAsync || false,
      supportsCancellation: false,
      submit: vi.fn().mockResolvedValue(submitResult),
      stream: vi.fn().mockRejectedValue(new Error('streaming unsupported')),
      submitAsync: vi.fn().mockResolvedValue(submitResult),
      cancel: vi.fn().mockResolvedValue({ cancelled: false, provider: providerId, supported: false }),
      normalizeResult: (response) => response,
      checkHealth: vi.fn().mockResolvedValue({}),
      listModels: vi.fn().mockResolvedValue([]),
    };
  }

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ensureTaskStore();
    mockTaskStore.clear();
    mockTaskEventsStore.clear();
    // Default to permissive auth in tests (production defaults to strict per C2 fix)
    getConfigSpy.mockImplementation((key) => {
      if (key === 'v2_auth_mode') return 'permissive';
      return null;
    });
    countTasksSpy.mockReturnValue(0);
    handleToolCallSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    listProvidersSpy.mockReturnValue([
      { provider: 'codex', enabled: true, max_concurrent: 6 },
      { provider: 'groq', enabled: true, max_concurrent: 4 },
    ]);
    getProviderSpy.mockImplementation((providerId) => {
      const providers = {
        codex: { provider: 'codex', enabled: true, max_concurrent: 6 },
        'claude-cli': { provider: 'claude-cli', enabled: true, max_concurrent: 3, transport: 'cli' },
        groq: { provider: 'groq', enabled: true, max_concurrent: 4 },
        ollama: { provider: 'ollama', enabled: true, max_concurrent: 4 },
        anthropic: { provider: 'anthropic', enabled: true, max_concurrent: 4 },
        deepinfra: { provider: 'deepinfra', enabled: true, max_concurrent: 5 },
        hyperbolic: { provider: 'hyperbolic', enabled: true, max_concurrent: 5 },
      };
      return providers[providerId] || null;
    });
    getDefaultProviderSpy.mockReturnValue('codex');
    getProviderHealthSpy.mockReturnValue({
      successes: 0,
      failures: 0,
      failureRate: 0,
    });
    isProviderHealthySpy.mockReturnValue(true);
    getProviderStatsSpy.mockReturnValue({
      provider: 'codex',
      total_tasks: 10,
      successful_tasks: 9,
      failed_tasks: 1,
      success_rate: 90,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_seconds: 2.4,
    });
    listOllamaHostsSpy.mockReturnValue([]);
    inferenceSubmitSpy = vi.fn().mockResolvedValue({
      output: 'placeholder',
      status: 'completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        model: 'codex-model',
      },
    });
    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            submitResult: {
              output: 'placeholder',
              status: 'completed',
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                duration_ms: 0,
                model: 'codex-model',
              },
            },
          }),
          submit: inferenceSubmitSpy,
        };
      }

      return null;
    });
  });

  it('GET /api/v2/providers returns provider descriptors', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.request_id).toBeDefined();
    expect(payload.meta.request_id).toBeDefined();
    expect(Array.isArray(payload.data.providers)).toBe(true);
    expect(payload.data.providers).toHaveLength(2);

    const codex = payload.data.providers.find((entry) => entry.id === 'codex');
    expect(codex).toMatchObject({
      id: 'codex',
      name: 'OpenAI Codex',
      transport: 'hybrid',
      local: false,
      enabled: true,
      default: true,
      status: 'healthy',
    });
    expect(codex.limits).toMatchObject({
      max_concurrent: 6,
      request_rate_per_minute: 120,
    });
    expect(codex.features).toEqual(expect.arrayContaining(['chat']));
    expect(codex.features).not.toContain('code_interpretation');

    const groq = payload.data.providers.find((entry) => entry.id === 'groq');
    expect(groq).toMatchObject({
      transport: 'api',
      local: false,
      enabled: true,
      default: false,
    });
  });

  it('GET /api/v2/providers/{provider_id} returns provider detail', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/codex',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.request_id).toBeDefined();
    expect(payload.meta.request_id).toBeDefined();
    expect(payload.data.provider.id).toBe('codex');
    expect(payload.data.provider.features).toEqual(expect.arrayContaining(['chat']));
    expect(payload.data.provider.limits.max_concurrent).toBe(6);
  });

  it('GET /api/v2/providers/{provider_id} returns 404 for unknown provider', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/unknown-provider',
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.body);

    expect(payload.error.code).toBe('provider_not_found');
    expect(payload.error.request_id).toBeDefined();
  });

  it('GET /api/v2/providers/{provider_id}/capabilities returns features', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/codex/capabilities',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.request_id).toBeDefined();
    expect(payload.meta.request_id).toBeDefined();
    expect(payload.data.provider_id).toBe('codex');
    expect(payload.data.capabilities).toMatchObject({
      streaming: false,
      async: false,
    });
    expect(payload.data.capabilities.supported_formats).toEqual(
      expect.arrayContaining(['text', 'embeddings']),
    );
  });

  it('GET /api/v2/providers/{provider_id}/capabilities returns 404 for unknown provider', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/ghost/capabilities',
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('provider_not_found');
    expect(payload.error.request_id).toBeDefined();
  });

  it.each(cloudProviderIds.map((providerId) => ({ providerId })))(
    'GET /api/v2/providers/{providerId}/models returns provider_api source models for $providerId',
    async ({ providerId }) => {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: `/api/v2/providers/${providerId}/models`,
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      const expectedModels = [...cloudProviderModelCatalog[providerId]].sort((left, right) => left.localeCompare(right));

      expect(payload.request_id).toBeDefined();
      expect(payload.meta.request_id).toBeDefined();
      expect(payload.provider_id).toBe(providerId);
      expect(payload.source).toBe('provider_api');
      expect(Array.isArray(payload.models)).toBe(true);
      expect(payload.models).toEqual(expectedModels);
      expect(payload.data.models.map((model) => model.id)).toEqual(expectedModels);
      expect(payload.model_count).toBe(payload.models.length);
    },
  );

  it('GET /api/v2/providers/{provider_id}/models returns runtime source models for ollama hosts', async () => {
    listOllamaHostsSpy.mockReturnValue([
      {
        id: 'host-a',
        name: 'alpha',
        url: 'http://alpha.local:11434',
        enabled: true,
      },
      {
        id: 'host-b',
        name: 'beta',
        url: 'http://beta.local:11434',
        enabled: true,
      },
    ]);

    const httpGetSpy = vi.spyOn(http, 'get').mockImplementation((url, _options, callback) => {
      const targetUrl = typeof url === 'string' ? url : url.toString();
      const request = new EventEmitter();
      request.destroy = vi.fn();

      process.nextTick(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);

        const routePayload = targetUrl === 'http://alpha.local:11434/api/tags'
          ? {
              models: ['phi4', 'llama3.1', { name: 'llama3.1', size: '4b' }],
            }
          : {
              models: [{ name: 'deepseek-r1' }, 'phi4'],
            };

        response.emit('data', JSON.stringify(routePayload));
        response.emit('end');
      });

      return request;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/ollama/models',
    });
    httpGetSpy.mockRestore();

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.request_id).toBeDefined();
    expect(payload.meta.request_id).toBeDefined();
    expect(payload.provider_id).toBe('ollama');
    expect(payload.source).toBe('runtime');
    expect(payload.models).toEqual(['deepseek-r1', 'llama3.1', 'phi4']);
    expect(payload.freshness).toEqual({ checked_at: payload.data.refreshed_at });
    expect(payload.data.models.map((model) => model.id)).toEqual(['deepseek-r1', 'llama3.1', 'phi4']);
    expect(payload.model_count).toBe(3);
  });

  it('GET /api/v2/providers/{provider_id}/models returns 404 for unknown provider', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/ghost/models',
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('provider_not_found');
    expect(payload.error.request_id).toBeDefined();
  });

  it('GET /api/v2/providers/{provider_id}/health returns health metadata', async () => {
    getConfigSpy.mockImplementation((key) => {
      if (key === 'v2_auth_mode') return 'permissive';
      if (key === 'groq_api_key') return 'groq-test-key';
      return null;
    });
    getProviderStatsSpy.mockReturnValue({
      provider: 'groq',
      total_tasks: 10,
      successful_tasks: 9,
      failed_tasks: 1,
      success_rate: 90,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_seconds: 2.75,
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/groq/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.request_id).toBeDefined();
    expect(payload.provider_id).toBe('groq');
    expect(payload.status).toBe('healthy');
    expect(payload.latency_ms).toBe(2750);
    expect(payload.success_ratio).toBe(0.9);
    expect(typeof payload.checked_at).toBe('string');
  });

  it.each(cloudProviderIds.map((providerId) => ({ providerId })))(
    'GET /api/v2/providers/{providerId}/health returns health metadata for $providerId',
    async ({ providerId }) => {
      const apiKeyByProvider = {
        anthropic: 'anthropic_api_key',
        groq: 'groq_api_key',
        deepinfra: 'deepinfra_api_key',
        hyperbolic: 'hyperbolic_api_key',
      };
      getConfigSpy.mockImplementation((key) => {
        if (key === 'v2_auth_mode') return 'permissive';
        return key === apiKeyByProvider[providerId] ? `${providerId}-test-key` : null;
      });
      getProviderStatsSpy.mockReturnValue({
        provider: providerId,
        total_tasks: 8,
        successful_tasks: 7,
        failed_tasks: 1,
        success_rate: 87,
        total_tokens: 0,
        total_cost: 0,
        avg_duration_seconds: 1.8,
      });

      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: `/api/v2/providers/${providerId}/health`,
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);

      expect(payload.request_id).toBeDefined();
      expect(payload.provider_id).toBe(providerId);
      expect(payload.status).toBe('healthy');
      expect(payload.latency_ms).toBe(1800);
      expect(payload.success_ratio).toBe(0.875);
      expect(typeof payload.checked_at).toBe('string');
    },
  );

  it('GET /api/v2/providers/{provider_id}/health returns 404 for unknown provider', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/ghost/health',
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('provider_not_found');
    expect(payload.error.request_id).toBeDefined();
  });

  it('POST /api/v2/inference returns validation_error when prompt/messages are missing', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { model: 'llama' },
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body);

    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.request_id).toBeDefined();
    expect(payload.error.details.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'messages',
          code: 'missing',
        }),
      ]),
    );
  });

  it('POST /api/v2/inference returns validation_error when both prompt and messages are supplied', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: {
        prompt: 'Summarize this',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.request_id).toBeDefined();
    expect(payload.error.details.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'messages',
          code: 'ambiguous',
        }),
      ]),
    );
  });

  it('POST /api/v2/inference returns validation_error for invalid timeout bound', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: {
        prompt: 'Hello',
        timeout_ms: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.request_id).toBeDefined();
    expect(payload.error.details.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'timeout_ms',
          code: 'range',
        }),
      ]),
    );
  });

  it('POST /api/v2/inference returns validation_error for invalid transport', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Use invalid transport', transport: 'webrtc' },
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.request_id).toBeDefined();
    expect(payload.error.details.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'transport',
          code: 'value',
        }),
      ]),
    );
  });

  it('POST /api/v2/inference returns validation_error when no provider and no default provider exists', async () => {
    getDefaultProviderSpy.mockReturnValue(null);

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Summarize this' },
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.request_id).toBeDefined();
    expect(payload.error.details.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'provider',
          code: 'missing',
        }),
      ]),
    );
  });

  it('POST /api/v2/inference returns validation_error for invalid JSON', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: '{ invalid json }',
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.request_id).toBeDefined();
  });

  it('POST /api/v2/inference returns stream_not_supported when selected adapter does not support streaming', async () => {
    const fallbackStreamUnsupported = vi.fn().mockResolvedValue({
      output: 'fallback stream',
      status: 'completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        model: 'codex-model',
      },
    });

    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            submitResult: {
              output: 'api placeholder',
              status: 'completed',
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                duration_ms: 0,
                model: 'codex-model',
              },
            },
            capabilities: {
              supportsStream: false,
              supportsAsync: false,
            },
          }),
          submit: inferenceSubmitSpy,
          stream: vi.fn(),
        };
      }

      if (providerId === 'claude-cli') {
        return {
          ...mockV2Adapter({
            providerId: 'claude-cli',
            capabilities: {
              supportsStream: false,
              supportsAsync: false,
            },
          }),
          submit: fallbackStreamUnsupported,
          stream: vi.fn(),
        };
      }

      return null;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Hello world', stream: true },
    });

    expect(response.statusCode).toBe(400);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('stream_not_supported');
    expect(payload.error.details).toMatchObject({
      transport: 'cli',
      route_reason: 'fallback_api_to_cli',
    });
    expect(payload.error.details.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          reason: 'provider_transport_api',
          status: 'failed',
          failure_reason: 'stream_unsupported',
          attempt_start_at: expect.any(String),
          attempt_end_at: expect.any(String),
          attempt_elapsed_ms: expect.any(Number),
        }),
        expect.objectContaining({
          provider: 'codex',
          transport: 'cli',
          reason: 'fallback_api_to_cli',
          status: 'failed',
          failure_reason: 'stream_unsupported',
          attempt_start_at: expect.any(String),
          attempt_end_at: expect.any(String),
          attempt_elapsed_ms: expect.any(Number),
        }),
      ]),
    );
    expect(payload.error.details.retry_count).toBe(2);
    expect(payload.error.request_id).toBeDefined();

    const usageCalls = getRecordProviderUsageCalls();
    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          success: false,
          failure_reason: 'stream_unsupported',
        }),
        expect.objectContaining({
          provider: 'codex',
          transport: 'cli',
          success: false,
          failure_reason: 'stream_unsupported',
        }),
      ]),
    );
    expect(usageCalls.filter((call) => call.provider === 'codex').length).toBe(2);
  });

  it('POST /api/v2/inference returns normalized synchronous success payload', async () => {
    inferenceSubmitSpy.mockResolvedValue({
      output: 'review passed with 3 suggestions',
      status: 'completed',
      usage: {
        input_tokens: 5,
        output_tokens: 12,
        total_tokens: 17,
        duration_ms: 1234,
        model: 'codex-model',
      },
      extra: { reviewed: true },
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: {
        prompt: 'Review this diff',
        model: 'codex-model',
        temperature: 0.2,
        max_tokens: 1200,
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.request_id).toBeDefined();
    expect(payload.task_id).toBeNull();
    expect(payload.status).toBe('completed');
    expect(payload.provider).toBe('codex');
    expect(payload.model).toBe('codex-model');
    expect(payload.result).toMatchObject({
      type: 'text',
      content: 'review passed with 3 suggestions',
      meta: {},
    });
    expect(payload.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 12,
      total_tokens: 17,
      elapsed_ms: 1234,
    });
    expect(payload.raw).toMatchObject({
      status: 'completed',
      extra: { reviewed: true },
    });
    const usageCalls = getRecordProviderUsageCalls();
    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          taskId: null,
          retry_count: 0,
          success: true,
          failure_reason: null,
          elapsed_ms: expect.any(Number),
          tokens_used: 17,
        }),
      ]),
    );
    expect(usageCalls).toHaveLength(1);
    expect(inferenceSubmitSpy).toHaveBeenCalledWith(
      'Review this diff',
      'codex-model',
      expect.objectContaining({
        timeout: expect.any(Number),
        maxTokens: 1200,
        tuning: { temperature: 0.2 },
      }),
    );
  });

  it.each([
    {
      providerId: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      output: 'anthropic reply',
      usage: { input_tokens: 3, output_tokens: 8, total_tokens: 11, duration_ms: 900 },
    },
    {
      providerId: 'groq',
      model: 'llama-3.1-70b-versatile',
      output: 'groq reply',
      usage: { input_tokens: 2, output_tokens: 7, total_tokens: 9, duration_ms: 720 },
    },
    {
      providerId: 'deepinfra',
      model: 'Qwen/Qwen2.5-72B-Instruct',
      output: 'deepinfra reply',
      usage: { input_tokens: 4, output_tokens: 11, total_tokens: 15, duration_ms: 1040 },
    },
    {
      providerId: 'hyperbolic',
      model: 'Qwen/Qwen2.5-72B-Instruct',
      output: 'hyperbolic reply',
      usage: { input_tokens: 1, output_tokens: 10, total_tokens: 11, duration_ms: 640 },
    },
  ])('POST /api/v2/providers/$providerId/inference returns same success schema as generic inference', async ({
    providerId,
    model,
    output,
    usage,
  }) => {
    const providerSubmitSpy = vi.fn().mockResolvedValue({
      output,
      status: 'completed',
      usage: {
        ...usage,
        model,
      },
    });
    const providerDescriptor = {
      provider: providerId,
      enabled: true,
      max_concurrent: 4,
    };

    getProviderSpy.mockImplementation((requestedProviderId) => {
      if (requestedProviderId === providerId) {
        return providerDescriptor;
      }

      if (requestedProviderId === 'codex') {
        return {
          provider: 'codex',
          enabled: true,
          max_concurrent: 6,
        };
      }

      return requestedProviderId === 'ollama'
        ? { provider: 'ollama', enabled: true, max_concurrent: 4 }
        : null;
    });

    getProviderAdapterDefaultSpy.mockImplementation((requestedProviderId) => {
      if (requestedProviderId === providerId) {
        return {
          ...mockV2Adapter({
            providerId,
            submitResult: {
              output,
              status: 'completed',
              usage: {
                ...usage,
                model,
              },
            },
          }),
          submit: providerSubmitSpy,
        };
      }

      if (requestedProviderId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            submitResult: {
              output: 'codex placeholder',
              status: 'completed',
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                duration_ms: 0,
              },
            },
          }),
          submit: inferenceSubmitSpy,
        };
      }

      return null;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: `/api/v2/providers/${providerId}/inference`,
      body: { prompt: 'Summarize this', model, max_tokens: 500 },
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);

    expect(payload.request_id).toBeDefined();
    expect(payload.task_id).toBeNull();
    expect(payload.status).toBe('completed');
    expect(payload.provider).toBe(providerId);
    expect(payload.model).toBe(model);
    expect(payload.result).toMatchObject({
      type: 'text',
      content: output,
      meta: {},
    });
    expect(payload.usage).toMatchObject({
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      elapsed_ms: usage.duration_ms,
    });
    expect(providerSubmitSpy).toHaveBeenCalledWith(
      'Summarize this',
      model,
      expect.objectContaining({
        timeout: expect.any(Number),
        maxTokens: 500,
      }),
    );
  });

  it.each(cloudProviderIds.map((providerId) => ({ providerId })))(
    'POST /api/v2/providers/$providerId/inference maps provider API throttling to provider_unavailable',
    async ({ providerId }) => {
      const providerSubmitSpy = vi.fn().mockRejectedValue(new Error('provider throttled, retry_after_seconds=5'));

      getProviderAdapterDefaultSpy.mockImplementation((requestedProviderId) => {
        if (requestedProviderId === providerId) {
          return {
            ...mockV2Adapter({
              providerId,
              submitResult: {
                output: 'placeholder',
                status: 'completed',
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                  duration_ms: 0,
                  model: 'retry-model',
                },
              },
            }),
            submit: providerSubmitSpy,
          };
        }

        if (requestedProviderId === 'codex') {
          return {
            ...mockV2Adapter({
              providerId: 'codex',
              submitResult: {
                output: 'placeholder',
                status: 'completed',
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                  duration_ms: 0,
                  model: 'codex-model',
                },
              },
            }),
            submit: inferenceSubmitSpy,
          };
        }

        return null;
      });

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: `/api/v2/providers/${providerId}/inference`,
        body: { prompt: 'Summarize this', model: 'auto', max_tokens: 400 },
      });

      expect(response.statusCode).toBe(500);
      const payload = JSON.parse(response.body);

      expect(payload.error.code).toBe('provider_unavailable');
      expect(payload.error.message).toMatch(/retry_after_seconds=5/);
      expect(payload.error.details).toMatchObject({
        provider: providerId,
        route_reason: 'provider_route',
        transport: 'api',
      });
      expect(Array.isArray(payload.error.details.attempts)).toBe(true);
      expect(payload.error.request_id).toBeDefined();
      expect(providerSubmitSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('POST /api/v2/inference uses explicit transport preference then fallback for codex', async () => {
    const codexSubmitSpy = vi.fn().mockImplementation(async (_prompt, _model, options = {}) => {
      if (options.transport === 'api') {
        throw new Error('temporary api transport issue');
      }

      return {
        output: 'cli fallback reply',
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          duration_ms: 250,
          model: 'codex-model',
        },
      };
    });

    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            capabilities: {
              supportsStream: false,
              supportsAsync: false,
            },
            submitResult: {
              output: 'api placeholder',
              status: 'failed',
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                duration_ms: 0,
                model: 'codex-model',
              },
              error: 'temporary issue',
            },
          }),
          submit: codexSubmitSpy,
        };
      }

      return null;
    });

    getProviderSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          provider: 'codex',
          enabled: true,
          max_concurrent: 6,
        };
      }
      return null;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Fallback sync transport', model: 'codex-model', transport: 'api' },
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.provider).toBe('codex');
    expect(payload.transport).toBe('cli');
    expect(payload.route_reason).toBe('fallback_api_to_cli');
    expect(Array.isArray(payload.attempts)).toBe(true);
    expect(payload.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          reason: 'request_transport_api',
          status: 'failed',
          failure_reason: 'provider_unavailable',
          attempt_start_at: expect.any(String),
          attempt_end_at: expect.any(String),
          attempt_elapsed_ms: expect.any(Number),
        }),
        expect.objectContaining({
          provider: 'codex',
          transport: 'cli',
          reason: 'fallback_api_to_cli',
          status: 'succeeded',
          failure_reason: null,
          attempt_start_at: expect.any(String),
          attempt_end_at: expect.any(String),
          attempt_elapsed_ms: expect.any(Number),
        }),
      ]),
    );
    expect(payload.retry_count).toBe(1);
    expect(codexSubmitSpy).toHaveBeenCalledTimes(2);
    const usageCalls = getRecordProviderUsageCalls().filter((call) => call.provider === 'codex');
    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          retry_count: 0,
          success: false,
          failure_reason: 'provider_unavailable',
          elapsed_ms: expect.any(Number),
        }),
        expect.objectContaining({
          provider: 'codex',
          transport: 'cli',
          retry_count: 1,
          success: true,
          failure_reason: null,
          elapsed_ms: expect.any(Number),
        }),
      ]),
    );
  });

  it('POST /api/v2/inference keeps canonical v2 response shape across explicit codex transport selection', async () => {
    const parityResponse = {
      output: 'parity reply content',
      status: 'completed',
      usage: {
        input_tokens: 2,
        output_tokens: 5,
        total_tokens: 7,
        duration_ms: 321,
        model: 'codex-model',
      },
    };

    const apiSubmitSpy = vi.fn().mockResolvedValue(parityResponse);

    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            submitResult: parityResponse,
          }),
          submit: apiSubmitSpy,
        };
      }

      return null;
    });

    const apiResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Compare payload across transports', transport: 'api', model: 'codex-model' },
    });
    expect(apiResponse.statusCode).toBe(200);
    const apiPayload = JSON.parse(apiResponse.body);

    const cliResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Compare payload across transports', transport: 'cli', model: 'codex-model' },
    });
    expect(cliResponse.statusCode).toBe(200);
    const cliPayload = JSON.parse(cliResponse.body);

    expect(apiPayload.provider).toBe('codex');
    expect(cliPayload.provider).toBe('codex');
    expect(apiPayload.transport).toBe('api');
    expect(cliPayload.transport).toBe('cli');
    expect(apiPayload.route_reason).toBe('request_transport_api');
    expect(cliPayload.route_reason).toBe('request_transport_cli');
    expect(apiPayload.status).toBe('completed');
    expect(cliPayload.status).toBe('completed');
    expect(apiPayload.model).toBe('codex-model');
    expect(cliPayload.model).toBe('codex-model');
    expect(apiPayload.result).toMatchObject({
      type: 'text',
      content: 'parity reply content',
      meta: {},
    });
    expect(cliPayload.result).toMatchObject({
      type: 'text',
      content: 'parity reply content',
      meta: {},
    });
    expect(apiPayload.usage).toMatchObject({
      input_tokens: 2,
      output_tokens: 5,
      total_tokens: 7,
      elapsed_ms: 321,
    });
    expect(cliPayload.usage).toMatchObject({
      input_tokens: 2,
      output_tokens: 5,
      total_tokens: 7,
      elapsed_ms: 321,
    });
    expect(apiPayload.raw).toMatchObject({
      status: 'completed',
      usage: expect.objectContaining({
        input_tokens: 2,
        output_tokens: 5,
        total_tokens: 7,
        duration_ms: 321,
      }),
    });
    expect(cliPayload.raw).toMatchObject({
      status: 'completed',
      usage: expect.objectContaining({
        input_tokens: 2,
        output_tokens: 5,
        total_tokens: 7,
        duration_ms: 321,
      }),
    });
    expect(apiPayload.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          reason: 'request_transport_api',
          status: 'succeeded',
        }),
      ]),
    );
    expect(cliPayload.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'cli',
          reason: 'request_transport_cli',
          status: 'succeeded',
        }),
      ]),
    );
    expect(apiPayload.request_id).toBeDefined();
    expect(cliPayload.request_id).toBeDefined();
    expect(apiPayload.request_id).not.toBe(cliPayload.request_id);
    expect(apiPayload.retry_count).toBe(0);
    expect(cliPayload.retry_count).toBe(0);
    expect(apiSubmitSpy).toHaveBeenCalledTimes(2);
    const usageCalls = getRecordProviderUsageCalls();
    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          taskId: null,
          success: true,
          failure_reason: null,
          elapsed_ms: expect.any(Number),
        }),
        expect.objectContaining({
          provider: 'codex',
          transport: 'cli',
          taskId: null,
          success: true,
          failure_reason: null,
          elapsed_ms: expect.any(Number),
        }),
      ]),
    );
  });

  it('POST /api/v2/inference applies codex async fallback from api to cli transport', async () => {
    const codexAsyncSubmitSpy = vi.fn().mockImplementation(async (_prompt, _model, options = {}) => {
      if (options.transport === 'api') {
        throw new Error('api transport down');
      }

      return {
        output: 'async cli fallback output',
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 5,
          total_tokens: 6,
          duration_ms: 300,
          model: 'codex-model',
        },
      };
    });

    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            capabilities: {
              supportsAsync: true,
            },
          }),
          supportsAsync: true,
          submit: codexAsyncSubmitSpy,
        };
      }

      return null;
    });

    const createResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Async fallback', async: true },
    });

    expect(createResponse.statusCode).toBe(202);
    const createPayload = JSON.parse(createResponse.body);
    expect(createPayload.status).toBe('queued');
    expect(createPayload.provider).toBe('codex');
    expect(createPayload.transport).toBe('api');
    expect(createPayload.route_reason).toBe('provider_transport_api');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const statusResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: `/api/v2/tasks/${createPayload.task_id}`,
    });

    expect(statusResponse.statusCode).toBe(200);
    const statusPayload = JSON.parse(statusResponse.body);
    // CP handler wraps response in { data: {...}, meta: {...} }
    const taskData = statusPayload.data;
    expect(taskData.status).toBe('completed');
    expect(taskData.provider).toBe('codex');
    expect(codexAsyncSubmitSpy).toHaveBeenCalledTimes(2);
    const usageCalls = getRecordProviderUsageCalls().filter((call) => call.provider === 'codex');
    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          taskId: createPayload.task_id,
          retry_count: 0,
          success: false,
          failure_reason: 'provider_unavailable',
          elapsed_ms: expect.any(Number),
        }),
        expect.objectContaining({
          provider: 'codex',
          transport: 'cli',
          taskId: createPayload.task_id,
          retry_count: 1,
          success: true,
          failure_reason: null,
          elapsed_ms: expect.any(Number),
        }),
      ]),
    );
    expect(usageCalls.filter((call) => call.provider === 'codex' && call.taskId === createPayload.task_id).length).toBe(2);
    expect(usageCalls.filter((call) => call.provider === 'codex' && call.transport === 'cli' && call.taskId === createPayload.task_id).length).toBe(1);
  });

  it('POST /api/v2/inference returns async task response for async inference', async () => {
    const asyncSubmitSpy = vi.fn().mockResolvedValue({
      output: 'async placeholder',
      status: 'completed',
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
        duration_ms: 250,
        model: 'codex-model',
      },
    });
    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            capabilities: {
              supportsAsync: true,
            },
            submitResult: {
              output: 'async placeholder',
              status: 'completed',
              usage: {
                input_tokens: 2,
                output_tokens: 3,
                total_tokens: 5,
                duration_ms: 250,
                model: 'codex-model',
              },
            },
          }),
          submit: asyncSubmitSpy,
          stream: vi.fn().mockResolvedValue({
            output: 'should-not-be-used',
            status: 'completed',
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              duration_ms: 0,
              model: 'codex-model',
            },
          }),
        };
      }
      return null;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: {
        prompt: 'Run async inference',
        async: true,
        model: 'codex-model',
      },
    });

    expect(response.statusCode).toBe(202);
    const payload = JSON.parse(response.body);
    expect(payload.task_id).toBeDefined();
    expect(payload.status).toBe('queued');
    expect(payload.polling_url).toBe(`/api/v2/tasks/${payload.task_id}`);

    await new Promise((resolve) => setImmediate(resolve));

    const statusResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: `/api/v2/tasks/${payload.task_id}`,
    });
    expect(statusResponse.statusCode).toBe(200);
    const statusPayload = JSON.parse(statusResponse.body);
    // CP handler wraps response in { data: {...}, meta: {...} }
    const taskData = statusPayload.data;
    expect(taskData.status).toBe('completed');
    expect(taskData.provider).toBe('codex');
    expect(asyncSubmitSpy).toHaveBeenCalledWith(
      'Run async inference',
      'codex-model',
      expect.objectContaining({
        timeout: expect.any(Number),
      }),
    );
    const usageCalls = getRecordProviderUsageCalls();
    expect(usageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'codex',
          transport: 'api',
          taskId: payload.task_id,
          retry_count: 0,
          success: true,
          failure_reason: null,
          elapsed_ms: expect.any(Number),
        }),
      ]),
    );
    expect(usageCalls.filter((call) => call.provider === 'codex').length).toBe(1);
  });

  it('POST /api/v2/inference supports streaming and emits SSE chunk/completion events', async () => {
    const previousDashboardPort = process.env.TORQUE_DASHBOARD_PORT;
    process.env.TORQUE_DASHBOARD_PORT = '4567';
    const streamSpy = vi.fn(async (_prompt, _model, options = {}) => {
      options.onChunk?.('first');
      options.onChunk?.('second');
      return {
        output: 'full response',
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          duration_ms: 1100,
          model: 'codex-model',
        },
      };
    });

    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            capabilities: {
              supportsStream: true,
            },
          }),
          submit: inferenceSubmitSpy,
          stream: streamSpy,
        };
      }
      return null;
    });

    try {
      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/v2/inference',
        body: { prompt: 'stream this', stream: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toContain('text/event-stream');
      expect(response.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4567');
      expect(response.body).toContain('event: status');
      expect(response.body).toContain('event: chunk');
      expect(response.body).toContain('event: completion');

      const events = parseSseEvents(response);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'status',
            data: expect.objectContaining({ status: 'running' }),
          }),
          expect.objectContaining({
            event: 'chunk',
            data: expect.objectContaining({ chunk: 'first', sequence: 1 }),
          }),
          expect.objectContaining({
            event: 'chunk',
            data: expect.objectContaining({ chunk: 'second', sequence: 2 }),
          }),
          expect.objectContaining({
            event: 'completion',
            data: expect.objectContaining({
              status: 'completed',
              result: expect.objectContaining({
                content: 'full response',
              }),
            }),
          }),
        ]),
      );
      const usageCalls = getRecordProviderUsageCalls();
      expect(usageCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: 'codex',
            transport: 'api',
            taskId: null,
            retry_count: 0,
            success: true,
            failure_reason: null,
            elapsed_ms: expect.any(Number),
            duration_seconds: expect.any(Number),
          }),
        ]),
      );
      expect(usageCalls.filter((call) => call.provider === 'codex').length).toBe(1);
    } finally {
      if (previousDashboardPort === undefined) {
        delete process.env.TORQUE_DASHBOARD_PORT;
      } else {
        process.env.TORQUE_DASHBOARD_PORT = previousDashboardPort;
      }
    }
  });

  it('GET /api/v2/tasks/{task_id}/events returns completion event for async task', async () => {
    const asyncSubmitSpy = vi.fn().mockResolvedValue({
      output: 'evented response',
      status: 'completed',
      usage: {
        input_tokens: 1,
        output_tokens: 3,
        total_tokens: 4,
        duration_ms: 100,
        model: 'codex-model',
      },
    });
    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            capabilities: {
              supportsAsync: true,
            },
          }),
          submit: asyncSubmitSpy,
          stream: vi.fn().mockResolvedValue({
            output: 'stream fallback',
            status: 'completed',
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              duration_ms: 0,
              model: 'codex-model',
            },
          }),
        };
      }
      return null;
    });

    const createResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Emit task events', async: true },
    });
    const { task_id: taskId } = JSON.parse(createResponse.body);
    await new Promise((resolve) => setImmediate(resolve));

    const eventsResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: `/api/v2/tasks/${taskId}/events`,
    });

    expect(eventsResponse.statusCode).toBe(200);
    expect(eventsResponse.headers['Content-Type']).toContain('text/event-stream');
    const events = parseSseEvents(eventsResponse);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'completion',
        data: expect.objectContaining({
          status: 'completed',
          result: expect.objectContaining({
            content: 'evented response',
          }),
        }),
      }),
    );
    expect(asyncSubmitSpy).toHaveBeenCalled();
  });

  it('POST /api/v2/tasks/{task_id}/cancel marks task as cancelled', async () => {
    let submitRelease;
    const asyncSubmitSpy = vi.fn(() => new Promise((resolve) => {
      submitRelease = resolve;
    }));
    getProviderAdapterDefaultSpy.mockImplementation((providerId) => {
      if (providerId === 'codex') {
        return {
          ...mockV2Adapter({
            providerId: 'codex',
            capabilities: {
              supportsAsync: true,
            },
          }),
          submit: asyncSubmitSpy,
        };
      }
      return null;
    });

    const createResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Cancelable task', async: true },
    });
    const { task_id: taskId } = JSON.parse(createResponse.body);
    await new Promise((resolve) => setImmediate(resolve));

    expect(typeof submitRelease).toBe('function');

    const cancelResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/cancel`,
    });
    expect(cancelResponse.statusCode).toBe(200);
    const cancelPayload = JSON.parse(cancelResponse.body);
    // CP cancel handler wraps response in { data: {...}, meta: {...} }
    const cancelData = cancelPayload.data;
    expect(cancelData.task_id).toBe(taskId);
    expect(cancelData.status).toBe('cancelled');
    expect(cancelData.cancelled).toBe(true);

    submitRelease({
      output: 'cancelled result',
      status: 'completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const statusResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: `/api/v2/tasks/${taskId}`,
    });
    const statusPayload = JSON.parse(statusResponse.body);
    expect(statusPayload.data.status).toBe('cancelled');
  });

  it('GET /api/tasks forwards to list_tasks tool with query params', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks?status=running&limit=10',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_tasks', { status: 'running', limit: '10' });
    expect(response.statusCode).toBe(200);
  });

  it('GET /api/tasks/:id forwards to get_result tool', async () => {
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: '{"id":"abc-123"}' }],
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks/abc-123',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('get_result', { task_id: 'abc-123' });
    expect(response.statusCode).toBe(200);
  });

  it('DELETE /api/tasks/:id forwards query params to cancel_task tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'DELETE',
      url: '/api/tasks/abc-123?confirm=true',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('cancel_task', {
      task_id: 'abc-123',
      confirm: 'true',
    });
    expect(response.statusCode).toBe(200);
  });

  it('GET /api/status forwards to check_status tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/status',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('check_status', {});
    expect(response.statusCode).toBe(200);
  });

  it('GET /api/providers forwards to list_providers tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/providers',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_providers', {});
    expect(response.statusCode).toBe(200);
  });

  it('POST /api/providers/configure forwards to configure_provider tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/providers/configure',
      body: { provider: 'ollama', enabled: true },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('configure_provider', { provider: 'ollama', enabled: true });
    expect(response.statusCode).toBe(200);
  });

  it('POST /api/providers/default forwards to set_default_provider tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/providers/default',
      body: { provider: 'codex' },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('set_default_provider', { provider: 'codex' });
    expect(response.statusCode).toBe(200);
  });

  it('GET /api/ollama/hosts forwards to list_ollama_hosts tool with query params', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/ollama/hosts?enabled_only=true',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_ollama_hosts', { enabled_only: 'true' });
    expect(response.statusCode).toBe(200);
  });

  it('POST /api/ollama/hosts forwards to add_ollama_host tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/ollama/hosts',
      body: { id: 'local-gpu', name: 'Local GPU', url: 'http://127.0.0.1:11434' },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('add_ollama_host', {
      id: 'local-gpu',
      name: 'Local GPU',
      url: 'http://127.0.0.1:11434',
    });
    expect(response.statusCode).toBe(200);
  });

  it('ollama host path routes forward to remove/enable/disable/refresh tools', async () => {
    const removeResponse = await dispatchRequest(requestHandler, {
      method: 'DELETE',
      url: '/api/ollama/hosts/discovered-test-host',
    });
    expect(handleToolCallSpy).toHaveBeenCalledWith('remove_ollama_host', { host_id: 'discovered-test-host' });
    expect(removeResponse.statusCode).toBe(200);

    const enableResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/ollama/hosts/discovered-test-host/enable',
    });
    expect(handleToolCallSpy).toHaveBeenCalledWith('enable_ollama_host', { host_id: 'discovered-test-host' });
    expect(enableResponse.statusCode).toBe(200);

    const disableResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/ollama/hosts/discovered-test-host/disable',
    });
    expect(handleToolCallSpy).toHaveBeenCalledWith('disable_ollama_host', { host_id: 'discovered-test-host' });
    expect(disableResponse.statusCode).toBe(200);

    const refreshResponse = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/ollama/hosts/discovered-test-host/refresh-models',
    });
    expect(handleToolCallSpy).toHaveBeenCalledWith('refresh_host_models', { host_id: 'discovered-test-host' });
    expect(refreshResponse.statusCode).toBe(200);
  });

  it('POST /api/workflows/{workflow_id}/tasks forwards to add_workflow_task tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/workflows/alpha-123/tasks',
      body: { path: 'src/main.js', type: 'add' },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('add_workflow_task', {
      workflow_id: 'alpha-123',
      path: 'src/main.js',
      type: 'add',
    });
    expect(response.statusCode).toBe(200);
  });

  it('POST /api/tools/strategic_decompose forwards to strategic_decompose tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/tools/strategic_decompose',
      body: {
        feature_name: 'TorqueCli',
        working_directory: '/tmp/test-project',
      },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('strategic_decompose', {
      feature_name: 'TorqueCli',
      working_directory: '/tmp/test-project',
    });
    expect(response.statusCode).toBe(200);
  });

  it('rollback drill: v2 is disabled and MCP compatibility still responds', async () => {
    getProviderSpy.mockImplementation((providerId) => {
      const providers = {
        codex: { provider: 'codex', enabled: false, max_concurrent: 6 },
        'claude-cli': { provider: 'claude-cli', enabled: false, max_concurrent: 3, transport: 'cli' },
        groq: { provider: 'groq', enabled: false, max_concurrent: 4 },
        ollama: { provider: 'ollama', enabled: false, max_concurrent: 4 },
        anthropic: { provider: 'anthropic', enabled: false, max_concurrent: 4 },
        deepinfra: { provider: 'deepinfra', enabled: false, max_concurrent: 5 },
        hyperbolic: { provider: 'hyperbolic', enabled: false, max_concurrent: 5 },
      };
      return providers[providerId] || null;
    });

    const v2Response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Run rollback drill while all providers are disabled.' },
    });

    expect(v2Response.statusCode).toBe(503);
    const v2Payload = JSON.parse(v2Response.body);
    expect(v2Payload.error.code).toBe('provider_unavailable');
    expect(v2Payload.error.message).toContain('Provider is disabled');
    expect(v2Payload.error.details?.attempts?.length).toBeGreaterThan(0);
    expect(v2Payload.error.details.attempts[0]).toMatchObject({
      provider: 'codex',
      error: 'provider_disabled',
    });
    expect(v2Payload.error.details.retry_count).toBeGreaterThanOrEqual(1);
    expect(v2Payload.error.details.attempts[0]).toMatchObject({
      failure_reason: 'provider_disabled',
      attempt_start_at: expect.any(String),
      attempt_end_at: expect.any(String),
      attempt_elapsed_ms: expect.any(Number),
    });

    const mcpTasksResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks?status=running&limit=10',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_tasks', { status: 'running', limit: '10' });
    expect(mcpTasksResponse.statusCode).toBe(200);

    const mcpStatusResponse = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/status',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('check_status', {});
    expect(mcpStatusResponse.statusCode).toBe(200);
  });

  it('GET /healthz returns health check payload', async () => {
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'healthy' }],
    });
    countTasksSpy.mockImplementation((f) => {
      if (f?.status === 'queued') return 2;
      if (f?.status === 'running') return 1;
      return 0;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/healthz',
    });

    // Codex RB-120: healthz now returns 'healthy'/'degraded'/'unhealthy' status
    // with DB as critical dependency. Ollama down = 200 degraded, DB down = 503.
    const payload = JSON.parse(response.body);
    expect([200, 503]).toContain(response.statusCode);
    expect(['healthy', 'degraded', 'unhealthy']).toContain(payload.status);
    expect(payload.database).toBe('connected');
    expect(payload.ollama).toBeDefined();
    expect(typeof payload.uptime_seconds).toBe('number');
  });

  it('OPTIONS returns CORS preflight response', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'OPTIONS',
      url: '/api/tasks',
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 401 when authentication fails', async () => {
    // Override the default auth mock to simulate missing/invalid credentials
    authMiddleware.authenticate.mockReturnValueOnce(null);

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks',
    });

    expect(response.statusCode).toBe(401);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('unauthorized');
    expect(payload.error.request_id).toBeDefined();
    expect(payload.error.message).toBe('Invalid or missing API key');
    expect(response.headers['WWW-Authenticate']).toBe('Bearer realm="Torque API", error="invalid_token"');
  });

  it('returns contract-shaped 401 for v2 inference when not authenticated', async () => {
    authMiddleware.authenticate.mockReturnValueOnce(null);

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { model: 'codex', prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(401);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('unauthorized');
    expect(payload.error.request_id).toBeDefined();
    expect(response.headers['WWW-Authenticate']).toBe('Bearer realm="Torque API", error="invalid_token"');
  });

  it('POST /api/v2/inference returns 401 when auth fails in strict mode', async () => {
    authMiddleware.authenticate.mockReturnValueOnce(null);
    getConfigSpy.mockImplementation((key) => {
      if (key === 'v2_auth_mode') return 'strict';
      return null;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(401);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('unauthorized');
    expect(payload.error.message).toBe('Invalid or missing API key');
    expect(response.headers['WWW-Authenticate']).toBe('Bearer realm="Torque API", error="invalid_token"');
  });

  it('POST /api/v2/inference returns 401 when auth fails even with strict mode and api_key config', async () => {
    authMiddleware.authenticate.mockReturnValueOnce(null);
    getConfigSpy.mockImplementation((key) => {
      if (key === 'v2_auth_mode') return 'strict';
      if (key === 'api_key') return 'secret-key-123';
      return null;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'Hello' },
    });

    expect(response.statusCode).toBe(401);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('unauthorized');
    expect(payload.error.request_id).toBeDefined();
    expect(response.headers['WWW-Authenticate']).toBe('Bearer realm="Torque API", error="invalid_token"');
  });

  it('POST /api/v2/inference succeeds with valid key when strict mode is enabled', async () => {
    getConfigSpy.mockImplementation((key) => {
      if (key === 'v2_auth_mode') return 'strict';
      if (key === 'api_key') return 'secret-key-123';
      return null;
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/inference',
      headers: { 'x-torque-key': 'secret-key-123' },
      body: { prompt: 'Hello with strict auth' },
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.request_id).toBeDefined();
    expect(payload.provider).toBe('codex');
  });

  it('returns 404 for unknown routes', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/nonexistent',
    });

    expect(response.statusCode).toBe(404);
  });

  // ============================================
  // Security headers tests
  // ============================================

  it('includes security headers in responses', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks?status=running',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block',
    }));
  });

  it('restricts CORS origin to localhost dashboard', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks?status=running',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:3456');
  });

  // ============================================
  // Rate limiting tests
  // ============================================

  describe('rate limiting', () => {
    // /api/tasks uses a per-endpoint rate limiter (200 req/window), not the
    // global RATE_LIMIT_MAX (1000). Use the actual endpoint limit so tests
    // are both correct and fast enough to avoid timeouts under parallel load.
    const TASKS_ENDPOINT_LIMIT = 200;

    // Freeze time so the 60-second window never expires mid-burst
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('normal requests pass through under the limit', async () => {
      const ip = '10.0.0.1';
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/tasks',
        remoteAddress: ip,
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 429 when rate limit is exceeded', async () => {
      const ip = '10.0.0.2';

      // Send requests up to the endpoint limit
      for (let i = 0; i < TASKS_ENDPOINT_LIMIT; i++) {
        await dispatchRequest(requestHandler, {
          method: 'GET',
          url: '/api/tasks',
          remoteAddress: ip,
        });
      }

      // The next request should be rate limited
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/tasks',
        remoteAddress: ip,
      });

      expect(response.statusCode).toBe(429);
      const payload = JSON.parse(response.body);
      expect(payload.error.code).toBe('rate_limit_exceeded');
      expect(payload.error.request_id).toBeDefined();
      expect(payload.error.details).toMatchObject({
        limit: 200,
        bucket: `ip:${ip}`,
      });
      expect(response.headers['Retry-After']).toBeDefined();
    });

    it('different IPs have independent rate limits', async () => {
      const ipA = '10.0.0.3';
      const ipB = '10.0.0.4';

      // Exhaust IP A's limit
      for (let i = 0; i < TASKS_ENDPOINT_LIMIT + 1; i++) {
        await dispatchRequest(requestHandler, {
          method: 'GET',
          url: '/api/tasks',
          remoteAddress: ipA,
        });
      }

      // IP B should still be allowed
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/tasks',
        remoteAddress: ipB,
      });

      expect(response.statusCode).toBe(200);
    });

    it('rate limit resets after window expires', async () => {
      const ip = '10.0.0.5';

      // Exhaust the limit
      for (let i = 0; i < TASKS_ENDPOINT_LIMIT + 1; i++) {
        await dispatchRequest(requestHandler, {
          method: 'GET',
          url: '/api/tasks',
          remoteAddress: ip,
        });
      }

      // Confirm we're rate limited
      let response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/tasks',
        remoteAddress: ip,
      });
      expect(response.statusCode).toBe(429);

      // Advance time past the 60-second window
      vi.advanceTimersByTime(61000);

      response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/tasks',
        remoteAddress: ip,
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 429 when /api/v2 route exceeds enforced v2 rate policy', async () => {
      getConfigSpy.mockImplementation((key) => {
        if (key === 'v2_rate_policy') return 'enforced';
        if (key === 'v2_rate_limit') return '2';
        return null;
      });

      await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/v2/inference',
        body: { prompt: 'first request' },
      });

      await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/v2/inference',
        body: { prompt: 'second request' },
      });

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/v2/inference',
        body: { prompt: 'third request' },
      });

      expect(response.statusCode).toBe(429);
      const payload = JSON.parse(response.body);
      expect(payload.error.code).toBe('rate_limit_exceeded');
      expect(payload.error.details.limit).toBe(2);
      expect(payload.error.details.bucket).toMatch(/^ip:/);
      expect(response.headers['Retry-After']).toBeDefined();
    });

    it('does not rate limit /api/v2 when v2 rate policy is disabled', async () => {
      getConfigSpy.mockImplementation((key) => {
        if (key === 'v2_auth_mode') return 'permissive';
        if (key === 'v2_rate_policy') return 'disabled';
        if (key === 'v2_rate_limit') return '1';
        return null;
      });

      const responses = await Promise.all([
        dispatchRequest(requestHandler, {
          method: 'POST',
          url: '/api/v2/inference',
          body: { prompt: 'first request' },
        }),
        dispatchRequest(requestHandler, {
          method: 'POST',
          url: '/api/v2/inference',
          body: { prompt: 'second request' },
        }),
        dispatchRequest(requestHandler, {
          method: 'POST',
          url: '/api/v2/inference',
          body: { prompt: 'third request' },
        }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }
    });
  });

  // ============================================
  // Health endpoint tests
  // ============================================

  describe('GET /readyz', () => {
    it('returns 200 when database is accessible and server has been up > 5 seconds', async () => {
      countTasksSpy.mockReturnValue(0); // Database query succeeds

      // Advance Date.now() past the 5-second warmup threshold
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 10000;

      try {
        const response = await dispatchRequest(requestHandler, {
          method: 'GET',
          url: '/readyz',
        });

        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.body);
        expect(payload.status).toBe('ready');
      } finally {
        Date.now = realDateNow;
      }
    });

    it('returns 503 when database is not accessible', async () => {
      countTasksSpy.mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/readyz',
      });

      expect(response.statusCode).toBe(503);
      const payload = JSON.parse(response.body);
      expect(payload.status).toBe('not ready');
      expect(payload.reasons).toContain('database not accessible');
    });
  });

  describe('GET /livez', () => {
    it('returns 200 with alive status', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/livez',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(['alive', 'ok']).toContain(payload.status);
    });

    it('includes security headers', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/livez',
      });

      expect(response.headers).toEqual(expect.objectContaining({
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
      }));
    });
  });

  describe('GET /healthz with timeout', () => {
    it('returns timeout status when ollama health check hangs', async () => {
      // Simulate a health check that never resolves
      handleToolCallSpy.mockImplementation((name) => {
        if (name === 'check_ollama_health') {
          return new Promise(() => {}); // Never resolves
        }
        return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
      });

      // Use fake timers to make the 5s timeout fire immediately
      vi.useFakeTimers();

      const requestPromise = dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/healthz',
      });

      // Advance past the 5-second health check timeout
      vi.advanceTimersByTime(5001);
      vi.useRealTimers();

      const response = await requestPromise;

      // New healthz logic: ollama timeout = degraded (200), not 503
      // 503 only when database is inaccessible
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.status).toBe('degraded');
      expect(payload.ollama).toBe('timeout');
    });
  });

  // ============================================
  // Shutdown auth tests
  // ============================================

  describe('POST /api/shutdown auth', () => {
    let shutdownEvents;
    let shutdownListener;

    beforeEach(() => {
      shutdownEvents = [];
      shutdownListener = (reason) => shutdownEvents.push(reason);
      eventBus.onShutdown(shutdownListener);
      vi.useFakeTimers();
    });

    afterEach(() => {
      eventBus.removeListener('shutdown', shutdownListener);
      vi.useRealTimers();
      shutdownEvents = [];
    });

    it('allows shutdown from 127.0.0.1 without an API key', async () => {
      // No API key configured — auth disabled globally — but test that localhost
      // bypass works even when a key IS configured
      getConfigSpy.mockImplementation((key) => key === 'api_key' ? 'secret-key' : null);

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '127.0.0.1',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });

      vi.runAllTimers();

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.status).toBe('shutting_down');
      expect(shutdownEvents).toHaveLength(1);
    });

    it('allows shutdown from ::1 (IPv6 localhost) without an API key', async () => {
      getConfigSpy.mockImplementation((key) => key === 'api_key' ? 'secret-key' : null);

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '::1',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });

      vi.runAllTimers();

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.status).toBe('shutting_down');
    });

    it('allows shutdown from ::ffff:127.0.0.1 (IPv4-mapped loopback) without an API key', async () => {
      getConfigSpy.mockImplementation((key) => key === 'api_key' ? 'secret-key' : null);

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '::ffff:127.0.0.1',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });

      vi.runAllTimers();

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.status).toBe('shutting_down');
    });

    it('blocks shutdown from a remote IP when authentication fails', async () => {
      // Override the default auth mock to simulate missing/invalid credentials
      authMiddleware.authenticate.mockReturnValueOnce(null);

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '192.0.2.50',
      });

      expect(response.statusCode).toBe(403);
      const payload = JSON.parse(response.body);
      expect(payload.error).toBe('Forbidden');
      // Shutdown event must NOT have been emitted
      vi.runAllTimers();
      expect(shutdownEvents).toHaveLength(0);
    });

    it('blocks shutdown from a remote IP when a wrong API key is provided', async () => {
      authMiddleware.authenticate.mockReturnValueOnce(null);

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '10.0.0.99',
        headers: { 'x-torque-key': 'wrong-key' },
      });

      expect(response.statusCode).toBe(403);
      const payload = JSON.parse(response.body);
      expect(payload.error).toBe('Forbidden');
      vi.runAllTimers();
      expect(shutdownEvents).toHaveLength(0);
    });

    it('allows shutdown from a remote IP when the correct API key is provided', async () => {
      getConfigSpy.mockImplementation((key) => key === 'api_key' ? 'secret-key' : null);

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '10.0.0.99',
        headers: { 'x-torque-key': 'secret-key', 'x-requested-with': 'XMLHttpRequest' },
      });

      vi.runAllTimers();

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.status).toBe('shutting_down');
      expect(shutdownEvents).toHaveLength(1);
    });

    it('allows shutdown from any IP when no API key is configured (auth disabled)', async () => {
      // getConfigSpy returns null by default in beforeEach — auth disabled
      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '203.0.113.5', // external IP
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });

      vi.runAllTimers();

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.status).toBe('shutting_down');
    });

    it('uses the provided reason in the response body', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '127.0.0.1',
        body: { reason: 'graceful upgrade' },
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });

      vi.runAllTimers();

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.reason).toBe('graceful upgrade');
    });

    it('defaults the reason to "HTTP /api/shutdown" when none is provided', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/shutdown',
        remoteAddress: '127.0.0.1',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });

      vi.runAllTimers();

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.reason).toBe('HTTP /api/shutdown');
    });
  });
});
