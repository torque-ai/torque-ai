import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OllamaStrategicProvider = require('../providers/ollama-strategic.js');

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

function textResponse(status, body, overrides = {}) {
  return {
    ok: false,
    status,
    text: async () => body,
    ...overrides,
  };
}

function requestBody(fetchMock, callIndex = 0) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

describe('OllamaStrategicProvider', () => {
  let originalHost;
  let fetchMock;
  let provider;

  let originalOllamaHost;

  beforeEach(() => {
    originalHost = process.env.OLLAMA_STRATEGIC_HOST;
    originalOllamaHost = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_STRATEGIC_HOST;
    delete process.env.OLLAMA_HOST;

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    provider = new OllamaStrategicProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    if (originalHost === undefined) {
      delete process.env.OLLAMA_STRATEGIC_HOST;
    } else {
      process.env.OLLAMA_STRATEGIC_HOST = originalHost;
    }
    if (originalOllamaHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = originalOllamaHost;
    }
  });

  describe('constructor', () => {
    it('sets inherited and strategic defaults', () => {
      expect(provider.name).toBe('ollama');
      expect(provider.enabled).toBe(true);
      expect(provider.maxConcurrent).toBe(3);
      expect(provider.activeTasks).toBe(0);
      expect(provider.host).toBe('http://localhost:11434');
      expect(provider.baseUrl).toBe('http://localhost:11434/v1');
      expect(provider.defaultModel).toBe('qwen2.5-coder:32b');
      expect(provider.defaultTemperature).toBe(0.3);
      expect(provider.hasCapacity()).toBe(true);
    });

    it('trims trailing slashes from an explicit host', () => {
      const customProvider = new OllamaStrategicProvider({ host: 'http://10.0.0.5:11434///' });

      expect(customProvider.host).toBe('http://10.0.0.5:11434');
      expect(customProvider.baseUrl).toBe('http://10.0.0.5:11434/v1');
    });

    it('uses an apiKey that looks like a URL as the host', () => {
      const hostFromApiKey = new OllamaStrategicProvider({
        apiKey: 'http://192.168.1.200:11434/',
      });

      expect(hostFromApiKey.host).toBe('http://192.168.1.200:11434');
      expect(hostFromApiKey.baseUrl).toBe('http://192.168.1.200:11434/v1');
    });

    it('prefers explicit host over apiKey host and environment values', () => {
      process.env.OLLAMA_STRATEGIC_HOST = 'http://192.168.1.201:11434';

      const customProvider = new OllamaStrategicProvider({
        host: 'http://192.168.1.202:11434/',
        apiKey: 'http://192.168.1.203:11434/',
      });

      expect(customProvider.host).toBe('http://192.168.1.202:11434');
    });

    it('uses the environment host when config does not provide one', () => {
      process.env.OLLAMA_STRATEGIC_HOST = 'http://192.168.1.150:11434/';

      const envProvider = new OllamaStrategicProvider();

      expect(envProvider.host).toBe('http://192.168.1.150:11434');
      expect(envProvider.baseUrl).toBe('http://192.168.1.150:11434/v1');
    });

    it('accepts custom default model, zero default temperature, and maxConcurrent', () => {
      const customProvider = new OllamaStrategicProvider({
        defaultModel: 'deepseek-r1:32b',
        defaultTemperature: 0,
        maxConcurrent: 1,
      });

      expect(customProvider.defaultModel).toBe('deepseek-r1:32b');
      expect(customProvider.defaultTemperature).toBe(0);
      expect(customProvider.maxConcurrent).toBe(1);
    });
  });

  describe('_buildPrompt', () => {
    it('returns the task unchanged when no context is provided', () => {
      expect(provider._buildPrompt('Plan the rollout', {})).toBe('Plan the rollout');
    });

    it('prepends only the working directory when files are absent', () => {
      expect(provider._buildPrompt('Plan the rollout', {
        working_directory: '/repo',
      })).toBe('Working directory: /repo\n\nPlan the rollout');
    });

    it('prepends files before the working directory for strategic context injection', () => {
      expect(provider._buildPrompt('Plan the rollout', {
        files: ['server/index.js', 'server/providers/ollama-strategic.js'],
        working_directory: '/repo',
      })).toBe(
        'Files: server/index.js, server/providers/ollama-strategic.js\n\nWorking directory: /repo\n\nPlan the rollout'
      );
    });

    it('ignores an empty files array', () => {
      expect(provider._buildPrompt('Plan the rollout', {
        files: [],
        working_directory: '/repo',
      })).toBe('Working directory: /repo\n\nPlan the rollout');
    });
  });

  describe('helpers', () => {
    it('extracts model names from string and object entries', () => {
      expect(provider._extractModelNames({
        models: ['qwen2.5-coder:32b', { name: 'deepseek-r1:32b' }, { name: '' }, {}],
      })).toEqual(['qwen2.5-coder:32b', 'deepseek-r1:32b']);
    });

    it('returns an empty array when the tags payload does not contain a models array', () => {
      expect(provider._extractModelNames(null)).toEqual([]);
      expect(provider._extractModelNames({})).toEqual([]);
      expect(provider._extractModelNames({ models: 'not-an-array' })).toEqual([]);
    });

    it('always estimates zero cost for local strategic calls', () => {
      expect(provider._estimateCost()).toBe(0);
      expect(provider._estimateCost({ prompt_tokens: 99999 }, 'any-model')).toBe(0);
    });
  });

  describe('checkHealth', () => {
    it('probes /api/tags and returns extracted model names', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue(jsonResponse({
        models: ['qwen2.5-coder:32b', { name: 'deepseek-r1:32b' }],
      }));

      const result = await provider.checkHealth();

      expect(result).toEqual({
        available: true,
        models: ['qwen2.5-coder:32b', 'deepseek-r1:32b'],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        expect.objectContaining({
          method: 'GET',
          signal: expect.any(AbortSignal),
        })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    });

    it('falls back to the default model when the tags payload has no usable names', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        models: [{ name: '' }, null, {}],
      }));

      await expect(provider.checkHealth()).resolves.toEqual({
        available: true,
        models: ['qwen2.5-coder:32b'],
      });
    });

    it('returns unavailable when /api/tags returns a non-OK status', async () => {
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

    it('returns unavailable when the probe throws a network error', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'connect ECONNREFUSED',
      });
    });

    it('returns a timeout-shaped error when the probe aborts', async () => {
      fetchMock.mockRejectedValue(makeAbortError());

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'Health check timed out (5s)',
      });
    });
  });

  describe('listModels', () => {
    it('returns extracted models from /api/tags', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        models: [{ name: 'qwen2.5-coder:32b' }, { name: 'llama3.1:70b' }],
      }));

      await expect(provider.listModels()).resolves.toEqual(['qwen2.5-coder:32b', 'llama3.1:70b']);
    });

    it('falls back to the default model when tags are empty', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ models: [] }));

      await expect(provider.listModels()).resolves.toEqual(['qwen2.5-coder:32b']);
    });

    it('returns an empty array when model discovery fails', async () => {
      fetchMock.mockRejectedValue(new Error('offline'));

      await expect(provider.listModels()).resolves.toEqual([]);
    });
  });

  describe('submit', () => {
    it('posts to the OpenAI-compatible chat completions endpoint with default settings', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'strategy ready' } }],
        usage: {
          total_tokens: 18,
          prompt_tokens: 11,
          completion_tokens: 7,
        },
      }));

      const result = await provider.submit('Diagnose the task');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: expect.any(AbortSignal),
        })
      );
      expect(requestBody(fetchMock)).toEqual({
        model: 'qwen2.5-coder:32b',
        messages: [{ role: 'user', content: 'Diagnose the task' }],
        max_tokens: 4096,
        temperature: 0.3,
      });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
      expect(result).toMatchObject({
        output: 'strategy ready',
        status: 'completed',
        usage: {
          tokens: 18,
          input_tokens: 11,
          output_tokens: 7,
          cost: 0,
          model: 'qwen2.5-coder:32b',
        },
      });
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('injects files and working directory into the strategic prompt body', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'analysis complete' } }],
        usage: {
          total_tokens: 4,
          prompt_tokens: 3,
          completion_tokens: 1,
        },
      }));

      await provider.submit('Review the architecture', null, {
        files: ['server/index.js', 'server/providers/ollama-strategic.js'],
        working_directory: '/repo',
      });

      expect(requestBody(fetchMock).messages).toEqual([{
        role: 'user',
        content: 'Files: server/index.js, server/providers/ollama-strategic.js\n\nWorking directory: /repo\n\nReview the architecture',
      }]);
    });

    it('uses the explicit model, custom max tokens, custom temperature, and custom host', async () => {
      const customProvider = new OllamaStrategicProvider({
        host: 'http://10.0.0.5:11434/',
        defaultModel: 'deepseek-r1:32b',
      });
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'done' } }],
        usage: {
          total_tokens: 9,
          prompt_tokens: 4,
          completion_tokens: 5,
        },
      }));

      const result = await customProvider.submit('Route the task', 'custom-model', {
        maxTokens: 2048,
        tuning: { temperature: 0.55 },
      });

      expect(fetchMock.mock.calls[0][0]).toBe('http://10.0.0.5:11434/v1/chat/completions');
      expect(requestBody(fetchMock)).toEqual({
        model: 'custom-model',
        messages: [{ role: 'user', content: 'Route the task' }],
        max_tokens: 2048,
        temperature: 0.55,
      });
      expect(result.usage.model).toBe('custom-model');
    });

    it('preserves an explicit zero tuning temperature', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'cold plan' } }],
        usage: {
          total_tokens: 2,
          prompt_tokens: 1,
          completion_tokens: 1,
        },
      }));

      await provider.submit('Task', null, {
        tuning: { temperature: 0 },
      });

      expect(requestBody(fetchMock).temperature).toBe(0);
    });

    it('returns empty output and zeroed usage when choices or usage are missing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      const result = await provider.submit('Task');

      expect(result).toEqual(expect.objectContaining({
        output: '',
        status: 'completed',
        usage: expect.objectContaining({
          tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost: 0,
          model: 'qwen2.5-coder:32b',
        }),
      }));
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('surfaces API error messages with the response status and body', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'server exploded'));

      await expect(provider.submit('Task')).rejects.toThrow(
        'Ollama API error (500): server exploded'
      );
    });

    it('propagates non-abort network errors', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 192.168.1.100:11434'));

      await expect(provider.submit('Task')).rejects.toThrow(/ECONNREFUSED/);
    });

    it('uses the configured timeout minutes when scheduling cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: {
          total_tokens: 1,
          prompt_tokens: 1,
          completion_tokens: 0,
        },
      }));

      await provider.submit('Task', null, { timeout: 2 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
    });

    it('returns timeout metadata when fetch rejects with AbortError', async () => {
      fetchMock.mockRejectedValue(makeAbortError());

      const result = await provider.submit('Task');

      expect(result).toMatchObject({
        output: '',
        status: 'timeout',
        usage: {
          tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost: 0,
        },
      });
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns timeout when an external abort signal fires', async () => {
      const externalController = new AbortController();
      const requestStarted = createDeferred();

      fetchMock.mockImplementation((_url, options) => {
        requestStarted.resolve();
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        });
      });

      const pending = provider.submit('Task', null, { signal: externalController.signal });
      await requestStarted.promise;
      externalController.abort();

      await expect(pending).resolves.toMatchObject({
        output: '',
        status: 'timeout',
      });
    });

    it('adds and removes the external abort listener after a successful submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: {
          total_tokens: 1,
          prompt_tokens: 1,
          completion_tokens: 0,
        },
      }));

      await provider.submit('Task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('tracks concurrent strategic submits and restores capacity when they settle', async () => {
      const concurrentProvider = new OllamaStrategicProvider({ maxConcurrent: 2 });
      const firstFetch = createDeferred();
      const secondFetch = createDeferred();

      fetchMock
        .mockImplementationOnce(() => firstFetch.promise)
        .mockImplementationOnce(() => secondFetch.promise);

      const firstPromise = concurrentProvider.submit('first task');
      expect(concurrentProvider.activeTasks).toBe(1);
      expect(concurrentProvider.hasCapacity()).toBe(true);

      const secondPromise = concurrentProvider.submit('second task');
      expect(concurrentProvider.activeTasks).toBe(2);
      expect(concurrentProvider.hasCapacity()).toBe(false);

      firstFetch.resolve(jsonResponse({
        choices: [{ message: { content: 'first done' } }],
        usage: {
          total_tokens: 3,
          prompt_tokens: 2,
          completion_tokens: 1,
        },
      }));
      secondFetch.resolve(jsonResponse({
        choices: [{ message: { content: 'second done' } }],
        usage: {
          total_tokens: 5,
          prompt_tokens: 2,
          completion_tokens: 3,
        },
      }));

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

      expect(firstResult.output).toBe('first done');
      expect(secondResult.output).toBe('second done');
      expect(concurrentProvider.activeTasks).toBe(0);
      expect(concurrentProvider.hasCapacity()).toBe(true);
    });

    it('decrements activeTasks after request errors', async () => {
      fetchMock.mockResolvedValue(textResponse(429, 'slow down'));

      await expect(provider.submit('Task')).rejects.toThrow(
        'Ollama API error (429): slow down'
      );
      expect(provider.activeTasks).toBe(0);
    });
  });
});
