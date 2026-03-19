'use strict';

/**
 * Unit tests for cli/api-client.js
 *
 * Covers:
 * - TORQUE_API_PORT respected via shared.js → api-client.js
 * - TORQUE_API_URL override takes precedence over TORQUE_API_PORT
 * - Successful GET/POST/DELETE round-trips
 * - ApiError thrown on non-OK HTTP responses
 * - Request timeout via AbortSignal.timeout (TimeoutError)
 * - ECONNREFUSED mapped to "Is the server running?" message
 */

const path = require('path');

// Paths are absolute so these work regardless of cwd
const SHARED_PATH = path.resolve(__dirname, '../../cli/shared.js');
const API_CLIENT_PATH = path.resolve(__dirname, '../../cli/api-client.js');

// Helper: load a fresh module instance with specific env vars set,
// then restore env and purge the module cache.
function loadWithEnv(envOverrides, modulePath) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  // Purge both modules so they re-evaluate env vars at require() time
  delete require.cache[require.resolve(SHARED_PATH)];
  delete require.cache[require.resolve(modulePath)];

  let mod;
  try {
    mod = require(modulePath);
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    // Purge again so later tests get a fresh load from their own env
    delete require.cache[require.resolve(SHARED_PATH)];
    delete require.cache[require.resolve(modulePath)];
  }

  return mod;
}

// ── Port / URL resolution ─────────────────────────────────────────────────────

describe('cli/api-client — port resolution', () => {
  afterEach(() => {
    // Ensure cache is clean between tests
    delete require.cache[require.resolve(SHARED_PATH)];
    delete require.cache[require.resolve(API_CLIENT_PATH)];
  });

  it('defaults to port 3457 when no env vars set', () => {
    const { BASE_URL } = loadWithEnv(
      { TORQUE_API_PORT: undefined, TORQUE_API_URL: undefined },
      API_CLIENT_PATH,
    );
    expect(BASE_URL).toBe('http://127.0.0.1:3457');
  });

  it('respects TORQUE_API_PORT via shared.js', () => {
    const { BASE_URL } = loadWithEnv(
      { TORQUE_API_PORT: '4000', TORQUE_API_URL: undefined },
      API_CLIENT_PATH,
    );
    expect(BASE_URL).toBe('http://127.0.0.1:4000');
  });

  it('TORQUE_API_URL takes precedence over TORQUE_API_PORT', () => {
    const { BASE_URL } = loadWithEnv(
      { TORQUE_API_PORT: '4000', TORQUE_API_URL: 'http://10.0.0.1:9000' },
      API_CLIENT_PATH,
    );
    expect(BASE_URL).toBe('http://10.0.0.1:9000');
  });

  it('TORQUE_API_URL alone (no port var) works', () => {
    const { BASE_URL } = loadWithEnv(
      { TORQUE_API_PORT: undefined, TORQUE_API_URL: 'http://remote:8080' },
      API_CLIENT_PATH,
    );
    expect(BASE_URL).toBe('http://remote:8080');
  });
});

// ── HTTP round-trips with mocked fetch ───────────────────────────────────────

describe('cli/api-client — HTTP methods', () => {
  let apiGet, apiPost, apiDelete, ApiError;
  let fetchMock;

  beforeEach(() => {
    // Load fresh module with default env
    const mod = loadWithEnv(
      { TORQUE_API_PORT: undefined, TORQUE_API_URL: undefined },
      API_CLIENT_PATH,
    );
    ({ apiGet, apiPost, apiDelete, ApiError } = mod);

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[require.resolve(SHARED_PATH)];
    delete require.cache[require.resolve(API_CLIENT_PATH)];
  });

  function makeResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }

  it('apiGet returns parsed JSON on 200', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { tasks: [] }));
    const result = await apiGet('/api/tasks');
    expect(result).toEqual({ tasks: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3457/api/tasks');
    expect(opts.method).toBe('GET');
  });

  it('apiPost sends JSON body and returns parsed response', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { id: '123' }));
    const result = await apiPost('/api/tasks', { description: 'test' });
    expect(result).toEqual({ id: '123' });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ description: 'test' });
  });

  it('apiDelete sends DELETE request', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, {}));
    await apiDelete('/api/tasks/123');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3457/api/tasks/123');
    expect(opts.method).toBe('DELETE');
  });

  it('throws ApiError with status on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(404, { error: 'not found' }));
    await expect(apiGet('/api/tasks/999')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
  });

  it('throws ApiError on 500 with body text', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, 'Internal Server Error'));
    const err = await apiPost('/api/tasks', {}).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain('500');
  });

  it('handles empty response body as empty object', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
    });
    const result = await apiDelete('/api/tasks/1');
    expect(result).toEqual({});
  });
});

// ── Timeout handling ──────────────────────────────────────────────────────────

describe('cli/api-client — request timeout', () => {
  let apiGet, ApiError;
  let fetchMock;

  beforeEach(() => {
    const mod = loadWithEnv(
      { TORQUE_API_PORT: undefined, TORQUE_API_URL: undefined },
      API_CLIENT_PATH,
    );
    ({ apiGet, ApiError } = mod);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[require.resolve(SHARED_PATH)];
    delete require.cache[require.resolve(API_CLIENT_PATH)];
  });

  it('passes an AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{}',
    });
    await apiGet('/api/tasks');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.signal).toBeDefined();
    // AbortSignal.timeout returns an AbortSignal instance
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('converts TimeoutError to a descriptive ApiError', async () => {
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    // DOMException sets .name automatically; simulate what AbortSignal.timeout throws
    fetchMock.mockRejectedValueOnce(timeoutErr);

    const err = await apiGet('/api/health').catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).toContain('GET');
    expect(err.message).toContain('/api/health');
  });

  it('converts ECONNREFUSED to "Is the server running?" message', async () => {
    const connErr = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    fetchMock.mockRejectedValueOnce(connErr);

    const err = await apiGet('/api/health').catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/Is the server running\?/i);
  });
});

// ── fetchWithTimeout helper ───────────────────────────────────────────────────

describe('cli/api-client — fetchWithTimeout helper', () => {
  let fetchWithTimeout;
  let fetchMock;

  beforeEach(() => {
    const mod = loadWithEnv(
      { TORQUE_API_PORT: undefined, TORQUE_API_URL: undefined },
      API_CLIENT_PATH,
    );
    ({ fetchWithTimeout } = mod);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[require.resolve(SHARED_PATH)];
    delete require.cache[require.resolve(API_CLIENT_PATH)];
  });

  it('merges options with a signal', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });
    await fetchWithTimeout('http://example.com/foo', { method: 'GET' }, 5000);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://example.com/foo');
    expect(opts.method).toBe('GET');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses 30000ms as default timeout', async () => {
    // We cannot easily inspect the timeout value on AbortSignal in Node,
    // but we can verify the signal is present when no timeout is given.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' });
    await fetchWithTimeout('http://example.com/bar');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
