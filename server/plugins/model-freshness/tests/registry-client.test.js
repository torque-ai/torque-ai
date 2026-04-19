'use strict';

const { fetchRemoteDigest, REGISTRY_BASE } = require('../registry-client');

afterEach(() => vi.restoreAllMocks());

describe('registry-client.fetchRemoteDigest', () => {
  it('returns the ollama-content-digest header on 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['ollama-content-digest', 'abcdef123']]),
    });
    const digest = await fetchRemoteDigest('qwen3-coder', '30b');
    expect(digest).toBe('abcdef123');
  });

  it('returns null on 404 (model removed from registry)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Map(),
    });
    expect(await fetchRemoteDigest('nonexistent', 'tag')).toBeNull();
  });

  it('throws on 5xx so caller can retry later', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Map(),
    });
    await expect(fetchRemoteDigest('f', 't')).rejects.toThrow(/503/);
  });

  it('throws on network failure', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchRemoteDigest('f', 't')).rejects.toThrow(/ENOTFOUND/);
  });

  it('issues a HEAD request', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: new Map([['ollama-content-digest', 'x']]),
    });
    await fetchRemoteDigest('qwen3-coder', '30b');
    const callArgs = spy.mock.calls[0];
    expect(callArgs[0]).toBe(`${REGISTRY_BASE}/v2/library/qwen3-coder/manifests/30b`);
    expect(callArgs[1].method).toBe('HEAD');
  });
});
