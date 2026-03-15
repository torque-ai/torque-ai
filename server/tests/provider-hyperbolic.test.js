import { describe, it, expect, vi, afterEach } from 'vitest';

const HyperbolicProvider = require('../providers/hyperbolic.js');
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

describe('provider hyperbolic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validates API key before submit', async () => {
    const provider = new HyperbolicProvider({ apiKey: '' });
    await expect(provider.submit('task', null, {})).rejects.toThrow(/API key/i);
  });

  it('formats OpenAI-compatible submit request with default model', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    });

    await provider.submit('Review bug', null, {
      maxTokens: 50,
      tuning: { temperature: 0.3 },
    });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.hyperbolic.xyz/v1/chat/completions');
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer hyperbolic-key',
    });

    const body = JSON.parse(options.body);
    expect(body.model).toBe('Qwen/Qwen2.5-72B-Instruct');
    expect(body.max_tokens).toBe(50);
    expect(body.temperature).toBe(0.3);
  });

  it('routes explicit model and returns it in usage metadata', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'model output' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const result = await provider.submit('task', 'meta-llama/Llama-3.1-70B-Instruct', {});
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.model).toBe('meta-llama/Llama-3.1-70B-Instruct');
    expect(result.usage.model).toBe('meta-llama/Llama-3.1-70B-Instruct');
  });

  it('parses output and usage fields from submit responses', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'final answer' } }],
        usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
      }),
    });

    const result = await provider.submit('task', null, {});
    expect(result.status).toBe('completed');
    expect(result.output).toBe('final answer');
    expect(result.usage.tokens).toBe(20);
    expect(result.usage.input_tokens).toBe(11);
    expect(result.usage.output_tokens).toBe(9);
  });

  it('builds auth-aware errors for unauthorized responses', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'denied',
    });

    await expect(provider.submit('task', null, {})).rejects.toThrow(/authentication failed or unauthorized/i);
  });

  it('includes retry_after_seconds when rate-limit headers are returned', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      headers: {
        get: (name) => (name.toLowerCase() === 'retry-after' ? '6' : null),
      },
      text: async () => 'rate limit',
    });

    await expect(provider.submit('task', null, {})).rejects.toThrow(/retry_after_seconds=6/);
  });

  it('returns timeout status on submit AbortError', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError());

    const result = await provider.submit('task', null, {});
    expect(result.status).toBe('timeout');
    expect(result.output).toBe('');
    expect(result.usage.tokens).toBe(0);
  });

  it('formats streaming requests and parses token deltas', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    const { body, onCancel } = makeSSEBody([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, body });

    const chunks = [];
    const result = await provider.submitStream('task', null, { onChunk: (chunk) => chunks.push(chunk) });

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.stream).toBe(true);
    expect(result.output).toBe('Hello there');
    expect(result.usage.tokens).toBe(6);
    expect(chunks).toEqual(['Hello', ' there']);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('handles malformed/split SSE lines and still parses valid chunks', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    const { body } = makeSSEBody([
      'data: {"choices":[{"delta":{"content":"He',
      'llo"}}]}\n\ndata: [not-json]\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, body });

    const result = await provider.submitStream('task', null, {});
    expect(result.output).toBe('Hello!');
    expect(result.usage.tokens).toBe(2);
  });

  it('truncates streaming output after MAX_STREAMING_OUTPUT', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    const maxChunk = 'A'.repeat(MAX_STREAMING_OUTPUT);
    const { body } = makeSSEBody([
      `data: {"choices":[{"delta":{"content":"${maxChunk}"}}]}\n\n`,
      'data: {"choices":[{"delta":{"content":"Z"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, body });

    const result = await provider.submitStream('task', null, {});
    expect(result.output).toContain('[...OUTPUT TRUNCATED...]');
    expect(result.output).not.toContain(`${maxChunk}Z`);
  });

  it('returns timeout for streaming AbortError failures', async () => {
    const provider = new HyperbolicProvider({ apiKey: 'hyperbolic-key' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError());

    const result = await provider.submitStream('task', null, {});
    expect(result.status).toBe('timeout');
    expect(result.output).toBe('');
    expect(result.usage.tokens).toBe(0);
  });
});
