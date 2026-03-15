import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const HyperbolicProvider = require('../providers/hyperbolic.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

describe('HyperbolicProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new HyperbolicProvider({ apiKey: 'test-key-456' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('sets name to hyperbolic', () => {
      expect(provider.name).toBe('hyperbolic');
    });

    it('uses env var for API key when not provided', () => {
      const origKey = process.env.HYPERBOLIC_API_KEY;
      process.env.HYPERBOLIC_API_KEY = 'env-key';
      const p = new HyperbolicProvider();
      expect(p.apiKey).toBe('env-key');
      if (origKey) process.env.HYPERBOLIC_API_KEY = origKey;
      else delete process.env.HYPERBOLIC_API_KEY;
    });

    it('uses default baseUrl', () => {
      expect(provider.baseUrl).toBe('https://api.hyperbolic.xyz/v1');
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key', async () => {
      const p = new HyperbolicProvider({ apiKey: '' });
      const result = await p.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/No API key/);
    });

    it('returns available with models on successful probe', async () => {
      const mockModels = { data: [{ id: 'qwen-72b' }, { id: 'llama-70b' }] };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockModels,
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['qwen-72b', 'llama-70b']);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.hyperbolic.xyz/v1/models',
        expect.objectContaining({
          headers: { 'Authorization': 'Bearer test-key-456' },
        })
      );
    });

    it('returns unavailable on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/403/);
    });

    it('returns unavailable on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));

      const result = await provider.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/ENOTFOUND/);
    });

    it('returns unavailable on timeout', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

      const result = await provider.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/timed out/);
    });

    it('falls back to default model when response format unexpected', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ models: ['a', 'b'] }), // wrong shape
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['Qwen/Qwen2.5-72B-Instruct']);
    });
  });

  describe('submit', () => {
    it('throws when no API key', async () => {
      const p = new HyperbolicProvider({ apiKey: '' });
      await expect(p.submit('test', null, {})).rejects.toThrow(/API key/);
    });

    it('returns completed result on success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hello world' } }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
      });

      const result = await provider.submit('test', null, {});
      expect(result.status).toBe('completed');
      expect(result.output).toBe('hello world');
      expect(result.usage.tokens).toBe(70);
    });

    it('passes tuning temperature to request body', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { total_tokens: 10 },
        }),
      });

      await provider.submit('test', null, { tuning: { temperature: 0.7 } });
      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
    });

    it('uses configured timeout option to schedule request cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hello world' } }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
      });

      await provider.submit('test', null, { timeout: 4 });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4 * 60 * 1000);
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

      const resultPromise = provider.submit('test', null, { signal: abortController.signal });
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
          choices: [{ message: { content: 'hello world' } }],
        }),
      });

      const result = await provider.submit('test', null, {});
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
          get: (name) => (name === 'Retry-After' || name === 'retry-after' ? '6' : null),
        },
        text: async () => 'Rate limited',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(/retry_after_seconds=6/);
    });

    it('removes external abort listener after successful submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hello world' } }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
      });

      await provider.submit('test', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
    });
  });

  describe('_estimateCost', () => {
    it('calculates cost for known model', () => {
      const cost = provider._estimateCost(
        { prompt_tokens: 1000, completion_tokens: 500 },
        'Qwen/Qwen2.5-72B-Instruct'
      );
      // input: 1000/1M * 0.40 = 0.0004, output: 500/1M * 0.40 = 0.0002
      expect(cost).toBeCloseTo(0.0006, 5);
    });

    it('returns 0 for no usage', () => {
      expect(provider._estimateCost(null, 'any')).toBe(0);
    });
  });

  describe('listModels', () => {
    it('returns static model list', async () => {
      const models = await provider.listModels();
      expect(models).toContain('Qwen/Qwen2.5-72B-Instruct');
      expect(models.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('supportsStreaming', () => {
    it('returns true', () => {
      expect(provider.supportsStreaming).toBe(true);
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
      const p = new HyperbolicProvider({ apiKey: '' });
      await expect(p.submitStream('test', null, {})).rejects.toThrow(/API key/);
    });

    it('parses SSE stream and returns accumulated output', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"."}}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
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
      expect(result.output).toBe('Hello there.');
      expect(chunks).toEqual(['Hello', ' there', '.']);
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

    it('parses SSE tokens split across chunk boundaries', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\n',
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
        'data: [bad]\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n',
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
      expect(result.output).toBe('Hello there');
      expect(chunks).toEqual(['Hello', ' there']);
      expect(result.usage.tokens).toBe(11);
      expect(result.usage.input_tokens).toBe(7);
      expect(result.usage.output_tokens).toBe(4);
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
          get: (name) => (name === 'Retry-After' || name === 'retry-after' ? '11' : null),
        },
        text: async () => 'Rate limited',
      });

      await expect(provider.submitStream('test', null, {})).rejects.toThrow(/retry_after_seconds=11/);
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
  });
});
