'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const PROVIDER_PATH = '../providers/cerebras';
const BASE_PATH = '../providers/base';
const LOGGER_PATH = '../logger';
const CONSTANTS_PATH = '../constants';
const MOCK_MAX_STREAMING_OUTPUT = 16;
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.CEREBRAS_API_KEY;

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function createLoggerMock() {
  const debug = vi.fn();
  const child = vi.fn(() => ({ debug }));

  return {
    debug,
    child,
    exports: { child },
  };
}

function loadProviderClass(loggerMock) {
  installMock(LOGGER_PATH, loggerMock.exports);
  installMock(CONSTANTS_PATH, {
    MAX_STREAMING_OUTPUT: MOCK_MAX_STREAMING_OUTPUT,
  });
  clearModule(BASE_PATH);
  clearModule(PROVIDER_PATH);
  return require(PROVIDER_PATH);
}

function makeAbortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function makeSseStream(chunks, overrides = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const reader = {
    cancel: overrides.cancel || vi.fn(async () => {}),
    read: overrides.read || vi.fn(async () => {
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }

      return {
        done: false,
        value: encoder.encode(chunks[index++]),
      };
    }),
  };

  return {
    body: {
      getReader: () => reader,
    },
    reader,
  };
}

describe('CerebrasProvider', () => {
  let CerebrasProvider;
  let loggerMock;
  let provider;

  beforeEach(() => {
    loggerMock = createLoggerMock();
    CerebrasProvider = loadProviderClass(loggerMock);
    provider = new CerebrasProvider({ apiKey: 'test-cerebras-key' });
    globalThis.fetch = vi.fn();
    delete process.env.CEREBRAS_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearModule(BASE_PATH);
    clearModule(PROVIDER_PATH);
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }

    if (originalApiKey === undefined) {
      delete process.env.CEREBRAS_API_KEY;
    } else {
      process.env.CEREBRAS_API_KEY = originalApiKey;
    }
  });

  describe('constructor', () => {
    it('inherits base provider defaults and Cerebras-specific config', () => {
      const customProvider = new CerebrasProvider({
        apiKey: 'custom-key',
        baseUrl: 'https://cerebras.internal',
        defaultModel: 'gpt-oss-120b',
        enabled: false,
        maxConcurrent: 9,
      });

      expect(customProvider.name).toBe('cerebras');
      expect(customProvider.enabled).toBe(false);
      expect(customProvider.maxConcurrent).toBe(9);
      expect(customProvider.activeTasks).toBe(0);
      expect(customProvider.apiKey).toBe('custom-key');
      expect(customProvider.baseUrl).toBe('https://cerebras.internal');
      expect(customProvider.defaultModel).toBe('gpt-oss-120b');
      expect(loggerMock.child).toHaveBeenCalledWith({ component: 'provider-base' });
    });

    it('falls back to environment and built-in defaults', () => {
      process.env.CEREBRAS_API_KEY = 'env-cerebras-key';

      const envProvider = new CerebrasProvider();

      expect(envProvider.apiKey).toBe('env-cerebras-key');
      expect(envProvider.baseUrl).toBe('https://api.cerebras.ai');
      expect(envProvider.defaultModel).toBe('qwen-3-235b-a22b-instruct-2507');
      expect(envProvider.supportsStreaming).toBe(true);
    });
  });

  describe('task execution via submit', () => {
    it('posts an OpenAI-compatible request body and returns normalized usage', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response text' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
      });

      const result = await provider.submit('ship tests', null, {
        maxTokens: 222,
        working_directory: '/tmp/torque',
        files: ['server/providers/cerebras.js', 'server/tests/cerebras-provider.test.js'],
        tuning: { temperature: 0.25 },
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cerebras.ai/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-cerebras-key',
          },
          signal: expect.any(AbortSignal),
        })
      );

      const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(requestBody).toEqual({
        model: 'qwen-3-235b-a22b-instruct-2507',
        messages: [{
          role: 'user',
          content: 'Files: server/providers/cerebras.js, server/tests/cerebras-provider.test.js\n\nWorking directory: /tmp/torque\n\nship tests',
        }],
        max_tokens: 222,
        temperature: 0.25,
      });
      expect(result).toMatchObject({
        output: 'response text',
        status: 'completed',
        usage: {
          tokens: 16,
          input_tokens: 12,
          output_tokens: 4,
          model: 'qwen-3-235b-a22b-instruct-2507',
        },
      });
      expect(result.usage.cost).toBeCloseTo(0.0000096, 10);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
      expect(provider.activeTasks).toBe(0);
    });

    it('uses the explicit model and default token limit when provided', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      const result = await provider.submit('route to custom model', 'zai-glm-4.7');
      const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);

      expect(requestBody.model).toBe('zai-glm-4.7');
      expect(requestBody.max_tokens).toBe(4096);
      expect(requestBody.temperature).toBeUndefined();
      expect(result.usage.model).toBe('zai-glm-4.7');
    });

    it('returns empty output and zero usage when the API omits them', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [],
        }),
      });

      const result = await provider.submit('missing payload fields');

      expect(result.output).toBe('');
      expect(result.usage).toMatchObject({
        tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        model: 'qwen-3-235b-a22b-instruct-2507',
      });
    });

    it('throws a configuration error when no API key is available', async () => {
      const noKeyProvider = new CerebrasProvider({ apiKey: '' });

      await expect(noKeyProvider.submit('task')).rejects.toThrow(
        'Cerebras API key not configured. Set CEREBRAS_API_KEY or provide apiKey in config.'
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('includes authentication details in 401 errors', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'bad key',
        headers: { get: () => null },
      });

      await expect(provider.submit('task')).rejects.toThrow(
        'Cerebras API error (401): authentication failed or unauthorized: bad key'
      );
    });

    it('includes retry-after seconds for rate-limited responses', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
        headers: {
          get: (name) => (name.toLowerCase() === 'retry-after' ? '15' : null),
        },
      });

      await expect(provider.submit('task')).rejects.toThrow(
        'Cerebras API error (429): Rate limited retry_after_seconds=15'
      );
    });

    it('returns timeout when the fetch is aborted and always decrements active tasks', async () => {
      globalThis.fetch.mockRejectedValue(makeAbortError());

      const result = await provider.submit('task');

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(provider.activeTasks).toBe(0);
    });

    it('wires timeout scheduling and external abort listener cleanup', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        }),
      });

      await provider.submit('task', null, { timeout: 2, signal });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('treats an externally aborted signal as a timeout result', async () => {
      const externalAbort = new AbortController();
      globalThis.fetch.mockImplementation((_url, options) => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
      }));

      const pending = provider.submit('task', null, { signal: externalAbort.signal });
      await Promise.resolve();
      externalAbort.abort();

      await expect(pending).resolves.toMatchObject({
        output: '',
        status: 'timeout',
      });
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('submitStream', () => {
    it('parses OpenAI-style SSE chunks and reports usage', async () => {
      const stream = makeSseStream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n',
        'data: [DONE]\n\n',
      ]);
      const onChunk = vi.fn();
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: stream.body,
      });

      const result = await provider.submitStream('stream task', null, { onChunk });
      const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);

      expect(requestBody).toMatchObject({
        model: 'qwen-3-235b-a22b-instruct-2507',
        max_tokens: 4096,
        stream: true,
      });
      expect(result).toMatchObject({
        output: 'Hello world',
        status: 'completed',
        usage: {
          tokens: 11,
          input_tokens: 7,
          output_tokens: 4,
          model: 'qwen-3-235b-a22b-instruct-2507',
        },
      });
      expect(result.usage.cost).toBeCloseTo(0.0000066, 10);
      expect(onChunk).toHaveBeenNthCalledWith(1, 'Hello');
      expect(onChunk).toHaveBeenNthCalledWith(2, ' world');
      expect(stream.reader.cancel).toHaveBeenCalledTimes(1);
    });

    it('handles split chunks and ignores malformed SSE lines', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: makeSseStream([
          'data: {"choices":[{"delta":{"content":"Hel',
          'lo"}}]}\n\ndata: [bad-json]\n\ndata: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":3,"completion_tokens":8,"total_tokens":11}}\n\ndata: [DONE]\n\n',
        ]).body,
      });

      const result = await provider.submitStream('task');

      expect(result.output).toBe('Hello world');
      expect(result.usage).toMatchObject({
        tokens: 11,
        input_tokens: 3,
        output_tokens: 8,
      });
    });

    it('truncates output after the configured streaming limit', async () => {
      const fullChunk = 'A'.repeat(MOCK_MAX_STREAMING_OUTPUT);
      const onChunk = vi.fn();
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: makeSseStream([
          `data: {"choices":[{"delta":{"content":"${fullChunk}"}}]}\n\n`,
          'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
          'data: [DONE]\n\n',
        ]).body,
      });

      const result = await provider.submitStream('task', null, { onChunk });

      expect(onChunk).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalledWith(fullChunk);
      expect(result.output).toBe(`${fullChunk}\n[...OUTPUT TRUNCATED...]`);
      expect(result.output.includes('B')).toBe(false);
    });

    it('surfaces authentication and retry-after details for streaming API failures', async () => {
      globalThis.fetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
        headers: { get: () => null },
      });

      await expect(provider.submitStream('task')).rejects.toThrow(
        'Cerebras streaming API error (403): authentication failed or unauthorized: forbidden'
      );

      globalThis.fetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
        headers: {
          get: (name) => (name.toLowerCase() === 'retry-after' ? '20' : null),
        },
      });

      await expect(provider.submitStream('task')).rejects.toThrow(
        'Cerebras streaming API error (429): Rate limited retry_after_seconds=20'
      );
    });

    it('returns timeout on streaming aborts and cleans up an in-flight reader', async () => {
      const externalAbort = new AbortController();
      const reader = {
        cancel: vi.fn(async () => {}),
        read: vi.fn(async () => {
          if (externalAbort.signal.aborted) {
            throw makeAbortError();
          }

          await new Promise((resolve) => {
            externalAbort.signal.addEventListener('abort', resolve, { once: true });
          });
          throw makeAbortError();
        }),
      };

      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => reader,
        },
      });

      const pending = provider.submitStream('task', null, { signal: externalAbort.signal });
      await Promise.resolve();
      externalAbort.abort();

      await expect(pending).resolves.toMatchObject({
        output: '',
        status: 'timeout',
      });
      expect(reader.cancel).toHaveBeenCalledTimes(1);
      expect(provider.activeTasks).toBe(0);
    });

    it('logs debug output when reader cleanup fails but preserves the result', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: makeSseStream(
          [
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            'data: [DONE]\n\n',
          ],
          {
            cancel: vi.fn(async () => {
              throw new Error('reader already closed');
            }),
          }
        ).body,
      });

      const result = await provider.submitStream('task');

      expect(result).toMatchObject({
        output: 'ok',
        status: 'completed',
      });
      expect(loggerMock.debug).toHaveBeenCalledWith(
        '[cerebras] Failed to cancel stream reader during Cerebras submitStream cleanup: reader already closed'
      );
    });
  });

  describe('health and metadata', () => {
    it('returns unavailable when no API key is configured', async () => {
      const noKeyProvider = new CerebrasProvider({ apiKey: '' });

      await expect(noKeyProvider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'No API key configured',
      });
    });

    it('probes /v1/models and filters out falsy ids', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'llama3.1-8b' }, { id: '' }, { id: null }, { id: 'gpt-oss-120b' }],
        }),
      });

      const result = await provider.checkHealth();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cerebras.ai/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-cerebras-key' },
          signal: expect.any(AbortSignal),
        })
      );
      expect(result).toEqual({
        available: true,
        models: [
          { model_name: 'llama3.1-8b', id: 'llama3.1-8b', owned_by: null, context_window: null },
          { model_name: 'gpt-oss-120b', id: 'gpt-oss-120b', owned_by: null, context_window: null },
        ],
      });
    });

    it('falls back to the default model when the health payload has no data array', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: true }),
      });

      await expect(provider.checkHealth()).resolves.toEqual({
        available: true,
        models: [{ model_name: 'qwen-3-235b-a22b-instruct-2507' }],
      });
    });

    it('reports HTTP, network, and timeout health check failures', async () => {
      globalThis.fetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'API returned 503',
      });

      globalThis.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'ECONNREFUSED',
      });

      globalThis.fetch.mockRejectedValueOnce(makeAbortError());
      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'Health check timed out (5s)',
      });
    });

    it('returns the static model list and prompt formatting behavior', async () => {
      await expect(provider.listModels()).resolves.toEqual([
        'llama3.1-8b',
        'qwen-3-235b-a22b-instruct-2507',
        'gpt-oss-120b',
        'zai-glm-4.7',
      ]);
      expect(provider._buildPrompt('task', {})).toBe('task');
      expect(provider._buildPrompt('task', { files: [] })).toBe('task');
      expect(provider._buildPrompt('task', {
        files: ['a.js'],
        working_directory: '/workspace',
      })).toBe('Files: a.js\n\nWorking directory: /workspace\n\ntask');
    });
  });
});
