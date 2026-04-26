import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loggerDebug } = vi.hoisted(() => ({
  loggerDebug: vi.fn(),
}));

vi.mock('../logger', () => ({
  child: vi.fn(() => ({
    debug: loggerDebug,
  })),
}));

const DeepInfraProvider = require('../providers/deepinfra.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

function abortError(message = 'aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(payload, overrides = {}) {
  return {
    ok: true,
    json: async () => payload,
    ...overrides,
  };
}

function textResponse(status, body, headers = { get: () => null }, overrides = {}) {
  return {
    ok: false,
    status,
    headers,
    text: async () => body,
    ...overrides,
  };
}

function makeSSEBody(chunks, overrides = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const reader = {
    cancel: overrides.cancel || vi.fn(),
    read: overrides.read || (async () => {
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }
      return { done: false, value: encoder.encode(chunks[index++]) };
    }),
  };

  return {
    body: {
      getReader: () => reader,
    },
    reader,
  };
}

describe('DeepInfraProvider', () => {
  let provider;
  let fetchMock;
  let originalApiKey;
  let originalFetch;

  beforeEach(() => {
    originalApiKey = process.env.DEEPINFRA_API_KEY;
    delete process.env.DEEPINFRA_API_KEY;

    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    loggerDebug.mockReset();
    provider = new DeepInfraProvider({ apiKey: 'deepinfra-key' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();

    if (originalApiKey === undefined) {
      delete process.env.DEEPINFRA_API_KEY;
    } else {
      process.env.DEEPINFRA_API_KEY = originalApiKey;
    }
  });

  describe('constructor', () => {
    it('sets name, baseUrl, and default model defaults', () => {
      expect(provider.name).toBe('deepinfra');
      expect(provider.baseUrl).toBe('https://api.deepinfra.com/v1/openai');
      expect(provider.defaultModel).toBeNull();
    });

    it('loads the API key from the environment when config key is missing', () => {
      process.env.DEEPINFRA_API_KEY = 'env-deepinfra-key';

      const envProvider = new DeepInfraProvider();

      expect(envProvider.apiKey).toBe('env-deepinfra-key');
    });

    it('accepts custom baseUrl, defaultModel, and maxConcurrent values', () => {
      const customProvider = new DeepInfraProvider({
        apiKey: 'custom-key',
        baseUrl: 'http://localhost:8081/openai',
        defaultModel: 'deepseek-ai/DeepSeek-R1',
        maxConcurrent: 7,
      });

      expect(customProvider.apiKey).toBe('custom-key');
      expect(customProvider.baseUrl).toBe('http://localhost:8081/openai');
      expect(customProvider.defaultModel).toBe('deepseek-ai/DeepSeek-R1');
      expect(customProvider.maxConcurrent).toBe(7);
    });

    it('initializes activeTasks to zero and starts with capacity', () => {
      expect(provider.activeTasks).toBe(0);
      expect(provider.hasCapacity()).toBe(true);
    });
  });

  describe('supportsStreaming', () => {
    it('returns true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });
  });

  describe('_buildPrompt', () => {
    it('returns the task as-is when no options are provided', () => {
      expect(provider._buildPrompt('do work', {})).toBe('do work');
    });

    it('prepends the working directory when provided', () => {
      expect(provider._buildPrompt('do work', { working_directory: '/repo' })).toBe(
        'Working directory: /repo\n\ndo work'
      );
    });

    it('prepends files before the working directory in provider order', () => {
      expect(provider._buildPrompt('do work', {
        files: ['src/index.js', 'src/util.js'],
        working_directory: '/repo',
      })).toBe('Files: src/index.js, src/util.js\n\nWorking directory: /repo\n\ndo work');
    });

    it('ignores an empty files array', () => {
      expect(provider._buildPrompt('do work', { files: [] })).toBe('do work');
    });
  });

  describe('_estimateCost', () => {
    it('returns zero when usage is missing', () => {
      expect(provider._estimateCost(null, provider.defaultModel)).toBe(0);
    });

    it.each([
      ['Qwen/Qwen2.5-72B-Instruct', 0.93],
      ['meta-llama/Llama-3.1-70B-Instruct', 1.15],
      ['meta-llama/Llama-3.1-405B-Instruct', 2.8],
      ['deepseek-ai/DeepSeek-R1', 4.8],
      ['Qwen/Qwen2.5-Coder-32B-Instruct', 0.39],
      ['unknown/model', 1.15],
    ])('uses the expected pricing for %s', (model, expectedCost) => {
      const cost = provider._estimateCost({
        prompt_tokens: 1_000_000,
        completion_tokens: 2_000_000,
      }, model);

      expect(cost).toBeCloseTo(expectedCost);
    });
  });

  describe('listModels', () => {
    it('returns empty array', async () => {
      await expect(provider.listModels()).resolves.toEqual([]);
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key is configured', async () => {
      const noKeyProvider = new DeepInfraProvider({ apiKey: '' });

      await expect(noKeyProvider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'No API key configured',
      });
    });

    it('probes the models endpoint and filters falsy model ids', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        data: [
          { id: 'Qwen/Qwen2.5-72B-Instruct' },
          { id: '' },
          { id: null },
          { id: 'deepseek-ai/DeepSeek-R1' },
        ],
      }));

      const result = await provider.checkHealth();

      expect(result).toEqual({
        available: true,
        models: [
          { model_name: 'Qwen/Qwen2.5-72B-Instruct', id: 'Qwen/Qwen2.5-72B-Instruct', owned_by: null, context_window: null },
          { model_name: 'deepseek-ai/DeepSeek-R1', id: 'deepseek-ai/DeepSeek-R1', owned_by: null, context_window: null },
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.deepinfra.com/v1/openai/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer deepinfra-key' },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('falls back to the default model when the response shape has no data array', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));

      await expect(provider.checkHealth()).resolves.toEqual({
        available: true,
        models: [{ model_name: null }],
      });
    });

    it('returns unavailable on HTTP errors', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toContain('503');
    });

    it('returns unavailable on network failures', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('returns a timeout-shaped error on AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toBe('Health check timed out (5s)');
    });
  });

  describe('submit', () => {
    it('validates the API key before submitting', async () => {
      const noKeyProvider = new DeepInfraProvider({ apiKey: '' });

      await expect(noKeyProvider.submit('task', 'test-model-stub', {})).rejects.toThrow(/API key/i);
    });

    it('formats an OpenAI-compatible request payload and headers', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }));

      await provider.submit('Analyze module', 'test-model-stub', {
        files: ['src/index.js'],
        working_directory: '/repo',
        maxTokens: 222,
        tuning: { temperature: 0.15 },
      });

      const [url, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(url).toBe('https://api.deepinfra.com/v1/openai/chat/completions');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer deepinfra-key',
        },
        signal: expect.any(AbortSignal),
      }));
      expect(body).toEqual({
        model: null,
        messages: [{
          role: 'user',
          content: 'Files: src/index.js\n\nWorking directory: /repo\n\nAnalyze module',
        }],
        max_tokens: 222,
        temperature: 0.15,
      });
    });

    it('defaults max_tokens to 4096 and omits temperature when tuning is missing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));

      await provider.submit('task', 'test-model-stub', {});

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBeNull();
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBeUndefined();
    });

    it.each([
      ['Qwen/Qwen2.5-72B-Instruct', 0.53],
      ['meta-llama/Llama-3.1-70B-Instruct', 0.75],
      ['meta-llama/Llama-3.1-405B-Instruct', 1.8],
      ['deepseek-ai/DeepSeek-R1', 2.65],
    ])('routes %s to the request body and usage metadata', async (model, expectedCost) => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: `${model} output` } }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 1_000_000,
          total_tokens: 2_000_000,
        },
      }));

      const result = await provider.submit('task', model, {});
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);

      expect(body.model).toBe(model);
      expect(result.output).toBe(`${model} output`);
      expect(result.usage.model).toBe(model);
      expect(result.usage.cost).toBeCloseTo(expectedCost);
    });

    it('parses submit output and zeroes usage defaults when fields are missing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [],
      }));

      const result = await provider.submit('task', 'test-model-stub', {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.model).toBeNull();
    });

    it.each([401, 403])('builds an auth-aware error message for %i responses', async (status) => {
      fetchMock.mockResolvedValue(textResponse(status, 'denied'));

      await expect(provider.submit('task', 'test-model-stub', {})).rejects.toThrow(
        new RegExp(`DeepInfra API error \\(${status}\\): authentication failed or unauthorized: denied`)
      );
    });

    it('includes retry_after_seconds when a rate-limit response includes Retry-After', async () => {
      fetchMock.mockResolvedValue(textResponse(
        429,
        'slow down',
        {
          get: (name) => (
            name === 'Retry-After' || name === 'retry-after'
              ? '8'
              : null
          ),
        }
      ));

      await expect(provider.submit('task', 'test-model-stub', {})).rejects.toThrow(/retry_after_seconds=8/);
    });

    it('uses the configured timeout minutes when scheduling cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));

      await provider.submit('task', 'test-model-stub', { timeout: 3 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3 * 60 * 1000);
    });

    it('returns timeout status when fetch rejects with AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submit('task', 'test-model-stub', {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('returns timeout when an external abort signal is triggered', async () => {
      const abortController = new AbortController();
      const requestStarted = createDeferred();

      fetchMock.mockImplementation((_url, { signal }) => {
        requestStarted.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      });

      const resultPromise = provider.submit('task', 'test-model-stub', { signal: abortController.signal });
      await requestStarted.promise;
      abortController.abort();

      const result = await resultPromise;

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('removes the external abort listener after a successful submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));

      await provider.submit('task', 'test-model-stub', { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('tracks concurrent in-flight submits and restores capacity after they settle', async () => {
      const concurrentProvider = new DeepInfraProvider({
        apiKey: 'deepinfra-key',
        maxConcurrent: 2,
      });
      const firstFetch = createDeferred();
      const secondFetch = createDeferred();

      fetchMock
        .mockImplementationOnce(() => firstFetch.promise)
        .mockImplementationOnce(() => secondFetch.promise);

      const firstPromise = concurrentProvider.submit('first task', 'test-model-stub', {});
      expect(concurrentProvider.activeTasks).toBe(1);
      expect(concurrentProvider.hasCapacity()).toBe(true);

      const secondPromise = concurrentProvider.submit('second task', 'test-model-stub', {});
      expect(concurrentProvider.activeTasks).toBe(2);
      expect(concurrentProvider.hasCapacity()).toBe(false);

      firstFetch.resolve(jsonResponse({
        choices: [{ message: { content: 'first done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      secondFetch.resolve(jsonResponse({
        choices: [{ message: { content: 'second done' } }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }));

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

      expect(firstResult.output).toBe('first done');
      expect(secondResult.output).toBe('second done');
      expect(concurrentProvider.activeTasks).toBe(0);
      expect(concurrentProvider.hasCapacity()).toBe(true);
    });

    it('decrements activeTasks after request errors', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'boom'));

      await expect(provider.submit('task', 'test-model-stub', {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('submitStream', () => {
    it('validates the API key before streaming', async () => {
      const noKeyProvider = new DeepInfraProvider({ apiKey: '' });

      await expect(noKeyProvider.submitStream('task', 'test-model-stub', {})).rejects.toThrow(/API key/i);
    });

    it('formats a streaming request and parses streamed tokens and usage', async () => {
      const { body, reader } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', 'test-model-stub', {
        onChunk: (chunk) => chunks.push(chunk),
      });

      const [url, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);

      expect(url).toBe('https://api.deepinfra.com/v1/openai/chat/completions');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer deepinfra-key',
        },
        signal: expect.any(AbortSignal),
      }));
      expect(requestBody).toEqual({
        model: null,
        messages: [{ role: 'user', content: 'task' }],
        max_tokens: 4096,
        stream: true,
      });
      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello world!');
      expect(result.usage.tokens).toBe(8);
      expect(result.usage.input_tokens).toBe(5);
      expect(result.usage.output_tokens).toBe(3);
      expect(chunks).toEqual(['Hello', ' world', '!']);
      expect(reader.cancel).toHaveBeenCalledTimes(1);
    });

    it('includes prompt formatting, explicit model, max tokens, and temperature in stream bodies', async () => {
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('stream task', 'meta-llama/Llama-3.1-405B-Instruct', {
        files: ['src/a.js'],
        working_directory: '/repo',
        maxTokens: 77,
        tuning: { temperature: 0.6 },
      });

      const bodyJson = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(bodyJson).toEqual({
        model: 'meta-llama/Llama-3.1-405B-Instruct',
        messages: [{
          role: 'user',
          content: 'Files: src/a.js\n\nWorking directory: /repo\n\nstream task',
        }],
        max_tokens: 77,
        stream: true,
        temperature: 0.6,
      });
    });

    it('continues parsing across split chunks and malformed data', async () => {
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"He',
        'llo"}}]}\n\ndata: [bad-json]\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', 'test-model-stub', {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello!');
      expect(result.usage.tokens).toBe(3);
      expect(result.usage.input_tokens).toBe(1);
      expect(result.usage.output_tokens).toBe(2);
    });

    it('defaults stream usage to zero when no usage chunk arrives', async () => {
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', 'test-model-stub', {});

      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('truncates streaming output after MAX_STREAMING_OUTPUT and stops emitting extra chunks', async () => {
      const largeChunk = 'A'.repeat(MAX_STREAMING_OUTPUT);
      const { body } = makeSSEBody([
        `data: {"choices":[{"delta":{"content":"${largeChunk}"}}]}\n\n`,
        'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', 'test-model-stub', {
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(chunks).toEqual([largeChunk]);
      expect(result.output).toContain('[...OUTPUT TRUNCATED...]');
      expect(result.output.endsWith('[...OUTPUT TRUNCATED...]')).toBe(true);
      expect(result.output.includes('B')).toBe(false);
    });

    it.each([401, 403])('builds an auth-aware streaming error message for %i responses', async (status) => {
      fetchMock.mockResolvedValue(textResponse(status, 'denied'));

      await expect(provider.submitStream('task', 'test-model-stub', {})).rejects.toThrow(
        new RegExp(`DeepInfra streaming API error \\(${status}\\): authentication failed or unauthorized: denied`)
      );
    });

    it('includes retry_after_seconds in streaming rate-limit errors', async () => {
      fetchMock.mockResolvedValue(textResponse(
        429,
        'slow down',
        {
          get: (name) => (
            name === 'Retry-After' || name === 'retry-after'
              ? '11'
              : null
          ),
        }
      ));

      await expect(provider.submitStream('task', 'test-model-stub', {})).rejects.toThrow(/retry_after_seconds=11/);
    });

    it('uses the configured timeout minutes when scheduling stream cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', 'test-model-stub', { timeout: 4 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4 * 60 * 1000);
    });

    it('returns timeout when fetch aborts before the stream starts', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submitStream('task', 'test-model-stub', {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('returns timeout when an external signal aborts mid-stream and cancels the reader', async () => {
      const abortController = new AbortController();
      const encoder = new TextEncoder();
      const secondReadStarted = createDeferred();
      const readerCancel = vi.fn();
      let readCount = 0;

      fetchMock.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            cancel: readerCancel,
            read: vi.fn(async () => {
              readCount += 1;

              if (readCount === 1) {
                return {
                  done: false,
                  value: encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
                };
              }

              secondReadStarted.resolve();
              await new Promise((resolve) => {
                abortController.signal.addEventListener('abort', resolve, { once: true });
              });
              throw abortError();
            }),
          }),
        },
      });

      const resultPromise = provider.submitStream('task', 'test-model-stub', { signal: abortController.signal });
      await secondReadStarted.promise;
      abortController.abort();

      const result = await resultPromise;

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(readerCancel).toHaveBeenCalledTimes(1);
    });

    it('removes the external abort listener after a successful streaming submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', 'test-model-stub', { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('swallows stream reader cleanup errors without changing the completed result', async () => {
      const cancel = vi.fn().mockRejectedValue(new Error('already closed'));
      const { body } = makeSSEBody(
        [
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ],
        {
          cancel,
        }
      );
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', 'test-model-stub', {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('ok');
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('decrements activeTasks after streaming request errors', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'boom'));

      await expect(provider.submitStream('task', 'test-model-stub', {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });
  });
});
