'use strict';

const { installMock } = require('./cjs-mock');

const PROVIDER_PATH = '../providers/ollama-cloud';
const BASE_PATH = '../providers/base';
const LOGGER_PATH = '../logger';
const CONSTANTS_PATH = '../constants';
const MOCK_MAX_STREAMING_OUTPUT = 16;
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OLLAMA_CLOUD_API_KEY;

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

function loadProviderClass(loggerMock, maxStreamingOutput = MOCK_MAX_STREAMING_OUTPUT) {
  installMock(LOGGER_PATH, loggerMock.exports);
  installMock(CONSTANTS_PATH, {
    MAX_STREAMING_OUTPUT: maxStreamingOutput,
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

function makeNdjsonStream(chunks, overrides = {}) {
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

describe('OllamaCloudProvider', () => {
  let OllamaCloudProvider;
  let loggerMock;
  let provider;

  beforeEach(() => {
    loggerMock = createLoggerMock();
    OllamaCloudProvider = loadProviderClass(loggerMock);
    provider = new OllamaCloudProvider({ apiKey: 'test-cloud-key' });
    globalThis.fetch = vi.fn();
    delete process.env.OLLAMA_CLOUD_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearModule(PROVIDER_PATH);
    clearModule(BASE_PATH);
    clearModule(LOGGER_PATH);
    clearModule(CONSTANTS_PATH);

    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }

    if (originalApiKey === undefined) {
      delete process.env.OLLAMA_CLOUD_API_KEY;
    } else {
      process.env.OLLAMA_CLOUD_API_KEY = originalApiKey;
    }
  });

  describe('constructor', () => {
    it('inherits base defaults and cloud-specific config', () => {
      const customProvider = new OllamaCloudProvider({
        apiKey: 'custom-cloud-key',
        baseUrl: 'https://cloud.internal',
        defaultModel: 'deepseek-v3.2',
        enabled: false,
        maxConcurrent: 7,
      });

      expect(customProvider.name).toBe('ollama-cloud');
      expect(customProvider.enabled).toBe(false);
      expect(customProvider.maxConcurrent).toBe(7);
      expect(customProvider.activeTasks).toBe(0);
      expect(customProvider.apiKey).toBe('custom-cloud-key');
      expect(customProvider.baseUrl).toBe('https://cloud.internal');
      expect(customProvider.defaultModel).toBe('deepseek-v3.2');
      expect(customProvider.supportsStreaming).toBe(true);
      expect(loggerMock.child).toHaveBeenCalledWith({ component: 'provider-base' });
    });

    it('falls back to environment variables and built-in defaults', () => {
      process.env.OLLAMA_CLOUD_API_KEY = 'env-cloud-key';

      const envProvider = new OllamaCloudProvider();

      expect(envProvider.apiKey).toBe('env-cloud-key');
      expect(envProvider.baseUrl).toBe('https://api.ollama.com');
      expect(envProvider.defaultModel).toBeNull();
    });
  });

  describe('submit', () => {
    it('throws a configuration error when no API key is available', async () => {
      const noKeyProvider = new OllamaCloudProvider({ apiKey: '' });

      await expect(noKeyProvider.submit('task')).rejects.toThrow(
        'Ollama Cloud API key not configured. Set OLLAMA_CLOUD_API_KEY or provide apiKey in config.'
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('posts to cloud chat and normalizes usage from the response', async () => {
      provider = new OllamaCloudProvider({ apiKey: 'test-cloud-key', defaultModel: 'qwen3-coder:480b' });
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'cloud response' },
          prompt_eval_count: 13,
          eval_count: 5,
        }),
      });

      const result = await provider.submit('ship tests', null, {
        maxTokens: 222,
        working_directory: '/tmp/torque',
        files: ['server/providers/ollama-cloud.js'],
        tuning: { temperature: 0.35 },
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.ollama.com/api/chat',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-cloud-key',
          },
          signal: expect.any(AbortSignal),
        })
      );

      const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(requestBody).toEqual({
        model: 'qwen3-coder:480b',
        messages: [{
          role: 'user',
          content: 'Files: server/providers/ollama-cloud.js\n\nWorking directory: /tmp/torque\n\nship tests',
        }],
        stream: false,
        options: {
          temperature: 0.35,
          num_predict: 222,
        },
      });
      expect(result).toMatchObject({
        output: 'cloud response',
        status: 'completed',
        usage: {
          tokens: 18,
          input_tokens: 13,
          output_tokens: 5,
          cost: 0,
          model: 'qwen3-coder:480b',
        },
      });
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
      expect(provider.activeTasks).toBe(0);
    });

    it('uses the explicit model and custom base URL when provided', async () => {
      const customProvider = new OllamaCloudProvider({
        apiKey: 'custom-cloud-key',
        baseUrl: 'https://edge.ollama.test',
      });

      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
          prompt_eval_count: 2,
          eval_count: 3,
        }),
      });

      const result = await customProvider.submit('route to cloud', 'deepseek-v3.2');
      const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://edge.ollama.test/api/chat',
        expect.any(Object)
      );
      expect(requestBody.model).toBe('deepseek-v3.2');
      expect(result.usage.model).toBe('deepseek-v3.2');
    });

    it('omits request options when tuning and maxTokens are absent', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
        }),
      });

      await provider.submit('plain task');
      const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);

      expect(requestBody.options).toBeUndefined();
    });

    it('returns empty output and zero usage when the API omits message and counts', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await provider.submit('missing payload fields');

      expect(result).toMatchObject({
        output: '',
        status: 'completed',
        usage: {
          tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost: 0,
          model: null,
        },
      });
    });

    it('surfaces HTTP failures with the API response body', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'server exploded',
      });

      await expect(provider.submit('task')).rejects.toThrow(
        'Ollama Cloud API error (500): server exploded'
      );
      expect(provider.activeTasks).toBe(0);
    });

    it('does not retry rate-limited requests and leaves retry policy to the caller', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      });

      await expect(provider.submit('task')).rejects.toThrow(
        'Ollama Cloud API error (429): rate limited'
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(provider.activeTasks).toBe(0);
    });

    it('returns timeout when fetch is aborted', async () => {
      globalThis.fetch.mockRejectedValue(makeAbortError());

      const result = await provider.submit('task');

      expect(result).toMatchObject({
        output: '',
        status: 'timeout',
        usage: {
          tokens: 0,
          cost: 0,
        },
      });
      expect(provider.activeTasks).toBe(0);
    });

    it('schedules timeout cancellation and cleans up external abort listeners', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
          prompt_eval_count: 1,
          eval_count: 1,
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
    it('posts a streaming chat request and parses NDJSON chunks', async () => {
      const stream = makeNdjsonStream([
        '{"message":{"content":"Hello"}}\n',
        '{"message":{"content":" world"}}\n{"done":true,"prompt_eval_count":7,"eval_count":4}\n',
      ]);
      const onChunk = vi.fn();
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: stream.body,
      });

      const result = await provider.submitStream('stream task', 'deepseek-v3.2', { onChunk });
      const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);

      expect(requestBody).toEqual({
        model: 'deepseek-v3.2',
        messages: [{
          role: 'user',
          content: 'stream task',
        }],
        stream: true,
      });
      expect(result).toMatchObject({
        output: 'Hello world',
        status: 'completed',
        usage: {
          tokens: 11,
          input_tokens: 7,
          output_tokens: 4,
          cost: 0,
          model: 'deepseek-v3.2',
        },
      });
      expect(onChunk).toHaveBeenNthCalledWith(1, 'Hello');
      expect(onChunk).toHaveBeenNthCalledWith(2, ' world');
      expect(stream.reader.cancel).toHaveBeenCalledTimes(1);
    });

    it('handles split NDJSON chunks and ignores malformed lines', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: makeNdjsonStream([
          '{"message":{"content":"Hel',
          'lo"}}\nnot-json\n{"message":{"content":" world"}}\n{"done":true,"prompt_eval_count":3,"eval_count":8}\n',
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

    it('flushes trailing buffered NDJSON to capture final usage counts', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: makeNdjsonStream([
          '{"message":{"content":"A"}}\n{"done":true,"prompt_eval_count":2,"eval_count":1}',
        ]).body,
      });

      const result = await provider.submitStream('task');

      expect(result.output).toBe('A');
      expect(result.usage).toMatchObject({
        tokens: 3,
        input_tokens: 2,
        output_tokens: 1,
      });
    });

    it('truncates output once MAX_STREAMING_OUTPUT is reached', async () => {
      const fullChunk = 'A'.repeat(MOCK_MAX_STREAMING_OUTPUT);
      const onChunk = vi.fn();
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: makeNdjsonStream([
          `{"message":{"content":"${fullChunk}"}}\n`,
          '{"message":{"content":"B"}}\n',
          '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
        ]).body,
      });

      const result = await provider.submitStream('task', null, { onChunk });

      expect(onChunk).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalledWith(fullChunk);
      expect(result.output).toBe(`${fullChunk}\n[...OUTPUT TRUNCATED...]`);
      expect(result.output.includes('B')).toBe(false);
    });

    it('surfaces streaming API failures with the response body', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'service unavailable',
      });

      await expect(provider.submitStream('task')).rejects.toThrow(
        'Ollama Cloud streaming error (503): service unavailable'
      );
    });

    it('returns timeout on streaming aborts and cancels the reader during cleanup', async () => {
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

    it('logs a debug breadcrumb if reader cleanup fails but keeps the result', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: makeNdjsonStream(
          [
            '{"message":{"content":"ok"}}\n',
            '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
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
        '[ollama-cloud] Failed to cancel stream reader during OllamaCloud submitStream cleanup: reader already closed'
      );
    });
  });

  describe('health and models', () => {
    it('returns unavailable when no API key is configured', async () => {
      const noKeyProvider = new OllamaCloudProvider({ apiKey: '' });

      await expect(noKeyProvider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'No API key configured',
      });
    });

    it('probes cloud tags and filters out falsy model names', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: 'qwen3-coder:480b' }, { name: '' }, { name: null }, { name: 'deepseek-v3.2' }],
        }),
      });

      const result = await provider.checkHealth();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.ollama.com/api/tags',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-cloud-key' },
          signal: expect.any(AbortSignal),
        })
      );
      expect(result).toEqual({
        available: true,
        models: [
          { model_name: 'qwen3-coder:480b', sizeBytes: null, parameter_size: undefined },
          { model_name: 'deepseek-v3.2', sizeBytes: null, parameter_size: undefined },
        ],
      });
    });

    it('falls back to the default model when the health payload has no models array', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: true }),
      });

      await expect(provider.checkHealth()).resolves.toEqual({
        available: true,
        models: [{ model_name: null }],
      });
    });

    it('reports HTTP, network, and timeout health check failures', async () => {
      globalThis.fetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
      });
      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'API returned 502',
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
        error: 'Health check timed out (10s)',
      });
    });

    it('returns health models when available and empty array otherwise', async () => {
      vi.spyOn(provider, 'checkHealth')
        .mockResolvedValueOnce({ available: true, models: ['glm-5', 'kimi-k2.5'] })
        .mockResolvedValueOnce({ available: false, models: [], error: 'offline' });

      await expect(provider.listModels()).resolves.toEqual(['glm-5', 'kimi-k2.5']);
      await expect(provider.listModels()).resolves.toEqual([]);
    });
  });
});
