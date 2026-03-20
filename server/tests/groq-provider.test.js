import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const GroqProvider = require('../providers/groq.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

describe('GroqProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new GroqProvider({ apiKey: 'test-groq-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('sets name to groq', () => {
      expect(provider.name).toBe('groq');
    });

    it('stores provided apiKey', () => {
      expect(provider.apiKey).toBe('test-groq-key');
    });

    it('uses env var for API key when not provided', () => {
      const origKey = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = 'env-groq-key';
      const p = new GroqProvider();
      expect(p.apiKey).toBe('env-groq-key');
      if (origKey) process.env.GROQ_API_KEY = origKey;
      else delete process.env.GROQ_API_KEY;
    });

    it('uses default model when not provided', () => {
      expect(provider.defaultModel).toBe('llama-3.3-70b-versatile');
    });

    it('accepts custom defaultModel', () => {
      const p = new GroqProvider({ apiKey: 'k', defaultModel: 'mixtral-8x7b-32768' });
      expect(p.defaultModel).toBe('mixtral-8x7b-32768');
    });

    it('uses default baseUrl when not provided', () => {
      expect(provider.baseUrl).toBe('https://api.groq.com/openai');
    });

    it('accepts custom baseUrl', () => {
      const p = new GroqProvider({ apiKey: 'k', baseUrl: 'http://localhost:8080' });
      expect(p.baseUrl).toBe('http://localhost:8080');
    });

    it('initializes activeTasks to 0', () => {
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key', async () => {
      const p = new GroqProvider({ apiKey: '' });
      const result = await p.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/No API key/);
    });

    it('returns available with models on successful probe', async () => {
      const mockModels = { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'mixtral-8x7b-32768' }] };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockModels,
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['llama-3.3-70b-versatile', 'mixtral-8x7b-32768']);
    });

    it('sends Authorization Bearer header', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await provider.checkHealth();
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.objectContaining({
          headers: { 'Authorization': 'Bearer test-groq-key' },
        })
      );
    });

    it('returns unavailable on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/401/);
    });

    it('returns unavailable on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await provider.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/ECONNREFUSED/);
    });

    it('returns unavailable on timeout', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

      const result = await provider.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/timed out/);
    });

    it('falls back to default model when response has no data array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: 'format' }),
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['llama-3.3-70b-versatile']);
    });

    it('filters out falsy model ids', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'llama-3.1-8b-instant' }, { id: '' }, { id: null }] }),
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['llama-3.1-8b-instant']);
    });
  });

  describe('submit', () => {
    it('throws when no API key', async () => {
      const p = new GroqProvider({ apiKey: '' });
      await expect(p.submit('test task', null, {})).rejects.toThrow(/API key/);
    });

    it('returns completed result on success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response text' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      });

      const result = await provider.submit('test task', null, {});
      expect(result.status).toBe('completed');
      expect(result.output).toBe('response text');
      expect(result.usage.input_tokens).toBe(100);
      expect(result.usage.output_tokens).toBe(50);
      expect(result.usage.tokens).toBe(150);
    });

    it('returns empty string when choices are missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
      });

      const result = await provider.submit('test task', null, {});
      expect(result.output).toBe('');
    });

    it('uses the specified model', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
      });

      const result = await provider.submit('task', 'mixtral-8x7b-32768', {});
      expect(result.usage.model).toBe('mixtral-8x7b-32768');
    });

    it('falls back to defaultModel when model is null', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
      });

      const result = await provider.submit('task', null, {});
      expect(result.usage.model).toBe('llama-3.3-70b-versatile');
    });

    it('sends Authorization Bearer header', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      });

      await provider.submit('task', null, {});
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/chat/completions'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-groq-key',
          }),
        })
      );
    });

    it('does not send x-api-key header', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      });

      await provider.submit('task', null, {});
      const callHeaders = fetch.mock.calls[0][1].headers;
      expect(callHeaders['x-api-key']).toBeUndefined();
    });

    it('throws on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(/429/);
    });

    it('returns timeout on abort', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

      const result = await provider.submit('test task', null, {});
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('uses configured timeout option to schedule request cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response text' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      });

      await provider.submit('test task', null, { timeout: 1 });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1 * 60 * 1000);
    });

    it('returns timeout when external signal is aborted', async () => {
      const abortController = new AbortController();
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, { signal }) => {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      });

      const resultPromise = provider.submit('test task', null, { signal: abortController.signal });
      await Promise.resolve();
      abortController.abort();

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('defaults usage to zeros when usage payload is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response text' } }],
        }),
      });

      const result = await provider.submit('task', null, {});
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('includes retry_after_seconds when rate limit response provides it', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        headers: {
          get: (name) => (name === 'Retry-After' || name === 'retry-after' ? '15' : null),
        },
        text: async () => 'Rate limited',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(/retry_after_seconds=15/);
    });

    it('removes external abort listener after successful submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response text' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      });

      await provider.submit('test task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
    });

    it('decrements activeTasks after success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      });

      await provider.submit('task', null, {});
      expect(provider.activeTasks).toBe(0);
    });

    it('decrements activeTasks after error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'server error',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow();
      expect(provider.activeTasks).toBe(0);
    });

    it('applies temperature from tuning options', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      });

      await provider.submit('task', null, { tuning: { temperature: 0.5 } });
      const callBody = JSON.parse(fetch.mock.calls[0][1].body);
      expect(callBody.temperature).toBe(0.5);
    });

    it('does not include temperature when not in tuning options', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      });

      await provider.submit('task', null, {});
      const callBody = JSON.parse(fetch.mock.calls[0][1].body);
      expect(callBody.temperature).toBeUndefined();
    });

    it('includes cost in usage', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }),
      });

      const result = await provider.submit('task', null, {});
      expect(typeof result.usage.cost).toBe('number');
      expect(result.usage.cost).toBeGreaterThan(0);
    });

    it('includes duration_ms in usage', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      });

      const result = await provider.submit('task', null, {});
      expect(typeof result.usage.duration_ms).toBe('number');
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('listModels', () => {
    it('returns static model list', async () => {
      const models = await provider.listModels();
      expect(models).toContain('llama-3.3-70b-versatile');
      expect(models).toContain('llama-3.1-8b-instant');
      expect(models).toContain('qwen/qwen3-32b');
      expect(models).toContain('meta-llama/llama-4-scout-17b-16e-instruct');
      expect(models.length).toBe(4);
    });
  });

  describe('_buildPrompt', () => {
    it('returns task as-is when no options', () => {
      const result = provider._buildPrompt('do something', {});
      expect(result).toBe('do something');
    });

    it('prepends working_directory when provided', () => {
      const result = provider._buildPrompt('do something', { working_directory: '/home/user/project' });
      expect(result).toContain('Working directory: /home/user/project');
      expect(result).toContain('do something');
    });

    it('prepends files list when provided', () => {
      const result = provider._buildPrompt('do something', { files: ['a.ts', 'b.ts'] });
      expect(result).toContain('Files: a.ts, b.ts');
      expect(result).toContain('do something');
    });

    it('includes both working_directory and files when both provided', () => {
      const result = provider._buildPrompt('do something', {
        working_directory: '/project',
        files: ['main.ts'],
      });
      expect(result).toContain('Working directory: /project');
      expect(result).toContain('Files: main.ts');
      expect(result).toContain('do something');
    });

    it('ignores empty files array', () => {
      const result = provider._buildPrompt('do something', { files: [] });
      expect(result).toBe('do something');
    });
  });

  describe('_estimateCost', () => {
    it('returns 0 for null usage', () => {
      expect(provider._estimateCost(null)).toBe(0);
    });

    it('returns 0 for undefined usage', () => {
      expect(provider._estimateCost(undefined)).toBe(0);
    });

    it('calculates cost using default model rate ($0.59 per 1M tokens)', () => {
      // Default model is llama-3.3-70b-versatile at $0.59/1M
      const cost = provider._estimateCost({ total_tokens: 1_000_000 });
      expect(cost).toBeCloseTo(0.59, 10);
    });

    it('calculates cost for partial token usage', () => {
      // 10000 tokens * 0.59/1M (llama-3.3-70b-versatile) = 0.0059
      const cost = provider._estimateCost({ total_tokens: 10_000 });
      expect(cost).toBeCloseTo(0.0059, 8);
    });

    it('calculates cost for small token amounts', () => {
      // 1000 tokens @ $0.59/1M (llama-3.3-70b-versatile) = 0.00000059 * 1000
      const cost = provider._estimateCost({ total_tokens: 1000 });
      expect(cost).toBeCloseTo(0.00000059 * 1000, 10);
    });

    it('returns 0 for zero tokens', () => {
      const cost = provider._estimateCost({ total_tokens: 0 });
      expect(cost).toBe(0);
    });

    it('handles missing total_tokens gracefully', () => {
      const cost = provider._estimateCost({});
      expect(cost).toBe(0);
    });

    it('uses model-specific rate when model is provided', () => {
      const usage = { total_tokens: 500_000 };
      // mixtral-8x7b-32768 is $0.24/1M -> 500_000 * 0.24/1M = 0.12
      const cost1 = provider._estimateCost(usage, 'mixtral-8x7b-32768');
      expect(cost1).toBeCloseTo(0.12, 6);
    });
  });

  describe('submitStream', () => {
    function makeSSEStream(chunks) {
      const encoder = new TextEncoder();
      let index = 0;
      return {
        getReader: () => ({
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[index++]) };
          },
        }),
      };
    }

    it('throws when no API key', async () => {
      const p = new GroqProvider({ apiKey: '' });
      await expect(p.submitStream('test', null, {})).rejects.toThrow(/API key/);
    });

    it('reports supportsStreaming as true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });

    it('parses OpenAI-compatible SSE stream', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}],"x_groq":{"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}}\n\n',
        'data: [DONE]\n\n',
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      const chunks = [];
      const result = await provider.submitStream('test', null, {
        onChunk: (token) => chunks.push(token),
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello world!');
      expect(chunks).toEqual(['Hello', ' world', '!']);
      expect(result.usage.tokens).toBe(11);
    });

    it('stops calling onChunk after MAX_STREAMING_OUTPUT is exceeded', async () => {
      const maxToken = 'A'.repeat(MAX_STREAMING_OUTPUT);
      const sseData = [
        `data: {"choices":[{"delta":{"content":"${maxToken}"}}]}\n\n`,
        'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      const chunks = [];
      const result = await provider.submitStream('test', null, {
        onChunk: (token) => chunks.push(token),
      });

      expect(chunks).toEqual([maxToken]);
      expect(result.output).toContain('[...OUTPUT TRUNCATED...]');
      expect(result.output.endsWith('[...OUTPUT TRUNCATED...]')).toBe(true);
      expect(result.output.includes('B')).toBe(false);
    });

    it('parses OpenAI SSE tokens split across chunk boundaries', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"He',
        'llo"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\n',
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      const chunks = [];
      const result = await provider.submitStream('test', null, {
        onChunk: (t) => chunks.push(t),
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello there');
      expect(chunks).toEqual(['Hello', ' there']);
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('ignores malformed SSE lines and continues parsing valid chunks', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: [bad]\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: {"x_groq":{"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}}\n\n',
        'data: [DONE]\n\n',
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      const chunks = [];
      const result = await provider.submitStream('test', null, {
        onChunk: (t) => chunks.push(t),
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello world');
      expect(chunks).toEqual(['Hello', ' world']);
      expect(result.usage.tokens).toBe(15);
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
    });

    it('defaults stream usage to zero when no usage chunk is present', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      const result = await provider.submitStream('test', null, {});
      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('handles HTTP error in streaming', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });

      await expect(provider.submitStream('test', null, {})).rejects.toThrow(/429/);
    });

    it('returns timeout on abort', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

      const result = await provider.submitStream('test', null, {});
      expect(result.status).toBe('timeout');
    });

    it('includes retry_after_seconds in streaming rate-limit errors', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        headers: {
          get: (name) => (name === 'Retry-After' || name === 'retry-after' ? '20' : null),
        },
        text: async () => 'Rate limited',
      });

      await expect(provider.submitStream('test', null, {})).rejects.toThrow(/retry_after_seconds=20/);
    });

    it('cancels stream reader when abort signal fires mid-stream', async () => {
      const encoder = new TextEncoder();
      const abortController = new AbortController();
      const readerCancel = vi.fn();

      let readCount = 0;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            cancel: readerCancel,
            read: vi.fn(async () => {
              readCount++;
              if (readCount === 1) {
                return {
                  done: false,
                  value: encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
                };
              }

              if (abortController.signal.aborted) {
                const abortErr = new Error('aborted');
                abortErr.name = 'AbortError';
                throw abortErr;
              }

              await new Promise(resolve => {
                abortController.signal.addEventListener('abort', resolve, { once: true });
              });

              const abortErr = new Error('aborted');
              abortErr.name = 'AbortError';
              throw abortErr;
            }),
          }),
        },
      });

      const resultPromise = provider.submitStream('test', null, { signal: abortController.signal });
      await Promise.resolve();
      abortController.abort();

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
      expect(readerCancel).toHaveBeenCalledTimes(1);
    });

    it('removes external abort listener after successful streaming submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      await provider.submitStream('test', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
    });

    it('sends stream:true in request body', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      await provider.submitStream('test prompt', null, {});

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
      expect(body.model).toBe('llama-3.3-70b-versatile');
    });
  });
});
