import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('http', () => ({
  request: vi.fn(),
  get: vi.fn(),
}));

vi.mock('https', () => ({
  request: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../database', () => ({
  getConfig: vi.fn(),
}));

const http = require('http');
const https = require('https');
const db = require('../database');
const CerebrasProvider = require('../providers/cerebras.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

function makeSSEStream(chunks, overrides = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    getReader: () => ({
      cancel: overrides.cancel || vi.fn(),
      read: overrides.read || (async () => {
        if (index >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: encoder.encode(chunks[index++]) };
      }),
    }),
  };
}

describe('CerebrasProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new CerebrasProvider({ apiKey: 'test-cerebras-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('sets name to cerebras', () => {
      expect(provider.name).toBe('cerebras');
    });

    it('stores provided apiKey', () => {
      expect(provider.apiKey).toBe('test-cerebras-key');
    });

    it('uses env var for API key when not provided', () => {
      const origKey = process.env.CEREBRAS_API_KEY;
      process.env.CEREBRAS_API_KEY = 'env-cerebras-key';

      const p = new CerebrasProvider();

      expect(p.apiKey).toBe('env-cerebras-key');

      if (origKey) process.env.CEREBRAS_API_KEY = origKey;
      else delete process.env.CEREBRAS_API_KEY;
    });

    it('uses default model and baseUrl when not provided', () => {
      expect(provider.defaultModel).toBe('qwen-3-235b-a22b-instruct-2507');
      expect(provider.baseUrl).toBe('https://api.cerebras.ai');
    });

    it('accepts custom defaultModel and baseUrl', () => {
      const p = new CerebrasProvider({
        apiKey: 'k',
        defaultModel: 'gpt-oss-120b',
        baseUrl: 'http://localhost:4040',
      });

      expect(p.defaultModel).toBe('gpt-oss-120b');
      expect(p.baseUrl).toBe('http://localhost:4040');
    });

    it('initializes activeTasks to 0', () => {
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key', async () => {
      const p = new CerebrasProvider({ apiKey: '' });

      const result = await p.checkHealth();

      expect(result.available).toBe(false);
      expect(result.error).toMatch(/No API key/);
    });

    it('returns available with models on successful probe', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'llama3.1-8b' }, { id: 'qwen-3-235b-a22b-instruct-2507' }],
        }),
      });

      const result = await provider.checkHealth();

      expect(result).toEqual({
        available: true,
        models: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507'],
      });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.cerebras.ai/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-cerebras-key' },
        })
      );
    });

    it('falls back to default model when response has no data array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: true }),
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(true);
      expect(result.models).toEqual(['qwen-3-235b-a22b-instruct-2507']);
    });

    it('filters out falsy model ids', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-oss-120b' }, { id: '' }, { id: null }] }),
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(true);
      expect(result.models).toEqual(['gpt-oss-120b']);
    });

    it('returns unavailable on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 503,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.error).toContain('503');
    });

    it('returns unavailable on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('returns unavailable on timeout abort', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });

  describe('submit', () => {
    it('throws when no API key', async () => {
      const p = new CerebrasProvider({ apiKey: '' });

      await expect(p.submit('test task', null, {})).rejects.toThrow(/API key/);
    });

    it('returns completed result on success and sends expected request body', async () => {
      const httpRequestSpy = vi.spyOn(http, 'request');
      const httpsRequestSpy = vi.spyOn(https, 'request');
      const dbGetConfigSpy = vi.spyOn(db, 'getConfig');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response text' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      });

      const result = await provider.submit('test task', null, {
        maxTokens: 222,
        working_directory: '/tmp/project',
        files: ['a.js', 'b.js'],
        tuning: { temperature: 0.25 },
      });

      const [url, options] = fetchSpy.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-cerebras-key',
      });
      expect(body).toEqual({
        model: 'qwen-3-235b-a22b-instruct-2507',
        messages: [{
          role: 'user',
          content: 'Files: a.js, b.js\n\nWorking directory: /tmp/project\n\ntest task',
        }],
        max_tokens: 222,
        temperature: 0.25,
      });
      expect(result.status).toBe('completed');
      expect(result.output).toBe('response text');
      expect(result.usage).toEqual(expect.objectContaining({
        tokens: 150,
        input_tokens: 100,
        output_tokens: 50,
        model: 'qwen-3-235b-a22b-instruct-2507',
      }));
      expect(result.usage.cost).toBeCloseTo(0.00009, 10);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(httpsRequestSpy).not.toHaveBeenCalled();
      expect(dbGetConfigSpy).not.toHaveBeenCalled();
    });

    it('uses the specified model when provided', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
      });

      const result = await provider.submit('task', 'zai-glm-4.7', {});

      expect(result.usage.model).toBe('zai-glm-4.7');
      expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('zai-glm-4.7');
    });

    it('returns empty output when choices are missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
      });

      const result = await provider.submit('task', null, {});

      expect(result.output).toBe('');
    });

    it('defaults usage fields to zero when usage payload is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'no usage payload' } }],
        }),
      });

      const result = await provider.submit('task', null, {});

      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('throws auth-shaped error text for unauthorized responses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'bad key',
        headers: { get: () => null },
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        /authentication failed or unauthorized: bad key/
      );
    });

    it('includes retry_after_seconds when a 429 response provides Retry-After', async () => {
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

    it('returns timeout when fetch aborts', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

      const result = await provider.submit('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('uses configured timeout option to schedule cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      await provider.submit('task', null, { timeout: 2 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
    });

    it('returns timeout when an external signal is aborted', async () => {
      const abortController = new AbortController();
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, { signal }) => {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          }, { once: true });
        });
      });

      const resultPromise = provider.submit('task', null, { signal: abortController.signal });
      await Promise.resolve();
      abortController.abort();

      const result = await resultPromise;

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('removes external abort listener and decrements activeTasks after submit settles', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      await provider.submit('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
      expect(provider.activeTasks).toBe(0);
    });

    it('decrements activeTasks after a request error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'server error',
        headers: { get: () => null },
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('submitStream', () => {
    it('throws when no API key', async () => {
      const p = new CerebrasProvider({ apiKey: '' });

      await expect(p.submitStream('test', null, {})).rejects.toThrow(/API key/);
    });

    it('reports supportsStreaming as true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });

    it('parses an OpenAI-compatible SSE stream and reports usage', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
          'data: [DONE]\n\n',
        ]),
      });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (token) => chunks.push(token),
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello world');
      expect(chunks).toEqual(['Hello', ' world']);
      expect(result.usage).toEqual(expect.objectContaining({
        tokens: 11,
        input_tokens: 8,
        output_tokens: 3,
        model: 'qwen-3-235b-a22b-instruct-2507',
      }));
      expect(result.usage.cost).toBeCloseTo(0.0000066, 10);
    });

    it('sends stream:true in the streaming request body', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      });

      await provider.submitStream('task', null, { maxTokens: 17, tuning: { temperature: 0.6 } });

      const [url, options] = fetchSpy.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
      expect(options.headers.Authorization).toBe('Bearer test-cerebras-key');
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(17);
      expect(body.temperature).toBe(0.6);
    });

    it('parses SSE tokens split across chunk boundaries', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"Hel',
          'lo"}}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":4,"total_tokens":6}}\n\ndata: [DONE]\n\n',
        ]),
      });

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(6);
      expect(result.usage.input_tokens).toBe(2);
      expect(result.usage.output_tokens).toBe(4);
    });

    it('ignores malformed SSE lines and continues with valid chunks', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: [bad-json]\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
          'data: [DONE]\n\n',
        ]),
      });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (token) => chunks.push(token),
      });

      expect(result.output).toBe('Hello world');
      expect(chunks).toEqual(['Hello', ' world']);
      expect(result.usage.tokens).toBe(15);
    });

    it('defaults stream usage to zero when no usage chunk is present', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      });

      const result = await provider.submitStream('task', null, {});

      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('truncates output after MAX_STREAMING_OUTPUT and stops emitting extra chunks', async () => {
      const largeChunk = 'A'.repeat(MAX_STREAMING_OUTPUT);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream([
          `data: {"choices":[{"delta":{"content":"${largeChunk}"}}]}\n\n`,
          'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      });

      const chunks = [];
      const result = await provider.submitStream('task', null, {
        onChunk: (token) => chunks.push(token),
      });

      expect(chunks).toEqual([largeChunk]);
      expect(result.output.endsWith('[...OUTPUT TRUNCATED...]')).toBe(true);
      expect(result.output.includes('B')).toBe(false);
    });

    it('throws auth-shaped streaming errors for forbidden responses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
        headers: { get: () => null },
      });

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        /Cerebras streaming API error \(403\): authentication failed or unauthorized: forbidden/
      );
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

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(/retry_after_seconds=20/);
    });

    it('returns timeout on streaming abort', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('cancels the stream reader when an external signal aborts mid-stream', async () => {
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

      const resultPromise = provider.submitStream('task', null, { signal: abortController.signal });
      await Promise.resolve();
      abortController.abort();

      const result = await resultPromise;

      expect(result.status).toBe('timeout');
      expect(readerCancel).toHaveBeenCalledTimes(1);
    });

    it('removes external abort listener and decrements activeTasks after streaming settles', async () => {
      const httpGetSpy = vi.spyOn(http, 'get');
      const httpsGetSpy = vi.spyOn(https, 'get');
      const dbGetConfigSpy = vi.spyOn(db, 'getConfig');
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      });

      await provider.submitStream('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
      expect(provider.activeTasks).toBe(0);
      expect(httpGetSpy).not.toHaveBeenCalled();
      expect(httpsGetSpy).not.toHaveBeenCalled();
      expect(dbGetConfigSpy).not.toHaveBeenCalled();
    });
  });

  describe('listModels', () => {
    it('returns the static Cerebras model list', async () => {
      const models = await provider.listModels();

      expect(models).toEqual([
        'llama3.1-8b',
        'qwen-3-235b-a22b-instruct-2507',
        'gpt-oss-120b',
        'zai-glm-4.7',
      ]);
    });
  });

  describe('_buildPrompt', () => {
    it('returns task as-is when no options are provided', () => {
      expect(provider._buildPrompt('do something', {})).toBe('do something');
    });

    it('prepends working_directory and files in provider order', () => {
      const prompt = provider._buildPrompt('do something', {
        working_directory: '/project',
        files: ['main.js', 'util.js'],
      });

      expect(prompt).toBe('Files: main.js, util.js\n\nWorking directory: /project\n\ndo something');
    });

    it('ignores an empty files array', () => {
      expect(provider._buildPrompt('do something', { files: [] })).toBe('do something');
    });
  });
});
