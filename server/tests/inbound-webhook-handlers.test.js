const { EventEmitter } = require('events');
const http = require('http');
const crypto = require('crypto');

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db, handleToolCall;
beforeAll(() => { ({ db, handleToolCall } = setupTestDb('inbound-wh')); });

let requestHandler;
let apiServer;
let apiVerifyWebhookSignature;
let apiSubstitutePayload;
let toolsHandleSpy;

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function createMockResponse() {
  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const headers = {};
  const listeners = {};

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    }),
    setHeader: vi.fn((name, value) => { headers[name.toLowerCase()] = value; }),
    getHeader: vi.fn((name) => headers[name.toLowerCase()]),
    writeHead: vi.fn((statusCode, responseHeaders) => {
      response.statusCode = statusCode;
      response.headers = responseHeaders;
    }),
    end: vi.fn((body = '') => {
      response.body = body;
      resolve();
    }),
  };

  return { response, done };
}

async function dispatchRequest(handler, { method, url, headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress };
  req.connection = { remoteAddress };

  const { response, done } = createMockResponse();
  const requestPromise = handler(req, response);

  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', body);
    }
    req.emit('end');
  });

  await requestPromise;
  await done;
  return response;
}

function signPayload(secret, body) {
  const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

function getResolvedTaskDescription(text) {
  const match = text.match(/### Resolved Task Description\n```\n([\s\S]*?)\n```/);
  return match ? match[1] : '';
}

beforeAll(async () => {
  const tools = require('../tools');

  toolsHandleSpy = vi.spyOn(tools, 'handleToolCall').mockImplementation(async (name, args) => {
    if (name === 'smart_submit_task') {
      return {
        content: [{ type: 'text', text: 'Queued from inbound webhook' }],
        __subscribe_task_id: 'task-inbound-1',
      };
    }

    return handleToolCall(name, args);
  });

  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => {
      if (cb) cb();
    }),
    close: vi.fn(),
  };

  vi.spyOn(http, 'createServer').mockImplementation((handler) => {
    requestHandler = handler;
    return mockServer;
  });

  apiServer = require('../api-server');
  ({ verifyWebhookSignature: apiVerifyWebhookSignature, substitutePayload: apiSubstitutePayload } = apiServer);
  await apiServer.start({ port: 0 });
});

afterAll(() => {
  if (apiServer) {
    apiServer.stop();
  }
  vi.restoreAllMocks();
  teardownTestDb();
});

beforeEach(() => {
  rawDb().prepare('DELETE FROM inbound_webhooks').run();
  rawDb().prepare('DELETE FROM webhook_deliveries').run();
  toolsHandleSpy.mockClear();
});

describe('inbound webhook handlers', () => {
  it('creates inbound webhook with full action config', async () => {
    const result = await safeTool('create_inbound_webhook', {
      name: 'ci-hook',
      source_type: 'github',
      task_description: 'Run {{payload.ref}}',
      provider: 'test-provider',
      model: 'test-model',
      tags: 'ci',
      working_directory: '/tmp/project',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('Inbound Webhook Created');
    expect(text).toContain('ci-hook');
    expect(text).toContain('github');

    const row = db.getInboundWebhook('ci-hook');
    expect(row).toBeTruthy();
    expect(row.action_config).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      tags: 'ci',
      working_directory: '/tmp/project',
    });
  });

  it('lists inbound webhooks', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'a-hook',
      task_description: 'First',
      source_type: 'generic',
    });
    await safeTool('create_inbound_webhook', {
      name: 'b-hook',
      task_description: 'Second',
      source_type: 'generic',
    });

    const result = await safeTool('list_inbound_webhooks', {});

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain('2 webhook(s) configured');
    expect(text).toContain('a-hook');
    expect(text).toContain('b-hook');
  });

  it('deletes inbound webhook', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'delete-me',
      task_description: 'Delete me',
      source_type: 'generic',
    });

    const deleteResult = await safeTool('delete_inbound_webhook', { name: 'delete-me' });
    expect(deleteResult.isError).toBeFalsy();
    expect(getText(deleteResult)).toContain('Deleted');

    const listResult = await safeTool('list_inbound_webhooks', {});
    expect(getText(listResult)).toContain('No inbound webhooks configured');
  });

  it('returns error when deleting missing webhook', async () => {
    const result = await safeTool('delete_inbound_webhook', { name: 'missing-hook' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('not found');
  });

  it('truncates long substituted payload values in dry-run output', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'truncate-hook',
      source_type: 'generic',
      task_description: 'Deploy {{payload.longValue}} from {{payload.repository.name}} missing {{payload.missing}}',
    });
    toolsHandleSpy.mockClear();

    const result = await safeTool('test_inbound_webhook', {
      webhook_name: 'truncate-hook',
      payload: {
        longValue: 'x'.repeat(550),
        repository: { name: 'torque' },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(getResolvedTaskDescription(getText(result))).toBe(
      `Deploy ${'x'.repeat(500)} from torque missing {{payload.missing}}`,
    );
    expect(toolsHandleSpy).not.toHaveBeenCalledWith('smart_submit_task', expect.any(Object));
  });

  it('strips control characters from substituted payload values in dry-run output', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'sanitize-hook',
      source_type: 'generic',
      task_description: 'Message {{payload.message}} missing {{payload.missing}}',
    });
    toolsHandleSpy.mockClear();

    const result = await safeTool('test_inbound_webhook', {
      webhook_name: 'sanitize-hook',
      payload: {
        message: 'line\nnext\twith\x7Fdel',
      },
    });

    const resolved = getResolvedTaskDescription(getText(result));
    expect(result.isError).toBeFalsy();
    expect(resolved).toBe('Message linenextwithdel missing {{payload.missing}}');
    expect(resolved).not.toMatch(/[\n\t\x7F]/);
    expect(toolsHandleSpy).not.toHaveBeenCalledWith('smart_submit_task', expect.any(Object));
  });
});

describe('crypto timing-safe signature validation', () => {
  it('validates signatures using crypto.timingSafeEqual', () => {
    const body = '{"event":"push","ref":"main"}';
    const secret = 'timing-secret';
    const signature = signPayload(secret, body);

    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    const ok = apiVerifyWebhookSignature(secret, body, signature);

    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Buffer));

    spy.mockRestore();
  });

  it('rejects invalid signatures quickly via constant-time compare', () => {
    const body = '{"event":"push"}';
    const secret = 'timing-secret';
    const signature = 'sha256=' + '0'.repeat(64);

    expect(apiVerifyWebhookSignature(secret, body, signature)).toBe(false);
  });
});

describe('payload substitution', () => {
  it('replaces nested payload fields in task templates', () => {
    const text = apiSubstitutePayload(
      'Deploy {{payload.repository.name}} on {{payload.ref}}',
      { repository: { name: 'repo-one' }, ref: 'main' }
    );

    expect(text).toBe('Deploy repo-one on main');
  });

  it('leaves missing placeholders unchanged', () => {
    const text = apiSubstitutePayload('Deploy {{payload.missing.field}}', { repository: { name: 'repo-one' } });
    expect(text).toBe('Deploy {{payload.missing.field}}');
  });
});

describe('inbound webhook trigger endpoint', () => {
  async function postInboundWebhook(name, payload, headers = {}) {
    const rawBody = JSON.stringify(payload);
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: `/api/webhooks/inbound/${encodeURIComponent(name)}`,
      headers,
      body: rawBody,
    });
    return { response, body: response.body ? JSON.parse(response.body) : null, rawBody };
  }

  it('fires smart_submit_task with substituted payload and records delivery', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'trigger-hook',
      source_type: 'github',
      task_description: 'Deploy {{payload.repository.name}} at {{payload.ref}}',
      provider: 'provider-a',
      model: 'model-a',
      tags: 'deploy',
      working_directory: '/workspace',
    });

    const webhook = db.getInboundWebhook('trigger-hook');
    const payload = { repository: { name: 'torque' }, ref: 'main' };
    const signature = signPayload(webhook.secret, JSON.stringify(payload));

    const { response, body } = await postInboundWebhook('trigger-hook', payload, {
      'x-hub-signature-256': signature,
      'x-github-delivery': 'delivery-123',
    });

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      success: true,
      task_id: 'task-inbound-1',
      webhook: 'trigger-hook',
    });

    expect(toolsHandleSpy).toHaveBeenCalledWith('smart_submit_task', expect.objectContaining({
      task_description: 'Deploy torque at main',
      provider: 'provider-a',
      model: 'model-a',
      tags: 'deploy',
      working_directory: '/workspace',
    }));

    const delivery = rawDb().prepare('SELECT task_id FROM webhook_deliveries WHERE delivery_id = ?').get('delivery-123');
    expect(delivery.task_id).toBe('task-inbound-1');
  });

  it('rejects invalid signatures', async () => {
    await safeTool('create_inbound_webhook', {
      name: 'bad-sig-hook',
      source_type: 'generic',
      task_description: 'Run {{payload.action}}',
    });

    const payload = { action: 'push' };
    const signature = 'sha256=' + 'f'.repeat(64);

    const { response, body } = await postInboundWebhook('bad-sig-hook', payload, {
      'x-webhook-signature': signature,
    });

    expect(response.statusCode).toBe(401);
    expect(body).toMatchObject({ error: 'Invalid signature' });
    const deliveries = rawDb().prepare('SELECT COUNT(*) AS cnt FROM webhook_deliveries').get();
    expect(deliveries.cnt).toBe(0);
  });

  it('returns 404 for missing webhook', async () => {
    const { response, body } = await postInboundWebhook('missing-hook', { ping: true }, {
      'x-webhook-signature': signPayload('anything', JSON.stringify({ ping: true })),
    });

    expect(response.statusCode).toBe(404);
    expect(body).toMatchObject({ error: 'Webhook not found' });
  });
});
