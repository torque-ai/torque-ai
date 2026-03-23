import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loggerDebug, loggerChild } = vi.hoisted(() => {
  const debug = vi.fn();
  const child = vi.fn(() => ({ debug }));
  return { loggerDebug: debug, loggerChild: child };
});

vi.mock('../logger', () => ({
  default: { child: loggerChild },
  child: loggerChild,
}));

const AnthropicProvider = require('../providers/anthropic.js');
const { MAX_STREAMING_OUTPUT } = require('../constants');

function abortError(message = 'aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function makeSSEBody(chunks, onCancel = vi.fn()) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    body: {
      getReader: () => ({
        cancel: onCancel,
        read: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: encoder.encode(chunks[index++]) };
        },
      }),
    },
    onCancel,
  };
}

describe('AnthropicProvider', () => {
  let provider;
  let fetchMock;
  let originalApiKey;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    vi.stubGlobal('fetch', vi.fn());
    fetchMock = globalThis.fetch;
    provider = new AnthropicProvider({ apiKey: 'anthropic-key' });

    loggerDebug.mockClear();
    loggerChild.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  describe('constructor', () => {
    it('sets anthropic defaults and initializes activeTasks', () => {
      expect(provider.name).toBe('anthropic');
      expect(provider.apiKey).toBe('anthropic-key');
      expect(provider.baseUrl).toBe('https://api.anthropic.com');
      expect(provider.defaultModel).toBe('claude-sonnet-4-20250514');
      expect(provider.activeTasks).toBe(0);
    });

    it('loads API key from environment when config key is missing', () => {
      process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';

      const envProvider = new AnthropicProvider();
      expect(envProvider.apiKey).toBe('env-anthropic-key');
    });

    it('prefers config apiKey over environment value', () => {
      process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';

      const configProvider = new AnthropicProvider({ apiKey: 'config-key' });
      expect(configProvider.apiKey).toBe('config-key');
    });

    it('accepts custom baseUrl and defaultModel', () => {
      const customProvider = new AnthropicProvider({
        apiKey: 'anthropic-key',
        baseUrl: 'http://localhost:9090',
        defaultModel: 'claude-haiku-4-20250514',
      });

      expect(customProvider.baseUrl).toBe('http://localhost:9090');
      expect(customProvider.defaultModel).toBe('claude-haiku-4-20250514');
    });
  });

  describe('_buildPrompt', () => {
    it('returns the task as-is when no options are provided', () => {
      expect(provider._buildPrompt('Implement parser', {})).toBe('Implement parser');
    });

    it('prepends files and working directory in Anthropic prompt order', () => {
      expect(provider._buildPrompt('Implement parser', {
        files: ['src/a.js', 'src/b.js'],
        working_directory: '/repo',
      })).toBe('Files: src/a.js, src/b.js\n\nWorking directory: /repo\n\nImplement parser');
    });

    it('prepends only the working directory when files are absent', () => {
      expect(provider._buildPrompt('Implement parser', {
        working_directory: '/repo',
      })).toBe('Working directory: /repo\n\nImplement parser');
    });

    it('ignores an empty files array', () => {
      expect(provider._buildPrompt('Implement parser', {
        files: [],
      })).toBe('Implement parser');
    });
  });

  describe('_estimateCost', () => {
    it('returns 0 when usage is missing', () => {
      expect(provider._estimateCost(null, provider.defaultModel)).toBe(0);
    });

    it('calculates sonnet pricing from input and output tokens', () => {
      expect(provider._estimateCost({
        input_tokens: 1000,
        output_tokens: 2000,
      }, 'claude-sonnet-4-20250514')).toBeCloseTo(0.033, 10);
    });

    it('calculates haiku pricing from input and output tokens', () => {
      expect(provider._estimateCost({
        input_tokens: 1000,
        output_tokens: 2000,
      }, 'claude-haiku-4-20250514')).toBeCloseTo(0.00275, 10);
    });

    it('falls back to sonnet pricing for unknown models', () => {
      expect(provider._estimateCost({
        input_tokens: 1000,
        output_tokens: 2000,
      }, 'claude-unknown')).toBeCloseTo(0.033, 10);
    });
  });

  describe('supportsStreaming', () => {
    it('returns true', () => {
      expect(provider.supportsStreaming).toBe(true);
    });
  });

  describe('listModels', () => {
    it('returns the static Anthropic model list', async () => {
      await expect(provider.listModels()).resolves.toEqual([
        'claude-sonnet-4-20250514',
        'claude-haiku-4-20250514',
        'claude-opus-4-20250514',
      ]);
    });
  });

  describe('submit', () => {
    it('throws when no API key is configured', async () => {
      const noKeyProvider = new AnthropicProvider({ apiKey: '' });

      await expect(noKeyProvider.submit('task', null, {})).rejects.toThrow(/API key/i);
    });

    it('formats requests with Anthropic headers and prompt payload', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
      });

      const result = await provider.submit('Implement parser', null, {
        files: ['src/a.js', 'src/b.js'],
        working_directory: '/repo',
        maxTokens: 111,
        tuning: { temperature: 0.4 },
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'anthropic-key',
          'anthropic-version': '2023-06-01',
        },
        signal: expect.any(AbortSignal),
      }));

      const body = JSON.parse(options.body);
      expect(body).toEqual({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 111,
        temperature: 0.4,
        messages: [{
          role: 'user',
          content: 'Files: src/a.js, src/b.js\n\nWorking directory: /repo\n\nImplement parser',
        }],
      });
      expect(result.output).toBe('done');
      expect(result.status).toBe('completed');
    });

    it('uses default max_tokens and omits temperature when tuning is absent', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      await provider.submit('task', null, {});

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBeUndefined();
    });

    it('uses the explicit model when one is provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      const result = await provider.submit('task', 'claude-haiku-4-20250514', {});
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);

      expect(body.model).toBe('claude-haiku-4-20250514');
      expect(result.usage.model).toBe('claude-haiku-4-20250514');
    });

    it('falls back to the configured defaultModel when no model is provided', async () => {
      const customProvider = new AnthropicProvider({
        apiKey: 'anthropic-key',
        defaultModel: 'claude-opus-4-20250514',
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      });

      const result = await customProvider.submit('task', null, {});
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);

      expect(body.model).toBe('claude-opus-4-20250514');
      expect(result.usage.model).toBe('claude-opus-4-20250514');
    });

    it('parses text blocks into output and usage metadata', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            { type: 'tool_use', name: 'ignored-tool' },
            { type: 'text', text: 'line-1' },
            { type: 'text', text: 'line-2' },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      });

      const result = await provider.submit('task', null, {});

      expect(result).toEqual(expect.objectContaining({
        output: 'line-1\nline-2',
        status: 'completed',
        usage: expect.objectContaining({
          tokens: 14,
          input_tokens: 10,
          output_tokens: 4,
          model: 'claude-sonnet-4-20250514',
        }),
      }));
      expect(result.usage.cost).toBeCloseTo(0.00009, 10);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns empty output and zeroed usage when response content is missing', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await provider.submit('task', null, {});

      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
    });

    it('builds auth-aware 401 error messages', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => 'invalid key',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'Anthropic API error (401): authentication failed or unauthorized: invalid key'
      );
    });

    it('builds auth-aware 403 error messages', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => 'forbidden',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'Anthropic API error (403): authentication failed or unauthorized: forbidden'
      );
    });

    it('includes retry_after_seconds in rate-limit errors', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        headers: {
          get: (name) => (name.toLowerCase() === 'retry-after' ? '7' : null),
        },
        text: async () => 'rate limited',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'Anthropic API error (429): rate limited retry_after_seconds=7'
      );
    });

    it('builds non-auth server error messages for 500 responses', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'internal server error',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(
        'Anthropic API error (500): internal server error'
      );
    });

    it('uses the configured timeout option to schedule request cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      });

      await provider.submit('task', null, { timeout: 2 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 1000);
    });

    it('returns timeout metadata when fetch rejects with AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submit('task', null, {});

      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
      expect(provider.activeTasks).toBe(0);
    });

    it('returns timeout when an external signal aborts the request', async () => {
      const externalController = new AbortController();

      fetchMock.mockImplementation((_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      }));

      const resultPromise = provider.submit('task', null, { signal: externalController.signal });
      await Promise.resolve();
      externalController.abort();

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
    });

    it('adds and removes external abort listeners after success', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      await provider.submit('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
    });

    it('decrements activeTasks after successful and failed submissions', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      await provider.submit('task', null, {});
      expect(provider.activeTasks).toBe(0);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'boom',
      });

      await expect(provider.submit('task', null, {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });
  });

  describe('submitStream', () => {
    it('throws when no API key is configured', async () => {
      const noKeyProvider = new AnthropicProvider({ apiKey: '' });

      await expect(noKeyProvider.submitStream('task', null, {})).rejects.toThrow(/API key/i);
    });

    it('formats streaming requests and parses Anthropic SSE events', async () => {
      const { body, onCancel } = makeSSEBody([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
        'data: [DONE]\n\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const chunks = [];
      const result = await provider.submitStream('stream task', null, {
        maxTokens: 77,
        onChunk: (chunk) => chunks.push(chunk),
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options).toEqual(expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'anthropic-key',
          'anthropic-version': '2023-06-01',
        },
        signal: expect.any(AbortSignal),
      }));

      const requestBody = JSON.parse(options.body);
      expect(requestBody).toEqual({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 77,
        stream: true,
        messages: [{
          role: 'user',
          content: 'stream task',
        }],
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello world');
      expect(result.usage.input_tokens).toBe(9);
      expect(result.usage.output_tokens).toBe(4);
      expect(result.usage.tokens).toBe(13);
      expect(chunks).toEqual(['Hello', ' world']);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('uses the explicit model for streaming requests and usage metadata', async () => {
      const { body } = makeSSEBody([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', 'claude-haiku-4-20250514', {});
      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      expect(requestBody.model).toBe('claude-haiku-4-20250514');
      expect(result.usage.model).toBe('claude-haiku-4-20250514');
    });

    it('uses default streaming max_tokens and omits temperature when tuning is absent', async () => {
      const { body } = makeSSEBody([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', null, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.max_tokens).toBe(4096);
      expect(requestBody.temperature).toBeUndefined();
      expect(requestBody.stream).toBe(true);
    });

    it('continues stream parsing across chunk boundaries and malformed data', async () => {
      const { body } = makeSSEBody([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He',
        'llo"}}\n\ndata: [bad-json]\n\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\ndata: [DONE]\n\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});
      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(5);
      expect(result.usage.input_tokens).toBe(2);
      expect(result.usage.output_tokens).toBe(3);
    });

    it('ignores non-data lines and non-text delta payloads', async () => {
      const { body } = makeSSEBody([
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        ': comment line\n\n',
        'data: [DONE]\n\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});
      expect(result.output).toBe('Hello');
      expect(result.usage.tokens).toBe(0);
    });

    it('defaults streaming usage to zero when no usage events arrive', async () => {
      const { body } = makeSSEBody([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
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

    it('truncates streamed output once MAX_STREAMING_OUTPUT is reached', async () => {
      const maxChunk = 'A'.repeat(MAX_STREAMING_OUTPUT);
      const { body } = makeSSEBody([
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${maxChunk}"}}\n\n`,
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"C"}}\n\n',
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
      expect(result.output.split('[...OUTPUT TRUNCATED...]')).toHaveLength(2);
      expect(result.output).not.toContain(`${maxChunk}B`);
    });

    it('builds auth-aware streaming errors for 403 responses', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => 'forbidden',
      });

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        'Anthropic streaming API error (403): authentication failed or unauthorized: forbidden'
      );
    });

    it('includes retry_after_seconds in streaming rate-limit errors', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        headers: {
          get: (name) => (name.toLowerCase() === 'retry-after' ? '11' : null),
        },
        text: async () => 'rate limited',
      });

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        'Anthropic streaming API error (429): rate limited retry_after_seconds=11'
      );
    });

    it('builds non-auth streaming server errors for 500 responses', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'server error',
      });

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(
        'Anthropic streaming API error (500): server error'
      );
    });

    it('uses the configured timeout option to schedule stream cancellation', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const { body } = makeSSEBody([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', null, { timeout: 3 });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3 * 60 * 1000);
    });

    it('returns timeout metadata when streaming setup fails with AbortError', async () => {
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.submitStream('task', null, {});
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(result.usage.cost).toBe(0);
      expect(result.usage.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns timeout when an external signal aborts mid-stream and cleans up the reader', async () => {
      const externalController = new AbortController();
      const encoder = new TextEncoder();
      const readerCancel = vi.fn();
      let requestSignal;
      let readCount = 0;

      fetchMock.mockImplementation(async (_url, options) => {
        requestSignal = options.signal;

        return {
          ok: true,
          body: {
            getReader: () => ({
              cancel: readerCancel,
              read: async () => {
                readCount++;
                if (readCount === 1) {
                  return {
                    done: false,
                    value: encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n'),
                  };
                }

                if (requestSignal.aborted) {
                  throw abortError();
                }

                await new Promise(resolve => {
                  requestSignal.addEventListener('abort', resolve, { once: true });
                });
                throw abortError();
              },
            }),
          },
        };
      });

      const resultPromise = provider.submitStream('task', null, { signal: externalController.signal });
      await Promise.resolve();
      externalController.abort();

      const result = await resultPromise;
      expect(result.status).toBe('timeout');
      expect(result.output).toBe('');
      expect(result.usage.tokens).toBe(0);
      expect(readerCancel).toHaveBeenCalledTimes(1);
    });

    it('adds and removes external abort listeners after successful streaming submit', async () => {
      const signal = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const { body } = makeSSEBody([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      ]);

      fetchMock.mockResolvedValue({ ok: true, body });

      await provider.submitStream('task', null, { signal });

      expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const abortHandler = signal.addEventListener.mock.calls[0][1];
      expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortHandler);
    });

    it('decrements activeTasks after successful and failed streaming submissions', async () => {
      const { body } = makeSSEBody([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      ]);

      fetchMock.mockResolvedValueOnce({ ok: true, body });
      await provider.submitStream('task', null, {});
      expect(provider.activeTasks).toBe(0);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'boom',
      });

      await expect(provider.submitStream('task', null, {})).rejects.toThrow(/500/);
      expect(provider.activeTasks).toBe(0);
    });

    it('swallows stream reader cleanup failures without failing the stream result', async () => {
      const onCancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
      const { body } = makeSSEBody([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      ], onCancel);

      fetchMock.mockResolvedValue({ ok: true, body });

      const result = await provider.submitStream('task', null, {});

      expect(result.status).toBe('completed');
      expect(result.output).toBe('ok');
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkHealth', () => {
    it('returns unavailable when no API key is configured', async () => {
      const noKeyProvider = new AnthropicProvider({ apiKey: '' });

      await expect(noKeyProvider.checkHealth()).resolves.toEqual({
        available: false,
        models: [],
        error: 'No API key configured',
      });
    });

    it('fetches the models endpoint with Anthropic headers and filters model ids', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-4-20250514' },
            { id: 'claude-haiku-4-20250514' },
            { id: '' },
            {},
          ],
        }),
      });

      const result = await provider.checkHealth();

      expect(result).toEqual({
        available: true,
        models: [
          { model_name: 'claude-sonnet-4-20250514', id: 'claude-sonnet-4-20250514', owned_by: null, context_window: null },
          { model_name: 'claude-haiku-4-20250514', id: 'claude-haiku-4-20250514', owned_by: null, context_window: null },
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models',
        expect.objectContaining({
          headers: {
            'x-api-key': 'anthropic-key',
            'anthropic-version': '2023-06-01',
          },
          signal: expect.any(AbortSignal),
        })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    });

    it('falls back to defaultModel when the models payload is missing', async () => {
      const customProvider = new AnthropicProvider({
        apiKey: 'anthropic-key',
        defaultModel: 'claude-opus-4-20250514',
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: 'format' }),
      });

      await expect(customProvider.checkHealth()).resolves.toEqual({
        available: true,
        models: [{ model_name: 'claude-opus-4-20250514' }],
      });
    });

    it('returns unavailable when the API responds with a non-OK status', async () => {
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
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1);
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      const result = await provider.checkHealth();
      expect(result).toEqual({
        available: false,
        models: [],
        error: 'ECONNRESET',
      });
    });

    it('returns unavailable with a timeout-specific message on AbortError', async () => {
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1);
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
      fetchMock.mockRejectedValue(abortError());

      const result = await provider.checkHealth();
      expect(result).toEqual({
        available: false,
        models: [],
        error: 'Health check timed out (5s)',
      });
    });

    it('uses the configured baseUrl for health checks', async () => {
      const customProvider = new AnthropicProvider({
        apiKey: 'anthropic-key',
        baseUrl: 'http://localhost:8080',
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'claude-sonnet-4-20250514' }] }),
      });

      await customProvider.checkHealth();
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/v1/models');
    });
  });
});
