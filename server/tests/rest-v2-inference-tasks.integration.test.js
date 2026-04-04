// SKIP REASON: Requires a running TORQUE server. Set TORQUE_INTEGRATION_BASE_URL,
// _KEY, and _TASK_ID env vars to enable. Skipped in CI/unit test runs.
const BASE_URL = (process.env.TORQUE_INTEGRATION_BASE_URL || '').trim();
const API_KEY = process.env.TORQUE_INTEGRATION_KEY || '';
const TEST_TASK_ID = process.env.TORQUE_INTEGRATION_TASK_ID || 'non-existent-v2-task-for-route-check';
const TEST_PROVIDER_ID = process.env.TORQUE_INTEGRATION_PROVIDER_ID || 'non-existent-provider-route-check';

const describeIntegration = BASE_URL ? describe : describe.skip;

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

function hasErrorMessage(payload) {
  return (
    typeof payload?.error === 'string'
    || typeof payload?.error?.message === 'string'
  );
}

function hasV2RequestId(payload) {
  return (
    typeof payload?.request_id === 'string'
    || typeof payload?.error?.request_id === 'string'
  );
}

describeIntegration('REST v2 inference/task route integration (running TORQUE server)', () => {
  it('POST /api/v2/inference validates request body path', async () => {
    const { response, payload } = await request('/api/v2/inference', {
      method: 'POST',
      body: {},
    });

    expect([400, 401]).toContain(response.status);
    expect(hasV2RequestId(payload)).toBe(true);

    if (response.status === 400) {
      expect(payload?.error?.code).toBe('validation_error');
      expect(hasErrorMessage(payload)).toBe(true);
    } else {
      expect(payload?.error?.code).toBe('unauthorized');
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('POST /api/v2/inference returns provider_not_found for unknown provider route', async () => {
    const { response, payload } = await request('/api/v2/inference', {
      method: 'POST',
      body: {
        provider: TEST_PROVIDER_ID,
        model: 'route-check-model',
        messages: [{ role: 'user', content: 'Route mount check' }],
        stream: false,
      },
    });

    expect([404, 401]).toContain(response.status);
    expect(hasV2RequestId(payload)).toBe(true);

    if (response.status === 404) {
      expect(payload?.error?.code).toBe('provider_not_found');
      expect(hasErrorMessage(payload)).toBe(true);
    } else {
      expect(payload?.error?.code).toBe('unauthorized');
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('GET /api/v2/tasks/{task_id} not-found path is mounted', async () => {
    const { response, payload } = await request(`/api/v2/tasks/${encodeURIComponent(TEST_TASK_ID)}`);

    expect([404, 401]).toContain(response.status);
    expect(hasV2RequestId(payload)).toBe(true);

    if (response.status === 404) {
      expect(payload?.error?.code).toBe('task_not_found');
      expect(hasErrorMessage(payload)).toBe(true);
    } else {
      expect(payload?.error?.code).toBe('unauthorized');
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('POST /api/v2/tasks/{task_id}/cancel not-found path is mounted', async () => {
    const { response, payload } = await request(`/api/v2/tasks/${encodeURIComponent(TEST_TASK_ID)}/cancel`, {
      method: 'POST',
    });

    expect([404, 401]).toContain(response.status);
    expect(hasV2RequestId(payload)).toBe(true);

    if (response.status === 404) {
      expect(payload?.error?.code).toBe('task_not_found');
      expect(hasErrorMessage(payload)).toBe(true);
    } else {
      expect(payload?.error?.code).toBe('unauthorized');
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });

  it('GET /api/v2/tasks/{task_id}/events not-found path is mounted', async () => {
    const { response, payload } = await request(`/api/v2/tasks/${encodeURIComponent(TEST_TASK_ID)}/events`);

    expect([404, 401]).toContain(response.status);
    expect(hasV2RequestId(payload)).toBe(true);

    if (response.status === 404) {
      expect(payload?.error?.code).toBe('task_not_found');
      expect(hasErrorMessage(payload)).toBe(true);
    } else {
      expect(payload?.error?.code).toBe('unauthorized');
      expect(hasErrorMessage(payload)).toBe(true);
    }
  });
});
