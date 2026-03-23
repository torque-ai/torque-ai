import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_PATH = path.resolve(__dirname, '../api/webhooks.js');
const RAW_WEBHOOK_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

function loadWebhooksModule(injectedModules = {}) {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const requireFromModule = createRequire(MODULE_PATH);
  const exportedModule = { exports: {} };
  const appendedSource = `
module.exports.__testHelpers = {
  parseRawWebhookBody,
};
`;
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    `${source}\n${appendedSource}`,
  );

  const customRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return requireFromModule(request);
  };

  compiled(customRequire, exportedModule, exportedModule.exports, MODULE_PATH, path.dirname(MODULE_PATH));
  return exportedModule.exports;
}

function createWebhook(overrides = {}) {
  const { action_config: actionConfigOverrides = {}, ...rest } = overrides;
  return {
    name: 'unit-hook',
    enabled: true,
    secret: 'top-secret',
    trigger_count: 2,
    action_config: {
      task_description: 'Run {{payload.repository.name}} on {{payload.ref}}',
      provider: 'provider-a',
      model: 'model-a',
      tags: 'ci',
      working_directory: '/tmp/project',
      ...actionConfigOverrides,
    },
    ...rest,
  };
}

function createSubject(options = {}) {
  const database = {
    getInboundWebhook: vi.fn(() => options.webhook ?? null),
    checkDeliveryExists: vi.fn(() => null),
    recordDelivery: vi.fn(),
    recordWebhookTrigger: vi.fn(),
    ...(options.database || {}),
  };
  const tools = {
    handleToolCall: vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      __subscribe_task_id: 'task-123',
    })),
    ...(options.tools || {}),
  };
  const middleware = {
    sendJson: vi.fn((res, data, status = 200, req = null) => {
      res.statusCode = status;
      res.body = data;
      res.req = req;
    }),
    ...(options.middleware || {}),
  };

  const mod = loadWebhooksModule({
    '../database': database,
    '../db/inbound-webhooks': database,
    '../tools': tools,
    './middleware': middleware,
  });

  return {
    mod,
    helpers: mod.__testHelpers,
    database,
    handleToolCall: tools.handleToolCall,
    sendJson: middleware.sendJson,
  };
}

function signPayload(secret, body) {
  const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

function createRequest({ headers = {}, body = '', chunks, error } = {}) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/webhooks/inbound/unit-hook';
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress: '127.0.0.1' };
  req.connection = { remoteAddress: '127.0.0.1' };

  return {
    req,
    pump() {
      process.nextTick(() => {
        if (error) {
          req.emit('error', error);
          return;
        }

        const effectiveChunks = chunks !== undefined
          ? chunks
          : (body === undefined || body === null ? [] : [body]);

        for (const chunk of effectiveChunks) {
          req.emit('data', chunk);
        }
        req.emit('end');
      });
    },
  };
}

async function runInboundRequest(subject, options = {}) {
  const { req, pump } = createRequest({
    headers: options.headers || {},
    body: options.body,
    chunks: options.chunks,
    error: options.error,
  });
  const res = {};
  const handlerPromise = subject.mod.handleInboundWebhook(req, res, options.webhookName || 'unit-hook');
  if (options.autoPump !== false) {
    pump();
  }
  await handlerPromise;
  return { req, res };
}

describe('api/webhooks.verifyWebhookSignature', () => {
  it('accepts a valid sha256-prefixed signature', () => {
    const { mod } = createSubject();
    const body = '{"ref":"main"}';

    expect(mod.verifyWebhookSignature('secret-1', body, signPayload('secret-1', body))).toBe(true);
  });

  it('accepts a valid bare hex signature', () => {
    const { mod } = createSubject();
    const body = '{"action":"push"}';
    const bareDigest = signPayload('secret-2', body).slice('sha256='.length);

    expect(mod.verifyWebhookSignature('secret-2', body, bareDigest)).toBe(true);
  });

  it('rejects a missing signature header', () => {
    const { mod } = createSubject();

    expect(mod.verifyWebhookSignature('secret', 'body', '')).toBe(false);
    expect(mod.verifyWebhookSignature('secret', 'body', null)).toBe(false);
    expect(mod.verifyWebhookSignature('secret', 'body', undefined)).toBe(false);
  });

  it('rejects signatures with the wrong secret', () => {
    const { mod } = createSubject();
    const body = '{"event":"build"}';

    expect(mod.verifyWebhookSignature('wrong-secret', body, signPayload('right-secret', body))).toBe(false);
  });

  it('rejects empty or null webhook secrets', () => {
    const { mod } = createSubject();
    const body = '{"event":"build"}';
    const signature = signPayload('real-secret', body);

    expect(mod.verifyWebhookSignature('', body, signature)).toBe(false);
    expect(mod.verifyWebhookSignature(null, body, signature)).toBe(false);
  });

  it('rejects signatures whose digest length does not match', () => {
    const { mod } = createSubject();

    expect(mod.verifyWebhookSignature('secret', 'body', 'sha256=deadbeef')).toBe(false);
  });

  it('rejects malformed or non-sha256 signature headers without throwing', () => {
    const { mod } = createSubject();

    expect(mod.verifyWebhookSignature('secret', 'body', 'sha256=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    expect(mod.verifyWebhookSignature('secret', 'body', 'sha1=abcd')).toBe(false);
  });
});

describe('api/webhooks.substitutePayload', () => {
  it('replaces nested payload placeholders', () => {
    const { mod } = createSubject();

    expect(mod.substitutePayload(
      'Deploy {{payload.repository.name}} from {{payload.repository.owner.login}}',
      { repository: { name: 'torque', owner: { login: 'testuser' } } },
    )).toBe('Deploy torque from testuser');
  });

  it('replaces repeated placeholders independently', () => {
    const { mod } = createSubject();

    expect(mod.substitutePayload(
      '{{payload.branch}} -> {{payload.branch}}',
      { branch: 'main' },
    )).toBe('main -> main');
  });

  it('stringifies numeric and boolean payload values', () => {
    const { mod } = createSubject();

    expect(mod.substitutePayload(
      'PR #{{payload.number}} draft={{payload.draft}}',
      { number: 42, draft: false },
    )).toBe('PR #42 draft=false');
  });

  it('leaves missing placeholders unchanged', () => {
    const { mod } = createSubject();

    expect(mod.substitutePayload('Deploy {{payload.missing.field}}', { repository: { name: 'torque' } }))
      .toBe('Deploy {{payload.missing.field}}');
  });

  it('leaves placeholders unchanged when traversal hits a non-object value', () => {
    const { mod } = createSubject();

    expect(mod.substitutePayload('Value {{payload.a.b}}', { a: 'not-an-object' })).toBe('Value {{payload.a.b}}');
  });

  it('uses JavaScript string conversion for object payload values', () => {
    const { mod } = createSubject();

    expect(mod.substitutePayload('Object {{payload.meta}}', { meta: { ok: true } })).toBe('Object [object Object]');
  });
});

describe('api/webhooks.parseRawWebhookBody', () => {
  it('concatenates string and buffer chunks into a utf8 body', async () => {
    const { helpers } = createSubject();
    const { req, pump } = createRequest({
      chunks: [Buffer.from('{"name":"tor'), 'que"}'],
    });

    const bodyPromise = helpers.parseRawWebhookBody(req);
    pump();

    await expect(bodyPromise).resolves.toBe('{"name":"torque"}');
  });

  it('resolves an empty string when the request has no body', async () => {
    const { helpers } = createSubject();
    const { req, pump } = createRequest({ chunks: [] });

    const bodyPromise = helpers.parseRawWebhookBody(req);
    pump();

    await expect(bodyPromise).resolves.toBe('');
  });

  it('rejects oversized payloads and destroys the request', async () => {
    const { helpers } = createSubject();
    const { req, pump } = createRequest({
      chunks: [
        Buffer.alloc(RAW_WEBHOOK_BODY_LIMIT_BYTES, 'a'),
        Buffer.from('b'),
      ],
    });

    const bodyPromise = helpers.parseRawWebhookBody(req);
    pump();

    await expect(bodyPromise).rejects.toThrow('Request body too large');
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects when the request stream errors', async () => {
    const { helpers } = createSubject();
    const { req, pump } = createRequest({
      error: new Error('socket closed'),
    });

    const bodyPromise = helpers.parseRawWebhookBody(req);
    pump();

    await expect(bodyPromise).rejects.toThrow('socket closed');
  });
});

describe('api/webhooks.handleInboundWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 500 when webhook lookup throws', async () => {
    const subject = createSubject({
      database: {
        getInboundWebhook: vi.fn(() => {
          throw new Error('db offline');
        }),
      },
    });

    const { res } = await runInboundRequest(subject, { autoPump: false });

    expect(subject.sendJson).toHaveBeenCalledWith(res, { error: 'Internal error' }, 500, expect.any(Object));
    expect(res.statusCode).toBe(500);
  });

  it('returns 404 when the webhook is not found', async () => {
    const subject = createSubject({ webhook: null });

    const { res } = await runInboundRequest(subject, { autoPump: false });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Webhook not found' });
  });

  it('returns 403 when the webhook is disabled', async () => {
    const subject = createSubject({
      webhook: createWebhook({ enabled: false }),
    });

    const { res } = await runInboundRequest(subject, { autoPump: false });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Webhook is disabled' });
  });

  it('returns 400 when the request stream fails during body parsing', async () => {
    const webhook = createWebhook();
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body: JSON.stringify({ ref: 'main' }),
      headers: { 'x-webhook-signature': signPayload(webhook.secret, JSON.stringify({ ref: 'main' })) },
      error: new Error('read failure'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'read failure' });
  });

  it('returns 401 when the signature header is missing', async () => {
    const subject = createSubject({
      webhook: createWebhook(),
    });

    const { res } = await runInboundRequest(subject, {
      body: JSON.stringify({ ref: 'main' }),
      headers: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
    expect(subject.handleToolCall).not.toHaveBeenCalled();
  });

  it('prefers x-hub-signature-256 over x-webhook-signature', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: {
        'x-hub-signature-256': signPayload(webhook.secret, body),
        'x-webhook-signature': 'sha256=' + '0'.repeat(64),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(subject.handleToolCall).toHaveBeenCalledWith('smart_submit_task', expect.any(Object));
  });

  it('rejects the request when x-hub-signature-256 is invalid even if x-webhook-signature is valid', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: {
        'x-hub-signature-256': 'sha256=' + 'f'.repeat(64),
        'x-webhook-signature': signPayload(webhook.secret, body),
      },
    });

    expect(res.statusCode).toBe(401);
    expect(subject.handleToolCall).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON payloads after signature verification', async () => {
    const webhook = createWebhook();
    const body = '{"broken":true';
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON payload' });
  });

  it('short-circuits duplicate deliveries before task creation', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({
      webhook,
      database: {
        checkDeliveryExists: vi.fn(() => ({ task_id: 'task-existing' })),
      },
    });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: {
        'x-webhook-signature': signPayload(webhook.secret, body),
        'x-webhook-delivery': 'delivery-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Duplicate delivery ignored',
      task_id: 'task-existing',
      delivery_id: 'delivery-1',
    });
    expect(subject.handleToolCall).not.toHaveBeenCalled();
    expect(subject.database.recordDelivery).not.toHaveBeenCalled();
    expect(subject.database.recordWebhookTrigger).not.toHaveBeenCalled();
  });

  it('routes standard webhooks through smart_submit_task with substituted payload fields', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: {
        'x-webhook-signature': signPayload(webhook.secret, body),
        'x-github-delivery': 'delivery-std-1',
      },
    });

    expect(subject.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
      task_description: 'Run torque on main',
      provider: 'provider-a',
      model: 'model-a',
      tags: 'ci',
      working_directory: '/tmp/project',
    });
    expect(subject.database.checkDeliveryExists).toHaveBeenCalledWith('delivery-std-1');
    expect(subject.database.recordDelivery).toHaveBeenCalledWith('delivery-std-1', 'unit-hook', 'task-123');
    expect(subject.database.recordWebhookTrigger).toHaveBeenCalledWith('unit-hook');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      task_id: 'task-123',
      webhook: 'unit-hook',
      trigger_count: 3,
    });
  });

  it('uses x-webhook-delivery ahead of x-hub-delivery and x-github-delivery', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({ webhook });

    await runInboundRequest(subject, {
      body,
      headers: {
        'x-webhook-signature': signPayload(webhook.secret, body),
        'x-webhook-delivery': 'delivery-webhook',
        'x-hub-delivery': 'delivery-hub',
        'x-github-delivery': 'delivery-github',
      },
    });

    expect(subject.database.checkDeliveryExists).toHaveBeenCalledWith('delivery-webhook');
    expect(subject.database.recordDelivery).toHaveBeenCalledWith('delivery-webhook', 'unit-hook', 'task-123');
  });

  it('does not consult or record delivery state when no delivery header is present', async () => {
    const webhook = createWebhook({
      action_config: { provider: undefined, model: undefined, tags: undefined, working_directory: undefined },
    });
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(subject.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
      task_description: 'Run torque on main',
    });
    expect(subject.database.checkDeliveryExists).not.toHaveBeenCalled();
    expect(subject.database.recordDelivery).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('returns 500 when smart_submit_task throws', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({
      webhook,
      tools: {
        handleToolCall: vi.fn(async () => {
          throw new Error('tool offline');
        }),
      },
    });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create task: tool offline' });
  });

  it('returns a structured 400 when smart_submit_task returns an MCP error result', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({
      webhook,
      tools: {
        handleToolCall: vi.fn(async () => ({
          isError: true,
          content: [{ type: 'text', text: 'validation failed' }],
        })),
      },
    });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'validation failed', webhook: 'unit-hook' });
  });

  it('falls back to a generic task creation error when the MCP error payload has no text', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({
      webhook,
      tools: {
        handleToolCall: vi.fn(async () => ({
          isError: true,
          content: [],
        })),
      },
    });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Task creation failed', webhook: 'unit-hook' });
  });

  it('records a null task id when the tool result does not expose __subscribe_task_id', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({
      webhook,
      tools: {
        handleToolCall: vi.fn(async () => ({
          content: [{ type: 'text', text: 'queued without subscription id' }],
        })),
      },
    });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: {
        'x-webhook-signature': signPayload(webhook.secret, body),
        'x-hub-delivery': 'delivery-no-task-id',
      },
    });

    expect(subject.database.recordDelivery).toHaveBeenCalledWith('delivery-no-task-id', 'unit-hook', null);
    expect(res.body.task_id).toBeNull();
  });

  it('continues successfully when webhook trigger recording fails', async () => {
    const webhook = createWebhook();
    const body = JSON.stringify({ repository: { name: 'torque' }, ref: 'main' });
    const subject = createSubject({
      webhook,
      database: {
        recordWebhookTrigger: vi.fn(() => {
          throw new Error('write failed');
        }),
      },
    });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('supports empty request bodies and treats the payload as an empty object', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Run static task',
        provider: undefined,
        model: undefined,
        tags: undefined,
        working_directory: undefined,
      },
    });
    const body = '';
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(subject.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
      task_description: 'Run static task',
    });
    expect(res.statusCode).toBe(200);
  });

  it('routes quota triggers to submit_task with the best available provider', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Free-tier {{payload.job}}',
        trigger_type: 'quota_task',
        provider: undefined,
        model: undefined,
        tags: 'free',
        working_directory: '/tmp/quota',
      },
    });
    const body = JSON.stringify({ job: 'lint' });
    const subject = createSubject({ webhook });
    const tracker = {
      getAvailableProvidersSmart: vi.fn(() => [
        { provider: 'groq' },
        { provider: 'cerebras' },
      ]),
    };
    subject.mod.setQuotaTrackerGetter(() => tracker);

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(tracker.getAvailableProvidersSmart).toHaveBeenCalledWith({
      complexity: 'normal',
      descriptionLength: 'Free-tier lint'.length,
    });
    expect(subject.handleToolCall).toHaveBeenCalledWith('submit_task', {
      task: 'Free-tier lint',
      provider: 'groq',
      working_directory: '/tmp/quota',
      tags: 'free',
    });
    expect(res.body).toEqual({
      success: true,
      task_id: 'task-123',
      webhook: 'unit-hook',
      trigger_count: 3,
      trigger_type: 'quota_task',
      quota_provider: 'groq',
    });
  });

  it('passes custom complexity metadata to the quota tracker', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Complex {{payload.job}}',
        trigger_type: 'quota_task',
        complexity: 'complex',
      },
    });
    const body = JSON.stringify({ job: 'planning' });
    const subject = createSubject({ webhook });
    const tracker = {
      getAvailableProvidersSmart: vi.fn(() => [{ provider: 'deepinfra' }]),
    };
    subject.mod.setQuotaTrackerGetter(() => tracker);

    await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(tracker.getAvailableProvidersSmart).toHaveBeenCalledWith({
      complexity: 'complex',
      descriptionLength: 'Complex planning'.length,
    });
  });

  it('falls back to smart_submit_task when no quota tracker getter is configured', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Fallback {{payload.job}}',
        trigger_type: 'quota_task',
        provider: undefined,
        model: undefined,
        tags: undefined,
        working_directory: undefined,
      },
    });
    const body = JSON.stringify({ job: 'review' });
    const subject = createSubject({ webhook });

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(subject.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
      task: 'Fallback review',
      quota_preferred: true,
    });
    expect(res.body.quota_provider).toBeNull();
  });

  it('falls back to smart_submit_task when the tracker getter returns null', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Null tracker',
        trigger_type: 'quota_task',
        provider: undefined,
        model: undefined,
        tags: undefined,
        working_directory: undefined,
      },
    });
    const body = JSON.stringify({});
    const subject = createSubject({ webhook });
    subject.mod.setQuotaTrackerGetter(() => null);

    await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(subject.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
      task: 'Null tracker',
      quota_preferred: true,
    });
  });

  it('falls back to smart_submit_task when the tracker returns no providers', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'No providers',
        trigger_type: 'quota_task',
        provider: undefined,
        model: undefined,
        tags: undefined,
        working_directory: undefined,
      },
    });
    const body = JSON.stringify({});
    const subject = createSubject({ webhook });
    const tracker = {
      getAvailableProvidersSmart: vi.fn(() => []),
    };
    subject.mod.setQuotaTrackerGetter(() => tracker);

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(subject.handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
      task: 'No providers',
      quota_preferred: true,
    });
    expect(res.body.quota_provider).toBeNull();
  });

  it('returns 500 when submit_task fails for a quota route', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Will fail',
        trigger_type: 'quota_task',
      },
    });
    const body = JSON.stringify({});
    const subject = createSubject({
      webhook,
      tools: {
        handleToolCall: vi.fn(async (name) => {
          if (name === 'submit_task') {
            throw new Error('provider unavailable');
          }
          return {
            content: [{ type: 'text', text: 'ok' }],
            __subscribe_task_id: 'task-123',
          };
        }),
      },
    });
    subject.mod.setQuotaTrackerGetter(() => ({
      getAvailableProvidersSmart: vi.fn(() => [{ provider: 'groq' }]),
    }));

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create quota task: provider unavailable' });
  });

  it('returns 500 when the quota fallback smart_submit_task call throws', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Fallback will fail',
        trigger_type: 'quota_task',
      },
    });
    const body = JSON.stringify({});
    const subject = createSubject({
      webhook,
      tools: {
        handleToolCall: vi.fn(async (name) => {
          if (name === 'smart_submit_task') {
            throw new Error('all providers exhausted');
          }
          return {
            content: [{ type: 'text', text: 'ok' }],
            __subscribe_task_id: 'task-123',
          };
        }),
      },
    });
    subject.mod.setQuotaTrackerGetter(() => ({
      getAvailableProvidersSmart: vi.fn(() => []),
    }));

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to create task (no quota providers available): all providers exhausted',
    });
  });

  it('returns a structured 400 when a quota task submission returns an MCP error result', async () => {
    const webhook = createWebhook({
      action_config: {
        task_description: 'Free-tier error',
        trigger_type: 'quota_task',
      },
    });
    const body = JSON.stringify({});
    const subject = createSubject({
      webhook,
      tools: {
        handleToolCall: vi.fn(async () => ({
          isError: true,
          content: [{ type: 'text', text: 'quota exhausted' }],
        })),
      },
    });
    subject.mod.setQuotaTrackerGetter(() => ({
      getAvailableProvidersSmart: vi.fn(() => [{ provider: 'groq' }]),
    }));

    const { res } = await runInboundRequest(subject, {
      body,
      headers: { 'x-webhook-signature': signPayload(webhook.secret, body) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'quota exhausted', webhook: 'unit-hook' });
  });
});
