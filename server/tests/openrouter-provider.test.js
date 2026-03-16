import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OpenRouterProvider = require('../providers/openrouter.js');
const { FALLBACK_MODELS } = require('../providers/openrouter.js');

describe('OpenRouterProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new OpenRouterProvider({ apiKey: 'test-key-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('sets name to openrouter', () => {
      expect(provider.name).toBe('openrouter');
    });

    it('stores provided apiKey', () => {
      expect(provider.apiKey).toBe('test-key-123');
    });

    it('uses env var for API key when not provided', () => {
      const origKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'env-or-key';
      const p = new OpenRouterProvider();
      expect(p.apiKey).toBe('env-or-key');
      if (origKey) process.env.OPENROUTER_API_KEY = origKey;
      else delete process.env.OPENROUTER_API_KEY;
    });

    it('uses trinity-large-preview:free as default model', () => {
      expect(provider.defaultModel).toBe('arcee-ai/trinity-large-preview:free');
    });

    it('accepts custom defaultModel', () => {
      const p = new OpenRouterProvider({ apiKey: 'k', defaultModel: 'meta-llama/llama-3.3-70b-instruct:free' });
      expect(p.defaultModel).toBe('meta-llama/llama-3.3-70b-instruct:free');
    });

    it('uses default baseUrl', () => {
      expect(provider.baseUrl).toBe('https://openrouter.ai/api');
    });
  });

  describe('submit', () => {
    it('throws when no API key', async () => {
      const p = new OpenRouterProvider({ apiKey: '' });
      await expect(p.submit('test task')).rejects.toThrow('API key not configured');
    });

    it('extracts content from standard response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hello world', role: 'assistant' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      }));

      const result = await provider.submit('say hello');
      expect(result.output).toBe('Hello world');
      expect(result.status).toBe('completed');
      expect(result.usage.tokens).toBe(15);
    });

    it('extracts reasoning from reasoning model response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '', role: 'assistant', reasoning: 'Detailed analysis here' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      }));

      const result = await provider.submit('analyze this');
      expect(result.output).toBe('Detailed analysis here');
      expect(result.status).toBe('completed');
    });

    it('prefers content over reasoning when both present', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Final answer', role: 'assistant', reasoning: 'Internal thought' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      }));

      const result = await provider.submit('test');
      expect(result.output).toBe('Final answer');
    });

    it('returns empty string when neither content nor reasoning', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { role: 'assistant' } }],
          usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
        }),
      }));

      const result = await provider.submit('test');
      expect(result.output).toBe('');
    });

    it('throws on non-429 error without fallback', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
        headers: { get: () => null },
      }));

      await expect(provider.submit('test')).rejects.toThrow('OpenRouter API error (500)');
    });

    it('falls back to next model on 429', async () => {
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First model: 429
          return Promise.resolve({
            ok: false,
            status: 429,
            text: () => Promise.resolve('rate-limited upstream'),
            headers: { get: () => null },
          });
        }
        // Second model: success
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: 'fallback worked' } }],
            usage: { total_tokens: 10 },
          }),
        });
      }));

      const result = await provider.submit('test');
      expect(result.output).toBe('fallback worked');
      expect(callCount).toBe(2);
    });

    it('throws when all fallback models are 429', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate-limited upstream'),
        headers: { get: () => null },
      }));

      await expect(provider.submit('test')).rejects.toThrow(/429/);
    });

    it('estimates zero cost for :free models', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      }));

      const result = await provider.submit('test', 'qwen/qwen3-coder:free');
      expect(result.usage.cost).toBe(0);
    });

    it('applies temperature from tuning options', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'ok' } }],
          usage: { total_tokens: 10 },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await provider.submit('test', null, { tuning: { temperature: 0.7 } });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
    });
  });

  describe('submitStream', () => {
    function makeSSEStream(chunks) {
      let index = 0;
      const encoder = new TextEncoder();
      return {
        getReader: () => ({
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            const chunk = chunks[index++];
            return { done: false, value: encoder.encode(chunk) };
          },
        }),
      };
    }

    it('throws when no API key', async () => {
      const p = new OpenRouterProvider({ apiKey: '' });
      await expect(p.submitStream('test task')).rejects.toThrow('API key not configured');
    });

    it('captures standard content tokens', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n',
        'data: [DONE]\n',
      ].join('');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: makeSSEStream([sseData]),
      }));

      const result = await provider.submitStream('say hello');
      expect(result.output).toBe('Hello world');
      expect(result.status).toBe('completed');
    });

    it('captures reasoning tokens from reasoning models', async () => {
      // This is the actual SSE format from nemotron/step-3.5-flash on OpenRouter
      const sseData = [
        'data: {"choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"We need"}}]}\n',
        'data: {"choices":[{"index":0,"delta":{"content":"","reasoning":" to analyze"}}]}\n',
        'data: {"choices":[{"index":0,"delta":{"content":"","reasoning":" the code"}}]}\n',
        'data: [DONE]\n',
      ].join('');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: makeSSEStream([sseData]),
      }));

      const result = await provider.submitStream('analyze code');
      expect(result.output).toBe('We need to analyze the code');
      expect(result.status).toBe('completed');
    });

    it('prefers content over reasoning in streaming', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Real answer","reasoning":"Internal thought"}}]}\n',
        'data: [DONE]\n',
      ].join('');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: makeSSEStream([sseData]),
      }));

      const result = await provider.submitStream('test');
      expect(result.output).toBe('Real answer');
    });

    it('calls onChunk callback for each token', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"A"}}]}\n',
        'data: {"choices":[{"delta":{"content":"B"}}]}\n',
        'data: [DONE]\n',
      ].join('');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: makeSSEStream([sseData]),
      }));

      const chunks = [];
      await provider.submitStream('test', null, { onChunk: (c) => chunks.push(c) });
      expect(chunks).toEqual(['A', 'B']);
    });

    it('captures usage from final SSE event', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n',
        'data: [DONE]\n',
      ].join('');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: makeSSEStream([sseData]),
      }));

      const result = await provider.submitStream('test');
      expect(result.usage.tokens).toBe(150);
      expect(result.usage.input_tokens).toBe(100);
      expect(result.usage.output_tokens).toBe(50);
    });

    it('skips malformed SSE lines', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
        'data: {invalid json\n',
        'data: {"choices":[{"delta":{"content":"!"}}]}\n',
        'data: [DONE]\n',
      ].join('');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: makeSSEStream([sseData]),
      }));

      const result = await provider.submitStream('test');
      expect(result.output).toBe('ok!');
    });

    it('handles chunked SSE data across read boundaries', async () => {
      // Data split across two read() calls, with a line split mid-boundary
      const chunk1 = 'data: {"choices":[{"delta":{"content":"He';
      const chunk2 = 'llo"}}]}\ndata: {"choices":[{"delta":{"content":" world"}}]}\ndata: [DONE]\n';

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: makeSSEStream([chunk1, chunk2]),
      }));

      const result = await provider.submitStream('test');
      expect(result.output).toBe('Hello world');
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key', async () => {
      const p = new OpenRouterProvider({ apiKey: '' });
      const health = await p.checkHealth();
      expect(health.available).toBe(false);
      expect(health.error).toBe('No API key configured');
    });

    it('returns available with models on success', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [{ id: 'model-a' }, { id: 'model-b' }],
        }),
      }));

      const health = await provider.checkHealth();
      expect(health.available).toBe(true);
      expect(health.models).toEqual(['model-a', 'model-b']);
    });

    it('returns unavailable on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      const health = await provider.checkHealth();
      expect(health.available).toBe(false);
      expect(health.error).toContain('500');
    });
  });

  describe('listModels', () => {
    it('returns an array of free models', async () => {
      const models = await provider.listModels();
      expect(models.length).toBeGreaterThan(5);
      for (const m of models) {
        expect(m).toMatch(/:free$/);
      }
    });

    it('includes qwen3-coder:free in model list', async () => {
      const models = await provider.listModels();
      expect(models).toContain('qwen/qwen3-coder:free');
    });

    it('does not include removed models', async () => {
      const models = await provider.listModels();
      expect(models).not.toContain('openai/gpt-oss-120b:free');
      expect(models).not.toContain('openai/gpt-oss-20b:free');
    });
  });

  describe('_buildPrompt', () => {
    it('returns task as-is with no options', () => {
      expect(provider._buildPrompt('do something', {})).toBe('do something');
    });

    it('prepends working directory', () => {
      const result = provider._buildPrompt('task', { working_directory: '/project' });
      expect(result).toContain('Working directory: /project');
      expect(result).toContain('task');
    });

    it('prepends files list', () => {
      const result = provider._buildPrompt('task', { files: ['a.js', 'b.js'] });
      expect(result).toContain('Files: a.js, b.js');
    });
  });

  describe('_estimateCost', () => {
    it('returns 0 for free models', () => {
      expect(provider._estimateCost({ total_tokens: 1000 }, 'qwen/qwen3-coder:free')).toBe(0);
    });

    it('returns 0 for null usage', () => {
      expect(provider._estimateCost(null, 'some-model')).toBe(0);
    });

    it('returns non-zero for non-free models', () => {
      expect(provider._estimateCost({ total_tokens: 1000000 }, 'openai/gpt-4o')).toBeGreaterThan(0);
    });
  });

  describe('supportsStreaming', () => {
    it('returns true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });
  });

  describe('model fallback', () => {
    it('exports FALLBACK_MODELS array', () => {
      expect(Array.isArray(FALLBACK_MODELS)).toBe(true);
      expect(FALLBACK_MODELS.length).toBeGreaterThan(5);
      for (const m of FALLBACK_MODELS) {
        expect(m).toMatch(/:free$/);
      }
    });

    it('_getFallbackCandidates puts requested model first', () => {
      const candidates = provider._getFallbackCandidates('google/gemma-3-12b-it:free');
      expect(candidates[0]).toBe('google/gemma-3-12b-it:free');
      expect(candidates.length).toBeGreaterThan(1);
    });

    it('_getFallbackCandidates skips cooled-down models', () => {
      provider._cooldownModel('arcee-ai/trinity-large-preview:free', 300);
      const candidates = provider._getFallbackCandidates('google/gemma-3-12b-it:free');
      expect(candidates).not.toContain('arcee-ai/trinity-large-preview:free');
    });

    it('_getFallbackCandidates does not duplicate requested model', () => {
      const candidates = provider._getFallbackCandidates('arcee-ai/trinity-large-preview:free');
      const count = candidates.filter(m => m === 'arcee-ai/trinity-large-preview:free').length;
      expect(count).toBe(1);
    });

    it('cooldown expires after duration', () => {
      // Set expiry to the past
      provider._modelCooldowns.set('model-x', Date.now() - 1000);
      expect(provider._isModelCooledDown('model-x')).toBe(false);
    });

    it('cooldown is active during duration', () => {
      provider._cooldownModel('model-y', 300);
      expect(provider._isModelCooledDown('model-y')).toBe(true);
    });

    it('_is429 detects rate limit errors', () => {
      expect(provider._is429({ message: 'OpenRouter API error (429): rate-limited' })).toBe(true);
      expect(provider._is429({ message: 'rate_limit exceeded' })).toBe(true);
      expect(provider._is429({ message: 'rate-limited upstream' })).toBe(true);
      expect(provider._is429({ message: 'OpenRouter API error (500): server error' })).toBe(false);
    });

    it('_parseRetryAfter extracts seconds from error message', () => {
      expect(provider._parseRetryAfter('error (429) retry_after_seconds=30')).toBe(30);
      expect(provider._parseRetryAfter('error without retry info')).toBeNull();
    });

    it('submit reports fallback model in usage', async () => {
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false, status: 429,
            text: () => Promise.resolve('rate-limited'),
            headers: { get: () => null },
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: 'ok' } }],
            usage: { total_tokens: 5 },
          }),
        });
      }));

      const result = await provider.submit('test', 'qwen/qwen3-coder:free');
      // Should have fallen back to a different model
      expect(result.usage.model).not.toBe('qwen/qwen3-coder:free');
      expect(result.output).toBe('ok');
    });

    it('submitStream falls back on 429', async () => {
      function makeSSEStream(chunks) {
        let index = 0;
        const encoder = new TextEncoder();
        return {
          getReader: () => ({
            read: async () => {
              if (index >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: encoder.encode(chunks[index++]) };
            },
            cancel: async () => {},
          }),
        };
      }

      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false, status: 429,
            text: () => Promise.resolve('rate-limited upstream'),
            headers: { get: () => null },
          });
        }
        return Promise.resolve({
          ok: true,
          body: makeSSEStream(['data: {"choices":[{"delta":{"content":"fallback"}}]}\ndata: [DONE]\n']),
        });
      }));

      const result = await provider.submitStream('test', 'qwen/qwen3-coder:free');
      expect(result.output).toBe('fallback');
      expect(callCount).toBe(2);
    });

    it('cooldowns persist across requests', async () => {
      // Requested model 429s, all fallbacks cooled down except gemma-3-12b
      let _callCount = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
        _callCount++;
        const body = JSON.parse(opts.body);
        if (body.model === provider.defaultModel) {
          // Requested model: 429
          return Promise.resolve({
            ok: false, status: 429,
            text: () => Promise.resolve('rate-limited'),
            headers: { get: () => null },
          });
        }
        // Any fallback: success
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: 'ok' } }],
            usage: { total_tokens: 5 },
          }),
        });
      }));

      // Cool down all fallback models except gemma-3-12b
      for (const m of FALLBACK_MODELS) {
        if (m !== 'google/gemma-3-12b-it:free' && m !== provider.defaultModel) {
          provider._cooldownModel(m, 300);
        }
      }

      const result = await provider.submit('test');
      // Requested model 429'd, only gemma-3-12b was available as fallback
      expect(result.usage.model).toBe('google/gemma-3-12b-it:free');
    });
  });
});
