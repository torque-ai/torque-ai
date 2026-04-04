// SKIP REASON: Requires a running TORQUE server with 2 providers configured.
// Set TORQUE_INTEGRATION_BASE_URL, _KEY, _CONCURRENCY_PROVIDER_A/B, _MODEL_A/B to enable.
const BASE_URL = (process.env.TORQUE_INTEGRATION_BASE_URL || '').trim();
const API_KEY = process.env.TORQUE_INTEGRATION_KEY || '';
const PROVIDER_A = (process.env.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_A || '').trim();
const MODEL_A = (process.env.TORQUE_INTEGRATION_CONCURRENCY_MODEL_A || '').trim();
const PROVIDER_B = (process.env.TORQUE_INTEGRATION_CONCURRENCY_PROVIDER_B || '').trim();
const MODEL_B = (process.env.TORQUE_INTEGRATION_CONCURRENCY_MODEL_B || '').trim();
const PROMPT_A = process.env.TORQUE_INTEGRATION_CONCURRENCY_PROMPT_A
  || 'Concurrency integration request A';
const PROMPT_B = process.env.TORQUE_INTEGRATION_CONCURRENCY_PROMPT_B
  || 'Concurrency integration request B';
const MAX_POLLS = Number.parseInt(process.env.TORQUE_INTEGRATION_CONCURRENCY_MAX_POLLS || '30', 10);
const POLL_DELAY_MS = Number.parseInt(process.env.TORQUE_INTEGRATION_CONCURRENCY_POLL_DELAY_MS || '500', 10);
const TEST_TIMEOUT_MS = Number.parseInt(process.env.TORQUE_INTEGRATION_CONCURRENCY_TEST_TIMEOUT_MS || '60000', 10);

const shouldRun = Boolean(BASE_URL && PROVIDER_A && MODEL_A && PROVIDER_B && MODEL_B);
const describeIntegration = shouldRun ? describe : describe.skip;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

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

async function pollTaskToTerminal(taskId) {
  const safeMaxPolls = Number.isFinite(MAX_POLLS) && MAX_POLLS > 0 ? MAX_POLLS : 30;
  const safePollDelay = Number.isFinite(POLL_DELAY_MS) && POLL_DELAY_MS >= 0 ? POLL_DELAY_MS : 500;
  let latest = null;

  for (let index = 0; index < safeMaxPolls; index += 1) {
    const result = await request(`/api/v2/tasks/${encodeURIComponent(taskId)}`);
    expect(result.response.status).toBe(200);
    latest = result.payload;
    if (TERMINAL.has(result.payload?.status)) {
      return latest;
    }
    await sleep(safePollDelay);
  }

  return latest;
}

describeIntegration('REST v2 concurrency integration (running TORQUE server)', () => {
  it('submits concurrent async tasks across configured lanes and reaches terminal states', async () => {
    const [createA, createB] = await Promise.all([
      request('/api/v2/inference', {
        method: 'POST',
        body: {
          provider: PROVIDER_A,
          model: MODEL_A,
          messages: [{ role: 'user', content: PROMPT_A }],
          async: true,
          stream: false,
        },
      }),
      request('/api/v2/inference', {
        method: 'POST',
        body: {
          provider: PROVIDER_B,
          model: MODEL_B,
          messages: [{ role: 'user', content: PROMPT_B }],
          async: true,
          stream: false,
        },
      }),
    ]);

    expect(createA.response.status).toBe(202);
    expect(createB.response.status).toBe(202);
    expect(typeof createA.payload.task_id).toBe('string');
    expect(typeof createB.payload.task_id).toBe('string');
    expect(createA.payload.task_id).not.toBe(createB.payload.task_id);
    expect(typeof createA.payload.request_id).toBe('string');
    expect(typeof createB.payload.request_id).toBe('string');

    const taskIdA = createA.payload.task_id;
    const taskIdB = createB.payload.task_id;

    const [cancelA, cancelB] = await Promise.all([
      request(`/api/v2/tasks/${encodeURIComponent(taskIdA)}/cancel`, { method: 'POST' }),
      request(`/api/v2/tasks/${encodeURIComponent(taskIdB)}/cancel`, { method: 'POST' }),
    ]);

    expect(cancelA.response.status).toBe(200);
    expect(cancelB.response.status).toBe(200);
    expect(cancelA.payload.task_id).toBe(taskIdA);
    expect(cancelB.payload.task_id).toBe(taskIdB);
    expect(typeof cancelA.payload.request_id).toBe('string');
    expect(typeof cancelB.payload.request_id).toBe('string');
    expect(['queued', 'running', 'completed', 'failed', 'cancelled']).toContain(cancelA.payload.status);
    expect(['queued', 'running', 'completed', 'failed', 'cancelled']).toContain(cancelB.payload.status);

    const [finalA, finalB] = await Promise.all([
      pollTaskToTerminal(taskIdA),
      pollTaskToTerminal(taskIdB),
    ]);

    expect(TERMINAL.has(finalA?.status)).toBe(true);
    expect(TERMINAL.has(finalB?.status)).toBe(true);
    expect(typeof finalA?.request_id).toBe('string');
    expect(typeof finalB?.request_id).toBe('string');
  }, Number.isFinite(TEST_TIMEOUT_MS) && TEST_TIMEOUT_MS > 0 ? TEST_TIMEOUT_MS : 60000);
});
