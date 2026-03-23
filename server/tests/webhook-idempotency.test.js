const { EventEmitter } = require('events');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

function createMockResponse() {
  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const responseHeaders = {};
  const listeners = {};
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, cb) => { listeners[event] = listeners[event] || []; listeners[event].push(cb); }),
    emit: vi.fn((event, ...args) => { (listeners[event] || []).forEach(cb => cb(...args)); }),
    setHeader: vi.fn((name, value) => { responseHeaders[name.toLowerCase()] = value; }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      response.body = body;
      resolve();
    }),
  };
  return { response, done };
}

async function dispatchRequest(handler, { method, url, headers = {}, body, remoteAddress } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress: remoteAddress || '127.0.0.1' };
  req.connection = { remoteAddress: remoteAddress || '127.0.0.1' };

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', body);
    }
    req.emit('end');
  });

  await handlerPromise;
  await done;
  return response;
}

function signPayload(secret, body) {
  const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

describe('inbound webhook idempotency (RB-044)', () => {
  let db;
  let inboundWebhooks;
  let apiServer;
  let requestHandler;
  let handleToolCallSpy;
  let templateBuffer;

  const webhookName = 'rb044-hook';
  const webhookSecret = 'rb044-secret';

  async function postInboundWebhook({ payload = { ref: 'refs/heads/main' }, headers = {}, remoteAddress } = {}) {
    const body = JSON.stringify(payload);
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: `/api/webhooks/inbound/${webhookName}`,
      headers: {
        'x-hub-signature-256': signPayload(webhookSecret, body),
        ...headers,
      },
      body,
      remoteAddress,
    });
    return response;
  }

  beforeAll(async () => {
    ({ db } = setupTestDb('webhook-idempotency'));
    templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
    inboundWebhooks = require('../db/inbound-webhooks');
    inboundWebhooks.setDb(db.getDbInstance());

    const tools = require('../tools');
    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      __subscribe_task_id: 'task-default',
    });

    const mockServer = {
      on: vi.fn(),
      listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
      close: vi.fn(),
    };
    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    apiServer = require('../api-server');
    await apiServer.start({ port: 4017 });
  });

  afterAll(() => {
    if (apiServer) apiServer.stop();
    vi.restoreAllMocks();
    teardownTestDb();
  });

  beforeEach(() => {
    db.resetForTest(templateBuffer);
    handleToolCallSpy.mockReset();
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      __subscribe_task_id: 'task-default',
    });

    inboundWebhooks.createInboundWebhook({
      name: webhookName,
      source_type: 'github',
      secret: webhookSecret,
      action_config: { task_description: 'Run for {{payload.ref}}' },
    });
  });

  it('returns success for replayed delivery id but creates only one task', async () => {
    handleToolCallSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'created' }],
      __subscribe_task_id: 'task-dup-1',
    });

    const first = await postInboundWebhook({
      headers: { 'x-github-delivery': 'delivery-dup-1' },
    });
    const second = await postInboundWebhook({
      headers: { 'x-github-delivery': 'delivery-dup-1' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstBody = JSON.parse(first.body);
    const secondBody = JSON.parse(second.body);
    expect(firstBody.success).toBe(true);
    expect(firstBody.task_id).toBe('task-dup-1');
    expect(secondBody).toEqual(expect.objectContaining({
      success: true,
      message: 'Duplicate delivery ignored',
      task_id: 'task-dup-1',
      delivery_id: 'delivery-dup-1',
    }));

    expect(handleToolCallSpy).toHaveBeenCalledTimes(1);

    const rows = db.getDbInstance()
      .prepare('SELECT delivery_id, task_id FROM webhook_deliveries ORDER BY delivery_id')
      .all();
    expect(rows).toEqual([{ delivery_id: 'delivery-dup-1', task_id: 'task-dup-1' }]);
  });

  it('creates separate tasks for different delivery ids', async () => {
    handleToolCallSpy
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'created' }],
        __subscribe_task_id: 'task-a',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'created' }],
        __subscribe_task_id: 'task-b',
      });

    const first = await postInboundWebhook({
      headers: { 'x-hub-delivery': 'delivery-a' },
    });
    const second = await postInboundWebhook({
      headers: { 'x-hub-delivery': 'delivery-b' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(first.body).task_id).toBe('task-a');
    expect(JSON.parse(second.body).task_id).toBe('task-b');
    expect(handleToolCallSpy).toHaveBeenCalledTimes(2);

    const rows = db.getDbInstance()
      .prepare('SELECT delivery_id, task_id FROM webhook_deliveries ORDER BY delivery_id')
      .all();
    expect(rows).toEqual([
      { delivery_id: 'delivery-a', task_id: 'task-a' },
      { delivery_id: 'delivery-b', task_id: 'task-b' },
    ]);
  });

  it('does not deduplicate when delivery id header is missing', async () => {
    handleToolCallSpy
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'created' }],
        __subscribe_task_id: 'task-no-delivery-1',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'created' }],
        __subscribe_task_id: 'task-no-delivery-2',
      });

    const first = await postInboundWebhook();
    const second = await postInboundWebhook();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(handleToolCallSpy).toHaveBeenCalledTimes(2);

    const count = db.getDbInstance()
      .prepare('SELECT COUNT(*) AS cnt FROM webhook_deliveries')
      .get().cnt;
    expect(count).toBe(0);
  });

  it('cleanupOldDeliveries removes expired entries', () => {
    inboundWebhooks.recordDelivery('delivery-old', webhookName, 'task-old');
    inboundWebhooks.recordDelivery('delivery-new', webhookName, 'task-new');

    db.getDbInstance()
      .prepare("UPDATE webhook_deliveries SET received_at = datetime('now', '-10 days') WHERE delivery_id = ?")
      .run('delivery-old');

    const result = inboundWebhooks.cleanupOldDeliveries(7);
    expect(result.changes).toBe(1);

    const remaining = db.getDbInstance()
      .prepare('SELECT delivery_id FROM webhook_deliveries ORDER BY delivery_id')
      .all();
    expect(remaining).toEqual([{ delivery_id: 'delivery-new' }]);
  });
});
