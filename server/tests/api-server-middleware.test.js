import { describe, expect, it, vi } from 'vitest';

const { EventEmitter } = require('events');
const {
  parseBody,
  parseQuery,
  sendJson,
} = require('../api/middleware');
const {
  coerceRestPassthroughValue,
  runRouteMiddleware,
} = require('../api/dispatcher-helpers');

function createMockRequest(overrides = {}) {
  const req = new EventEmitter();
  req.method = 'GET';
  req.url = '/';
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  req.connection = { remoteAddress: '127.0.0.1' };
  req.destroy = vi.fn();
  return Object.assign(req, overrides);
}

function createMockResponse() {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const listeners = {};
  const responseHeaders = {};
  const writtenChunks = [];

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, callback) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    }),
    emit: vi.fn((event, ...args) => {
      for (const callback of listeners[event] || []) {
        callback(...args);
      }
    }),
    setHeader: vi.fn((name, value) => {
      responseHeaders[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
    write: vi.fn((chunk) => {
      writtenChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      response.body = writtenChunks.join('');
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      if (body) {
        writtenChunks.push(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      }
      response.body = writtenChunks.join('');
      for (const callback of listeners.finish || []) {
        callback();
      }
      resolveDone();
    }),
  };

  return { response, done };
}

describe('api/middleware', () => {
  it('exports parseBody, parseQuery, and sendJson as functions', () => {
    const middleware = require('../api/middleware');

    expect(typeof middleware.parseBody).toBe('function');
    expect(typeof middleware.parseQuery).toBe('function');
    expect(typeof middleware.sendJson).toBe('function');
  });

  it('parses a JSON body from emitted request chunks', async () => {
    const req = createMockRequest();
    const bodyPromise = parseBody(req);

    process.nextTick(() => {
      req.emit('data', Buffer.from('{"ok":'));
      req.emit('data', Buffer.from('true}'));
      req.emit('end');
    });

    await expect(bodyPromise).resolves.toEqual({ ok: true });
  });

  it('parses query params from the request url', () => {
    expect(parseQuery('/foo?a=1&b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('writes a JSON response body with content type headers', async () => {
    const mockReq = createMockRequest({ requestId: 'req-json' });
    const { response, done } = createMockResponse();

    sendJson(response, { ok: true }, 200, mockReq);
    await done;

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
      'X-Request-ID': 'req-json',
    }));
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });
});

describe('api/dispatcher-helpers coerceRestPassthroughValue', () => {
  it('coerces integers and rejects invalid integer input', () => {
    const integerSchema = { properties: { count: { type: 'integer' } } };

    expect(coerceRestPassthroughValue(integerSchema, 'count', '42')).toEqual({ ok: true, value: 42 });
    expect(coerceRestPassthroughValue(integerSchema, 'count', 'abc')).toEqual(expect.objectContaining({ ok: false }));
  });

  it('coerces numbers and rejects non-numeric input', () => {
    const numberSchema = { properties: { ratio: { type: 'number' } } };

    expect(coerceRestPassthroughValue(numberSchema, 'ratio', '3.14')).toEqual({ ok: true, value: 3.14 });
    expect(coerceRestPassthroughValue(numberSchema, 'ratio', 'NaN')).toEqual(expect.objectContaining({ ok: false }));
  });

  it('coerces booleans and rejects unsupported boolean strings', () => {
    const booleanSchema = { properties: { enabled: { type: 'boolean' } } };

    expect(coerceRestPassthroughValue(booleanSchema, 'enabled', 'true')).toEqual({ ok: true, value: true });
    expect(coerceRestPassthroughValue(booleanSchema, 'enabled', 'false')).toEqual({ ok: true, value: false });
    expect(coerceRestPassthroughValue(booleanSchema, 'enabled', 'yes')).toEqual(expect.objectContaining({ ok: false }));
  });

  it('passes string values through unchanged when schema is string or missing', () => {
    const stringSchema = { properties: { name: { type: 'string' } } };
    const missingSchema = { properties: {} };

    expect(coerceRestPassthroughValue(stringSchema, 'name', 'alpha')).toEqual({ ok: true, value: 'alpha' });
    expect(coerceRestPassthroughValue(missingSchema, 'name', 'beta')).toEqual({ ok: true, value: 'beta' });
  });
});

describe('api/dispatcher-helpers runRouteMiddleware', () => {
  it('returns true for an empty middleware chain', async () => {
    const req = createMockRequest();
    const { response } = createMockResponse();

    await expect(runRouteMiddleware([], req, response)).resolves.toBe(true);
  });

  it('continues when middleware calls next', async () => {
    const req = createMockRequest();
    const { response } = createMockResponse();
    const middleware = vi.fn((_req, _res, next) => {
      next();
    });

    await expect(runRouteMiddleware([middleware], req, response)).resolves.toBe(true);
    expect(middleware).toHaveBeenCalledTimes(1);
  });

  it('halts the chain when middleware responds without calling next', async () => {
    const req = createMockRequest();
    const { response } = createMockResponse();
    const middleware = vi.fn((_req, res) => {
      res.end(JSON.stringify({ halted: true }));
    });

    await expect(runRouteMiddleware([middleware], req, response)).resolves.toBe(false);
    expect(JSON.parse(response.body)).toEqual({ halted: true });
  });
});
