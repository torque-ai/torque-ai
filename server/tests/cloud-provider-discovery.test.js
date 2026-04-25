/**
 * Cloud Provider Discovery Tests
 *
 * Tests that each cloud provider's checkHealth() returns rich model objects
 * (with model_name field) instead of plain string IDs.
 *
 * Phase 2, Task 2: Upgrade Cloud Provider checkHealth() to Return Rich Metadata
 */

const GroqProvider = require('../providers/groq');
const DeepInfraProvider = require('../providers/deepinfra');
const CerebrasProvider = require('../providers/cerebras');
const HyperbolicProvider = require('../providers/hyperbolic');
const OpenRouterProvider = require('../providers/openrouter');
const OllamaCloudProvider = require('../providers/ollama-cloud');
const GoogleAIProvider = require('../providers/google-ai');
const AnthropicProvider = require('../providers/anthropic');

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helper: mock a successful /v1/models response ─────────────────────────────

function mockV1ModelsResponse(models) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: models }),
  }));
}

function mockFailedResponse(status = 401) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
  }));
}

// ── Groq ─────────────────────────────────────────────────────────────────────

describe('GroqProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new GroqProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
    expect(health.error).toMatch(/api key/i);
  });

  it('returns rich model objects from /v1/models response', async () => {
    mockV1ModelsResponse([
      { id: 'llama-3.3-70b-versatile', owned_by: 'Meta' },
      { id: 'llama-3.1-8b-instant', owned_by: 'Meta' },
    ]);
    const p = new GroqProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models).toHaveLength(2);
    expect(health.models[0]).toMatchObject({ model_name: 'llama-3.3-70b-versatile' });
    expect(health.models[1]).toMatchObject({ model_name: 'llama-3.1-8b-instant' });
  });

  it('each model object has model_name field', async () => {
    mockV1ModelsResponse([{ id: 'mixtral-8x7b-32768', owned_by: 'Mistral' }]);
    const p = new GroqProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(typeof health.models[0]).toBe('object');
    expect(health.models[0].model_name).toBe('mixtral-8x7b-32768');
  });

  it('preserves owned_by when present in API response', async () => {
    mockV1ModelsResponse([{ id: 'llama-3.3-70b-versatile', owned_by: 'Meta' }]);
    const p = new GroqProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models[0].owned_by).toBe('Meta');
  });

  it('falls back to defaultModel object when API returns non-array data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    const p = new GroqProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models).toHaveLength(1);
    expect(health.models[0]).toMatchObject({ model_name: p.defaultModel });
  });

  it('returns { available: false } on API error', async () => {
    mockFailedResponse(403);
    const p = new GroqProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toContain('403');
  });
});

// ── DeepInfra ─────────────────────────────────────────────────────────────────

describe('DeepInfraProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new DeepInfraProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
  });

  it('returns rich model objects from /v1/openai/models response', async () => {
    mockV1ModelsResponse([
      { id: 'Qwen/Qwen2.5-72B-Instruct', owned_by: 'Qwen' },
      { id: 'meta-llama/Llama-3.1-70B-Instruct', owned_by: 'meta-llama' },
    ]);
    const p = new DeepInfraProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models[0]).toMatchObject({ model_name: 'Qwen/Qwen2.5-72B-Instruct' });
    expect(health.models[1]).toMatchObject({ model_name: 'meta-llama/Llama-3.1-70B-Instruct' });
  });

  it('each model object has model_name field', async () => {
    mockV1ModelsResponse([{ id: 'deepseek-ai/DeepSeek-R1' }]);
    const p = new DeepInfraProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(typeof health.models[0]).toBe('object');
    expect(health.models[0].model_name).toBe('deepseek-ai/DeepSeek-R1');
  });

  it('falls back to defaultModel object when data is not array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'not-an-array' }),
    }));
    const p = new DeepInfraProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models[0]).toMatchObject({ model_name: p.defaultModel });
  });
});

// ── Cerebras ──────────────────────────────────────────────────────────────────

describe('CerebrasProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new CerebrasProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
  });

  it('returns rich model objects from /v1/models response', async () => {
    mockV1ModelsResponse([
      { id: 'llama3.1-8b', owned_by: 'Meta' },
      { id: 'qwen-3-235b-a22b-instruct-2507', owned_by: 'Qwen' },
    ]);
    const p = new CerebrasProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models[0]).toMatchObject({ model_name: 'llama3.1-8b' });
    expect(health.models[1]).toMatchObject({ model_name: 'qwen-3-235b-a22b-instruct-2507' });
  });

  it('each model object has model_name field', async () => {
    mockV1ModelsResponse([{ id: 'gpt-oss-120b' }]);
    const p = new CerebrasProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(typeof health.models[0]).toBe('object');
    expect(health.models[0].model_name).toBe('gpt-oss-120b');
  });
});

// ── Hyperbolic ────────────────────────────────────────────────────────────────

describe('HyperbolicProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new HyperbolicProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
  });

  it('returns rich model objects from /v1/models response', async () => {
    mockV1ModelsResponse([
      { id: 'Qwen/Qwen2.5-72B-Instruct', owned_by: 'Qwen' },
      { id: 'meta-llama/Llama-3.1-405B-Instruct', owned_by: 'meta-llama' },
    ]);
    const p = new HyperbolicProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models[0]).toMatchObject({ model_name: 'Qwen/Qwen2.5-72B-Instruct' });
    expect(health.models[1]).toMatchObject({ model_name: 'meta-llama/Llama-3.1-405B-Instruct' });
  });

  it('each model object has model_name field', async () => {
    mockV1ModelsResponse([{ id: 'deepseek-ai/DeepSeek-R1' }]);
    const p = new HyperbolicProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(typeof health.models[0]).toBe('object');
    expect(health.models[0].model_name).toBe('deepseek-ai/DeepSeek-R1');
  });
});

// ── OpenRouter ────────────────────────────────────────────────────────────────

describe('OpenRouterProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new OpenRouterProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
  });

  it('returns rich model objects with context_window from /v1/models response', async () => {
    mockV1ModelsResponse([
      { id: 'qwen/qwen3-coder:free', owned_by: 'Qwen', context_length: 262144 },
      { id: 'google/gemma-3-27b-it:free', owned_by: 'Google', context_length: 32768 },
    ]);
    const p = new OpenRouterProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models[0]).toMatchObject({
      model_name: 'qwen/qwen3-coder:free',
      context_window: 262144,
    });
    expect(health.models[1]).toMatchObject({
      model_name: 'google/gemma-3-27b-it:free',
      context_window: 32768,
    });
  });

  it('each model object has model_name field', async () => {
    mockV1ModelsResponse([{ id: 'arcee-ai/trinity-large-preview:free', context_length: 131072 }]);
    const p = new OpenRouterProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(typeof health.models[0]).toBe('object');
    expect(health.models[0].model_name).toBe('arcee-ai/trinity-large-preview:free');
  });

  it('returns all paged models and preserves context_length', async () => {
    const manyModels = Array.from({ length: 60 }, (_, i) => ({
      id: `model-${i}`,
      context_length: 8192,
    }));
    mockV1ModelsResponse(manyModels);
    const p = new OpenRouterProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models).toHaveLength(60);
    expect(health.models[0].context_window).toBe(8192);
  });

  it('falls back to defaultModel object when data is not array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    const p = new OpenRouterProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models[0]).toMatchObject({ model_name: p.defaultModel });
  });
});

// ── Ollama Cloud ──────────────────────────────────────────────────────────────

describe('OllamaCloudProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new OllamaCloudProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
  });

  it('maps /api/tags response: model_name from name field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          { name: 'qwen3-coder:480b', size: 270000000000, details: { parameter_size: '480B' } },
          { name: 'deepseek-v3.1:671b', size: 380000000000, details: { parameter_size: '671B' } },
        ],
      }),
    }));
    const p = new OllamaCloudProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models).toHaveLength(2);
    expect(health.models[0]).toMatchObject({ model_name: 'qwen3-coder:480b' });
    expect(health.models[1]).toMatchObject({ model_name: 'deepseek-v3.1:671b' });
  });

  it('includes parameter_size from details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          { name: 'qwen3-coder:480b', size: 270000000000, details: { parameter_size: '480B' } },
        ],
      }),
    }));
    const p = new OllamaCloudProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models[0].parameter_size).toBe('480B');
    expect(health.models[0].sizeBytes).toBe(270000000000);
  });

  it('falls back to defaultModel object when models array is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    const p = new OllamaCloudProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models).toHaveLength(1);
    expect(health.models[0]).toMatchObject({ model_name: p.defaultModel });
  });

  it('handles models without details gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [{ name: 'some-model:latest' }],
      }),
    }));
    const p = new OllamaCloudProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models[0].model_name).toBe('some-model:latest');
    expect(health.models[0].parameter_size).toBeUndefined();
  });
});

// ── Google AI ─────────────────────────────────────────────────────────────────

describe('GoogleAIProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new GoogleAIProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
  });

  it('maps /v1beta/models response: model_name from name field (stripped prefix)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-1.0-pro', supportedGenerationMethods: ['countTokens'] },
        ],
      }),
    }));
    const p = new GoogleAIProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    // Only models supporting generateContent are included
    expect(health.models).toHaveLength(2);
    expect(health.models[0]).toMatchObject({ model_name: 'gemini-2.5-flash' });
    expect(health.models[1]).toMatchObject({ model_name: 'gemini-2.5-pro' });
  });

  it('each model object has model_name field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    }));
    const p = new GoogleAIProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(typeof health.models[0]).toBe('object');
    expect(health.models[0].model_name).toBe('gemini-2.0-flash');
  });

  it('falls back to defaultModel object when models array is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    const p = new GoogleAIProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models[0]).toMatchObject({ model_name: p.defaultModel });
  });
});

// ── Anthropic ─────────────────────────────────────────────────────────────────

describe('AnthropicProvider.checkHealth()', () => {
  it('returns { available: false, models: [] } when no API key', async () => {
    const p = new AnthropicProvider({ apiKey: '' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.models).toEqual([]);
  });

  it('returns rich model objects from /v1/models response', async () => {
    mockV1ModelsResponse([
      { id: 'claude-sonnet-4-20250514' },
      { id: 'claude-haiku-4-20250514' },
    ]);
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.available).toBe(true);
    expect(health.models[0]).toMatchObject({ model_name: 'claude-sonnet-4-20250514' });
    expect(health.models[1]).toMatchObject({ model_name: 'claude-haiku-4-20250514' });
  });

  it('each model object has model_name field', async () => {
    mockV1ModelsResponse([{ id: 'claude-opus-4-20250514' }]);
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(typeof health.models[0]).toBe('object');
    expect(health.models[0].model_name).toBe('claude-opus-4-20250514');
  });

  it('falls back to defaultModel object when data is not array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();

    expect(health.models[0]).toMatchObject({ model_name: p.defaultModel });
  });

  it('returns { available: false } on API error', async () => {
    mockFailedResponse(401);
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    const health = await p.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toContain('401');
  });
});
