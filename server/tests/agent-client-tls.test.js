'use strict';

const { EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { RemoteAgentClient } = require('../remote/agent-client');

describe('RemoteAgentClient TLS transport selection', () => {
  function mockRequest({ responseChunks = [], responseStatusCode = 200, responseDataIsBuffer = false }) {
    const req = new EventEmitter();
    req.setTimeout = vi.fn();
    req.write = vi.fn();
    req.end = vi.fn();

    const res = new EventEmitter();
    res.statusCode = responseStatusCode;
    res.setEncoding = vi.fn();

    process.nextTick(() => {
      for (const chunk of responseChunks) {
        res.emit('data', responseDataIsBuffer ? Buffer.from(chunk) : chunk);
      }
      res.emit('end');
    });

    return { req, res };
  }

  it('uses http request when tls is disabled', async () => {
    const httpRequestSpy = vi.spyOn(http, 'request');
    const httpsRequestSpy = vi.spyOn(https, 'request');

    try {
      httpRequestSpy.mockImplementation((opts, cb) => {
        const { req, res } = mockRequest({ responseChunks: ['ok'], responseDataIsBuffer: true });
        cb(res);
        return req;
      });

      const c = new RemoteAgentClient({ host: '127.0.0.1', port: 1, secret: 's' });
      const result = await c._request('GET', '/health', null, 100);

      expect(result.status).toBe(200);
      expect(result.body).toBe('ok');
      expect(httpRequestSpy).toHaveBeenCalledTimes(1);
      expect(httpsRequestSpy).not.toHaveBeenCalled();
    } finally {
      httpRequestSpy.mockRestore();
      httpsRequestSpy.mockRestore();
    }
  });

  it('uses https request when tls is enabled', async () => {
    const httpRequestSpy = vi.spyOn(http, 'request');
    const httpsRequestSpy = vi.spyOn(https, 'request');

    try {
      httpsRequestSpy.mockImplementation((opts, cb) => {
        const { req, res } = mockRequest({
          responseChunks: [
            JSON.stringify({ exit_code: 0, duration_ms: 1 }) + '\n',
          ],
        });
        cb(res);
        return req;
      });

      const c = new RemoteAgentClient({
        host: '127.0.0.1',
        port: 1,
        secret: 's',
        tls: true,
      });

      const result = await c._requestStreaming('POST', '/run', { command: 'echo' }, 100);

      expect(result.success).toBe(true);
      expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
      expect(httpRequestSpy).not.toHaveBeenCalled();
    } finally {
      httpRequestSpy.mockRestore();
      httpsRequestSpy.mockRestore();
    }
  });

  it('passes rejectUnauthorized through to HTTPS options', async () => {
    const httpsRequestSpy = vi.spyOn(https, 'request');

    try {
      httpsRequestSpy.mockImplementation((opts, cb) => {
        const { req, res } = mockRequest({ responseChunks: ['ok'], responseDataIsBuffer: true });
        cb(res);
        return req;
      });

      const c = new RemoteAgentClient({
        host: '127.0.0.1',
        port: 1,
        secret: 's',
        tls: true,
        rejectUnauthorized: false,
      });

      await c._request('GET', '/health', null, 100);

      expect(httpsRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rejectUnauthorized: false,
        }),
        expect.any(Function)
      );
    } finally {
      httpsRequestSpy.mockRestore();
    }
  });
});
