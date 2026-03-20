import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fetchMock, loggerDebug, loggerChild } = vi.hoisted(() => {
  const debug = vi.fn();
  const child = vi.fn(() => ({ debug }));
  return {
    fetchMock: vi.fn(),
    loggerDebug: debug,
    loggerChild: child,
  };
});

vi.mock('../logger', () => ({
  default: { child: loggerChild },
  child: loggerChild,
}));

const GoogleAIProvider = require('../providers/google-ai.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

function makeAbortError(message = 'aborted') {
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

function makeSSEStream(chunks, overrides = {}) {
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

function requestBody(callIndex = 0) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

export { makeSSEStream, makeAbortError };

describe('GoogleAIProvider', () => {
  let provider;
  let originalApiKey;

  beforeEach(() => {
    originalApiKey = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;

    fetchMock.mockReset();
    loggerDebug.mockReset();
    loggerChild.mockClear();

    vi.stubGlobal('fetch', fetchMock);
    provider = new GoogleAIProvider({ apiKey: 'google-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    if (originalApiKey === undefined) {
      delete process.env.GOOGLE_AI_API_KEY;
    } else {
      process.env.GOOGLE_AI_API_KEY = originalApiKey;
    }
  });

  describe('constructor', () => {
    it('sets Google AI defaults and inherited state', () => {
      expect(provider.name).toBe('google-ai');
      expect(provider.apiKey).toBe('google-key');
      expect(provider.baseUrl).toBe('https://generativelanguage.googleapis.com');
      expect(provider.defaultModel).toBe('gemini-2.5-flash');
      expect(provider.activeTasks).toBe(0);
      expect(provider.hasCapacity()).toBe(true);
    });

    it('loads the API key from the environment when config is missing', () => {
      process.env.GOOGLE_AI_API_KEY = 'env-google-key';

      const envProvider = new GoogleAIProvider();
      expect(envProvider.apiKey).toBe('env-google-key');
    });

    it('prefers the config API key over the environment value', () => {
      process.env.GOOGLE_AI_API_KEY = 'env-google-key';

      const configProvider = new GoogleAIProvider({ apiKey: 'config-google-key' });
      expect(configProvider.apiKey).toBe('config-google-key');
    });

    it('accepts custom baseUrl, defaultModel, and maxConcurrent values', () => {
      const customProvider = new GoogleAIProvider({
        apiKey: 'custom-key',
        baseUrl: 'http://localhost:8080',
        defaultModel: 'gemini-2.5-pro',
        maxConcurrent: 1,
      });

      expect(customProvider.baseUrl).toBe('http://localhost:8080');
      expect(customProvider.defaultModel).toBe('gemini-2.5-pro');
      expect(customProvider.maxConcurrent).toBe(1);
    });
  });

  describe('_buildPrompt', () => {
    it('returns the task as-is when no options are provided', () => {
      expect(provider._buildPrompt('Implement parser', {})).toBe('Implement parser');
    });

    it('prepends only the working directory when files are absent', () => {
      expect(provider._buildPrompt('Implement parser', {
        working_directory: '/repo',
      })).toBe('Working directory: /repo\n\nImplement parser');
    });

    it('prepends files before the working directory in provider order', () => {
      expect(provider._buildPrompt('Implement parser', {
        files: ['src/a.js', 'src/b.js'],
        working_directory: '/repo',
      })).toBe('Files: src/a.js, src/b.js\n\nWorking directory: /repo\n\nImplement parser');
    });

    it('ignores an empty files array', () => {
      expect(provider._buildPrompt('Implement parser', {
        files: [],
      })).toBe('Implement parser');
    });
  });

  describe('supportsStreaming', () => {
    it('returns true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key is configured', async () => {
      const noKeyProvider = new GoogleAIProvider({ apiKey: '' });

      await expect(noKeyProvider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'No API key configured',
      });
    });

    it('probes the models endpoint, filters generateContent models, and strips prefixes', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['countTokens', 'generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          { name: '', supportedGenerationMethods: ['generateContent'] },
          {},
        ],
      }));

      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const result = await provider.checkHealth();

      expect(result).toEqual({
        available: true,
        models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models',
        expect.objectContaining({
          headers: { 'X-Goog-Api-Key': 'google-key' },
          signal: expect.any(AbortSignal),
        })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    });

    it('uses the configured baseUrl and custom defaultModel when the payload has no models array', async () => {
      const customProvider = new GoogleAIProvider({
        apiKey: 'google-key',
        baseUrl: 'http://localhost:9090',
        defaultModel: 'gemini-2.5-pro',
      });
      fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));

      const result = await customProvider.checkHealth();

      expect(result).toEqual({
        available: true,
        models: ['gemini-2.5-pro'],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9090/v1beta/models',
        expect.objectContaining({
          headers: { 'X-Goog-Api-Key': 'google-key' },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('returns unavailable on non-OK HTTP responses', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
      });

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'API returned 503',
      });
    });

    it('returns unavailable when the health probe throws a network error', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'ECONNREFUSED',
      });
    });

    it('returns a timeout-shaped error when the probe is aborted', async () => {
      fetchMock.mockRejectedValue(makeAbortError());

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'Health check timed out (5s)',
      });
    });
  });

  describe('listModels', () => {
    it('returns discovered models when health succeeds with models', async () => {
      vi.spyOn(provider, 'checkHealth').mockResolvedValue({
        available: true,
        models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      });

      await expect(provider.listModels()).resolves.toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    });

    it('falls back to the static Gemini list when health returns no models', async () => {
      vi.spyOn(provider, 'checkHealth').mockResolvedValue({
        available: true,
        models: [],
      });

      await expect(provider.listModels()).resolves.toEqual([
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-3-flash-preview',
        'gemini-3-pro-preview',
      ]);
    });

    it('falls back to the static Gemini list when health is unavailable', async () => {
      vi.spyOn(provider, 'checkHealth').mockResolvedValue({
        available: false,
        models: [],
        error: 'boom',
      });

      await expect(provider.listModels()).resolves.toEqual([
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-3-flash-preview',
        'gemini-3-pro-preview',
      ]);
    });
  });

  describe('submit', () => {
    it('validates that an API key is configured', async () => {
      const noKeyProvider = new GoogleAIProvider({ apiKey: '' });

      await expect(noKeyProvider.submit('task', null, {})).rejects.toThrow(/API key/i);
    });

    it('formats Google AI requests with contents, role, parts, and generationConfig', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          totalTokenCount: 11,
          promptTokenCount: 7,
          candidatesTokenCount: 4,
        },
      }));

      const result = await provider.submit('Implement change', 'gemini-2.5-pro', {
        files: ['src/a.js', 'src/b.js'],
        working_directory: '/repo',
        maxTokens: 2048,
        tuning: { temperature: 0.25 },
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'
      );
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': 'google-key',
        },
        signal: expect.any(AbortSignal),
      }));
      expect(requestBody()).toEqual({
        contents: [{
          role: 'user',
          parts: [{
            text: 'Files: src/a.js, src/b.js\n\nWorking directory: /repo\n\nImplement change',
          }],
        }],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.25,
        },
      });
      expect(result.output).toBe('ok');
      expect(result.status).toBe('completed');
      expect(result.usage).toEqual(expect.objectContaining({
        tokens: 11,
        input_tokens: 7,
        output_tokens: 4,
        model: 'gemini-2.5-pro',
      }));
      expect(result.usage.cost).toBeCloseTo(0.0000385, 10);
    });

    it('uses the configured defaultModel when a model is not provided', async () => {
      const customProvider = new GoogleAIProvider({
        apiKey: 'google-key',
        defaultModel: 'gemini-2.5-pro',
      });
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'custom default' }] } }],
        usageMetadata: {
          totalTokenCount: 5,
          promptTokenCount: 3,
          candidatesTokenCount: 2,
        },
      }));

      const result = await customProvider.submit('task', null, {});

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'
      );
      expect(result.usage.model).toBe('gemini-2.5-pro');
    });

    it('uses the configured baseUrl for submit requests', async () => {
      const customProvider = new GoogleAIProvider({
        apiKey: 'google-key',
        baseUrl: 'http://localhost:8081',
      });
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          totalTokenCount: 1,
          promptTokenCount: 1,
          candidatesTokenCount: 0,
        },
      }));

      await customProvider.submit('task', null, {});
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://localhost:8081/v1beta/models/gemini-2.5-flash:generateContent'
      );
    });

    it('preserves large prompts, large token limits, and zero temperature for large context requests', async () => {
      const longTask = 'LargeContext '.repeat(10_000);
      const files = Array.from({ length: 128 }, (_, index) => `src/file-${index}.js`);
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          totalTokenCount: 1000,
          promptTokenCount: 900,
          candidatesTokenCount: 100,
        },
      }));

      await provider.submit(longTask, null, {
        files,
        working_directory: '/very/large/repo',
        maxTokens: 131072,
        tuning: { temperature: 0 },
      });

      const body = requestBody();
      expect(body.generationConfig).toEqual({
        maxOutputTokens: 131072,
        temperature: 0,
      });
      expect(body.contents[0].role).toBe('user');
      expect(body.contents[0].parts).toHaveLength(1);
      expect(body.contents[0].parts[0].text).toContain('Files: src/file-0.js');
      expect(body.contents[0].parts[0].text).toContain('Working directory: /very/large/repo');
      expect(body.contents[0].parts[0].text.endsWith(longTask)).toBe(true);
    });

    it('defaults maxOutputTokens to 8192 and omits temperature when tuning is absent', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          totalTokenCount: 2,
          promptTokenCount: 1,
          candidatesTokenCount: 1,
        },
      }));

      await provider.submit('task', null, {});

      expect(requestBody().generationConfig).toEqual({
        maxOutputTokens: 8192,
      });
    });

    it('concatenates text parts and ignores non-text parts in the first candidate', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{
          content: {
            parts: [
              { text: 'Hello' },
              { inlineData: { mimeType: 'image/png' } },
              { text: ' world' },
              { text: '' },
            ],
          },
        }],
        usageMetadata: {
          totalTokenCount: 9,
          promptTokenCount: 5,
          candidatesTokenCount: 4,
        },
      }));

      const result = await provider.submit('task', null, {});
      expect(result.output).toBe('Hello world');
    });

    it('returns empty output and zero usage defaults when candidates or usage metadata are missing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: null }],
      }));

      const result = await provider.submit('task', null, {});

      expect(result).toEqual(expect.objectContaining({
        output: '',
        status: 'completed',
        usage: expect.objectContaining({
          tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost: 0,
          model: 'gemini-2.5-flash',
        }),
      }));
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it.each([401, 403])('surfaces Google API error details for %i responses', async (status) => {
      fetchMock.mockResolvedValue(textResponse(status, 'invalid API key'));

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        new RegExp(`Google AI API error \\(${status}\\): invalid API key`)
      );
    });

    it('includes retry_after_seconds when a quota response provides Retry-After', async () => {
      fetchMock.mockResolvedValue(textResponse(
        429,
        'quota exceeded',
        {
          get: (name) => (
            name === 'Retry-After' || name === 'retry-after'
              ? '7'
              : null
          ),
        }
      ));

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'Google AI API error (429): quota exceeded retry_after_seconds=7'
      );
    });

    it('surfaces server errors with the response body', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'server error'));

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'Google AI API error (500): server error'
      );
    });

    it('uses the configured timeout minutes when scheduling cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          totalTokenCount: 1,
          promptTokenCount: 1,
          candidatesTokenCount: 0,
        },
      }));

      await provider.submit('task', null, { timeout: 2 });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
    });

    it('returns timeout metadata when fetch rejects with AbortError', async () => {
      fetchMock.mockRejectedValue(makeAbortError());

      const result = await provider.submit('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns timeout when an external abort signal is triggered', async () => {
      const externalController = new AbortController();
      const requestStarted = createDeferred();

      fetchMock.mockImplementation((_url, options) => {
        requestStarted.resolve();
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        });
      });

      const resultPromise = provider.submit('task', null, { signal: externalController.signal });
      await requestStarted.promise;
      externalController.abort();

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('adds and removes the external abort listener after a successful submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      fetchMock.mockResolvedValue(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          totalTokenCount: 1,
          promptTokenCount: 1,
          candidatesTokenCount: 0,
        },
      }));

      await provider.submit('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('tracks concurrent submits against maxConcurrent and restores capacity when they settle', async () => {
      const concurrentProvider = new GoogleAIProvider({
        apiKey: 'google-key',
        maxConcurrent: 2,
      });
      const firstFetch = createDeferred();
      const secondFetch = createDeferred();

      fetchMock
        .mockImplementationOnce(() => firstFetch.promise)
        .mockImplementationOnce(() => secondFetch.promise);

      const firstPromise = concurrentProvider.submit('first task', null, {});
      expect(concurrentProvider.activeTasks).toBe(1);
      expect(concurrentProvider.hasCapacity()).toBe(true);

      const secondPromise = concurrentProvider.submit('second task', null, {});
      expect(concurrentProvider.activeTasks).toBe(2);
      expect(concurrentProvider.hasCapacity()).toBe(false);

      firstFetch.resolve(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'first done' }] } }],
        usageMetadata: {
          totalTokenCount: 2,
          promptTokenCount: 1,
          candidatesTokenCount: 1,
        },
      }));
      secondFetch.resolve(jsonResponse({
        candidates: [{ content: { parts: [{ text: 'second done' }] } }],
        usageMetadata: {
          totalTokenCount: 4,
          promptTokenCount: 2,
          candidatesTokenCount: 2,
        },
      }));

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

      expect(firstResult.output).toBe('first done');
      expect(secondResult.output).toBe('second done');
      expect(concurrentProvider.activeTasks).toBe(0);
      expect(concurrentProvider.hasCapacity()).toBe(true);
    });

    it('decrements activeTasks after submit request errors', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'boom'));

      await expect(provider.submit('task', null, {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('submitStream', () => {
    it('validates that an API key is configured before streaming', async () => {
      const noKeyProvider = new GoogleAIProvider({ apiKey: '' });

      await expect(noKeyProvider.submitStream('task', null, {})).rejects.toThrow(/API key/i);
    });

    it('formats streaming requests for the Gemini SSE endpoint', async () => {
      const { body } = makeSSEStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('Stream change', 'gemini-2.5-pro', {
        files: ['src/a.js'],
        working_directory: '/repo',
        maxTokens: 512,
        tuning: { temperature: 0.15 },
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'
      );
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': 'google-key',
        },
        signal: expect.any(AbortSignal),
      }));
      expect(requestBody()).toEqual({
        contents: [{
          role: 'user',
          parts: [{
            text: 'Files: src/a.js\n\nWorking directory: /repo\n\nStream change',
          }],
        }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.15,
        },
      });
    });

    it('uses the configured defaultModel for streaming when no explicit model is given', async () => {
      const customProvider = new GoogleAIProvider({
        apiKey: 'google-key',
        defaultModel: 'gemini-2.5-pro',
      });
      const { body } = makeSSEStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"totalTokenCount":3,"promptTokenCount":2,"candidatesTokenCount":1}}\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await customProvider.submitStream('task', null, {});

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'
      );
      expect(result.usage.model).toBe('gemini-2.5-pro');
    });

    it('parses Gemini SSE parts, accumulates output, usage, and emits chunks', async () => {
      const { body, reader } = makeSSEStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"},{"text":" world"}]}}]}\n\n',
        'data: {"usageMetadata":{"totalTokenCount":13,"promptTokenCount":8,"candidatesTokenCount":5}}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello world');
      expect(result.usage).toEqual(expect.objectContaining({
        tokens: 13,
        input_tokens: 8,
        output_tokens: 5,
        model: 'gemini-2.5-flash',
      }));
      expect(result.usage.cost).toBeCloseTo(0.000004875, 10);
      expect(chunks).toEqual(['Hello', ' world']);
      expect(reader.cancel).toHaveBeenCalledTimes(1);
    });

    it('parses SSE events that are split across chunk boundaries', async () => {
      const { body } = makeSSEStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel',
        'lo"}]}}]}\n\ndata: {"usageMetadata":{"totalTokenCount":6,"promptTokenCount":2,"candidatesTokenCount":4}}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(6);
      expect(result.usage.input_tokens).toBe(2);
      expect(result.usage.output_tokens).toBe(4);
    });

    it('ignores malformed JSON, blank data lines, comments, and the DONE sentinel', async () => {
      const { body } = makeSSEStream([
        'event: ping\n',
        ': comment line\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n',
        'data:   \n',
        'data: [not-json]\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" there"}]}}]}\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(result.output).toBe('Hello there');
      expect(chunks).toEqual(['Hello', ' there']);
      expect(result.usage.tokens).toBe(0);
    });

    it('keeps the latest usageMetadata values when multiple usage events arrive', async () => {
      const { body } = makeSSEStream([
        'data: {"usageMetadata":{"totalTokenCount":5,"promptTokenCount":3,"candidatesTokenCount":2}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n',
        'data: {"usageMetadata":{"totalTokenCount":9,"promptTokenCount":4,"candidatesTokenCount":5}}\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.output).toBe('Hi');
      expect(result.usage.tokens).toBe(9);
      expect(result.usage.input_tokens).toBe(4);
      expect(result.usage.output_tokens).toBe(5);
    });

    it('defaults streaming usage fields to zero when usageMetadata is absent', async () => {
      const { body } = makeSSEStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.output).toBe('Hello');
      expect(result.usage).toEqual(expect.objectContaining({
        tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        model: 'gemini-2.5-flash',
      }));
    });

    it('truncates streaming output after MAX_STREAMING_OUTPUT and suppresses extra chunks', async () => {
      const maxChunk = 'A'.repeat(MAX_STREAMING_OUTPUT);
      const { body } = makeSSEStream([
        `data: {"candidates":[{"content":{"parts":[{"text":"${maxChunk}"}]}}]}\n\n`,
        'data: {"candidates":[{"content":{"parts":[{"text":"B"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"C"}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(chunks).toEqual([maxChunk]);
      expect(result.output).toContain('[...OUTPUT TRUNCATED...]');
      expect(result.output.endsWith('[...OUTPUT TRUNCATED...]')).toBe(true);
      expect(result.output).not.toContain(`${maxChunk}B`);
      expect(result.output.split('[...OUTPUT TRUNCATED...]')).toHaveLength(2);
    });

    it.each([401, 403])('surfaces stream error details for %i responses', async (status) => {
      fetchMock.mockResolvedValue(textResponse(status, 'denied'));

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        new RegExp(`Google AI API error \\(${status}\\): denied`)
      );
    });

    it('includes retry_after_seconds in streaming quota errors', async () => {
      fetchMock.mockResolvedValue(textResponse(
        429,
        'rate limited',
        {
          get: (name) => (
            name === 'Retry-After' || name === 'retry-after'
              ? '11'
              : null
          ),
        }
      ));

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        'Google AI API error (429): rate limited retry_after_seconds=11'
      );
    });

    it('surfaces streaming server errors with the response body', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'server error'));

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        'Google AI API error (500): server error'
      );
    });

    it('uses the configured timeout minutes when scheduling stream cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const { body } = makeSSEStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', null, { timeout: 3 });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3 * 60 * 1000);
    });

    it('returns timeout metadata when stream setup fails with AbortError', async () => {
      fetchMock.mockRejectedValue(makeAbortError());

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns timeout when an external abort signal fires mid-stream and cancels the reader', async () => {
      const externalController = new AbortController();
      const secondReadStarted = createDeferred();
      const encoder = new TextEncoder();
      const readerCancel = vi.fn();
      let readCount = 0;

      fetchMock.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            cancel: readerCancel,
            read: async () => {
              readCount += 1;
              if (readCount === 1) {
                return {
                  done: false,
                  value: encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'),
                };
              }

              secondReadStarted.resolve();
              await new Promise((resolve) => {
                externalController.signal.addEventListener('abort', resolve, { once: true });
              });
              throw makeAbortError();
            },
          }),
        },
      });

      const resultPromise = provider.submitStream('task', null, { signal: externalController.signal });
      await secondReadStarted.promise;
      externalController.abort();

      const result = await resultPromise;

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(readerCancel).toHaveBeenCalledTimes(1);
    });

    it('adds and removes the external abort listener after a successful streaming submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const { body } = makeSSEStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('swallows stream reader cleanup failures and logs a debug breadcrumb', async () => {
      const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
      const { body } = makeSSEStream(
        ['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'],
        { cancel }
      );
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('ok');
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('decrements activeTasks after streaming request errors', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'boom'));

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });
  });
});
