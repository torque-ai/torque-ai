import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  loggerDebug,
  loggerChild,
} = vi.hoisted(() => {
  const debug = vi.fn();
  const child = vi.fn(() => ({ debug }));

  return {
    loggerDebug: debug,
    loggerChild: child,
  };
});

vi.mock('../logger', () => ({
  default: { child: loggerChild },
  child: loggerChild,
}));

const OllamaCloudProvider = require('../providers/ollama-cloud.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

function abortError(message = 'aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function deferred() {
  let resolve;
  let reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function makeNdjsonBody(chunks, onCancel = vi.fn()) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    body: {
      getReader: () => ({
        cancel: onCancel,
        read: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }

          return {
            done: false,
            value: encoder.encode(chunks[index++]),
          };
        },
      }),
    },
    onCancel,
  };
}

describe('OllamaCloudProvider', () => {
  let provider;
  let fetchMock;
  let originalApiKey;

  beforeEach(() => {
    originalApiKey = process.env.OLLAMA_CLOUD_API_KEY;
    delete process.env.OLLAMA_CLOUD_API_KEY;

    vi.stubGlobal('fetch', vi.fn());
    fetchMock = globalThis.fetch;
    provider = new OllamaCloudProvider({ apiKey: 'cloud-key' });

    loggerDebug.mockClear();
    loggerChild.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    if (originalApiKey === undefined) {
      delete process.env.OLLAMA_CLOUD_API_KEY;
    } else {
      process.env.OLLAMA_CLOUD_API_KEY = originalApiKey;
    }
  });

  describe('constructor', () => {
    it('sets provider defaults and active task state', () => {
      expect(provider.name).toBe('ollama-cloud');
      expect(provider.apiKey).toBe('cloud-key');
      expect(provider.baseUrl).toBe('https://api.ollama.com');
      expect(provider.defaultModel).toBe('qwen3-coder:480b');
      expect(provider.activeTasks).toBe(0);
      expect(provider.maxConcurrent).toBe(3);
    });

    it('loads the API key from the environment when config is missing', () => {
      process.env.OLLAMA_CLOUD_API_KEY = 'env-cloud-key';

      const envProvider = new OllamaCloudProvider();
      expect(envProvider.apiKey).toBe('env-cloud-key');
    });

    it('prefers the config API key over the environment value', () => {
      process.env.OLLAMA_CLOUD_API_KEY = 'env-cloud-key';

      const configProvider = new OllamaCloudProvider({ apiKey: 'config-cloud-key' });
      expect(configProvider.apiKey).toBe('config-cloud-key');
    });

    it('accepts custom baseUrl, defaultModel, and base-provider options', () => {
      const customProvider = new OllamaCloudProvider({
        apiKey: 'custom-key',
        baseUrl: 'https://edge.ollama.test',
        defaultModel: 'deepseek-v3.2',
        maxConcurrent: 7,
        enabled: false,
      });

      expect(customProvider.baseUrl).toBe('https://edge.ollama.test');
      expect(customProvider.defaultModel).toBe('deepseek-v3.2');
      expect(customProvider.maxConcurrent).toBe(7);
      expect(customProvider.enabled).toBe(false);
    });
  });

  describe('_buildPrompt', () => {
    it('returns the task unchanged when no prompt options are provided', () => {
      expect(provider._buildPrompt('Implement parser', {})).toBe('Implement parser');
    });

    it('prepends only the working directory when provided', () => {
      expect(provider._buildPrompt('Implement parser', {
        working_directory: '/repo',
      })).toBe('Working directory: /repo\n\nImplement parser');
    });

    it('prepends only files when working directory is absent', () => {
      expect(provider._buildPrompt('Implement parser', {
        files: ['src/a.js', 'src/b.js'],
      })).toBe('Files: src/a.js, src/b.js\n\nImplement parser');
    });

    it('prepends files before working directory and ignores empty file arrays', () => {
      expect(provider._buildPrompt('Implement parser', {
        files: ['src/a.js', 'src/b.js'],
        working_directory: '/repo',
      })).toBe('Files: src/a.js, src/b.js\n\nWorking directory: /repo\n\nImplement parser');

      expect(provider._buildPrompt('Implement parser', {
        files: [],
        working_directory: '/repo',
      })).toBe('Working directory: /repo\n\nImplement parser');
    });
  });

  describe('supportsStreaming', () => {
    it('returns true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });
  });

  describe('submit', () => {
    it('throws when no API key is configured', async () => {
      const noKeyProvider = new OllamaCloudProvider({ apiKey: '' });

      await expect(noKeyProvider.submit('task', null, {})).rejects.toThrow(
        'Ollama Cloud API key not configured. Set OLLAMA_CLOUD_API_KEY or provide apiKey in config.'
      );
    });

    it('formats submit requests with auth headers, prompt metadata, and default model routing', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'done' },
          prompt_eval_count: 12,
          eval_count: 4,
        }),
      });

      const result = await provider.submit('Implement parser', null, {
        files: ['src/a.js', 'src/b.js'],
        working_directory: '/repo',
        maxTokens: 111,
        tuning: { temperature: 0.4 },
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.ollama.com/api/chat');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer cloud-key',
        },
        signal: expect.any(AbortSignal),
      }));

      const body = JSON.parse(options.body);
      expect(body).toEqual({
        model: 'qwen3-coder:480b',
        messages: [{
          role: 'user',
          content: 'Files: src/a.js, src/b.js\n\nWorking directory: /repo\n\nImplement parser',
        }],
        stream: false,
        options: {
          temperature: 0.4,
          num_predict: 111,
        },
      });

      expect(result).toEqual(expect.objectContaining({
        output: 'done',
        status: 'completed',
        usage: expect.objectContaining({
          tokens: 16,
          input_tokens: 12,
          output_tokens: 4,
          cost: 0,
          model: 'qwen3-coder:480b',
        }),
      }));
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('routes submit requests to an explicit model and custom baseUrl', async () => {
      const customProvider = new OllamaCloudProvider({
        apiKey: 'cloud-key',
        baseUrl: 'https://edge.ollama.test',
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
          prompt_eval_count: 1,
          eval_count: 2,
        }),
      });

      const result = await customProvider.submit('task', 'deepseek-v3.2', {});
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);

      expect(fetchMock.mock.calls[0][0]).toBe('https://edge.ollama.test/api/chat');
      expect(body.model).toBe('deepseek-v3.2');
      expect(result.usage.model).toBe('deepseek-v3.2');
    });

    it('includes only a temperature option when maxTokens is absent', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
        }),
      });

      await provider.submit('task', null, {
        tuning: { temperature: 0.25 },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.options).toEqual({ temperature: 0.25 });
    });

    it('includes only num_predict when tuning is absent', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
        }),
      });

      await provider.submit('task', null, {
        maxTokens: 222,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.options).toEqual({ num_predict: 222 });
    });

    it('omits request options when tuning and maxTokens are absent', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
        }),
      });

      await provider.submit('task', null, {});

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.options).toBeUndefined();
    });

    it('returns empty output and zeroed usage when the response omits message and counts', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await provider.submit('task', null, {});

      expect(result.output).toBe('');
      expect(result.status).toBe('completed');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.model).toBe('qwen3-coder:480b');
    });

    it('surfaces non-OK submit responses with the response text', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'server exploded',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'Ollama Cloud API error (500): server exploded'
      );
    });

    it('uses the configured timeout option to schedule submit cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
        }),
      });

      await provider.submit('task', null, { timeout: 2 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
    });

    it('returns timeout metadata when submit rejects with AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submit('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns timeout when an external signal aborts the submit request', async () => {
      const externalController = new AbortController();

      fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      }));

      const resultPromise = provider.submit('task', null, { signal: externalController.signal });
      await Promise.resolve();
      externalController.abort();

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('adds and removes external abort listeners after a successful submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      });

      await provider.submit('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
    });

    it('removes external abort listeners and decrements activeTasks after submit failures', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      });

      await expect(provider.submit('task', null, { signal })).rejects.toThrow(
        'Ollama Cloud API error (429): rate limited'
      );

      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
      expect(provider.activeTasks).toBe(0);
    });

    it('tracks activeTasks while a submit request is in flight', async () => {
      const fetchDeferred = deferred();
      fetchMock.mockReturnValue(fetchDeferred.promise);

      const resultPromise = provider.submit('task', null, {});
      expect(provider.activeTasks).toBe(1);

      fetchDeferred.resolve({
        ok: true,
        json: async () => ({
          message: { content: 'done' },
          prompt_eval_count: 2,
          eval_count: 3,
        }),
      });

      const result = await resultPromise;
      expect(result.output).toBe('done');
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('submitStream', () => {
    it('throws when no API key is configured', async () => {
      const noKeyProvider = new OllamaCloudProvider({ apiKey: '' });

      await expect(noKeyProvider.submitStream('task', null, {})).rejects.toThrow(
        'Ollama Cloud API key not configured. Set OLLAMA_CLOUD_API_KEY or provide apiKey in config.'
      );
    });

    it('formats streaming requests with auth headers, prompt metadata, and options', async () => {
      const { body, onCancel } = makeNdjsonBody([
        '{"message":{"content":"Hello"}}\n',
        '{"done":true,"prompt_eval_count":9,"eval_count":4}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('stream task', null, {
        files: ['src/a.js'],
        working_directory: '/repo',
        maxTokens: 77,
        tuning: { temperature: 0.5 },
        onChunk: (chunk) => chunks.push(chunk),
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.ollama.com/api/chat');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer cloud-key',
        },
        signal: expect.any(AbortSignal),
      }));

      const bodyPayload = JSON.parse(options.body);
      expect(bodyPayload).toEqual({
        model: 'qwen3-coder:480b',
        messages: [{
          role: 'user',
          content: 'Files: src/a.js\n\nWorking directory: /repo\n\nstream task',
        }],
        stream: true,
        options: {
          temperature: 0.5,
          num_predict: 77,
        },
      });

      expect(result).toEqual(expect.objectContaining({
        output: 'Hello',
        status: 'completed',
        usage: expect.objectContaining({
          tokens: 13,
          input_tokens: 9,
          output_tokens: 4,
          cost: 0,
          model: 'qwen3-coder:480b',
        }),
      }));
      expect(chunks).toEqual(['Hello']);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('routes streaming requests to an explicit model and custom baseUrl', async () => {
      const customProvider = new OllamaCloudProvider({
        apiKey: 'cloud-key',
        baseUrl: 'https://edge.ollama.test',
      });
      const { body } = makeNdjsonBody([
        '{"message":{"content":"ok"}}\n',
        '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await customProvider.submitStream('task', 'deepseek-v3.2', {});
      const bodyPayload = JSON.parse(fetchMock.mock.calls[0][1].body);

      expect(fetchMock.mock.calls[0][0]).toBe('https://edge.ollama.test/api/chat');
      expect(bodyPayload.model).toBe('deepseek-v3.2');
      expect(result.usage.model).toBe('deepseek-v3.2');
    });

    it('parses NDJSON token chunks and completion usage', async () => {
      const { body } = makeNdjsonBody([
        '{"message":{"content":"Hello"}}\n',
        '{"message":{"content":" world"}}\n{"done":true,"prompt_eval_count":7,"eval_count":4}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(result.output).toBe('Hello world');
      expect(result.usage.tokens).toBe(11);
      expect(result.usage.input_tokens).toBe(7);
      expect(result.usage.output_tokens).toBe(4);
      expect(chunks).toEqual(['Hello', ' world']);
    });

    it('continues parsing across chunk boundaries and skips malformed NDJSON lines', async () => {
      const { body } = makeNdjsonBody([
        '{"message":{"content":"Hel',
        'lo"}}\nnot-json\n{"message":{"content":" world"}}\n{"done":true,"prompt_eval_count":3,"eval_count":8}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});
      expect(result.output).toBe('Hello world');
      expect(result.usage.tokens).toBe(11);
      expect(result.usage.input_tokens).toBe(3);
      expect(result.usage.output_tokens).toBe(8);
    });

    it('flushes trailing buffered NDJSON to capture final usage counts', async () => {
      const { body } = makeNdjsonBody([
        '{"message":{"content":"A"}}\n{"done":true,"prompt_eval_count":2,"eval_count":1}',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});
      expect(result.output).toBe('A');
      expect(result.usage.tokens).toBe(3);
      expect(result.usage.input_tokens).toBe(2);
      expect(result.usage.output_tokens).toBe(1);
    });

    it('defaults streaming usage counts to zero when no done payload is received', async () => {
      const { body } = makeNdjsonBody([
        '{"message":{"content":"Hello"}}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});
      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('truncates streaming output at MAX_STREAMING_OUTPUT and appends the marker once', async () => {
      const maxChunk = 'A'.repeat(MAX_STREAMING_OUTPUT);
      const { body } = makeNdjsonBody([
        `{"message":{"content":"${maxChunk}"}}\n`,
        '{"message":{"content":"B"}}\n',
        '{"message":{"content":"C"}}\n',
        '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(chunks).toEqual([maxChunk]);
      expect(result.output).toBe(`${maxChunk}\n[...OUTPUT TRUNCATED...]`);
    });

    it('surfaces streaming API failures with the response text', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'service unavailable',
      });

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        'Ollama Cloud streaming error (503): service unavailable'
      );
    });

    it('uses the configured timeout option to schedule stream cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const { body } = makeNdjsonBody([
        '{"message":{"content":"ok"}}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', null, { timeout: 3 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3 * 60 * 1000);
    });

    it('returns timeout metadata when stream setup rejects with AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns timeout when an external signal aborts mid-stream and cleans up the reader', async () => {
      const externalController = new AbortController();
      const encoder = new TextEncoder();
      const readerCancel = vi.fn();
      let requestSignal;
      let readCount = 0;

      fetchMock.mockImplementation(async (_url, options) => {
        requestSignal = options.signal;

        return {
          ok: true,
          body: {
            getReader: () => ({
              cancel: readerCancel,
              read: async () => {
                readCount++;
                if (readCount === 1) {
                  return {
                    done: false,
                    value: encoder.encode('{"message":{"content":"Hello"}}\n'),
                  };
                }

                if (requestSignal.aborted) {
                  throw abortError();
                }

                await new Promise((resolve) => {
                  requestSignal.addEventListener('abort', resolve, { once: true });
                });
                throw abortError();
              },
            }),
          },
        };
      });

      const resultPromise = provider.submitStream('task', null, { signal: externalController.signal });
      await Promise.resolve();
      externalController.abort();

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(readerCancel).toHaveBeenCalledTimes(1);
    });

    it('adds and removes external abort listeners after a successful stream submission', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const { body } = makeNdjsonBody([
        '{"message":{"content":"ok"}}\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
    });

    it('tracks activeTasks while a stream is in flight', async () => {
      const readDeferred = deferred();
      const readerCancel = vi.fn();

      fetchMock.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            cancel: readerCancel,
            read: () => readDeferred.promise,
          }),
        },
      });

      const resultPromise = provider.submitStream('task', null, {});
      expect(provider.activeTasks).toBe(1);

      readDeferred.resolve({ done: true, value: undefined });

      const result = await resultPromise;
      expect(result.output).toBe('');
      expect(readerCancel).toHaveBeenCalledTimes(1);
      expect(provider.activeTasks).toBe(0);
    });

    it('swallows stream reader cleanup failures without failing the stream result', async () => {
      const onCancel = vi.fn().mockRejectedValue(new Error('reader already closed'));
      const { body } = makeNdjsonBody([
        '{"message":{"content":"ok"}}\n',
        '{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ], onCancel);
      const cleanupSpy = vi.spyOn(provider, 'cancelStreamReaderForCleanup');

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('ok');
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith(expect.any(Object), 'OllamaCloud submitStream cleanup');
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key is configured', async () => {
      const noKeyProvider = new OllamaCloudProvider({ apiKey: '' });

      await expect(noKeyProvider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'No API key configured',
      });
    });

    it('fetches the tags endpoint with auth headers and filters model names', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: 'qwen3-coder:480b' },
            { name: '' },
            {},
            { name: 'deepseek-v3.2' },
          ],
        }),
      });

      const result = await provider.checkHealth();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.ollama.com/api/tags',
        expect.objectContaining({
          headers: { Authorization: 'Bearer cloud-key' },
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

    it('uses the configured baseUrl and a 10 second timeout for health checks', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const customProvider = new OllamaCloudProvider({
        apiKey: 'cloud-key',
        baseUrl: 'https://edge.ollama.test',
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'glm-5' }] }),
      });

      await customProvider.checkHealth();

      expect(fetchMock.mock.calls[0][0]).toBe('https://edge.ollama.test/api/tags');
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10000);
    });

    it('falls back to defaultModel when the health payload has no models array', async () => {
      const customProvider = new OllamaCloudProvider({
        apiKey: 'cloud-key',
        defaultModel: 'glm-5',
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: true }),
      });

      await expect(customProvider.checkHealth()).resolves.toEqual({
        available: true,
        models: [{ model_name: 'glm-5' }],
      });
    });

    it('returns an empty model list when the models array exists but names are falsy', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: '' }, { name: null }, {}],
        }),
      });

      await expect(provider.checkHealth()).resolves.toEqual({
        available: true,
        models: [],
      });
    });

    it('returns unavailable when the health endpoint responds with a non-OK status', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
      });

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'API returned 502',
      });
    });

    it('returns unavailable when the health check throws a network error', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'ECONNRESET',
      });
    });

    it('returns a timeout-specific health error on AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'Health check timed out (10s)',
      });
    });
  });

  describe('listModels', () => {
    it('returns models from a successful health check', async () => {
      vi.spyOn(provider, 'checkHealth').mockResolvedValue({
        available: true,
        models: ['glm-5', 'kimi-k2.5'],
      });

      await expect(provider.listModels()).resolves.toEqual(['glm-5', 'kimi-k2.5']);
    });

    it('falls back to the static catalog when health is unavailable', async () => {
      vi.spyOn(provider, 'checkHealth').mockResolvedValue({
        available: false,
        models: [],
        error: 'offline',
      });

      await expect(provider.listModels()).resolves.toEqual([
        'qwen3-coder:480b', 'deepseek-v3.1:671b', 'deepseek-v3.2',
        'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k2:1t', 'kimi-k2.5',
        'qwen3-coder-next', 'qwen3-next:80b', 'devstral-2:123b',
        'mistral-large-3:675b', 'glm-5',
      ]);
    });

    it('falls back to the static catalog when health returns no models', async () => {
      vi.spyOn(provider, 'checkHealth').mockResolvedValue({
        available: true,
        models: [],
      });

      await expect(provider.listModels()).resolves.toEqual([
        'qwen3-coder:480b', 'deepseek-v3.1:671b', 'deepseek-v3.2',
        'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k2:1t', 'kimi-k2.5',
        'qwen3-coder-next', 'qwen3-next:80b', 'devstral-2:123b',
        'mistral-large-3:675b', 'glm-5',
      ]);
    });
  });
});
