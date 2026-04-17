'use strict';

const { installMock } = require('./cjs-mock');

const MODULE_PATHS = [
  'crypto',
  '../database',
  '../task-manager',
  '../api/v2-inference',
];

const mockCrypto = {
  randomUUID: vi.fn(),
};

const mockDatabaseModule = {
  init: vi.fn(),
};

const mockTaskManagerModule = {
  init: vi.fn(),
};

const state = {
  providers: new Map(),
  adapters: new Map(),
  capabilities: new Map(),
  taskRows: new Map(),
};

const mockDb = {
  getProvider: vi.fn(),
  recordProviderUsage: vi.fn(),
  createTask: vi.fn(),
  updateTaskStatus: vi.fn(),
};

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
};

let deps;
let handlers;

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that were not loaded in this test.
    }
  }
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? (inputTokens + outputTokens));

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    elapsed_ms: Number(usage.elapsed_ms ?? 0),
  };
}

function normalizeAttempt(attempt = {}, index = 0) {
  return {
    provider: attempt.provider ?? null,
    transport: attempt.transport ?? null,
    reason: attempt.reason ?? null,
    status: attempt.status ?? 'not_attempted',
    index: attempt.index ?? index,
    attempt_start_at: attempt.attempt_start_at ?? null,
    attempt_end_at: attempt.attempt_end_at ?? null,
    attempt_elapsed_ms: attempt.attempt_elapsed_ms ?? null,
    failure_reason: attempt.failure_reason ?? null,
    error: attempt.error ?? null,
  };
}

function normalizeStatus(status) {
  const value = String(status ?? 'completed').toLowerCase();
  if (value === 'completed' || value === 'ok' || value === 'succeeded') {
    return 'completed';
  }
  if (value === 'queued' || value === 'running') {
    return value;
  }
  return 'failed';
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry.text === 'string') return entry.text;
        return '';
      })
      .join('')
      .trim();
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim();
  }

  return '';
}

function createInjectedDeps() {
  return {
    db: mockDb,
    logger: mockLogger,
    getProviderAdapter: vi.fn((providerId) => state.adapters.get(providerId) || null),
    getProviderCapabilityMatrix: vi.fn(() => ({})),
    SECURITY_HEADERS: { 'x-test': 'true' },
    sendJson: vi.fn(),
    normalizeV2Transport: vi.fn((transport) => {
      if (transport === null || transport === undefined || transport === '') {
        return null;
      }
      const normalized = String(transport).trim().toLowerCase();
      return normalized === 'api' || normalized === 'cli' ? normalized : null;
    }),
    getV2ProviderTransport: vi.fn((providerConfig) => providerConfig?.transport || 'api'),
    getV2ProviderDefaultTimeoutMs: vi.fn((providerId) => (providerId === 'codex' ? 90000 : 120000)),
    normalizeMessageContent: vi.fn(normalizeMessageContent),
    formatV2InferenceResult: vi.fn((output) => ({
      type: 'text',
      content: String(output ?? ''),
      meta: { length: String(output ?? '').length },
    })),
    normalizeV2InferenceStatus: vi.fn(normalizeStatus),
    normalizeV2ProviderUsage: vi.fn(normalizeUsage),
    normalizeV2AttemptMetadata: vi.fn((attempts) => (
      Array.isArray(attempts) ? attempts : []
    ).map((attempt, index) => normalizeAttempt(attempt, index))),
    getV2RetryCount: vi.fn((attempts) => (
      Array.isArray(attempts) ? attempts : []
    ).filter((attempt, index) => normalizeAttempt(attempt, index).status === 'failed').length),
    getAttemptElapsedMs: vi.fn(() => 321),
    getV2ProviderAdapterCapabilities: vi.fn((providerId) => (
      state.capabilities.get(providerId) || { supportsStream: true, supportsAsync: true }
    )),
    sendV2SseHeaders: vi.fn(),
    sendV2SseEvent: vi.fn(),
    getV2TaskStatusRow: vi.fn((taskId) => state.taskRows.get(taskId) || null),
    recordV2TaskEvent: vi.fn(),
    sendV2Success: vi.fn(),
    sendV2Error: vi.fn(),
  };
}

function loadHandlers() {
  clearLoadedModules();
  installMock('crypto', mockCrypto);
  installMock('../database', mockDatabaseModule);
  installMock('../task-manager', mockTaskManagerModule);
  return require('../api/v2-inference');
}

function resetState() {
  state.providers = new Map();
  state.adapters = new Map();
  state.capabilities = new Map();
  state.taskRows = new Map();

  mockCrypto.randomUUID.mockReset().mockReturnValue('async-task-1');
  mockDatabaseModule.init.mockReset();
  mockTaskManagerModule.init.mockReset();

  mockDb.getProvider.mockReset().mockImplementation((providerId) => state.providers.get(providerId) || null);
  mockDb.recordProviderUsage.mockReset().mockReturnValue(undefined);
  mockDb.createTask.mockReset().mockImplementation((task) => {
    state.taskRows.set(task.id, {
      id: task.id,
      status: task.status,
      provider: task.provider,
      model: task.model,
      metadata: task.metadata || {},
      output: null,
      error_output: null,
    });
    return task;
  });
  mockDb.updateTaskStatus.mockReset().mockImplementation(async (taskId, status, updates = {}) => {
    const current = state.taskRows.get(taskId) || { id: taskId, metadata: {} };
    const next = {
      ...current,
      status,
    };

    if (Object.prototype.hasOwnProperty.call(updates, 'provider')) {
      next.provider = updates.provider;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'metadata')) {
      next.metadata = updates.metadata;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'output')) {
      next.output = updates.output;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'error_output')) {
      next.error_output = updates.error_output;
    }

    state.taskRows.set(taskId, next);
    return next;
  });

  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  deps = createInjectedDeps();
  handlers = loadHandlers();
  handlers.init(deps);
}

function seedProvider(providerId, overrides = {}) {
  const provider = {
    enabled: true,
    transport: 'api',
    ...overrides,
  };
  state.providers.set(providerId, provider);
  return provider;
}

function seedAdapter(providerId, overrides = {}) {
  const adapter = {
    submit: vi.fn(),
    stream: vi.fn(),
    ...overrides,
  };
  state.adapters.set(providerId, adapter);
  return adapter;
}

function setCapabilities(providerId, overrides = {}) {
  state.capabilities.set(providerId, {
    supportsStream: true,
    supportsAsync: true,
    ...overrides,
  });
}

function createReq(overrides = {}) {
  return {
    headers: {},
    ...overrides,
  };
}

function createRes() {
  return {
    end: vi.fn(),
  };
}

function getLastSuccess() {
  const [res, requestId, payload, statusCode, req] = deps.sendV2Success.mock.calls.at(-1) || [];
  return { res, requestId, payload, statusCode, req };
}

function getLastError() {
  const [res, requestId, code, message, statusCode, details, req] = deps.sendV2Error.mock.calls.at(-1) || [];
  return { res, requestId, code, message, statusCode, details, req };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetState();
});

afterEach(() => {
  clearLoadedModules();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('api/v2-inference.init', () => {
  it('replaces injected dependencies when reinitialized', () => {
    const altDeps = createInjectedDeps();
    altDeps.formatV2InferenceResult = vi.fn((output) => ({
      type: 'alt',
      content: `alt:${output}`,
      meta: { source: 'alt' },
    }));
    altDeps.normalizeV2ProviderUsage = vi.fn(() => ({
      input_tokens: 9,
      output_tokens: 1,
      total_tokens: 10,
      elapsed_ms: 7,
    }));
    altDeps.normalizeV2InferenceStatus = vi.fn(() => 'failed');

    handlers.init(altDeps);

    const payload = handlers.buildV2InferencePayload({
      providerId: 'ollama',
      model: 'test-model',
      taskResult: { output: 'hello', usage: {} },
      status: 'completed',
    });

    expect(payload.result).toEqual({
      type: 'alt',
      content: 'alt:hello',
      meta: { source: 'alt' },
    });
    expect(payload.usage.total_tokens).toBe(10);
    expect(payload.status).toBe('failed');
  });
});

describe('api/v2-inference pure helpers', () => {
  it('maps claude-cli api attempts to anthropic', () => {
    expect(handlers.getV2AttemptProvider('claude-cli', 'api')).toBe('anthropic');
  });

  it('leaves non-remapped attempt providers unchanged', () => {
    expect(handlers.getV2AttemptProvider('ollama', 'api')).toBe('ollama');
    expect(handlers.getV2AttemptProvider('claude-cli', 'cli')).toBe('claude-cli');
    expect(handlers.getV2AttemptProvider('claude-code-sdk', 'cli')).toBe('claude-code-sdk');
  });

  it('prefers the explicit prompt field when present', () => {
    expect(handlers.buildV2InferencePrompt({
      prompt: 'Direct prompt',
      messages: [{ role: 'user', content: 'ignored' }],
    })).toBe('Direct prompt');
  });

  it('returns an empty prompt when the explicit prompt is not a string', () => {
    expect(handlers.buildV2InferencePrompt({
      prompt: { text: 'bad input' },
      messages: [{ role: 'user', content: 'ignored' }],
    })).toBe('');
  });

  it('builds a prompt from normalized messages and skips invalid entries', () => {
    const prompt = handlers.buildV2InferencePrompt({
      messages: [
        { role: 'system', content: ' Setup ' },
        null,
        { role: '', content: 'skip me' },
        { role: 'user', content: [{ text: 'Hello' }, ' world'] },
        { role: 'assistant', content: { text: ' Answer ' } },
      ],
    });

    expect(prompt).toBe('system: Setup\nuser: Hello world\nassistant: Answer');
  });

  it('builds an inference payload with normalized usage, result, and attempts', () => {
    const rawResult = {
      status: 'ok',
      result: 'Resolved output',
      usage: {
        prompt_tokens: 4,
        completion_tokens: 3,
      },
      model: 'resolved-model',
    };

    const payload = handlers.buildV2InferencePayload({
      providerId: 'ollama',
      model: 'requested-model',
      taskResult: rawResult,
      status: 'ok',
      taskId: 'task-1',
      routeReason: 'provider_route',
      transport: 'api',
      attempts: [{ provider: 'ollama', transport: 'api', status: 'succeeded' }],
    });

    expect(payload).toEqual({
      task_id: 'task-1',
      status: 'completed',
      provider: 'ollama',
      model: 'resolved-model',
      result: {
        type: 'text',
        content: 'Resolved output',
        meta: { length: 15 },
      },
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        total_tokens: 7,
        elapsed_ms: 0,
      },
      raw: rawResult,
      transport: 'api',
      route_reason: 'provider_route',
      attempts: [expect.objectContaining({
        provider: 'ollama',
        transport: 'api',
        status: 'succeeded',
      })],
      retry_count: 0,
    });
  });

  it('falls back to text output and explicit model defaults in inference payloads', () => {
    const payload = handlers.buildV2InferencePayload({
      providerId: 'codex',
      model: 'requested-model',
      taskResult: {
        status: 'queued',
        text: 'Fallback body',
      },
      transport: null,
      attempts: [{ provider: 'codex', transport: 'api', status: 'failed' }],
    });

    expect(payload).toEqual(expect.objectContaining({
      status: 'queued',
      provider: 'codex',
      model: 'requested-model',
      result: {
        type: 'text',
        content: 'Fallback body',
        meta: { length: 13 },
      },
      transport: null,
      retry_count: 1,
    }));
  });

  it('builds the queued async response envelope', () => {
    const payload = handlers.buildV2AsyncTaskResponse({
      taskId: 'task-async',
      providerId: 'ollama',
      model: 'test-model',
      requestId: 'req-async',
      transport: 'cli',
      routeReason: 'fallback_api_to_cli',
      attempts: [{ provider: 'ollama', transport: 'cli', status: 'failed' }],
    });

    expect(payload).toEqual({
      task_id: 'task-async',
      status: 'queued',
      provider: 'ollama',
      model: 'test-model',
      polling_url: '/api/v2/tasks/task-async',
      result: {
        type: 'text',
        content: '',
        meta: {},
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        elapsed_ms: 0,
      },
      raw: {},
      transport: 'cli',
      route_reason: 'fallback_api_to_cli',
      attempts: [expect.objectContaining({
        provider: 'ollama',
        transport: 'cli',
        status: 'failed',
      })],
      retry_count: 1,
      request_id: 'req-async',
    });
  });

  it('normalizes route attempts and filters incomplete entries', () => {
    expect(handlers.normalizeV2RouteAttempts([
      { provider: 'ollama', transport: 'API', reason: 'primary', status: 'pending' },
      { provider: 'codex', transport: 'ssh', status: 'pending' },
      { transport: 'cli', status: 'pending' },
      { provider: 'claude-cli', transport: 'cli' },
    ])).toEqual([
      {
        provider: 'ollama',
        transport: 'api',
        reason: 'primary',
        status: 'pending',
        index: 0,
      },
      {
        provider: 'claude-cli',
        transport: 'cli',
        reason: null,
        status: 'not_attempted',
        index: 3,
      },
    ]);
  });

  it('builds a single-attempt plan for non-codex providers', () => {
    expect(handlers.buildV2ExecutionPlan({
      providerId: 'ollama',
      requestedTransport: null,
      providerConfig: { transport: 'cli' },
    })).toEqual([{
      provider: 'ollama',
      transport: 'cli',
      reason: 'provider_route',
      status: 'pending',
    }]);
  });

  it('builds a single-attempt cli plan for claude-cli requests', () => {
    expect(handlers.buildV2ExecutionPlan({
      providerId: 'claude-cli',
      requestedTransport: 'cli',
      providerConfig: { transport: 'api' },
    })).toEqual([{
      provider: 'claude-cli',
      transport: 'cli',
      reason: 'request_transport_cli',
      status: 'pending',
    }]);
  });

  it('routes claude-cli api requests to anthropic without codex fallback', () => {
    expect(handlers.buildV2ExecutionPlan({
      providerId: 'claude-cli',
      requestedTransport: 'api',
      providerConfig: { transport: 'cli' },
    })).toEqual([{
      provider: 'anthropic',
      transport: 'api',
      reason: 'request_transport_api',
      status: 'pending',
    }]);
  });

  it('forces claude-code-sdk onto cli transport without fallback', () => {
    expect(handlers.buildV2ExecutionPlan({
      providerId: 'claude-code-sdk',
      requestedTransport: 'api',
      providerConfig: { transport: 'api' },
    })).toEqual([{
      provider: 'claude-code-sdk',
      transport: 'cli',
      reason: 'provider_transport_cli',
      status: 'pending',
    }]);
  });

  it('uses the configured transport as the primary codex-family route when no transport is requested', () => {
    expect(handlers.buildV2ExecutionPlan({
      providerId: 'codex',
      requestedTransport: null,
      providerConfig: { transport: 'cli' },
    })).toEqual([
      {
        provider: 'codex',
        transport: 'cli',
        reason: 'provider_transport_cli',
        status: 'pending',
      },
      {
        provider: 'codex',
        transport: 'api',
        reason: 'fallback_cli_to_api',
        status: 'pending',
      },
    ]);
  });

  it('records provider telemetry for a successful attempt', () => {
    handlers.recordV2AttemptUsage({
      taskId: 'task-usage',
      attempt: {
        provider: 'ollama',
        transport: 'api',
        status: 'succeeded',
        attempt_elapsed_ms: 900,
      },
      attemptIndex: 2,
      taskResult: {
        usage: {
          total_tokens: 15,
          cost_usd: 0.25,
        },
      },
    });

    expect(mockDb.recordProviderUsage).toHaveBeenCalledWith('ollama', 'task-usage', {
      tokens_used: 15,
      cost_estimate: 0.25,
      duration_seconds: 0.9,
      elapsed_ms: 900,
      transport: 'api',
      retry_count: 2,
      failure_reason: null,
      success: true,
      error_type: null,
    });
  });

  it('does not record telemetry when the attempt has no provider', () => {
    handlers.recordV2AttemptUsage({
      taskId: 'task-no-provider',
      attempt: {
        provider: null,
        transport: 'api',
        status: 'failed',
      },
      attemptIndex: 0,
      taskResult: null,
    });

    expect(mockDb.recordProviderUsage).not.toHaveBeenCalled();
  });

  it('swallows provider telemetry write failures', () => {
    mockDb.recordProviderUsage.mockImplementationOnce(() => {
      throw new Error('telemetry unavailable');
    });

    expect(() => handlers.recordV2AttemptUsage({
      taskId: 'task-usage-failure',
      attempt: {
        provider: 'ollama',
        transport: 'api',
        status: 'failed',
        failure_reason: 'timeout',
        attempt_elapsed_ms: 400,
      },
      attemptIndex: 1,
      taskResult: null,
    })).not.toThrow();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('telemetry unavailable'));
  });

  it.each([
    ['stream support errors', new Error('Stream is not supported by this provider'), 'stream_unsupported'],
    ['timeouts', new Error('Operation timeout after 30 seconds'), 'timeout'],
    ['auth failures', new Error('Missing auth token for provider'), 'auth_required'],
    ['missing models', new Error('Requested model not found'), 'model_not_found'],
    ['rate limits', new Error('rate limit exceeded'), 'provider_unavailable'],
    ['empty errors', null, 'provider_unavailable'],
  ])('derives %s into %s', (_label, error, expected) => {
    expect(handlers.deriveV2AttemptFailureReason(error)).toBe(expected);
  });

  it('builds a failure payload with normalized attempts', () => {
    expect(handlers.buildV2FailurePayload({
      requestId: 'req-failure',
      transport: 'api',
      routeReason: 'provider_route',
      attempts: [
        { provider: 'ollama', transport: 'api', status: 'failed' },
        { provider: 'codex', transport: 'cli', status: 'pending' },
      ],
    })).toEqual({
      transport: 'api',
      route_reason: 'provider_route',
      attempts: [
        expect.objectContaining({ provider: 'ollama', status: 'failed' }),
        expect.objectContaining({ provider: 'codex', status: 'pending' }),
      ],
      retry_count: 1,
      request_id: 'req-failure',
    });
  });

  it('builds inference task options from explicit request values', () => {
    expect(handlers.buildV2InferenceTaskOptions({
      timeout_ms: 90000,
      max_tokens: '250',
      temperature: 0.2,
      top_p: 0.8,
    }, 'codex')).toEqual({
      timeout: 1.5,
      maxTokens: 250,
      tuning: {
        temperature: 0.2,
        top_p: 0.8,
      },
    });
  });

  it('uses the provider default timeout when timeout_ms is omitted', () => {
    expect(handlers.buildV2InferenceTaskOptions({
      max_tokens: 99,
    }, 'ollama')).toEqual({
      timeout: 2,
      maxTokens: 99,
      tuning: {},
    });
  });

  it('falls back to a safe timeout when timeout_ms is invalid', () => {
    expect(handlers.buildV2InferenceTaskOptions({
      timeout_ms: 'not-a-number',
    }, 'ollama')).toEqual({
      timeout: 5,
      maxTokens: undefined,
      tuning: {},
    });
  });
});

describe('api/v2-inference.executeV2ProviderInference', () => {
  it('submits sync inference successfully', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.submit.mockResolvedValue({
      status: 'completed',
      output: 'hello there',
      usage: {
        input_tokens: 4,
        output_tokens: 6,
        total_tokens: 10,
        elapsed_ms: 55,
      },
      model: 'resolved-model',
    });

    const req = createReq({ requestId: 'req-sync' });
    const res = createRes();

    await handlers.executeV2ProviderInference({
      requestId: 'req-sync',
      payload: {
        messages: [{ role: 'user', content: 'Hello there' }],
        model: 'requested-model',
      },
      providerId: 'ollama',
      req,
      res,
    });

    expect(adapter.submit).toHaveBeenCalledWith('user: Hello there', 'requested-model', expect.objectContaining({
      timeout: 2,
      transport: 'api',
      attemptReason: 'provider_route',
    }));

    const success = getLastSuccess();
    expect(success.statusCode).toBe(200);
    expect(success.requestId).toBe('req-sync');
    expect(success.payload).toEqual(expect.objectContaining({
      status: 'completed',
      provider: 'ollama',
      model: 'resolved-model',
      transport: 'api',
      route_reason: 'provider_route',
      retry_count: 0,
    }));
    expect(success.payload.result).toEqual(expect.objectContaining({
      content: 'hello there',
    }));
  });

  it('returns provider_unavailable when the final route provider is missing', async () => {
    await handlers.executeV2ProviderInference({
      requestId: 'req-no-provider',
      payload: {
        prompt: 'No provider',
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('provider_unavailable');
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('Provider not found: ollama');
    expect(error.details).toEqual(expect.objectContaining({
      transport: 'api',
      route_reason: 'provider_route',
      request_id: 'req-no-provider',
    }));
  });

  it('returns provider_unavailable when the final route provider is disabled', async () => {
    seedProvider('ollama', { enabled: false, transport: 'api' });

    await handlers.executeV2ProviderInference({
      requestId: 'req-provider-disabled',
      payload: {
        prompt: 'Disabled provider',
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('provider_unavailable');
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('Provider is disabled: ollama');
  });

  it('returns provider_unavailable when the final route adapter is missing', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });

    await handlers.executeV2ProviderInference({
      requestId: 'req-adapter-missing',
      payload: {
        prompt: 'Missing adapter',
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('provider_unavailable');
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('Provider adapter not available: ollama');
  });

  it('routes claude-cli api requests to anthropic instead of codex', async () => {
    seedProvider('anthropic', { enabled: true, transport: 'api' });
    seedProvider('codex', { enabled: true, transport: 'api' });
    const anthropicAdapter = seedAdapter('anthropic');
    const codexAdapter = seedAdapter('codex');
    anthropicAdapter.submit.mockResolvedValue({
      status: 'completed',
      output: 'anthropic worked',
      usage: { total_tokens: 8 },
    });

    await handlers.executeV2ProviderInference({
      requestId: 'req-anthropic-route',
      payload: {
        prompt: 'Route please',
        transport: 'api',
        model: 'anthropic-model',
      },
      providerId: 'claude-cli',
      req: createReq(),
      res: createRes(),
    });

    expect(anthropicAdapter.submit).toHaveBeenCalledWith('Route please', 'anthropic-model', expect.objectContaining({
      transport: 'api',
      attemptReason: 'request_transport_api',
    }));
    expect(codexAdapter.submit).not.toHaveBeenCalled();

    const success = getLastSuccess();
    expect(success.payload.provider).toBe('anthropic');
    expect(success.payload.attempts).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        transport: 'api',
        reason: 'request_transport_api',
        status: 'succeeded',
      }),
    ]);
  });

  it('does not fall back claude-cli cli requests to codex', async () => {
    seedProvider('claude-cli', { enabled: false, transport: 'cli' });
    seedProvider('codex', { enabled: true, transport: 'api' });
    const codexAdapter = seedAdapter('codex');

    await handlers.executeV2ProviderInference({
      requestId: 'req-no-cross-route',
      payload: {
        prompt: 'Fallback please',
        transport: 'cli',
        model: 'fallback-model',
      },
      providerId: 'claude-cli',
      req: createReq(),
      res: createRes(),
    });

    expect(codexAdapter.submit).not.toHaveBeenCalled();

    const error = getLastError();
    expect(error.code).toBe('provider_unavailable');
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('Provider is disabled: claude-cli');
    expect(error.details.attempts).toEqual([
      expect.objectContaining({
        provider: 'claude-cli',
        transport: 'cli',
        reason: 'request_transport_cli',
        status: 'failed',
        failure_reason: 'provider_disabled',
      }),
    ]);
  });

  it('returns a validation-style error when streaming is unsupported', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    seedAdapter('ollama');
    setCapabilities('ollama', { supportsStream: false, supportsAsync: true });

    await handlers.executeV2ProviderInference({
      requestId: 'req-stream-error',
      payload: {
        prompt: 'Try streaming',
        stream: true,
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('stream_not_supported');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual(expect.objectContaining({
      provider: 'ollama',
      route_reason: 'provider_route',
      transport: 'api',
    }));
  });

  it('returns a validation-style error when async is unsupported', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    seedAdapter('ollama');
    setCapabilities('ollama', { supportsStream: true, supportsAsync: false });

    await handlers.executeV2ProviderInference({
      requestId: 'req-async-unsupported',
      payload: {
        prompt: 'Try async',
        async: true,
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('async_not_supported');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual(expect.objectContaining({
      provider: 'ollama',
      supports_async: false,
      transport: 'api',
    }));
  });

  it('streams SSE chunks and completion payloads', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.stream.mockImplementation(async (_prompt, _model, options) => {
      options.onChunk('hel');
      options.onChunk('lo');
      return {
        status: 'completed',
        output: 'hello',
        usage: { total_tokens: 5 },
      };
    });

    const req = createReq({ requestId: 'req-stream' });
    const res = createRes();

    await handlers.executeV2ProviderInference({
      requestId: 'req-stream',
      payload: {
        prompt: 'Stream please',
        stream: true,
        model: 'stream-model',
      },
      providerId: 'ollama',
      req,
      res,
    });

    expect(deps.sendV2SseHeaders).toHaveBeenCalledWith(res, req);
    expect(deps.sendV2SseEvent).toHaveBeenNthCalledWith(1, res, 'status', expect.objectContaining({
      request_id: 'req-stream',
      status: 'running',
      provider: 'ollama',
      transport: 'api',
    }));
    expect(deps.sendV2SseEvent).toHaveBeenNthCalledWith(2, res, 'chunk', expect.objectContaining({
      request_id: 'req-stream',
      chunk: 'hel',
      sequence: 1,
    }));
    expect(deps.sendV2SseEvent).toHaveBeenNthCalledWith(3, res, 'chunk', expect.objectContaining({
      request_id: 'req-stream',
      chunk: 'lo',
      sequence: 2,
    }));
    expect(deps.sendV2SseEvent).toHaveBeenNthCalledWith(4, res, 'completion', expect.objectContaining({
      request_id: 'req-stream',
      status: 'completed',
      result: expect.objectContaining({ content: 'hello' }),
      usage: expect.objectContaining({ total_tokens: 5 }),
    }));
    expect(res.end).toHaveBeenCalledOnce();
    expect(deps.sendV2Success).not.toHaveBeenCalled();
    expect(deps.sendV2Error).not.toHaveBeenCalled();
  });

  it('emits an SSE error event and ends the response when the final stream attempt fails', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.stream.mockRejectedValue(new Error('stream setup failed'));

    const res = createRes();

    await handlers.executeV2ProviderInference({
      requestId: 'req-stream-failed',
      payload: {
        prompt: 'Break the stream',
        stream: true,
      },
      providerId: 'ollama',
      req: createReq(),
      res,
    });

    expect(deps.sendV2SseEvent).toHaveBeenNthCalledWith(1, res, 'status', expect.any(Object));
    expect(deps.sendV2SseEvent).toHaveBeenNthCalledWith(2, res, 'error', expect.objectContaining({
      request_id: 'req-stream-failed',
      error: expect.objectContaining({
        code: 'provider_unavailable',
        message: 'stream setup failed',
      }),
    }));
    expect(res.end).toHaveBeenCalledOnce();
  });

  it('returns a queued async response and schedules background execution', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    seedAdapter('ollama');
    setCapabilities('ollama', { supportsAsync: true });
    mockCrypto.randomUUID.mockReturnValueOnce('queued-task-1');

    let scheduled = null;
    vi.spyOn(global, 'setImmediate').mockImplementation((callback, ...args) => {
      scheduled = () => callback(...args);
      return 1;
    });

    await handlers.executeV2ProviderInference({
      requestId: 'req-async',
      payload: {
        prompt: 'Queue this task',
        async: true,
        model: 'async-model',
      },
      providerId: 'ollama',
      req: createReq({ requestId: 'req-async' }),
      res: createRes(),
    });

    expect(mockDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'queued-task-1',
      status: 'queued',
      task_description: 'Queue this task',
      provider: 'ollama',
      model: 'async-model',
    }));
    expect(deps.recordV2TaskEvent).toHaveBeenCalledWith('queued-task-1', 'status', null, 'queued', expect.objectContaining({
      request_id: 'req-async',
      provider: 'ollama',
      model: 'async-model',
      transport: 'api',
    }));

    const success = getLastSuccess();
    expect(success.statusCode).toBe(202);
    expect(success.payload).toEqual(expect.objectContaining({
      task_id: 'queued-task-1',
      status: 'queued',
      provider: 'ollama',
      request_id: 'req-async',
      retry_count: 0,
    }));
    expect(typeof scheduled).toBe('function');
  });

  it('returns a server error when async task creation fails', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    seedAdapter('ollama');
    setCapabilities('ollama', { supportsAsync: true });
    mockDb.createTask.mockImplementationOnce(() => {
      throw new Error('database write failed');
    });

    await handlers.executeV2ProviderInference({
      requestId: 'req-async-failure',
      payload: {
        prompt: 'Queue this task',
        async: true,
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('provider_unavailable');
    expect(error.statusCode).toBe(500);
    expect(error.message).toContain('Failed to create async inference task: database write failed');
    expect(error.details).toEqual(expect.objectContaining({
      provider: 'ollama',
      transport: 'api',
      route_reason: 'provider_route',
    }));
  });

  it('returns an error when the final sync result is non-completed', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.submit.mockResolvedValue({
      status: 'failed',
      error: 'model rejected prompt',
      usage: { total_tokens: 2 },
    });

    await handlers.executeV2ProviderInference({
      requestId: 'req-sync-failed-result',
      payload: {
        prompt: 'Please fail',
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('provider_unavailable');
    expect(error.statusCode).toBe(500);
    expect(error.message).toContain('Inference failed for provider: ollama');
    expect(error.details.attempts[0]).toEqual(expect.objectContaining({
      provider: 'ollama',
      status: 'failed',
      failure_reason: 'provider_result_error',
    }));
  });

  it('maps thrown stream-unsupported sync submit errors to HTTP 400', async () => {
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.submit.mockRejectedValue(new Error('stream not supported for this adapter'));

    await handlers.executeV2ProviderInference({
      requestId: 'req-submit-stream-error',
      payload: {
        prompt: 'Bad transport',
      },
      providerId: 'ollama',
      req: createReq(),
      res: createRes(),
    });

    const error = getLastError();
    expect(error.code).toBe('provider_unavailable');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual(expect.objectContaining({
      provider: 'ollama',
      reason: 'stream_unsupported',
    }));
  });
});

describe('api/v2-inference.runV2AsyncTask', () => {
  it('returns immediately when taskId is missing', async () => {
    await handlers.runV2AsyncTask({
      taskId: null,
      providerId: 'ollama',
      prompt: 'ignored',
    });

    expect(deps.getV2TaskStatusRow).not.toHaveBeenCalled();
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('does nothing when the stored task is not queued', async () => {
    state.taskRows.set('task-running', {
      id: 'task-running',
      status: 'running',
      metadata: {},
    });

    await handlers.runV2AsyncTask({
      taskId: 'task-running',
      providerId: 'ollama',
      prompt: 'ignored',
    });

    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('completes a queued async task successfully', async () => {
    state.taskRows.set('task-success', {
      id: 'task-success',
      status: 'queued',
      metadata: { request_id: 'req-task' },
    });
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.submit.mockResolvedValue({
      status: 'completed',
      output: 'async output',
      usage: {
        total_tokens: 9,
      },
    });

    await handlers.runV2AsyncTask({
      taskId: 'task-success',
      requestId: 'req-task',
      providerId: 'ollama',
      prompt: 'Hello async',
      model: 'async-model',
      taskOptions: { timeout: 2 },
    });

    expect(adapter.submit).toHaveBeenCalledWith('Hello async', 'async-model', expect.objectContaining({
      timeout: 2,
      transport: 'api',
      attemptReason: 'provider_route',
    }));

    const row = state.taskRows.get('task-success');
    expect(row.status).toBe('completed');
    expect(row.provider).toBe('ollama');
    expect(row.output).toEqual({
      status: 'completed',
      output: 'async output',
      usage: {
        total_tokens: 9,
      },
    });
    expect(row.error_output).toBeNull();
    expect(row.metadata.attempts[0]).toEqual(expect.objectContaining({
      provider: 'ollama',
      status: 'succeeded',
      transport: 'api',
    }));
    expect(deps.recordV2TaskEvent).toHaveBeenNthCalledWith(1, 'task-success', 'status', 'queued', 'running', expect.objectContaining({
      request_id: 'req-task',
      provider: 'ollama',
    }));
    expect(deps.recordV2TaskEvent).toHaveBeenNthCalledWith(2, 'task-success', 'completion', 'running', 'completed', expect.objectContaining({
      request_id: 'req-task',
      provider: 'ollama',
    }));
  });

  it('does not fall back claude-cli async cli requests to codex', async () => {
    state.taskRows.set('task-fallback', {
      id: 'task-fallback',
      status: 'queued',
      metadata: { request_id: 'req-fallback' },
    });
    seedProvider('claude-cli', { enabled: false, transport: 'cli' });
    seedProvider('codex', { enabled: true, transport: 'api' });
    const codexAdapter = seedAdapter('codex');

    await handlers.runV2AsyncTask({
      taskId: 'task-fallback',
      requestId: 'req-fallback',
      providerId: 'claude-cli',
      prompt: 'Retry me',
      model: 'fallback-model',
      requestedTransport: 'cli',
    });

    const row = state.taskRows.get('task-fallback');
    expect(codexAdapter.submit).not.toHaveBeenCalled();
    expect(row.status).toBe('failed');
    expect(row.provider).toBe('claude-cli');
    expect(row.error_output).toBe('Async provider unavailable');
    expect(row.metadata.attempts).toEqual([
      expect.objectContaining({
        provider: 'claude-cli',
        transport: 'cli',
        reason: 'request_transport_cli',
        status: 'failed',
        failure_reason: 'provider_disabled',
      }),
    ]);
  });

  it('marks the task failed when the final async attempt lacks async support', async () => {
    state.taskRows.set('task-unsupported', {
      id: 'task-unsupported',
      status: 'queued',
      metadata: { request_id: 'req-unsupported' },
    });
    seedProvider('ollama', { enabled: true, transport: 'api' });
    seedAdapter('ollama');
    setCapabilities('ollama', { supportsAsync: false });

    await handlers.runV2AsyncTask({
      taskId: 'task-unsupported',
      requestId: 'req-unsupported',
      providerId: 'ollama',
      prompt: 'Unsupported async',
    });

    const row = state.taskRows.get('task-unsupported');
    expect(row.status).toBe('failed');
    expect(row.output).toEqual({
      status: 'failed',
      error: 'Async provider unavailable',
    });
    expect(row.error_output).toBe('Async provider unavailable');
    expect(row.metadata.attempts[0]).toEqual(expect.objectContaining({
      provider: 'ollama',
      status: 'failed',
      failure_reason: 'async_unsupported',
    }));
  });

  it('marks the task failed when the final async attempt throws', async () => {
    state.taskRows.set('task-failed', {
      id: 'task-failed',
      status: 'queued',
      metadata: { request_id: 'req-failed' },
    });
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.submit.mockRejectedValue(new Error('timeout while running'));

    await handlers.runV2AsyncTask({
      taskId: 'task-failed',
      requestId: 'req-failed',
      providerId: 'ollama',
      prompt: 'Boom',
      model: 'broken-model',
    });

    const row = state.taskRows.get('task-failed');
    expect(row.status).toBe('failed');
    expect(row.output).toEqual({
      status: 'failed',
      error: 'timeout while running',
    });
    expect(row.error_output).toBe('timeout while running');
    expect(row.metadata.attempts[0]).toEqual(expect.objectContaining({
      provider: 'ollama',
      status: 'failed',
      failure_reason: 'timeout',
    }));
    expect(deps.recordV2TaskEvent).toHaveBeenLastCalledWith('task-failed', 'error', 'running', 'failed', expect.objectContaining({
      request_id: 'req-failed',
      provider: 'ollama',
      error: 'timeout while running',
    }));
  });

  it('returns early when the task is cancelled after provider submission', async () => {
    state.taskRows.set('task-cancelled', {
      id: 'task-cancelled',
      status: 'queued',
      metadata: { request_id: 'req-cancelled' },
    });
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.submit.mockImplementation(async () => {
      state.taskRows.set('task-cancelled', {
        ...state.taskRows.get('task-cancelled'),
        status: 'cancelled',
      });
      return {
        status: 'completed',
        output: 'ignored',
      };
    });

    await handlers.runV2AsyncTask({
      taskId: 'task-cancelled',
      requestId: 'req-cancelled',
      providerId: 'ollama',
      prompt: 'Cancel me',
    });

    const row = state.taskRows.get('task-cancelled');
    expect(row.status).toBe('cancelled');
    expect(deps.recordV2TaskEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordV2TaskEvent).toHaveBeenCalledWith('task-cancelled', 'status', 'queued', 'running', expect.any(Object));
  });

  it('marks the task failed when the provider returns a failed result', async () => {
    state.taskRows.set('task-result-failed', {
      id: 'task-result-failed',
      status: 'queued',
      metadata: { request_id: 'req-result-failed' },
    });
    seedProvider('ollama', { enabled: true, transport: 'api' });
    const adapter = seedAdapter('ollama');
    adapter.submit.mockResolvedValue({
      status: 'failed',
      error: 'provider said no',
      usage: { total_tokens: 7 },
    });

    await handlers.runV2AsyncTask({
      taskId: 'task-result-failed',
      requestId: 'req-result-failed',
      providerId: 'ollama',
      prompt: 'Reject me',
    });

    const row = state.taskRows.get('task-result-failed');
    expect(row.status).toBe('failed');
    expect(row.output).toEqual({
      status: 'failed',
      error: 'provider said no',
      usage: { total_tokens: 7 },
    });
    expect(row.error_output).toBe('provider said no');
    expect(row.metadata.attempts[0]).toEqual(expect.objectContaining({
      provider: 'ollama',
      status: 'failed',
      failure_reason: 'provider_result_error',
    }));
  });

  it('records an outer error and fails the task when task state persistence throws', async () => {
    state.taskRows.set('task-write-failure', {
      id: 'task-write-failure',
      status: 'queued',
      metadata: { request_id: 'req-write-failure' },
    });
    seedProvider('ollama', { enabled: true, transport: 'api' });
    seedAdapter('ollama');

    mockDb.updateTaskStatus
      .mockImplementationOnce(async () => {
        throw new Error('write failed');
      })
      .mockImplementationOnce(async (taskId, status, updates = {}) => {
        const current = state.taskRows.get(taskId) || { id: taskId, metadata: {} };
        const next = { ...current, status };
        if (Object.prototype.hasOwnProperty.call(updates, 'output')) next.output = updates.output;
        if (Object.prototype.hasOwnProperty.call(updates, 'error_output')) next.error_output = updates.error_output;
        state.taskRows.set(taskId, next);
        return next;
      });

    await handlers.runV2AsyncTask({
      taskId: 'task-write-failure',
      requestId: 'req-write-failure',
      providerId: 'ollama',
      prompt: 'Trigger outer failure',
    });

    const row = state.taskRows.get('task-write-failure');
    expect(row.status).toBe('failed');
    expect(row.output).toEqual({
      status: 'failed',
      error: 'write failed',
    });
    expect(row.error_output).toBe('write failed');
    expect(deps.recordV2TaskEvent).toHaveBeenLastCalledWith('task-write-failure', 'error', 'queued', 'failed', expect.objectContaining({
      request_id: 'req-write-failure',
      provider: 'ollama',
      error: 'write failed',
    }));
  });
});
