/**
 * Cloud Provider Tests
 *
 * Unit tests for base.js, deepinfra.js, hyperbolic.js, anthropic.js, groq.js.
 * Tests constructor, health checks, model listing, prompt building, cost estimation,
 * capacity tracking, and request/response handling with mocked fetch.
 */

const BaseProvider = require('../providers/base');
const DeepInfraProvider = require('../providers/deepinfra');
const HyperbolicProvider = require('../providers/hyperbolic');
const AnthropicProvider = require('../providers/anthropic');
const GroqProvider = require('../providers/groq');

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Base Provider ──────────────────────────────────────────

describe('BaseProvider', () => {
  it('initializes with defaults', () => {
    const p = new BaseProvider();
    expect(p.name).toBe('unknown');
    expect(p.enabled).toBe(true);
    expect(p.maxConcurrent).toBe(3);
    expect(p.activeTasks).toBe(0);
  });

  it('accepts config overrides', () => {
    const p = new BaseProvider({ name: 'test', enabled: false, maxConcurrent: 5 });
    expect(p.name).toBe('test');
    expect(p.enabled).toBe(false);
    expect(p.maxConcurrent).toBe(5);
  });

  it('submit throws not implemented', async () => {
    const p = new BaseProvider();
    await expect(p.submit('task')).rejects.toThrow(/not implemented/i);
  });

  it('checkHealth throws not implemented', async () => {
    const p = new BaseProvider();
    await expect(p.checkHealth()).rejects.toThrow(/not implemented/i);
  });

  it('listModels returns empty array', async () => {
    const p = new BaseProvider();
    expect(await p.listModels()).toEqual([]);
  });

  describe('hasCapacity', () => {
    it('returns true when enabled and under limit', () => {
      const p = new BaseProvider({ maxConcurrent: 3 });
      expect(p.hasCapacity()).toBe(true);
    });

    it('returns false when disabled', () => {
      const p = new BaseProvider({ enabled: false });
      expect(p.hasCapacity()).toBe(false);
    });

    it('returns false when at max concurrent', () => {
      const p = new BaseProvider({ maxConcurrent: 2 });
      p.activeTasks = 2;
      expect(p.hasCapacity()).toBe(false);
    });

    it('returns true when below max', () => {
      const p = new BaseProvider({ maxConcurrent: 3 });
      p.activeTasks = 2;
      expect(p.hasCapacity()).toBe(true);
    });
  });
});

// ── Shared tests for all cloud providers ──────────────────

const providers = [
  {
    name: 'DeepInfra',
    Class: DeepInfraProvider,
    envKey: 'DEEPINFRA_API_KEY',
    expectedName: 'deepinfra',
    expectedDefaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    expectedBaseUrl: 'https://api.deepinfra.com/v1/openai',
    apiFormat: 'openai',
  },
  {
    name: 'Hyperbolic',
    Class: HyperbolicProvider,
    envKey: 'HYPERBOLIC_API_KEY',
    expectedName: 'hyperbolic',
    expectedDefaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    expectedBaseUrl: 'https://api.hyperbolic.xyz/v1',
    apiFormat: 'openai',
  },
  {
    name: 'Anthropic',
    Class: AnthropicProvider,
    envKey: 'ANTHROPIC_API_KEY',
    expectedName: 'anthropic',
    expectedDefaultModel: 'claude-sonnet-4-20250514',
    expectedBaseUrl: 'https://api.anthropic.com',
    apiFormat: 'anthropic',
  },
  {
    name: 'Groq',
    Class: GroqProvider,
    envKey: 'GROQ_API_KEY',
    expectedName: 'groq',
    expectedDefaultModel: 'llama-3.3-70b-versatile',
    expectedBaseUrl: 'https://api.groq.com/openai',
    apiFormat: 'openai',
  },
];

describe.each(providers)('$name Provider', ({ Class, envKey, expectedName, expectedDefaultModel, expectedBaseUrl, apiFormat }) => {
  describe('constructor', () => {
    it('sets correct defaults', () => {
      const p = new Class();
      expect(p.name).toBe(expectedName);
      expect(p.defaultModel).toBe(expectedDefaultModel);
      expect(p.baseUrl).toBe(expectedBaseUrl);
    });

    it('reads API key from config', () => {
      const p = new Class({ apiKey: 'test-key-123' });
      expect(p.apiKey).toBe('test-key-123');
    });

    it('reads API key from env', () => {
      const orig = process.env[envKey];
      process.env[envKey] = 'env-key-456';
      const p = new Class();
      expect(p.apiKey).toBe('env-key-456');
      if (orig !== undefined) process.env[envKey] = orig;
      else delete process.env[envKey];
    });

    it('accepts custom baseUrl', () => {
      const p = new Class({ baseUrl: 'https://custom.api.com' });
      expect(p.baseUrl).toBe('https://custom.api.com');
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable without API key', async () => {
      const _p = new Class({ apiKey: undefined });
      // Clear env var
      const orig = process.env[envKey];
      delete process.env[envKey];
      const p2 = new Class();
      const health = await p2.checkHealth();
      expect(health.available).toBe(false);
      expect(health.error).toBeDefined();
      if (orig !== undefined) process.env[envKey] = orig;
    });

    it('returns available with API key', async () => {
      // Mock fetch for providers that make real API calls in checkHealth
      vi.spyOn(global, 'fetch').mockImplementation(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: 'test-model' }] }),
      }));
      const p = new Class({ apiKey: 'test-key' });
      const health = await p.checkHealth();
      expect(health.available).toBe(true);
      expect(health.models.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('listModels', () => {
    it('returns non-empty array of strings', async () => {
      const p = new Class();
      const models = await p.listModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThanOrEqual(1);
      models.forEach(m => expect(typeof m).toBe('string'));
    });

    it('includes default model', async () => {
      const p = new Class();
      const models = await p.listModels();
      expect(models).toContain(expectedDefaultModel);
    });
  });

  describe('_buildPrompt', () => {
    it('returns task unchanged with no options', () => {
      const p = new Class({ apiKey: 'key' });
      expect(p._buildPrompt('write tests', {})).toBe('write tests');
    });

    it('prepends working directory', () => {
      const p = new Class({ apiKey: 'key' });
      const result = p._buildPrompt('write tests', { working_directory: '/src' });
      expect(result).toContain('Working directory: /src');
      expect(result).toContain('write tests');
    });

    it('prepends files list', () => {
      const p = new Class({ apiKey: 'key' });
      const result = p._buildPrompt('task', { files: ['a.js', 'b.ts'] });
      expect(result).toContain('Files: a.js, b.ts');
    });

    it('includes both working_directory and files', () => {
      const p = new Class({ apiKey: 'key' });
      const result = p._buildPrompt('task', {
        working_directory: '/app',
        files: ['x.js'],
      });
      expect(result).toContain('Working directory: /app');
      expect(result).toContain('Files: x.js');
      expect(result).toContain('task');
    });
  });

  describe('_estimateCost', () => {
    it('returns 0 for null usage', () => {
      const p = new Class({ apiKey: 'key' });
      expect(p._estimateCost(null)).toBe(0);
      expect(p._estimateCost(undefined)).toBe(0);
    });

    it('calculates cost for usage', () => {
      const p = new Class({ apiKey: 'key' });
      const usage = apiFormat === 'openai'
        ? { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
        : { input_tokens: 1000, output_tokens: 500 };
      const cost = p._estimateCost(usage, expectedDefaultModel);
      expect(cost).toBeGreaterThan(0);
      expect(typeof cost).toBe('number');
    });
  });

  describe('submit', () => {
    it('throws without API key', async () => {
      const orig = process.env[envKey];
      delete process.env[envKey];
      const p = new Class();
      await expect(p.submit('task')).rejects.toThrow(/key/i);
      if (orig !== undefined) process.env[envKey] = orig;
    });

    it('tracks activeTasks on success', async () => {
      const p = new Class({ apiKey: 'key' });

      // Mock successful response
      if (apiFormat === 'openai') {
        vi.spyOn(global, 'fetch').mockImplementation(async () => ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'result' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
        }));
      } else {
        vi.spyOn(global, 'fetch').mockImplementation(async () => ({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: 'result' }],
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
        }));
      }

      expect(p.activeTasks).toBe(0);
      const result = await p.submit('task', null, {});
      expect(p.activeTasks).toBe(0); // decremented after
      expect(result.output).toBe('result');
      expect(result.status).toBe('completed');
      expect(result.usage.tokens).toBeGreaterThan(0);
    });

    it('decrements activeTasks on error', async () => {
      const p = new Class({ apiKey: 'key' });

      vi.spyOn(global, 'fetch').mockImplementation(async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }));

      expect(p.activeTasks).toBe(0);
      await expect(p.submit('task')).rejects.toThrow(/500/);
      expect(p.activeTasks).toBe(0);
    });

    it('sends correct headers', async () => {
      const p = new Class({ apiKey: 'test-key-header' });
      let capturedHeaders;

      if (apiFormat === 'openai') {
        vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
          capturedHeaders = opts.headers;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: '' } }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }),
          };
        });
      } else {
        vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
          capturedHeaders = opts.headers;
          return {
            ok: true,
            json: async () => ({
              content: [{ type: 'text', text: '' }],
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          };
        });
      }

      await p.submit('task', null, {});

      expect(capturedHeaders['Content-Type']).toBe('application/json');
      if (apiFormat === 'openai') {
        expect(capturedHeaders['Authorization']).toBe('Bearer test-key-header');
      } else {
        expect(capturedHeaders['x-api-key']).toBe('test-key-header');
        expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
      }
    });

    it('includes temperature when provided', async () => {
      const p = new Class({ apiKey: 'key' });
      let capturedBody;

      const mockResponse = apiFormat === 'openai'
        ? { ok: true, json: async () => ({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) }
        : { ok: true, json: async () => ({ content: [{ type: 'text', text: '' }], usage: { input_tokens: 0, output_tokens: 0 } }) };

      vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return mockResponse;
      });

      await p.submit('task', null, { tuning: { temperature: 0.5 } });
      expect(capturedBody.temperature).toBe(0.5);
    });

    it('returns timeout on AbortError', async () => {
      const p = new Class({ apiKey: 'key' });

      vi.spyOn(global, 'fetch').mockImplementation(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      const result = await p.submit('task', null, { timeout: 0.001 });
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
    });
  });
});
