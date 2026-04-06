'use strict';

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { TEST_MODELS } = require('./test-helpers');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createConfigCoreMock(overrides = {}) {
  const defaultGetConfig = vi.fn((key) => {
    switch (key) {
      case 'ollama_host':
        return 'fallback-host:11434';
      case 'ollama_model':
        return 'configured-default:7b';
      case 'ollama_keep_alive':
        return '7m';
      case 'hashline_capable_models':
        return '';
      default:
        return null;
    }
  });

  return {
    getConfig: defaultGetConfig,
    ...overrides,
  };
}

function createHostManagementMock(overrides = {}) {
  return {
    listOllamaHosts: vi.fn(() => []),
    selectOllamaHostForModel: vi.fn(() => null),
    selectHostWithModelVariant: vi.fn(() => null),
    getAggregatedModels: vi.fn(() => []),
    tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
    releaseHostSlot: vi.fn(),
    decrementHostTasks: vi.fn(),
    ...overrides,
  };
}

function createConstantsMock(overrides = {}) {
  return {
    DEFAULT_FALLBACK_MODEL: 'fallback-default:7b',
    MAX_STREAMING_OUTPUT: 48,
    ...overrides,
    TASK_TIMEOUTS: {
      OLLAMA_API: 4321,
      ...(overrides.TASK_TIMEOUTS || {}),
    },
    PROVIDER_DEFAULT_TIMEOUTS: {
      ollama: 30,
      ...(overrides.PROVIDER_DEFAULT_TIMEOUTS || {}),
    },
  };
}

function loadProviders(overrides = {}) {
  const { getConfig, ...hostManagementOverrides } = overrides.db || {};
  const configCoreMock = createConfigCoreMock(getConfig ? { getConfig } : {});
  const hostManagementMock = createHostManagementMock(hostManagementOverrides);
  const dbMock = { ...configCoreMock, ...hostManagementMock };
  const constantsMock = createConstantsMock(overrides.constants);
  const loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const loggerMock = {
    child: vi.fn(() => loggerChild),
  };

  const providersPath = require.resolve('../providers/v2-local-providers');

  vi.resetModules();
  delete require.cache[require.resolve('../db/config-core')];
  delete require.cache[require.resolve('../db/host-management')];
  delete require.cache[require.resolve('../constants')];
  delete require.cache[require.resolve('../logger')];
  delete require.cache[providersPath];
  installCjsModuleMock('../db/config-core', configCoreMock);
  installCjsModuleMock('../db/host-management', hostManagementMock);
  installCjsModuleMock('../constants', constantsMock);
  installCjsModuleMock('../logger', loggerMock);

  return {
    providers: require('../providers/v2-local-providers'),
    dbMock,
    constantsMock,
    loggerChild,
  };
}

function makeHost(overrides = {}) {
  return {
    id: 'host-1',
    name: 'Host 1',
    url: 'http://ollama.local:11434',
    models: [TEST_MODELS.SMALL],
    ...overrides,
  };
}

function respondWithJson(callback, statusCode, chunks) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  callback(res);
  process.nextTick(() => {
    for (const chunk of chunks) {
      res.emit('data', chunk);
    }
    res.emit('end');
  });
}

function installRequestMock({ transport = 'http', onRequest }) {
  const target = transport === 'https' ? https : http;
  let capturedOptions = null;
  let capturedBody = '';

  const spy = vi.spyOn(target, 'request').mockImplementation((options, callback) => {
    capturedOptions = options;
    capturedBody = '';

    const req = new EventEmitter();
    req.write = vi.fn((chunk) => {
      capturedBody += chunk;
    });
    req.end = vi.fn(() => {
      onRequest({ options, body: capturedBody, callback, req });
    });
    req.destroy = vi.fn((error) => {
      if (error) {
        process.nextTick(() => req.emit('error', error));
      }
    });

    return req;
  });

  return {
    spy,
    getOptions: () => capturedOptions,
    getBody: () => capturedBody,
  };
}

function installGetMock({ transport = 'http', onRequest }) {
  const target = transport === 'https' ? https : http;
  let capturedOptions = null;

  const spy = vi.spyOn(target, 'get').mockImplementation((options, callback) => {
    capturedOptions = options;

    const req = new EventEmitter();
    req.destroy = vi.fn((error) => {
      if (error) {
        process.nextTick(() => req.emit('error', error));
      }
    });

    process.nextTick(() => {
      onRequest({ options, callback, req });
    });

    return req;
  });

  return {
    spy,
    getOptions: () => capturedOptions,
  };
}

describe('v2-local-providers helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('sanitizes model strings by trimming whitespace', () => {
    const { providers } = loadProviders();

    expect(providers.sanitizeModel(`  ${TEST_MODELS.SMALL}  `)).toBe(TEST_MODELS.SMALL);
  });

  it('returns an empty string when sanitizeModel receives non-strings', () => {
    const { providers } = loadProviders();

    expect(providers.sanitizeModel(null)).toBe('');
    expect(providers.sanitizeModel(42)).toBe('');
    expect(providers.sanitizeModel({})).toBe('');
  });

  it('parses model sizes from b-suffixed names', () => {
    const { providers } = loadProviders();

    expect(providers.parseModelSize(TEST_MODELS.DEFAULT)).toBe(14);
    expect(providers.parseModelSize('CODESTRAL:22B')).toBe(22);
  });

  it('returns zero when parseModelSize does not find a size tag', () => {
    const { providers } = loadProviders();

    expect(providers.parseModelSize('llama3:latest')).toBe(0);
    expect(providers.parseModelSize('')).toBe(0);
  });

  it('detects exact numeric version tags', () => {
    const { providers } = loadProviders();

    expect(providers.hasExactVersionTag(TEST_MODELS.DEFAULT)).toBe(true);
    expect(providers.hasExactVersionTag('qwen2.5-coder:latest')).toBe(false);
  });

  it('identifies fast model names from suffixes and keywords', () => {
    const { providers } = loadProviders();

    expect(providers.isFastModelName('granite:3b')).toBe(true);
    expect(providers.isFastModelName('custom-mini-model')).toBe(true);
    expect(providers.isFastModelName('deepseek-r1:14b')).toBe(false);
  });

  it('normalizes Ollama endpoints', () => {
    const { providers } = loadProviders();

    expect(providers.resolveOllamaEndpoint()).toBe('http://localhost:11434');
    expect(providers.resolveOllamaEndpoint('http://example:11434')).toBe('http://example:11434');
    expect(providers.resolveOllamaEndpoint('10.0.0.9:11434')).toBe('http://10.0.0.9:11434');
  });

  it('deduplicates, stringifies, and sorts uniqueStrings output', () => {
    const { providers } = loadProviders();

    expect(providers.uniqueStrings(['beta', null, 'alpha', 'beta', 7])).toEqual(['7', 'alpha', 'beta']);
  });

  it('parses provider models from enabled host metadata', () => {
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [
          makeHost({ models: ['llama3:latest', { name: TEST_MODELS.SMALL }, null] }),
          makeHost({ id: 'host-2', models: ['llama3:latest', { name: TEST_MODELS.DEFAULT }] }),
          { id: 'host-3', models: null },
        ]),
      },
    });

    expect(providers.parseProviderModels()).toEqual(['llama3:latest', TEST_MODELS.DEFAULT, TEST_MODELS.SMALL]);
  });

  it('returns no models when host lookup throws', () => {
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => {
          throw new Error('db unavailable');
        }),
      },
    });

    expect(providers.parseProviderModels()).toEqual([]);
  });

  it('treats all models as hashline-capable when config is blank', () => {
    const { providers } = loadProviders();

    expect(providers.isHashlineCapableModelName(TEST_MODELS.SMALL)).toBe(true);
  });

  it('matches hashline-capable models by exact name, variant, or base model', () => {
    const { providers } = loadProviders({
      db: {
        getConfig: vi.fn((key) => (key === 'hashline_capable_models' ? `${TEST_MODELS.SMALL.split(':')[0]},llama3:8b` : null)),
      },
    });

    expect(providers.isHashlineCapableModelName(TEST_MODELS.SMALL)).toBe(true);
    expect(providers.isHashlineCapableModelName('llama3:8b')).toBe(true);
    expect(providers.isHashlineCapableModelName('mistral:7b')).toBe(false);
  });

  it('truncates long Ollama errors', () => {
    const { providers } = loadProviders();
    const longText = 'x'.repeat(260);

    const truncated = providers.buildTruncatedError(longText);
    expect(truncated.length).toBeLessThan(longText.length);
    expect(truncated.endsWith('...')).toBe(true);
  });

  it('returns the default or original text for short Ollama errors', () => {
    const { providers } = loadProviders();

    expect(providers.buildTruncatedError()).toBe('Ollama request failed');
    expect(providers.buildTruncatedError('short error')).toBe('short error');
  });
});

describe('v2-local-providers selection and payload behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('builds generate payloads with tuning, max tokens, and keep-alive', () => {
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    expect(provider._buildGeneratePayload(TEST_MODELS.SMALL, 'Prompt', {
      tuning: { temperature: '0.4', top_p: '0.9' },
      maxTokens: '12.9',
    }, true)).toEqual({
      model: TEST_MODELS.SMALL,
      prompt: 'Prompt',
      system: expect.any(String),
      stream: true,
      think: false,
      keep_alive: '7m',
      options: {
        temperature: 0.4,
        top_p: 0.9,
        num_predict: 12,
      },
    });
  });

  it('normalizes Ollama usage metrics and falls back to elapsed time', () => {
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    expect(provider._normalizeUsage({
      prompt_eval_count: 11,
      eval_count: 7,
      total_duration: 9_000_000,
    }, TEST_MODELS.SMALL, 55)).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      cost: 0,
      duration_ms: 9,
      model: TEST_MODELS.SMALL,
    });

    expect(provider._normalizeUsage({}, TEST_MODELS.SMALL, 55).duration_ms).toBe(55);
  });

  it('falls back to configured host when no Ollama hosts are registered', async () => {
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => []),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._selectExecutionTarget(`  ${TEST_MODELS.SMALL}  `)).resolves.toEqual({
      hostUrl: 'http://fallback-host:11434',
      model: TEST_MODELS.SMALL,
      slotRelease: null,
    });
  });

  it('uses variant host selection and rewrites the chosen model', async () => {
    const host = makeHost({ url: 'http://variant-host:11434' });
    const { providers, dbMock } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [host]),
        selectHostWithModelVariant: vi.fn(() => ({ host, model: TEST_MODELS.DEFAULT })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    const target = await provider._selectExecutionTarget('qwen2.5-coder');

    expect(target.hostUrl).toBe('http://variant-host:11434');
    expect(target.model).toBe(TEST_MODELS.DEFAULT);
    expect(dbMock.selectHostWithModelVariant).toHaveBeenCalledWith('qwen2.5-coder');
  });

  it('falls back to the largest available model when the requested one is unavailable', async () => {
    const host = makeHost({ url: 'http://largest-host:11434' });
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [host]),
        getAggregatedModels: vi.fn(() => [{ name: TEST_MODELS.FAST }, { name: 'coder:14b' }, { name: 'coder:7b' }]),
        selectOllamaHostForModel: vi.fn((model) => (model === 'coder:14b' ? { host } : null)),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.FAST });

    const target = await provider._selectExecutionTarget('missing:7b');

    expect(target.model).toBe('coder:14b');
    expect(target.hostUrl).toBe('http://largest-host:11434');
  });

  it('throws memory-limit errors returned by host selection', async () => {
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [makeHost()]),
        selectOllamaHostForModel: vi.fn(() => ({ memoryError: true, reason: 'needs 24 GB' })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.DEFAULT });

    await expect(provider._selectExecutionTarget(TEST_MODELS.DEFAULT)).rejects.toThrow('needs 24 GB');
  });

  it('throws capacity errors returned by host selection', async () => {
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [makeHost()]),
        selectOllamaHostForModel: vi.fn(() => ({ atCapacity: true, reason: 'queue full' })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.DEFAULT });

    await expect(provider._selectExecutionTarget(TEST_MODELS.DEFAULT)).rejects.toThrow('queue full');
  });

  it('includes available models in no-host-match failures', async () => {
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [
          makeHost({ models: [TEST_MODELS.SMALL, TEST_MODELS.DEFAULT] }),
        ]),
        selectOllamaHostForModel: vi.fn(() => null),
        selectHostWithModelVariant: vi.fn(() => null),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._selectExecutionTarget('missing:7b')).rejects.toThrow(
      `No Ollama host has model 'missing:7b'. Available models: ${TEST_MODELS.DEFAULT}, ${TEST_MODELS.SMALL}`,
    );
  });

  it('releases reserved slots through decrementHostTasks when releaseHostSlot is unavailable', () => {
    const { providers, dbMock } = loadProviders({
      db: {
        releaseHostSlot: undefined,
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    const release = provider._acquireHostSlot({ id: 'host-9', name: 'Host 9' });
    release();

    expect(dbMock.decrementHostTasks).toHaveBeenCalledWith('host-9');
  });

  it('throws explicit reservation errors from host slot acquisition', () => {
    const { providers } = loadProviders({
      db: {
        tryReserveHostSlot: vi.fn(() => ({ acquired: false, error: 'GPU is busy' })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    expect(() => provider._acquireHostSlot({ id: 'host-2', name: 'Host 2' })).toThrow('GPU is busy');
  });

  it('throws capacity details when no host slot can be reserved', () => {
    const { providers } = loadProviders({
      db: {
        tryReserveHostSlot: vi.fn(() => ({ acquired: false, currentLoad: 4, maxCapacity: 4 })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    expect(() => provider._acquireHostSlot({ id: 'host-2', name: 'Host 2' })).toThrow(
      "Unable to reserve Ollama slot for host 'Host 2' (4/4)",
    );
  });

});

describe('v2-local-providers request handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('submits a sync inference request and normalizes the response', async () => {
    const host = makeHost({ url: 'http://sync-host:11434' });
    const requestMock = installRequestMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({
          response: '  completed output  ',
          prompt_eval_count: 5,
          eval_count: 7,
          total_duration: 2_000_000,
        })]);
      },
    });
    const { providers, dbMock } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [host]),
        selectOllamaHostForModel: vi.fn(() => ({ host })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    const result = await provider.submit('  Build this  ', TEST_MODELS.SMALL, {
      tuning: { temperature: '0.25', top_p: '0.8' },
      maxTokens: '16',
    });

    expect(result).toEqual({
      output: 'completed output',
      status: 'completed',
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        total_tokens: 12,
        cost: 0,
        duration_ms: 2,
        model: TEST_MODELS.SMALL,
      },
    });
    expect(requestMock.getOptions()).toMatchObject({
      hostname: 'sync-host',
      port: '11434',
      path: '/api/generate',
      method: 'POST',
      timeout: 30 * 60 * 1000,
    });
    expect(JSON.parse(requestMock.getBody())).toMatchObject({
      model: TEST_MODELS.SMALL,
      prompt: 'Build this',
      stream: false,
      keep_alive: '7m',
      options: {
        temperature: 0.25,
        top_p: 0.8,
        num_predict: 16,
      },
    });
    expect(dbMock.releaseHostSlot).toHaveBeenCalledWith('host-1');
  });

  it('uses the https transport for secure Ollama hosts', async () => {
    const httpsMock = installRequestMock({
      transport: 'https',
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({ response: 'secure', done: true })]);
      },
    });
    const httpSpy = vi.spyOn(http, 'request');
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('https://secure-host:443', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false)).resolves.toEqual({
      response: 'secure',
      usage: {
        prompt_eval_count: 0,
        eval_count: 0,
        total_duration: 0,
      },
    });
    expect(httpsMock.spy).toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
  });

  it('rejects sync requests with truncated non-200 errors', async () => {
    const requestMock = installRequestMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 500, ['y'.repeat(260)]);
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false)).rejects.toThrow(/Ollama API error \(500\): .*\.{3}$/);
    expect(requestMock.spy).toHaveBeenCalled();
  });

  it('rejects sync requests when Ollama returns an error field', async () => {
    installRequestMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({ error: 'model missing' })]);
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false)).rejects.toThrow('model missing');
  });

  it('returns an empty response when Ollama omits the response field', async () => {
    installRequestMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({ total_duration: 7_000_000 })]);
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false)).resolves.toEqual({
      response: '',
      usage: {
        total_duration: 7_000_000,
      },
    });
  });

  it('rejects timed-out sync requests', async () => {
    installRequestMock({
      onRequest: ({ req }) => {
        process.nextTick(() => req.emit('timeout'));
      },
    });
    const { providers } = loadProviders({
      constants: {
        PROVIDER_DEFAULT_TIMEOUTS: { ollama: 0.025 },
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false)).rejects.toThrow('Ollama request timed out after 1500ms');
  });

  it('uses per-request timeout overrides in minutes', async () => {
    const requestMock = installRequestMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({ response: 'ok' })]);
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false, { timeout: 0.02 });

    expect(requestMock.getOptions().timeout).toBe(1200);
  });

  it('defaults HTTP Ollama generate requests to port 11434 when the URL omits a port', async () => {
    const requestMock = installRequestMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({ response: 'ok' })]);
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await provider._invokeGenerate('http://ollama.local', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false);

    expect(requestMock.getOptions().port).toBe(11434);
  });

  it('releases reserved host slots even when submit fails', async () => {
    const host = makeHost({ url: 'http://error-host:11434' });
    installRequestMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 500, ['request failed']);
      },
    });
    const { providers, dbMock } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [host]),
        selectOllamaHostForModel: vi.fn(() => ({ host })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider.submit('failing prompt', TEST_MODELS.SMALL)).rejects.toThrow('request failed');
    expect(dbMock.releaseHostSlot).toHaveBeenCalledWith('host-1');
  });

  it('rejects when the caller aborts the inference request', async () => {
    vi.spyOn(http, 'request').mockImplementation((options) => {
      const req = new EventEmitter();
      req.write = vi.fn();
      req.end = vi.fn();
      req.destroy = vi.fn();

      options.signal.addEventListener('abort', () => {
        process.nextTick(() => req.emit('error', new Error('caller aborted')));
      }, { once: true });

      return req;
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });
    const controller = new AbortController();

    const pending = provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: false,
    }, false, { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toThrow('caller aborted');
  });

  it('accumulates streaming chunks and forwards onChunk callbacks', async () => {
    const host = makeHost({ url: 'http://stream-host:11434' });
    const onChunk = vi.fn();
    installRequestMock({
      onRequest: ({ callback }) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit('data', '{"response":"Hel');
          res.emit('data', 'lo"}\n{"response":" world"}\n');
          res.emit('data', `${JSON.stringify({
            done: true,
            prompt_eval_count: 2,
            eval_count: 3,
            total_duration: 9000000,
          })}\n`);
          res.emit('end');
        });
      },
    });
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [host]),
        selectOllamaHostForModel: vi.fn(() => ({ host })),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    const result = await provider.submitStream('stream test', TEST_MODELS.SMALL, { onChunk });

    expect(result).toEqual({
      output: 'Hello world',
      status: 'completed',
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
        cost: 0,
        duration_ms: 9,
        model: TEST_MODELS.SMALL,
      },
    });
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onChunk).toHaveBeenNthCalledWith(2, ' world');
  });

  it('ignores malformed streaming lines and resolves when the stream ends without done', async () => {
    installRequestMock({
      onRequest: ({ callback }) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit('data', 'not json\n{"response":"partial"}\n');
          res.emit('end');
        });
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: true,
    }, true)).resolves.toEqual({
      response: 'partial',
      usage: {},
    });
  });

  it('appends leftover non-JSON stream buffers at end', async () => {
    installRequestMock({
      onRequest: ({ callback }) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit('data', 'tail without newline');
          res.emit('end');
        });
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: true,
    }, true)).resolves.toEqual({
      response: 'tail without newline',
      usage: {},
    });
  });

  it('caps streaming output at MAX_STREAMING_OUTPUT and marks truncation', async () => {
    installRequestMock({
      onRequest: ({ callback }) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit('data', `${JSON.stringify({ response: 'a'.repeat(30) })}\n`);
          res.emit('data', `${JSON.stringify({ response: 'b'.repeat(30) })}\n`);
          res.emit('data', `${JSON.stringify({ done: true })}\n`);
          res.emit('end');
        });
      },
    });
    const { providers } = loadProviders({
      constants: {
        MAX_STREAMING_OUTPUT: 40,
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    const result = await provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: true,
    }, true);

    expect(result.response).toContain('[...OUTPUT TRUNCATED...]');
    expect(result.response.startsWith('a')).toBe(true);
  });

  it('ignores onChunk callback failures while streaming', async () => {
    const onChunk = vi.fn(() => {
      throw new Error('callback failed');
    });
    installRequestMock({
      onRequest: ({ callback }) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit('data', `${JSON.stringify({ response: 'chunk' })}\n`);
          res.emit('data', `${JSON.stringify({ done: true })}\n`);
          res.emit('end');
        });
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._invokeGenerate('http://ollama.local:11434', {
      model: TEST_MODELS.SMALL,
      prompt: 'test',
      stream: true,
    }, true, { onChunk })).resolves.toEqual({
      response: 'chunk',
      usage: {},
    });
    expect(onChunk).toHaveBeenCalledWith('chunk');
  });
});

describe('v2-local-providers health checks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('checks hosts in order and returns the first healthy host', async () => {
    installGetMock({
      onRequest: ({ options, callback }) => {
        if (options.hostname === 'bad-host') {
          respondWithJson(callback, 503, ['unhealthy']);
          return;
        }

        respondWithJson(callback, 200, [JSON.stringify({
          models: [
            { name: TEST_MODELS.SMALL },
            { name: TEST_MODELS.SMALL },
            TEST_MODELS.DEFAULT,
          ],
        })]);
      },
    });
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [
          makeHost({ name: 'Bad Host', url: 'http://bad-host:11434' }),
          makeHost({ id: 'host-2', name: 'Good Host', url: 'http://good-host:11434' }),
        ]),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider.checkHealth()).resolves.toEqual({
      available: true,
      models: [TEST_MODELS.DEFAULT, TEST_MODELS.SMALL],
      host: 'Good Host',
    });
  });

  it('falls back to the configured host when no DB hosts exist', async () => {
    const getMock = installGetMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({ models: [{ name: TEST_MODELS.SMALL }] })]);
      },
    });
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => []),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider.checkHealth()).resolves.toEqual({
      available: true,
      models: [TEST_MODELS.SMALL],
      host: 'http://fallback-host:11434',
    });
    expect(getMock.getOptions()).toMatchObject({
      hostname: 'fallback-host',
      port: '11434',
      path: '/api/tags',
      timeout: 4321,
    });
  });

  it('returns an unavailable health result when every host fails', async () => {
    installGetMock({
      onRequest: ({ req }) => {
        process.nextTick(() => req.emit('error', new Error('socket hang up')));
      },
    });
    const { providers } = loadProviders({
      db: {
        listOllamaHosts: vi.fn(() => [makeHost({ url: 'http://broken-host:11434' })]),
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider.checkHealth()).resolves.toEqual({
      available: false,
      models: [],
      error: 'socket hang up',
    });
  });

  it('treats malformed tag payloads as healthy hosts with no discovered models', async () => {
    installGetMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, ['{not-json']);
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._fetchOllamaTags('http://fallback-host:11434')).resolves.toEqual({
      ok: true,
      status: 200,
      host: 'http://fallback-host:11434',
      models: [],
    });
  });

  it('rejects health checks that time out', async () => {
    installGetMock({
      onRequest: ({ req }) => {
        process.nextTick(() => req.emit('timeout'));
      },
    });
    const { providers } = loadProviders({
      constants: {
        TASK_TIMEOUTS: { OLLAMA_API: 2222 },
      },
    });
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await expect(provider._fetchOllamaTags('http://slow-host:11434')).rejects.toThrow(
      'Ollama health check timeout after 2222ms',
    );
  });

  it('defaults HTTP Ollama health checks to port 11434 when the URL omits a port', async () => {
    const getMock = installGetMock({
      onRequest: ({ callback }) => {
        respondWithJson(callback, 200, [JSON.stringify({ models: [] })]);
      },
    });
    const { providers } = loadProviders();
    const provider = new providers.OllamaProvider({ defaultModel: TEST_MODELS.SMALL });

    await provider._fetchOllamaTags('http://health-host');

    expect(getMock.getOptions().port).toBe(11434);
  });
});