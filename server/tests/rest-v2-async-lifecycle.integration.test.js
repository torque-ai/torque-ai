const BASE_URL = (process.env.TORQUE_INTEGRATION_BASE_URL || '').trim();
const API_KEY = process.env.TORQUE_INTEGRATION_KEY || '';
const ASYNC_PROVIDER = (process.env.TORQUE_INTEGRATION_ASYNC_PROVIDER || '').trim();
const ASYNC_MODEL = (process.env.TORQUE_INTEGRATION_ASYNC_MODEL || '').trim();
const ASYNC_PROMPT = process.env.TORQUE_INTEGRATION_ASYNC_PROMPT
  || 'Torque async lifecycle integration smoke test.';
const MAX_POLLS = Number.parseInt(process.env.TORQUE_INTEGRATION_ASYNC_MAX_POLLS || '20', 10);
const POLL_DELAY_MS = Number.parseInt(process.env.TORQUE_INTEGRATION_ASYNC_POLL_DELAY_MS || '500', 10);

const shouldRun = Boolean(BASE_URL && ASYNC_PROVIDER && ASYNC_MODEL);
const describeIntegration = shouldRun ? describe : describe.skip;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function pollForTerminal(taskId) {
  let latest = null;
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  const pollCount = Number.isFinite(MAX_POLLS) && MAX_POLLS > 0 ? MAX_POLLS : 20;
  const pollDelayMs = Number.isFinite(POLL_DELAY_MS) && POLL_DELAY_MS >= 0 ? POLL_DELAY_MS : 500;

  for (let index = 0; index < pollCount; index += 1) {
    const result = await request(`/api/v2/tasks/${encodeURIComponent(taskId)}`);
    expect(result.response.status).toBe(200);
    latest = result.payload;
    if (terminalStatuses.has(result.payload?.status)) {
      return latest;
    }
    await sleep(pollDelayMs);
  }
  return latest;
}

describeIntegration('REST v2 async lifecycle integration (running TORQUE server)', () => {
  it('creates async inference task, polls status, and exercises cancel route', async () => {
    const createResult = await request('/api/v2/inference', {
      method: 'POST',
      body: {
        provider: ASYNC_PROVIDER,
        model: ASYNC_MODEL,
        messages: [{ role: 'user', content: ASYNC_PROMPT }],
        async: true,
        stream: false,
      },
    });

    expect(createResult.response.status).toBe(202);
    expect(typeof createResult.payload.task_id).toBe('string');
    expect(createResult.payload.status).toBe('queued');
    expect(typeof createResult.payload.request_id).toBe('string');

    const taskId = createResult.payload.task_id;
    const firstPoll = await request(`/api/v2/tasks/${encodeURIComponent(taskId)}`);
    expect(firstPoll.response.status).toBe(200);
    expect(firstPoll.payload.task_id).toBe(taskId);
    expect(typeof firstPoll.payload.request_id).toBe('string');
    expect(['queued', 'running', 'completed', 'failed', 'cancelled']).toContain(firstPoll.payload.status);

    const cancelResult = await request(`/api/v2/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
    });
    expect(cancelResult.response.status).toBe(200);
    expect(cancelResult.payload.task_id).toBe(taskId);
    expect(typeof cancelResult.payload.request_id).toBe('string');
    expect(['queued', 'running', 'completed', 'failed', 'cancelled']).toContain(cancelResult.payload.status);

    const finalStatus = await pollForTerminal(taskId);
    expect(typeof finalStatus?.request_id).toBe('string');
    expect(['completed', 'failed', 'cancelled']).toContain(finalStatus?.status);
  });
});
