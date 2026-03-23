import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const AnthropicProvider = require('../providers/anthropic.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

// Note: Anthropic provider is opt-in (not seeded by default since 2026-03-17).
// These tests verify the provider class works correctly when explicitly added by users.
describe('AnthropicProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new AnthropicProvider({ apiKey: 'test-key-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('sets name to anthropic', () => {
      expect(provider.name).toBe('anthropic');
    });

    it('stores provided apiKey', () => {
      expect(provider.apiKey).toBe('test-key-123');
    });

    it('uses env var for API key when not provided', () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
      const p = new AnthropicProvider();
      expect(p.apiKey).toBe('env-anthropic-key');
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
    });

    it('uses default model when not provided', () => {
      expect(provider.defaultModel).toBe('claude-sonnet-4-20250514');
    });

    it('accepts custom defaultModel', () => {
      const p = new AnthropicProvider({ apiKey: 'k', defaultModel: 'claude-haiku-4-20250514' });
      expect(p.defaultModel).toBe('claude-haiku-4-20250514');
    });

    it('uses default baseUrl when not provided', () => {
      expect(provider.baseUrl).toBe('https://api.anthropic.com');
    });

    it('accepts custom baseUrl', () => {
      const p = new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://localhost:9090' });
      expect(p.baseUrl).toBe('http://localhost:9090');
    });

    it('initializes activeTasks to 0', () => {
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key', async () => {
      const p = new AnthropicProvider({ apiKey: '' });
      const result = await p.checkHealth();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/No API key/);
    });

    it('returns available with models on successful probe', async () => {
      const mockModels = { data: [{ id: 'claude-sonnet-4-20250514' }, { id: 'claude-haiku-4-20250514' }] };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockModels,
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(true);
      expect(result.models.map(model => model.model_name)).toEqual(['claude-sonnet-4-20250514', 'claude-haiku-4-20250514']);
    });

    it('sends x-api-key and anthropic-version headers', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await provider.checkHealth();
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'test-key-123',
            'anthropic-version': '2023-06-01',
          }),
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
      expect(result.models.map(model => model.model_name)).toEqual(['claude-sonnet-4-20250514']);
    });

    it('filters out falsy model ids', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'claude-opus-4-20250514' }, { id: '' }, { id: null }] }),
      });

      const result = await provider.checkHealth();
      expect(result.available).toBe(true);
      expect(result.models.map(model => model.model_name)).toEqual(['claude-opus-4-20250514']);
    });
  });

  describe('submit', () => {
    it('throws when no API key', async () => {
      const p = new AnthropicProvider({ apiKey: '' });
      await expect(p.submit('test task', null, {})).rejects.toThrow(/API key/);
    });

    it('returns completed result on success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'response text' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      });

      const result = await provider.submit('test task', null, {});
      expect(result.status).toBe('completed');
      expect(result.output).toBe('response text');
      expect(result.usage.input_tokens).toBe(100);
      expect(result.usage.output_tokens).toBe(50);
      expect(result.usage.tokens).toBe(150);
    });

    it('concatenates multiple text content blocks', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      const result = await provider.submit('test task', null, {});
      expect(result.output).toBe('Hello\n world');
    });

    it('ignores non-text content blocks', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            { type: 'tool_use', id: 'x', name: 'fn', input: {} },
            { type: 'text', text: 'final' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      const result = await provider.submit('test task', null, {});
      expect(result.output).toBe('final');
    });

    it('returns empty string when content is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      });

      const result = await provider.submit('test task', null, {});
      expect(result.output).toBe('');
    });

    it('uses the specified model', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      });

      const result = await provider.submit('task', 'claude-haiku-4-20250514', {});
      expect(result.usage.model).toBe('claude-haiku-4-20250514');
    });

    it('falls back to defaultModel when model is null', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      });

      const result = await provider.submit('task', null, {});
      expect(result.usage.model).toBe('claude-sonnet-4-20250514');
    });

    it('sends x-api-key and anthropic-version headers', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      });

      await provider.submit('task', null, {});
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'test-key-123',
            'anthropic-version': '2023-06-01',
          }),
        })
      );
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
          content: [{ type: 'text', text: 'response text' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      });

      await provider.submit('test task', null, { timeout: 2 });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
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
          content: [{ type: 'text', text: 'no usage payload' }],
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
          get: (name) => (name === 'Retry-After' || name === 'retry-after' ? '5' : null),
        },
        text: async () => 'Rate limited',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(/retry_after_seconds=5/);
    });

    it('removes external abort listener after successful submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'response text' }],
          usage: { input_tokens: 100, output_tokens: 50 },
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
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
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
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      });

      await provider.submit('task', null, { tuning: { temperature: 0.7 } });
      const callBody = JSON.parse(fetch.mock.calls[0][1].body);
      expect(callBody.temperature).toBe(0.7);
    });

    it('does not include temperature when not in tuning options', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
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
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1000, output_tokens: 500 },
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
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 5 },
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
      expect(models).toContain('claude-sonnet-4-20250514');
      expect(models).toContain('claude-haiku-4-20250514');
      expect(models).toContain('claude-opus-4-20250514');
      expect(models.length).toBe(3);
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
      expect(provider._estimateCost(null, 'claude-sonnet-4-20250514')).toBe(0);
    });

    it('returns 0 for undefined usage', () => {
      expect(provider._estimateCost(undefined, 'claude-sonnet-4-20250514')).toBe(0);
    });

    it('calculates cost for sonnet (input: $3/1M, output: $15/1M)', () => {
      const cost = provider._estimateCost(
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        'claude-sonnet-4-20250514'
      );
      expect(cost).toBeCloseTo(18.0, 5);
    });

    it('calculates cost for haiku (input: $0.25/1M, output: $1.25/1M)', () => {
      const cost = provider._estimateCost(
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        'claude-haiku-4-20250514'
      );
      expect(cost).toBeCloseTo(1.5, 5);
    });

    it('calculates cost for opus (input: $15/1M, output: $75/1M)', () => {
      const cost = provider._estimateCost(
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        'claude-opus-4-20250514'
      );
      expect(cost).toBeCloseTo(90.0, 5);
    });

    it('falls back to sonnet pricing for unknown model', () => {
      const costUnknown = provider._estimateCost(
        { input_tokens: 1_000_000, output_tokens: 0 },
        'claude-unknown-model'
      );
      const costSonnet = provider._estimateCost(
        { input_tokens: 1_000_000, output_tokens: 0 },
        'claude-sonnet-4-20250514'
      );
      expect(costUnknown).toBeCloseTo(costSonnet, 10);
    });

    it('calculates small token amounts correctly', () => {
      // 1000 input @ $3/1M = $0.003, 500 output @ $15/1M = $0.0075, total = $0.0105
      const cost = provider._estimateCost(
        { input_tokens: 1000, output_tokens: 500 },
        'claude-sonnet-4-20250514'
      );
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('handles zero tokens', () => {
      const cost = provider._estimateCost(
        { input_tokens: 0, output_tokens: 0 },
        'claude-sonnet-4-20250514'
      );
      expect(cost).toBe(0);
    });

    it('handles missing token fields gracefully', () => {
      const cost = provider._estimateCost({}, 'claude-sonnet-4-20250514');
      expect(cost).toBe(0);
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
      const p = new AnthropicProvider({ apiKey: '' });
      await expect(p.submitStream('test', null, {})).rejects.toThrow(/API key/);
    });

    it('reports supportsStreaming as true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });

    it('parses Anthropic Messages API SSE stream', async () => {
      const sseData = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":15}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
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
      expect(result.output).toBe('Hello world');
      expect(chunks).toEqual(['Hello', ' world']);
      expect(result.usage.input_tokens).toBe(15);
      expect(result.usage.output_tokens).toBe(5);
      expect(result.usage.tokens).toBe(20);
    });

    it('stops calling onChunk after MAX_STREAMING_OUTPUT is exceeded', async () => {
      const maxToken = 'A'.repeat(MAX_STREAMING_OUTPUT);
      const sseData = [
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${maxToken}"}}\n\n`,
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}\n\n',
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
        'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel',
        'lo"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\ndata: [DONE]\n\n',
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      const result = await provider.submitStream('test', null, {});
      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(6);
      expect(result.usage.input_tokens).toBe(2);
      expect(result.usage.output_tokens).toBe(4);
    });

    it('ignores malformed SSE lines and continues parsing valid tokens', async () => {
      const sseData = [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'data: [not-json]\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
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
      expect(result.output).toBe('Hello world');
      expect(chunks).toEqual(['Hello', ' world']);
      expect(result.usage.tokens).toBe(9);
    });

    it('defaults stream usage to zero when no usage lines are present', async () => {
      const sseData = [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'data: [DONE]\n\n',
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
        status: 500,
        text: async () => 'Server error',
      });

      await expect(provider.submitStream('test', null, {})).rejects.toThrow(/500/);
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
          get: (name) => (name === 'Retry-After' || name === 'retry-after' ? '12' : null),
        },
        text: async () => 'Rate limited',
      });

      await expect(provider.submitStream('test', null, {})).rejects.toThrow(/retry_after_seconds=12/);
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
                  value: encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n'),
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
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
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

    it('sends stream:true and correct headers', async () => {
      const sseData = [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: [DONE]\n\n',
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream(sseData),
      });

      await provider.submitStream('test prompt', null, {});

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/v1/messages');
      const body = JSON.parse(opts.body);
      expect(body.stream).toBe(true);
      expect(opts.headers['x-api-key']).toBe('test-key-123');
      expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    });
  });
});
