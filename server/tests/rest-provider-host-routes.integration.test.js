const BASE_URL = (process.env.TORQUE_INTEGRATION_BASE_URL || '').trim();
const API_KEY = process.env.TORQUE_INTEGRATION_KEY || '';
const TEST_HOST_ID = process.env.TORQUE_INTEGRATION_HOST_ID || 'non-existent-host-for-route-check';

const describeIntegration = BASE_URL ? describe : describe.skip;
const GET_STATUSES = [200, 401];
const MUTATION_STATUSES = [200, 400, 401];

function hasErrorMessage(payload) {
  return (
    typeof payload?.error === 'string' ||
    typeof payload?.error?.message === 'string'
  );
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (API_KEY) {
    headers['X-Torque-Key'] = API_KEY;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  return { response, payload };
}

describeIntegration('REST provider/host route integration (running TORQUE server)', () => {
  it('GET /api/providers returns tool-backed provider payload', async () => {
    const { response, payload } = await request('/api/providers');
    expect(GET_STATUSES).toContain(response.status);
    if (response.status === 200) {
      expect(payload.tool).toBe('list_providers');
      expect(typeof payload.result).toBe('string');
    } else {
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('POST /api/providers/configure is routed (validation response path)', async () => {
    const { response, payload } = await request('/api/providers/configure', {
      method: 'POST',
      body: {},
    });
    expect(MUTATION_STATUSES).toContain(response.status);
    if (response.status === 200) {
      expect(payload.tool).toBe('configure_provider');
    } else {
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('POST /api/providers/default is routed (validation response path)', async () => {
    const { response, payload } = await request('/api/providers/default', {
      method: 'POST',
      body: {},
    });
    expect(MUTATION_STATUSES).toContain(response.status);
    if (response.status === 200) {
      expect(payload.tool).toBe('set_default_provider');
    } else {
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('GET /api/ollama/hosts returns host list route payload', async () => {
    const { response, payload } = await request('/api/ollama/hosts?enabled_only=true');
    expect(GET_STATUSES).toContain(response.status);
    if (response.status === 200) {
      expect(payload.tool).toBe('list_ollama_hosts');
      expect(typeof payload.result).toBe('string');
    } else {
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('POST /api/ollama/hosts validates body on mapped add host route', async () => {
    const { response, payload } = await request('/api/ollama/hosts', {
      method: 'POST',
      body: {},
    });
    expect(MUTATION_STATUSES).toContain(response.status);
    if (response.status === 200) {
      expect(payload.tool).toBe('add_ollama_host');
    } else {
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('host-id path routes for enable/disable/refresh/remove are mounted', async () => {
    const checks = [
      { method: 'POST', path: `/api/ollama/hosts/${encodeURIComponent(TEST_HOST_ID)}/enable` },
      { method: 'POST', path: `/api/ollama/hosts/${encodeURIComponent(TEST_HOST_ID)}/disable` },
      { method: 'POST', path: `/api/ollama/hosts/${encodeURIComponent(TEST_HOST_ID)}/refresh-models` },
      { method: 'DELETE', path: `/api/ollama/hosts/${encodeURIComponent(TEST_HOST_ID)}` },
    ];

    for (const check of checks) {
      const { response, payload } = await request(check.path, { method: check.method });
      expect(MUTATION_STATUSES).toContain(response.status);
      if (response.status === 200) {
        expect(typeof payload.tool).toBe('string');
      } else {
        expect(hasErrorMessage(payload)).toBe(true);
      }
    }
  });
});
