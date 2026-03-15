import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

const {
  createProviderAdapter,
  registerProviderAdapter,
  getProviderAdapter,
  getProviderCapabilityMatrix,
  getRegisteredProviderIds,
  isAdapterRegistered,
} = require('../providers/adapter-registry');

function makeSSEBody(chunks) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    getReader: () => ({
      cancel: vi.fn(),
      read: async () => {
        if (index >= chunks.length) {
          return { done: true, value: undefined };
        }
        return { done: false, value: encoder.encode(chunks[index++]) };
      },
    }),
  };
}

describe('provider adapter registry', () => {
  let originalAnthropicKey;

  beforeAll(() => {
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'registry-anthropic-key';
  });

  afterAll(() => {
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers expected built-in providers', () => {
    const providerIds = getRegisteredProviderIds();
    const expected = [
      'aider-ollama',
      'anthropic',
      'claude-cli',
      'codex',
      'deepinfra',
      'groq',
      'hashline-openai',
      'hashline-ollama',
      'hyperbolic',
      'ollama',
    ];

    for (const id of expected) {
      expect(providerIds).toContain(id);
    }
  });

  it('reports adapter registration status for known and unknown IDs', () => {
    expect(isAdapterRegistered('anthropic')).toBe(true);
    expect(isAdapterRegistered('hyperbolic')).toBe(true);
    expect(isAdapterRegistered('does-not-exist')).toBe(false);
  });

  it('returns null from lookup for unknown providers', () => {
    expect(getProviderAdapter('unknown-provider')).toBeNull();
    expect(createProviderAdapter('unknown-provider')).toBeNull();
  });

  it('returns cached adapter instances for repeated lookup', () => {
    const firstAdapter = getProviderAdapter('anthropic');
    const secondAdapter = getProviderAdapter('anthropic');

    expect(firstAdapter).toBeTruthy();
    expect(firstAdapter).toBe(secondAdapter);
    expect(firstAdapter.id).toBe('anthropic');
    expect(firstAdapter.supportsStream).toBe(true);
    expect(firstAdapter.supportsAsync).toBe(true);
  });

  it('creates new adapter instances with createProviderAdapter', () => {
    const first = createProviderAdapter('groq');
    const second = createProviderAdapter('groq');

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(first.id).toBe('groq');
  });

  it('builds unavailable transport adapters with consistent fallback behavior', async () => {
    const adapter = getProviderAdapter('hashline-openai');

    expect(adapter).toBeTruthy();
    expect(adapter.supportsStream).toBe(false);
    expect(adapter.supportsAsync).toBe(false);
    expect(adapter.supportsCancellation).toBe(false);

    await expect(adapter.submit('hi', 'model')).rejects.toThrow(/not implemented for v2/i);
    await expect(adapter.stream('hi', 'model')).rejects.toThrow(/not implemented for v2/i);
    await expect(adapter.submitAsync('hi', 'model')).rejects.toThrow(/not implemented for v2/i);
    await expect(adapter.cancel()).resolves.toMatchObject({ cancelled: false, supported: false });
    await expect(adapter.checkHealth()).resolves.toMatchObject({
      available: false,
      error: expect.stringMatching(/not implemented for v2/i),
    });
    await expect(adapter.listModels()).resolves.toEqual([]);
    expect(adapter.normalizeResult({ ok: true })).toEqual({ ok: true });
  });

  it('publishes provider capability matrix with expected capability flags', () => {
    const matrix = getProviderCapabilityMatrix();

    expect(matrix.anthropic).toMatchObject({
      supportsStream: true,
      supportsAsync: true,
      supportsCancellation: false,
    });
    expect(matrix.deepinfra).toMatchObject({
      supportsStream: true,
      supportsAsync: true,
      supportsCancellation: false,
    });
    expect(matrix.hyperbolic).toMatchObject({
      supportsStream: true,
      supportsAsync: true,
      supportsCancellation: false,
    });
    expect(matrix.codex).toMatchObject({
      supportsStream: false,
      supportsAsync: false,
      supportsCancellation: false,
    });
    expect(matrix['hashline-openai']).toMatchObject({
      supportsStream: false,
      supportsAsync: false,
      supportsCancellation: false,
    });
  });

  it('uses fallback errors for stream/async on non-streaming adapter chains', async () => {
    const codex = getProviderAdapter('codex');

    expect(codex.supportsStream).toBe(false);
    expect(codex.supportsAsync).toBe(false);
    await expect(codex.stream('task', 'model')).rejects.toThrow(/not implemented for v2/i);
    await expect(codex.submitAsync('task', 'model')).rejects.toThrow(/not implemented for v2/i);
  });

  it('delegates submit/checkHealth/listModels to API-backed provider adapters', async () => {
    const adapter = getProviderAdapter('anthropic');
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'adapter-output' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'claude-sonnet-4-20250514' }] }),
      });

    const submitResult = await adapter.submit('task', 'claude-sonnet-4-20250514', { maxTokens: 7 });
    const healthResult = await adapter.checkHealth();
    const modelsResult = await adapter.listModels();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(submitResult.output).toBe('adapter-output');
    expect(healthResult).toEqual({ available: true, models: ['claude-sonnet-4-20250514'] });
    expect(modelsResult).toContain('claude-sonnet-4-20250514');
  });

  it('delegates stream calls to provider streaming implementation', async () => {
    const adapter = getProviderAdapter('anthropic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: makeSSEBody([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    const chunks = [];
    const result = await adapter.stream('task', 'claude-sonnet-4-20250514', {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Hi');
    expect(result.usage.tokens).toBe(3);
    expect(chunks).toEqual(['Hi']);
  });

  it('allows runtime adapter registration and lookup for custom providers', async () => {
    const customId = 'unit-custom-registry';
    registerProviderAdapter(customId, () => ({
      id: customId,
      capabilities: { supportsStream: false, supportsAsync: true, supportsCancellation: true },
      supportsStream: false,
      supportsAsync: true,
      supportsCancellation: true,
      submit: async () => ({ output: 'custom', status: 'completed' }),
      stream: async () => ({ output: '', status: 'completed' }),
      submitAsync: async () => ({ output: 'custom-async', status: 'completed' }),
      cancel: async () => ({ cancelled: true, provider: customId, supported: true }),
      normalizeResult: (value) => ({ wrapped: value }),
      checkHealth: async () => ({ available: true, models: ['m1'] }),
      listModels: async () => ['m1'],
    }));

    expect(isAdapterRegistered(customId)).toBe(true);

    const created = createProviderAdapter(customId);
    const cached = getProviderAdapter(customId);
    const cachedAgain = getProviderAdapter(customId);

    expect(created).toBeTruthy();
    expect(cached).toBeTruthy();
    expect(created).not.toBe(cached);
    expect(cached).toBe(cachedAgain);
    await expect(cached.submitAsync()).resolves.toMatchObject({ output: 'custom-async' });

    const matrix = getProviderCapabilityMatrix();
    expect(matrix[customId]).toMatchObject({
      supportsStream: false,
      supportsAsync: true,
      supportsCancellation: true,
    });
  });
});
