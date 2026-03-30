import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const realCrypto = require('node:crypto');

const MODULE_PATH = path.resolve(__dirname, '../plugins/snapscope/handlers/webhook-outbound.js');
const realSetImmediate = global.setImmediate;

let currentModules = {};

vi.mock('crypto', () => currentModules.crypto);
vi.mock('http', () => currentModules.http);
vi.mock('https', () => currentModules.https);

function createLoggerMock() {
  const instance = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    instance,
    module: {
      child: vi.fn(() => instance),
    },
  };
}

function createCryptoMock() {
  return {
    createHmac: vi.fn((algorithm, secret) => realCrypto.createHmac(algorithm, secret)),
  };
}

function createRequestModule(options = {}) {
  const { responseStatus, requestError, throwOnRequest } = options;
  const calls = [];

  const request = vi.fn((url, requestOptions, onResponse) => {
    if (throwOnRequest) {
      throw throwOnRequest;
    }

    const req = new EventEmitter();
    const call = {
      url,
      options: requestOptions,
      onResponse,
      req,
      body: '',
      response: null,
      destroyedWith: null,
      emitResponse(statusCode = 200) {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = vi.fn();
        call.response = res;
        if (typeof onResponse === 'function') {
          onResponse(res);
        }
        return res;
      },
    };

    req.write = vi.fn((chunk) => {
      call.body += chunk;
    });

    req.end = vi.fn(() => {
      if (requestError) {
        req.emit('error', requestError);
        return;
      }

      if (responseStatus !== undefined) {
        const res = call.emitResponse(responseStatus);
        res.emit('end');
      }
    });

    req.destroy = vi.fn((error) => {
      call.destroyedWith = error || null;
      if (error) {
        req.emit('error', error);
      }
    });

    calls.push(call);
    return req;
  });

  return {
    module: { request },
    request,
    calls,
  };
}

function createDeferredImmediate() {
  const callbacks = [];

  return {
    callbacks,
    stub: vi.fn((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
    runAll() {
      while (callbacks.length > 0) {
        const callback = callbacks.shift();
        callback();
      }
    },
  };
}

function loadWebhookOutbound(injectedModules = {}) {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const requireFromModule = createRequire(MODULE_PATH);
  const exportedModule = { exports: {} };
  const appendedSource = `
module.exports.__testHelpers = {
  eventSubscriptionMatches,
  webhookMatchesEvent,
  getSubscribedPeekWebhooks,
  buildSafeHeaders,
  logWebhookDelivery,
  dispatchWebhook,
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

function createSubject(options = {}) {
  const logger = options.logger || createLoggerMock();
  const database = {
    listWebhooks: vi.fn(() => options.webhooks || []),
    getWebhooksForEvent: vi.fn(() => options.webhooks || []),
    logWebhookDelivery: vi.fn(),
    ...(options.database || {}),
  };
  const shared = {
    isInternalHost: vi.fn(() => false),
    ...(options.shared || {}),
  };
  const http = options.http || createRequestModule();
  const https = options.https || createRequestModule();
  const crypto = options.crypto || createCryptoMock();

  currentModules = {
    crypto,
    http: http.module,
    https: https.module,
    database,
    logger: logger.module,
    shared,
  };

  const mod = loadWebhookOutbound({
    crypto,
    http: http.module,
    https: https.module,
    '../../db/webhooks-streaming': database,
    '../../logger': logger.module,
    '../shared': shared,
  });

  return {
    mod,
    helpers: mod.__testHelpers,
    logger,
    database,
    shared,
    http,
    https,
    crypto,
  };
}

function createPayload(mod, event = 'peek.bundle.created', data = { task_id: 'task-1' }) {
  const payload = mod.buildWebhookPayload(event, data);
  return {
    payload,
    payloadStr: JSON.stringify(payload),
  };
}

describe('peek/webhook-outbound handlers', () => {
  beforeEach(() => {
    currentModules = {};
    global.setImmediate = realSetImmediate;
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.setImmediate = realSetImmediate;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('computeHmacSignature', () => {
    it('hashes string payloads with a sha256 prefix', () => {
      const { mod, crypto } = createSubject();

      const signature = mod.computeHmacSignature('payload-body', 'secret-key');

      expect(signature).toBe(
        `sha256=${realCrypto.createHmac('sha256', 'secret-key').update('payload-body').digest('hex')}`,
      );
      expect(crypto.createHmac).toHaveBeenCalledWith('sha256', 'secret-key');
    });

    it('serializes object payloads before hashing', () => {
      const { mod } = createSubject();
      const payload = {
        event: 'peek.bundle.created',
        data: { task_id: 'task-22', kind: 'bundle' },
      };

      const signature = mod.computeHmacSignature(payload, 'object-secret');

      expect(signature).toBe(
        `sha256=${realCrypto.createHmac('sha256', 'object-secret').update(JSON.stringify(payload)).digest('hex')}`,
      );
    });

    it('returns the same signature for repeated inputs', () => {
      const { mod } = createSubject();

      const first = mod.computeHmacSignature('repeatable', 'same-secret');
      const second = mod.computeHmacSignature('repeatable', 'same-secret');

      expect(first).toBe(second);
    });
  });

  describe('buildWebhookPayload', () => {
    it('builds an event envelope with an ISO timestamp', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-02T03:04:05.678Z'));
      const { mod } = createSubject();

      expect(mod.buildWebhookPayload('peek.compliance.generated', { report_id: 'report-1' })).toEqual({
        event: 'peek.compliance.generated',
        timestamp: '2026-03-02T03:04:05.678Z',
        data: { report_id: 'report-1' },
      });
    });

    it('keeps the original data object reference', () => {
      const { mod } = createSubject();
      const data = { task_id: 'task-11', nested: { ok: true } };

      const payload = mod.buildWebhookPayload('peek.recovery.executed', data);

      expect(payload.data).toBe(data);
    });
  });

  describe('eventSubscriptionMatches', () => {
    it('matches exact event subscriptions', () => {
      const { helpers } = createSubject();

      expect(helpers.eventSubscriptionMatches('peek.bundle.created', 'peek.bundle.created')).toBe(true);
    });

    it('matches the catch-all wildcard subscription', () => {
      const { helpers } = createSubject();

      expect(helpers.eventSubscriptionMatches('*', 'peek.bundle.created')).toBe(true);
    });

    it('matches prefix wildcard subscriptions', () => {
      const { helpers } = createSubject();

      expect(helpers.eventSubscriptionMatches('peek.*', 'peek.compliance.generated')).toBe(true);
    });

    it('trims subscription whitespace before matching', () => {
      const { helpers } = createSubject();

      expect(helpers.eventSubscriptionMatches('  peek.recovery.executed  ', 'peek.recovery.executed')).toBe(true);
    });

    it('returns false for blank subscriptions', () => {
      const { helpers } = createSubject();

      expect(helpers.eventSubscriptionMatches('   ', 'peek.bundle.created')).toBe(false);
    });

    it('returns false for non-string subscriptions', () => {
      const { helpers } = createSubject();

      expect(helpers.eventSubscriptionMatches(null, 'peek.bundle.created')).toBe(false);
    });

    it('returns false when a prefix subscription does not match the event', () => {
      const { helpers } = createSubject();

      expect(helpers.eventSubscriptionMatches('peek.bundle.*', 'peek.compliance.generated')).toBe(false);
    });
  });

  describe('webhookMatchesEvent', () => {
    it('returns false for a missing webhook record', () => {
      const { helpers } = createSubject();

      expect(helpers.webhookMatchesEvent(null, 'peek.bundle.created')).toBe(false);
    });

    it('returns false for disabled webhooks', () => {
      const { helpers } = createSubject();

      expect(helpers.webhookMatchesEvent({
        enabled: false,
        events: ['peek.bundle.created'],
      }, 'peek.bundle.created')).toBe(false);
    });

    it('returns true when any subscription matches the event', () => {
      const { helpers } = createSubject();

      expect(helpers.webhookMatchesEvent({
        enabled: true,
        events: ['task.completed', 'peek.*'],
      }, 'peek.bundle.created')).toBe(true);
    });

    it('returns false when the events property is not an array', () => {
      const { helpers } = createSubject();

      expect(helpers.webhookMatchesEvent({
        enabled: true,
        events: 'peek.bundle.created',
      }, 'peek.bundle.created')).toBe(false);
    });

    it('returns false when no subscription matches', () => {
      const { helpers } = createSubject();

      expect(helpers.webhookMatchesEvent({
        enabled: true,
        events: ['task.completed'],
      }, 'peek.bundle.created')).toBe(false);
    });
  });

  describe('getSubscribedPeekWebhooks', () => {
    it('filters listWebhooks results by enabled state and event subscriptions', () => {
      const webhooks = [
        { id: 'wh-exact', enabled: true, events: ['peek.bundle.created'] },
        { id: 'wh-prefix', enabled: true, events: ['peek.*'] },
        { id: 'wh-wildcard', enabled: true, events: ['*'] },
        { id: 'wh-disabled', enabled: false, events: ['peek.bundle.created'] },
        { id: 'wh-other', enabled: true, events: ['task.completed'] },
      ];
      const { helpers, database } = createSubject({ webhooks });

      const subscribed = helpers.getSubscribedPeekWebhooks('peek.bundle.created');

      expect(database.listWebhooks).toHaveBeenCalledTimes(1);
      expect(subscribed.map((webhook) => webhook.id)).toEqual(['wh-exact', 'wh-prefix', 'wh-wildcard']);
    });

    it('prefers listWebhooks over getWebhooksForEvent when both are available', () => {
      const { helpers, database } = createSubject({
        database: {
          listWebhooks: vi.fn(() => [{ id: 'wh-list', enabled: true, events: ['peek.bundle.created'] }]),
          getWebhooksForEvent: vi.fn(() => [{ id: 'wh-fallback', enabled: true, events: ['peek.bundle.created'] }]),
        },
      });

      const subscribed = helpers.getSubscribedPeekWebhooks('peek.bundle.created');

      expect(subscribed.map((webhook) => webhook.id)).toEqual(['wh-list']);
      expect(database.getWebhooksForEvent).not.toHaveBeenCalled();
    });

    it('falls back to getWebhooksForEvent when listWebhooks is unavailable', () => {
      const { helpers, database } = createSubject({
        database: {
          listWebhooks: undefined,
          getWebhooksForEvent: vi.fn(() => [{ id: 'wh-fallback', enabled: true, events: ['peek.*'] }]),
        },
      });

      const subscribed = helpers.getSubscribedPeekWebhooks('peek.compliance.generated');

      expect(database.getWebhooksForEvent).toHaveBeenCalledWith('peek.compliance.generated');
      expect(subscribed.map((webhook) => webhook.id)).toEqual(['wh-fallback']);
    });

    it('returns an empty array when the lookup result is not an array', () => {
      const { helpers } = createSubject({
        database: {
          listWebhooks: vi.fn(() => ({ invalid: true })),
        },
      });

      expect(helpers.getSubscribedPeekWebhooks('peek.bundle.created')).toEqual([]);
    });

    it('returns an empty array when no webhook lookup helpers exist', () => {
      const { helpers } = createSubject({
        database: {
          listWebhooks: undefined,
          getWebhooksForEvent: undefined,
        },
      });

      expect(helpers.getSubscribedPeekWebhooks('peek.bundle.created')).toEqual([]);
    });
  });

  describe('buildSafeHeaders', () => {
    it('returns an empty object for non-object input', () => {
      const { helpers } = createSubject();

      expect(helpers.buildSafeHeaders(null)).toEqual({});
    });

    it('keeps safe custom headers unchanged', () => {
      const { helpers } = createSubject();

      expect(helpers.buildSafeHeaders({
        'X-Custom-Trace': 'trace-123',
        Authorization: 'Bearer token',
      })).toEqual({
        'X-Custom-Trace': 'trace-123',
        Authorization: 'Bearer token',
      });
    });

    it('removes blocked headers regardless of case', () => {
      const { helpers } = createSubject();

      expect(helpers.buildSafeHeaders({
        Host: 'example.test',
        'content-type': 'text/plain',
        'X-Webhook-Signature': 'bad-value',
        'X-Keep-Me': 'ok',
      })).toEqual({
        'X-Keep-Me': 'ok',
      });
    });

    it('removes headers with invalid names', () => {
      const { helpers } = createSubject();

      expect(helpers.buildSafeHeaders({
        'X Good': 'nope',
        'X_Good': 'still-nope',
        'X-Good': 'yes',
      })).toEqual({
        'X-Good': 'yes',
      });
    });

    it('removes non-string, multiline, and oversized values', () => {
      const { helpers } = createSubject();

      expect(helpers.buildSafeHeaders({
        'X-Number': 42,
        'X-Multiline': 'one\r\ntwo',
        'X-Oversized': 'a'.repeat(8193),
        'X-Valid': 'ok',
      })).toEqual({
        'X-Valid': 'ok',
      });
    });
  });

  describe('logWebhookDelivery', () => {
    it('writes delivery records when the database logger is available', () => {
      const { helpers, database } = createSubject();
      const details = { webhookId: 'wh-1', success: true };

      helpers.logWebhookDelivery(details);

      expect(database.logWebhookDelivery).toHaveBeenCalledWith(details);
    });

    it('no-ops when the database logger is unavailable', () => {
      const { helpers } = createSubject({
        database: {
          logWebhookDelivery: undefined,
        },
      });

      expect(() => helpers.logWebhookDelivery({ webhookId: 'wh-1' })).not.toThrow();
    });

    it('swallows database logging failures and emits a debug message', () => {
      const { helpers, logger } = createSubject({
        database: {
          logWebhookDelivery: vi.fn(() => {
            throw new Error('db write failed');
          }),
        },
      });

      helpers.logWebhookDelivery({ webhookId: 'wh-debug' });

      expect(logger.instance.debug).toHaveBeenCalledWith(
        'Webhook delivery log failed for wh-debug: db write failed',
      );
    });
  });

  describe('dispatchWebhook', () => {
    it('blocks internal hosts and records an SSRF failure without sending a request', () => {
      const { mod, helpers, database, logger, shared, http } = createSubject({
        shared: {
          isInternalHost: vi.fn(() => true),
        },
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-internal', url: 'http://127.0.0.1/hook' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      expect(shared.isInternalHost).toHaveBeenCalledWith('http://127.0.0.1/hook');
      expect(http.request).not.toHaveBeenCalled();
      expect(database.logWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
        webhookId: 'wh-internal',
        success: false,
        error: 'SSRF protection: internal/private hosts not allowed',
      }));
      expect(logger.instance.warn).toHaveBeenCalledWith(
        'Webhook delivery blocked for wh-internal: SSRF protection: internal/private hosts not allowed',
      );
    });

    it('uses the http client for http webhook URLs', () => {
      const { mod, helpers, http, https } = createSubject({
        http: createRequestModule({ responseStatus: 202 }),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-http', url: 'http://example.test/webhook' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(https.request).not.toHaveBeenCalled();
      expect(http.calls[0].url.href).toBe('http://example.test/webhook');
      expect(http.calls[0].options.method).toBe('POST');
      expect(http.calls[0].body).toBe(payloadStr);
    });

    it('uses the https client for https webhook URLs', () => {
      const { mod, helpers, http, https } = createSubject({
        https: createRequestModule({ responseStatus: 202 }),
      });
      const { payload, payloadStr } = createPayload(mod, 'peek.compliance.generated', { report_id: 'report-1' });

      helpers.dispatchWebhook(
        { id: 'wh-https', url: 'https://example.test/webhook' },
        'peek.compliance.generated',
        payload,
        payloadStr,
      );

      expect(https.request).toHaveBeenCalledTimes(1);
      expect(http.request).not.toHaveBeenCalled();
      expect(https.calls[0].url.href).toBe('https://example.test/webhook');
    });

    it('adds both signature headers when the webhook has a secret', () => {
      const { mod, helpers, http } = createSubject({
        http: createRequestModule({ responseStatus: 202 }),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-secret', url: 'http://example.test/webhook', secret: 'top-secret' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      const expectedSignature = `sha256=${realCrypto.createHmac('sha256', 'top-secret').update(payloadStr).digest('hex')}`;

      expect(http.calls[0].options.headers['X-Torque-Signature']).toBe(expectedSignature);
      expect(http.calls[0].options.headers['X-Webhook-Signature']).toBe(expectedSignature);
    });

    it('merges safe custom headers and filters blocked ones', () => {
      const { mod, helpers, http } = createSubject({
        http: createRequestModule({ responseStatus: 202 }),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        {
          id: 'wh-headers',
          url: 'http://example.test/webhook',
          headers: {
            Authorization: 'Bearer token',
            'X-Custom-Trace': 'trace-1',
            Host: 'blocked.example',
            'content-type': 'text/plain',
          },
        },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      expect(http.calls[0].options.headers).toMatchObject({
        Authorization: 'Bearer token',
        'X-Custom-Trace': 'trace-1',
        'Content-Type': 'application/json',
        'User-Agent': 'TORQUE-Peek-Webhook/1.0',
        'X-Webhook-Event': 'peek.bundle.created',
      });
      expect(http.calls[0].options.headers.Host).toBeUndefined();
    });

    it('logs successful deliveries when the response status is below 400', () => {
      const { mod, helpers, http, database } = createSubject({
        http: createRequestModule({ responseStatus: 204 }),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-success', url: 'http://example.test/webhook' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      expect(http.calls[0].response.resume).toHaveBeenCalledTimes(1);
      expect(database.logWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
        webhookId: 'wh-success',
        event: 'peek.bundle.created',
        taskId: 'task-1',
        responseStatus: 204,
        responseBody: null,
        success: true,
        error: null,
      }));
    });

    it('logs failed deliveries when the response status is 400 or higher', () => {
      const { mod, helpers, database } = createSubject({
        http: createRequestModule({ responseStatus: 503 }),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-http-error', url: 'http://example.test/webhook' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      expect(database.logWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
        webhookId: 'wh-http-error',
        success: false,
        responseStatus: 503,
        error: 'HTTP 503',
      }));
    });

    it('logs request errors for unreachable endpoints', () => {
      const { mod, helpers, database, logger, http } = createSubject({
        http: createRequestModule({ requestError: new Error('ENOTFOUND example.test') }),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-unreachable', url: 'http://example.test/webhook' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(logger.instance.warn).toHaveBeenCalledWith(
        'Webhook delivery failed for wh-unreachable: ENOTFOUND example.test',
      );
      expect(database.logWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
        webhookId: 'wh-unreachable',
        success: false,
        error: 'ENOTFOUND example.test',
      }));
    });

    it('destroys timed-out requests and records the timeout error', () => {
      const { mod, helpers, http, database } = createSubject({
        http: createRequestModule(),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-timeout', url: 'http://example.test/webhook' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      http.calls[0].req.emit('timeout');

      expect(http.calls[0].req.destroy).toHaveBeenCalledTimes(1);
      expect(http.calls[0].destroyedWith).toBeInstanceOf(Error);
      expect(http.calls[0].destroyedWith.message).toBe('Request timeout');
      expect(database.logWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
        webhookId: 'wh-timeout',
        success: false,
        error: 'Request timeout',
      }));
    });

    it('captures URL parsing failures without throwing', () => {
      const { mod, helpers, database, logger, http } = createSubject();
      const { payload, payloadStr } = createPayload(mod);

      expect(() => helpers.dispatchWebhook(
        { id: 'wh-invalid-url', url: 'not a url' },
        'peek.bundle.created',
        payload,
        payloadStr,
      )).not.toThrow();

      expect(http.request).not.toHaveBeenCalled();
      expect(logger.instance.warn).toHaveBeenCalledWith(
        expect.stringContaining('Webhook fire error for wh-invalid-url:'),
      );
      expect(database.logWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
        webhookId: 'wh-invalid-url',
        success: false,
      }));
    });

    it('captures synchronous client.request failures and records them', () => {
      const { mod, helpers, database, logger, http } = createSubject({
        http: createRequestModule({ throwOnRequest: new Error('socket setup failed') }),
      });
      const { payload, payloadStr } = createPayload(mod);

      helpers.dispatchWebhook(
        { id: 'wh-throw', url: 'http://example.test/webhook' },
        'peek.bundle.created',
        payload,
        payloadStr,
      );

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(logger.instance.warn).toHaveBeenCalledWith(
        'Webhook fire error for wh-throw: socket setup failed',
      );
      expect(database.logWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
        webhookId: 'wh-throw',
        success: false,
        error: 'socket setup failed',
      }));
    });
  });

  describe('fireWebhookForEvent', () => {
    it('returns fired=0 and warns when the event is unknown', async () => {
      const { mod, database, http, logger } = createSubject({
        webhooks: [{ id: 'wh-1', enabled: true, url: 'http://example.test/webhook', events: ['*'] }],
      });

      const result = await mod.fireWebhookForEvent('peek.unknown', { ok: true });

      expect(result).toEqual({ fired: 0 });
      expect(database.listWebhooks).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
      expect(logger.instance.warn).toHaveBeenCalledWith('Unknown peek webhook event: peek.unknown');
    });

    it('returns fired=0 when there are no subscribed webhooks', async () => {
      const deferred = createDeferredImmediate();
      global.setImmediate = deferred.stub;
      const { mod } = createSubject({
        webhooks: [{ id: 'wh-other', enabled: true, url: 'http://example.test/webhook', events: ['task.completed'] }],
      });

      const result = await mod.fireWebhookForEvent('peek.bundle.created', { task_id: 'task-1' });

      expect(result).toEqual({ fired: 0 });
      expect(deferred.stub).not.toHaveBeenCalled();
    });

    it('returns a lookup error when webhook discovery throws', async () => {
      const { mod, logger } = createSubject({
        database: {
          listWebhooks: vi.fn(() => {
            throw new Error('db offline');
          }),
        },
      });

      const result = await mod.fireWebhookForEvent('peek.bundle.created', { task_id: 'task-1' });

      expect(result).toEqual({ fired: 0, error: 'db offline' });
      expect(logger.instance.warn).toHaveBeenCalledWith('Failed to list webhooks for peek.bundle.created: db offline');
    });

    it.each([
      'peek.recovery.executed',
      'peek.bundle.created',
      'peek.compliance.generated',
    ])('fires %s asynchronously and serializes the expected payload schema', async (event) => {
      const deferred = createDeferredImmediate();
      global.setImmediate = deferred.stub;
      const { mod, http } = createSubject({
        webhooks: [{ id: `wh-${event}`, enabled: true, url: 'http://example.test/webhook', events: [event] }],
        http: createRequestModule({ responseStatus: 202 }),
      });

      const result = await mod.fireWebhookForEvent(event, { task_id: 'task-55', source: event });

      expect(result).toEqual({ fired: 1 });
      expect(deferred.stub).toHaveBeenCalledTimes(1);
      expect(http.request).not.toHaveBeenCalled();

      deferred.runAll();

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(http.calls[0].body)).toEqual({
        event,
        timestamp: expect.any(String),
        data: { task_id: 'task-55', source: event },
      });
      expect(Number.isNaN(Date.parse(JSON.parse(http.calls[0].body).timestamp))).toBe(false);
    });

    it('schedules one fire-and-forget dispatch per matching webhook', async () => {
      const deferred = createDeferredImmediate();
      global.setImmediate = deferred.stub;
      const { mod, http } = createSubject({
        webhooks: [
          { id: 'wh-exact', enabled: true, url: 'http://example.test/exact', events: ['peek.bundle.created'] },
          { id: 'wh-prefix', enabled: true, url: 'http://example.test/prefix', events: ['peek.*'] },
          { id: 'wh-wild', enabled: true, url: 'http://example.test/wild', events: ['*'] },
          { id: 'wh-disabled', enabled: false, url: 'http://example.test/disabled', events: ['peek.bundle.created'] },
        ],
        http: createRequestModule({ responseStatus: 202 }),
      });

      const result = await mod.fireWebhookForEvent('peek.bundle.created', { task_id: 'task-101' });

      expect(result).toEqual({ fired: 3 });
      expect(deferred.stub).toHaveBeenCalledTimes(3);
      expect(http.request).not.toHaveBeenCalled();

      deferred.runAll();

      expect(http.request).toHaveBeenCalledTimes(3);
    });

    it('falls back to getWebhooksForEvent when listWebhooks is unavailable', async () => {
      const deferred = createDeferredImmediate();
      global.setImmediate = deferred.stub;
      const { mod, database, http } = createSubject({
        database: {
          listWebhooks: undefined,
          getWebhooksForEvent: vi.fn(() => [
            { id: 'wh-fallback', enabled: true, url: 'http://example.test/fallback', events: ['peek.*'] },
          ]),
        },
        http: createRequestModule({ responseStatus: 202 }),
      });

      const result = await mod.fireWebhookForEvent('peek.compliance.generated', { report_id: 'report-88' });

      expect(result).toEqual({ fired: 1 });
      expect(database.getWebhooksForEvent).toHaveBeenCalledWith('peek.compliance.generated');

      deferred.runAll();

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(http.calls[0].body)).toEqual({
        event: 'peek.compliance.generated',
        timestamp: expect.any(String),
        data: { report_id: 'report-88' },
      });
    });
  });
});
