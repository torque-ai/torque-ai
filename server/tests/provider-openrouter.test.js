import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loggerInfo, loggerDebug } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('../logger', () => ({
  child: vi.fn(() => ({
    info: loggerInfo,
    debug: loggerDebug,
  })),
}));

const OpenRouterProvider = require('../providers/openrouter.js');
const {
  FALLBACK_MODELS,
  DEFAULT_COOLDOWN_SECONDS,
} = require('../providers/openrouter.js');
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

describe('OpenRouterProvider', () => {
  let provider;
  let fetchMock;
  let originalApiKey;
  let originalFetch;

  beforeEach(() => {
    originalApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    loggerInfo.mockReset();
    loggerDebug.mockReset();

    provider = new OpenRouterProvider({ apiKey: 'openrouter-key' });
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }

    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('sets default provider metadata, limits, and cooldown state', () => {
      expect(provider.name).toBe('openrouter');
      expect(provider.apiKey).toBe('openrouter-key');
      expect(provider.baseUrl).toBe('https://openrouter.ai/api');
      expect(provider.defaultModel).toBeNull();
      expect(provider.fallbackModels).toEqual([]);
      expect(provider.maxConcurrent).toBe(3);
      expect(provider.activeTasks).toBe(0);
      expect(provider.hasCapacity()).toBe(true);
      expect(provider._modelCooldowns).toBeInstanceOf(Map);
      expect(provider._modelCooldowns.size).toBe(0);
    });

    it('loads the API key from OPENROUTER_API_KEY when config omits it', () => {
      process.env.OPENROUTER_API_KEY = 'env-openrouter-key';

      const envProvider = new OpenRouterProvider();

      expect(envProvider.apiKey).toBe('env-openrouter-key');
    });

    it('accepts custom apiKey, baseUrl, defaultModel, and maxConcurrent values', () => {
      const customProvider = new OpenRouterProvider({
        apiKey: 'custom-key',
        baseUrl: 'http://localhost:4100/openrouter',
        defaultModel: 'google/gemma-3-12b-it:free',
        fallbackModels: ['minimax/minimax-m2.5:free'],
        maxConcurrent: 7,
      });

      expect(customProvider.apiKey).toBe('custom-key');
      expect(customProvider.baseUrl).toBe('http://localhost:4100/openrouter');
      expect(customProvider.defaultModel).toBe('google/gemma-3-12b-it:free');
      expect(customProvider.fallbackModels).toEqual(['minimax/minimax-m2.5:free']);
      expect(customProvider.maxConcurrent).toBe(7);
    });
  });

  describe('supportsStreaming', () => {
    it('returns true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });
  });

  describe('listModels', () => {
    it('lists free model names from OpenRouter metadata', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        data: [
          {
            id: 'minimax/minimax-m2.5:free',
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['tools', 'response_format'],
          },
          {
            id: 'paid/model',
            pricing: { prompt: '0.1', completion: '0.2' },
            supported_parameters: ['tools'],
          },
          {
            id: 'free/no-tools:free',
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['response_format'],
          },
        ],
      }));

      await expect(provider.listModels()).resolves.toEqual([
        'minimax/minimax-m2.5:free',
        'free/no-tools:free',
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer openrouter-key' },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('can opt into the OpenRouter tools metadata filter', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        data: [
          {
            id: 'minimax/minimax-m2.5:free',
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['tools'],
          },
          {
            id: 'free/no-tools:free',
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['response_format'],
          },
        ],
      }));

      await expect(provider.listModels({ toolsOnly: true })).resolves.toEqual(['minimax/minimax-m2.5:free']);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models?supported_parameters=tools',
        expect.objectContaining({
          headers: { Authorization: 'Bearer openrouter-key' },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('can list public model metadata when the API key is missing', async () => {
      const noKeyProvider = new OpenRouterProvider({ apiKey: '' });
      fetchMock.mockResolvedValue(jsonResponse({
        data: [
          {
            id: 'minimax/minimax-m2.5:free',
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['tools'],
          },
        ],
      }));

      await expect(noKeyProvider.listModels()).resolves.toEqual(['minimax/minimax-m2.5:free']);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: {},
          signal: expect.any(AbortSignal),
        })
      );
    });
  });

  describe('discoverModels', () => {
    it('discovers free tool-capable model metadata', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        data: [
          {
            id: 'google/gemma-3-12b-it:free',
            name: 'Gemma 3 12B',
            owned_by: 'google',
            context_length: 32768,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['tools'],
          },
          {
            id: 'meta/llama-paid',
            pricing: { prompt: '0.01', completion: '0.01' },
            supported_parameters: ['tools'],
          },
        ],
      }));

      const result = await provider.discoverModels();

      expect(result.provider).toBe('openrouter');
      expect(result.models).toEqual([
        {
          model_name: 'google/gemma-3-12b-it:free',
          id: 'google/gemma-3-12b-it:free',
          name: 'Gemma 3 12B',
          owned_by: 'google',
          context_window: 32768,
          created: null,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools'],
          free: true,
          supports_tools: true,
        },
      ]);
    });
  });

  describe('helpers', () => {
    describe('_buildPrompt', () => {
      it('returns the task as-is when no options are provided', () => {
        expect(provider._buildPrompt('inspect repo', {})).toBe('inspect repo');
      });

      it('prepends the working directory when present', () => {
        expect(provider._buildPrompt('inspect repo', { working_directory: '/repo' })).toBe(
          'Working directory: /repo\n\ninspect repo'
        );
      });

      it('prepends files before the working directory in provider order', () => {
        expect(provider._buildPrompt('inspect repo', {
          files: ['src/index.js', 'src/lib.js'],
          working_directory: '/repo',
        })).toBe('Files: src/index.js, src/lib.js\n\nWorking directory: /repo\n\ninspect repo');
      });

      it('ignores an empty files array', () => {
        expect(provider._buildPrompt('inspect repo', { files: [] })).toBe('inspect repo');
      });
    });

    describe('_estimateCost', () => {
      it('returns zero when usage is missing', () => {
        expect(provider._estimateCost(null, 'openai/gpt-4o')).toBe(0);
      });

      it('returns zero for quota models', () => {
        expect(provider._estimateCost({ total_tokens: 1_000_000 }, 'qwen/qwen3-coder:free')).toBe(0);
      });

      it('uses the flat OpenRouter estimate for paid models', () => {
        expect(provider._estimateCost({ total_tokens: 1_000_000 }, 'openai/gpt-4o')).toBeCloseTo(0.5);
        expect(provider._estimateCost({ total_tokens: 250_000 }, 'anthropic/claude-sonnet')).toBeCloseTo(0.125);
      });
    });

    describe('fallback helpers', () => {
      it('exports the fallback model list and default cooldown constant', () => {
        expect(Array.isArray(FALLBACK_MODELS)).toBe(true);
        expect(FALLBACK_MODELS.length).toBe(0);
        expect(DEFAULT_COOLDOWN_SECONDS).toBe(60);
      });

      it('_cooldownModel uses the provided cooldown seconds', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-12T00:00:00Z'));

        provider._cooldownModel('model-a', 12);

        expect(provider._modelCooldowns.get('model-a')).toBe(Date.now() + 12_000);
      });

      it('_cooldownModel defaults to DEFAULT_COOLDOWN_SECONDS when seconds are missing', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-12T00:00:00Z'));

        provider._cooldownModel('model-b');

        expect(provider._modelCooldowns.get('model-b')).toBe(
          Date.now() + DEFAULT_COOLDOWN_SECONDS * 1000
        );
      });

      it('_isModelCooledDown returns true for active cooldowns', () => {
        provider._modelCooldowns.set('model-c', Date.now() + 30_000);

        expect(provider._isModelCooledDown('model-c')).toBe(true);
      });

      it('_isModelCooledDown clears expired cooldowns', () => {
        provider._modelCooldowns.set('model-d', Date.now() - 1);

        expect(provider._isModelCooledDown('model-d')).toBe(false);
        expect(provider._modelCooldowns.has('model-d')).toBe(false);
      });

      it('_getFallbackCandidates keeps the requested model first without duplication', () => {
        const candidates = provider._getFallbackCandidates('some-model:free', {
          fallbackModels: ['some-model:free', 'backup-model:free'],
        });

        expect(candidates[0]).toBe('some-model:free');
        expect(candidates.filter((model) => model === 'some-model:free')).toHaveLength(1);
        expect(candidates).toEqual(['some-model:free', 'backup-model:free']);
      });

      it('_getFallbackCandidates still returns the requested model even when cooled down and skips cooled fallbacks', () => {
        provider._cooldownModel('custom/requested-model', 30);
        provider._cooldownModel('custom/fallback-model', 30);

        const candidates = provider._getFallbackCandidates('custom/requested-model', {
          fallbackModels: ['custom/fallback-model', 'custom/healthy-model'],
        });

        expect(candidates[0]).toBe('custom/requested-model');
        expect(candidates).toEqual(['custom/requested-model', 'custom/healthy-model']);
      });

      it.each([
        ['OpenRouter API error (429): rate-limited', true],
        ['rate_limit exceeded', true],
        ['provider was rate-limited upstream', true],
        ['OpenRouter API error (500): boom', false],
      ])('_is429 detects rate-limit shaped errors for "%s"', (message, expected) => {
        expect(provider._is429({ message })).toBe(expected);
      });

      it('parses retry_after_seconds metadata from error messages', () => {
        expect(provider._parseRetryAfter('OpenRouter error retry_after_seconds=45')).toBe(45);
        expect(provider._parseRetryAfter('OpenRouter error without retry info')).toBeNull();
      });
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key is configured', async () => {
      const noKeyProvider = new OpenRouterProvider({ apiKey: '' });

      await expect(noKeyProvider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'No API key configured',
      });
    });

    it('probes all pages, filters falsy ids, and returns available models', async () => {
      const models = Array.from({ length: 55 }, (_, index) => ({ id: `model-${index}` }));
      models.splice(10, 0, { id: '' }, { id: null });
      fetchMock.mockResolvedValue(jsonResponse({ data: models }));

      const result = await provider.checkHealth();

      expect(result).toEqual({
        available: true,
        models: Array.from({ length: 55 }, (_, index) => ({
          model_name: `model-${index}`,
          id: `model-${index}`,
          name: null,
          owned_by: null,
          context_window: null,
          created: null,
          pricing: null,
          supported_parameters: [],
          free: false,
          supports_tools: false,
        })),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer openrouter-key' },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('fetches additional pages from OpenRouter models pagination', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({
          data: [
            { id: 'google/gemma-3-12b-it:free', pricing: { prompt: '0', completion: '0' } },
            { id: 'meta/llama-paid', pricing: { prompt: '0.1', completion: '0.2' } },
          ],
          next: 'https://openrouter.ai/api/v1/models?page=2',
        }))
        .mockResolvedValueOnce(jsonResponse({
          data: [
            { id: 'qwen/qwen2.5-coder:free', pricing: { prompt: '0', completion: '0' } },
            { id: 'google/gemma-3-12b-it:free', pricing: { prompt: '0', completion: '0' } },
          ],
        }));

      const result = await provider.checkHealth();

      expect(result.available).toBe(true);
      expect(result.models).toHaveLength(3);
      expect(result.models).toMatchObject([
        { model_name: 'google/gemma-3-12b-it:free', free: true },
        { model_name: 'meta/llama-paid', free: false },
        { model_name: 'qwen/qwen2.5-coder:free', free: true },
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://openrouter.ai/api/v1/models', expect.any(Object));
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://openrouter.ai/api/v1/models?page=2',
        expect.any(Object)
      );
    });

    it('parses retry-after metadata from headers or numeric fields on error objects', () => {
      const errorWithHeader = new Error('OpenRouter API error (429): limited');
      errorWithHeader.headers = {
        get: (name) => (name === 'Retry-After' ? '18' : null),
      };
      const errorWithCamelCaseHeader = {
        message: 'OpenRouter API error (429): limited',
        headers: {
          get: (name) => (name.toLowerCase() === 'retry-after' ? '21' : null),
        },
      };
      const errorWithField = {
        message: 'OpenRouter API error (429): limited',
        retry_after_seconds: 15,
      };

      expect(provider._parseRetryAfter(errorWithHeader)).toBe(18);
      expect(provider._parseRetryAfter(errorWithCamelCaseHeader)).toBe(21);
      expect(provider._parseRetryAfter(errorWithField)).toBe(15);
      expect(provider._parseRetryAfter('OpenRouter error without retry info')).toBeNull();
    });

    it('returns fallback default model when response shape has no data array', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));

      await expect(provider.checkHealth()).resolves.toEqual({
        available: true,
        models: [{ model_name: null }],
      });
    });

    it('returns unavailable on HTTP errors', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503 });

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'API returned 503',
      });
    });

    it('returns a timeout-shaped error on AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      await expect(provider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'Health check timed out (5s)',
      });
    });

    it('returns unavailable on other network failures', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toContain('ECONNRESET');
    });
  });

  describe('submit', () => {
    it('validates the API key before submitting', async () => {
      const noKeyProvider = new OpenRouterProvider({ apiKey: '' });

      await expect(noKeyProvider.submit('task', null, {})).rejects.toThrow(/API key/i);
    });

    it('formats an OpenAI-compatible request payload and headers', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }));

      await provider.submit('Analyze module', null, {
        files: ['src/index.js'],
        working_directory: '/repo',
        maxTokens: 222,
        tuning: { temperature: 0.15 },
      });

      const [url, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer openrouter-key',
          'HTTP-Referer': 'https://github.com/torque-orchestrator',
          'X-Title': 'TORQUE',
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

      await provider.submit('task', null, {});

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBeNull();
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBeUndefined();
    });

    it('uses an explicit model in both the request body and usage metadata', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'explicit response' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }));

      const result = await provider.submit('task', 'google/gemma-3-12b-it:free', {});
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);

      expect(body.model).toBe('google/gemma-3-12b-it:free');
      expect(result.output).toBe('explicit response');
      expect(result.usage.model).toBe('google/gemma-3-12b-it:free');
      expect(result.usage.duration_ms).toEqual(expect.any(Number));
    });

    it('uses reasoning output when content is absent', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: '', reasoning: 'step by step reasoning' } }],
        usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
      }));

      const result = await provider.submit('task', null, {});

      expect(result.output).toBe('step by step reasoning');
    });

    it('prefers content over reasoning when both are present', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'final answer', reasoning: 'internal notes' } }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }));

      const result = await provider.submit('task', null, {});

      expect(result.output).toBe('final answer');
    });

    it('parses submit output and zeroes usage defaults when fields are missing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ choices: [] }));

      const result = await provider.submit('task', null, {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.model).toBeNull();
    });

    it('throws immediately on non-429 API errors without trying fallbacks', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'internal error'));

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'OpenRouter API error (500): internal error'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws on 429 when no fallback models are available', async () => {
      fetchMock.mockResolvedValue(textResponse(429, 'rate limited', {
        get: (name) => (
          name === 'Retry-After' || name === 'retry-after'
            ? '12'
            : null
        ),
      }));

      // With empty FALLBACK_MODELS and null default, only one candidate (null) is tried
      await expect(provider.submit('task', null, {})).rejects.toThrow(/429/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('applies cooldown on 429 even when no fallback is available', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T00:00:00Z'));

      // Use a configured model so we can verify cooldown tracking
      const configuredProvider = new OpenRouterProvider({
        apiKey: 'openrouter-key',
        defaultModel: 'test/model:free',
      });

      fetchMock.mockResolvedValue(textResponse(429, 'rate limited', {
        get: (name) => (
          name === 'Retry-After' || name === 'retry-after'
            ? '12'
            : null
        ),
      }));

      await expect(configuredProvider.submit('task', null, {})).rejects.toThrow(/429/);
      expect(configuredProvider._modelCooldowns.get('test/model:free')).toBe(Date.now() + 12_000);
    });

    it('tries configured fallback models after a 429 and returns the successful fallback', async () => {
      const fallbackProvider = new OpenRouterProvider({
        apiKey: 'openrouter-key',
        defaultModel: 'primary/model:free',
        fallbackModels: ['fallback/model:free'],
      });
      fetchMock
        .mockResolvedValueOnce(textResponse(429, 'rate limited', {
          get: (name) => (
            name === 'Retry-After' || name === 'retry-after'
              ? '10'
              : null
          ),
        }))
        .mockResolvedValueOnce(jsonResponse({
          choices: [{ message: { content: 'fallback response' } }],
          usage: { total_tokens: 3 },
        }));

      const result = await fallbackProvider.submit('task', null, {});
      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);

      expect(firstBody.model).toBe('primary/model:free');
      expect(secondBody.model).toBe('fallback/model:free');
      expect(result.output).toBe('fallback response');
      expect(result.usage.model).toBe('fallback/model:free');
    });

    it('returns timeout status when fetch rejects with AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submit('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('returns cancelled when an external abort signal is triggered', async () => {
      const abortController = new AbortController();
      const requestStarted = createDeferred();

      fetchMock.mockImplementation((_url, { signal }) => {
        requestStarted.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      });

      const resultPromise = provider.submit('task', null, { signal: abortController.signal });
      await requestStarted.promise;
      abortController.abort();

      const result = await resultPromise;

      expect(result.status).toBe('cancelled');
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
        usage: { total_tokens: 2 },
      }));

      await provider.submit('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('tracks concurrent in-flight submits and restores capacity after they settle', async () => {
      const concurrentProvider = new OpenRouterProvider({
        apiKey: 'openrouter-key',
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
        choices: [{ message: { content: 'first done' } }],
        usage: { total_tokens: 2 },
      }));
      secondFetch.resolve(jsonResponse({
        choices: [{ message: { content: 'second done' } }],
        usage: { total_tokens: 4 },
      }));

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

      expect(firstResult.output).toBe('first done');
      expect(secondResult.output).toBe('second done');
      expect(concurrentProvider.activeTasks).toBe(0);
      expect(concurrentProvider.hasCapacity()).toBe(true);
    });

    it('decrements activeTasks after request errors', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'boom'));

      await expect(provider.submit('task', null, {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('submitStream', () => {
    it('validates the API key before streaming', async () => {
      const noKeyProvider = new OpenRouterProvider({ apiKey: '' });

      await expect(noKeyProvider.submitStream('task', null, {})).rejects.toThrow(/API key/i);
    });

    it('formats a streaming request and parses streamed content tokens and usage', async () => {
      const { body, reader } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (chunk) => chunks.push(chunk),
      });

      const [url, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);

      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer openrouter-key',
          'HTTP-Referer': 'https://github.com/torque-orchestrator',
          'X-Title': 'TORQUE',
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
      expect(result.usage.model).toBeNull();
      expect(chunks).toEqual(['Hello', ' world', '!']);
      expect(reader.cancel).toHaveBeenCalledTimes(1);
    });

    it('includes prompt formatting, explicit model, max tokens, and temperature in stream bodies', async () => {
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('stream task', 'google/gemma-3-12b-it:free', {
        files: ['src/a.js'],
        working_directory: '/repo',
        maxTokens: 77,
        tuning: { temperature: 0.6 },
      });

      const bodyJson = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(bodyJson).toEqual({
        model: 'google/gemma-3-12b-it:free',
        messages: [{
          role: 'user',
          content: 'Files: src/a.js\n\nWorking directory: /repo\n\nstream task',
        }],
        max_tokens: 77,
        stream: true,
        temperature: 0.6,
      });
    });

    it('parses reasoning deltas when content is empty', async () => {
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"","reasoning":"Think"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":" carefully"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.output).toBe('Think carefully');
    });

    it('prefers content over reasoning in streamed deltas', async () => {
      const { body } = makeSSEBody([
        'data: {"choices":[{"delta":{"content":"Real answer","reasoning":"Internal notes"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.output).toBe('Real answer');
    });

    it('continues parsing across split chunks, ignores malformed payloads, and skips non-data lines', async () => {
      const { body } = makeSSEBody([
        'event: ping\n\n',
        'data: {"choices":[{"delta":{"content":"He',
        'llo"}}]}\n\ndata: [bad-json]\n\n',
        ': keepalive\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ]);
      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

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

      const result = await provider.submitStream('task', null, {});

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
      const result = await provider.submitStream('task', null, {
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(chunks).toEqual([largeChunk]);
      expect(result.output).toContain('[...OUTPUT TRUNCATED...]');
      expect(result.output.endsWith('[...OUTPUT TRUNCATED...]')).toBe(true);
      expect(result.output.includes('B')).toBe(false);
    });

    it('throws immediately on non-429 streaming API errors without trying fallbacks', async () => {
      fetchMock.mockResolvedValue(textResponse(500, 'stream boom'));

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        'OpenRouter streaming error (500): stream boom'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws on streaming 429 when no fallback models are available', async () => {
      fetchMock.mockResolvedValue(textResponse(429, 'slow down', {
        get: (name) => (
          name === 'Retry-After' || name === 'retry-after'
            ? '8'
            : null
        ),
      }));

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(/429/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns timeout when fetch aborts before the stream starts', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('returns cancelled when an external signal aborts mid-stream and cancels the reader', async () => {
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

      const resultPromise = provider.submitStream('task', null, { signal: abortController.signal });
      await secondReadStarted.promise;
      abortController.abort();

      const result = await resultPromise;

      expect(result.status).toBe('cancelled');
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

      await provider.submitStream('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
    });

    it('swallows stream reader cleanup errors and logs a debug breadcrumb', async () => {
      const cancel = vi.fn().mockRejectedValue(new Error('already closed'));
      const { body } = makeSSEBody(
        [
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ],
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
