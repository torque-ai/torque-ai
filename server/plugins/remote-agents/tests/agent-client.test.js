'use strict';

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { RemoteAgentClient, HEALTH_CACHE_TTL } = require('../agent-client');

describe('RemoteAgentClient', () => {
  /** @type {RemoteAgentClient} */
  let client;

  beforeEach(() => {
    client = new RemoteAgentClient({
      host: '127.0.0.1',
      port: 19999,  // unlikely to be in use
      secret: 'test-secret',
      healthCheckTimeout: 1000,
    });
  });

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

  // ─── transport selection ─────────────────────────────────────

  describe('_request transport selection', () => {
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
        httpRequestSpy.mockImplementation(() => {
          throw new Error('HTTP request should not be used for tls clients');
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

    it('passes rejectUnauthorized to transport options when tls is enabled', async () => {
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

        expect(httpsRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
          rejectUnauthorized: false,
        }), expect.any(Function));
      } finally {
        httpsRequestSpy.mockRestore();
      }
    });
  });

  // ─── isAvailable() ─────────────────────────────────────────────

  describe('isAvailable()', () => {
    it('returns false with no health data', () => {
      expect(client.isAvailable()).toBe(false);
    });

    it('returns true with fresh healthy data', () => {
      client._cachedHealth = {
        status: 'healthy',
        running_tasks: 0,
        max_concurrent: 3,
        timestamp: Date.now(),
      };
      expect(client.isAvailable()).toBe(true);
    });

    it('returns false with stale data (timestamp > 90s old)', () => {
      client._cachedHealth = {
        status: 'healthy',
        running_tasks: 0,
        max_concurrent: 3,
        timestamp: Date.now() - HEALTH_CACHE_TTL - 1,
      };
      expect(client.isAvailable()).toBe(false);
    });

    it('returns false when at capacity (running_tasks >= max_concurrent)', () => {
      client._cachedHealth = {
        status: 'healthy',
        running_tasks: 3,
        max_concurrent: 3,
        timestamp: Date.now(),
      };
      expect(client.isAvailable()).toBe(false);
    });

    it('returns false when status is not healthy', () => {
      client._cachedHealth = {
        status: 'degraded',
        running_tasks: 0,
        max_concurrent: 3,
        timestamp: Date.now(),
      };
      expect(client.isAvailable()).toBe(false);
    });
  });

  // ─── checkHealth() ─────────────────────────────────────────────

  describe('checkHealth()', () => {
    it('returns null on unreachable host and increments consecutiveFailures', async () => {
      const result = await client.checkHealth();
      expect(result).toBeNull();
      expect(client.consecutiveFailures).toBe(1);
      expect(client.status).toBe('degraded');
    });

    it('sets status to degraded after 1-2 failures', async () => {
      await client.checkHealth();
      expect(client.status).toBe('degraded');
      expect(client.consecutiveFailures).toBe(1);

      await client.checkHealth();
      expect(client.status).toBe('degraded');
      expect(client.consecutiveFailures).toBe(2);
    });

    it('sets status to down after 3 consecutive failures', async () => {
      await client.checkHealth();
      await client.checkHealth();
      await client.checkHealth();
      expect(client.status).toBe('down');
      expect(client.consecutiveFailures).toBe(3);
    });

    it('resets to healthy and consecutiveFailures to 0 on success', async () => {
      // Simulate prior failures
      client._status = 'down';
      client._consecutiveFailures = 5;

      // Create a mock HTTP server that returns healthy status
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          running_tasks: 1,
          max_concurrent: 3,
          uptime: 12345,
        }));
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const healthClient = new RemoteAgentClient({
          host: '127.0.0.1',
          port,
          secret: 'test-secret',
        });
        healthClient._status = 'down';
        healthClient._consecutiveFailures = 5;

        const result = await healthClient.checkHealth();

        expect(result).not.toBeNull();
        expect(result.status).toBe('healthy');
        expect(result.running_tasks).toBe(1);
        expect(healthClient.status).toBe('healthy');
        expect(healthClient.consecutiveFailures).toBe(0);
        expect(healthClient.isAvailable()).toBe(true);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('clears cached health on failure', async () => {
      client._cachedHealth = {
        status: 'healthy',
        running_tasks: 0,
        max_concurrent: 3,
        timestamp: Date.now(),
      };

      // checkHealth to unreachable host should clear the cache
      await client.checkHealth();
      expect(client._cachedHealth).toBeNull();
      expect(client.isAvailable()).toBe(false);
    });
  });

  // ─── constructor defaults ──────────────────────────────────────

  describe('constructor', () => {
    it('initializes with correct defaults', () => {
      const c = new RemoteAgentClient({
        host: '10.0.0.1',
        port: 7500,
        secret: 'abc',
      });
      expect(c.host).toBe('10.0.0.1');
      expect(c.port).toBe(7500);
      expect(c.secret).toBe('abc');
      expect(c.healthCheckTimeout).toBe(5000);
      expect(c.status).toBe('unknown');
      expect(c.consecutiveFailures).toBe(0);
      expect(c.isAvailable()).toBe(false);
    });
  });

  // ─── sync() ────────────────────────────────────────────────────

  describe('sync()', () => {
    it('sends sync request and returns parsed response', async () => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
          const parsed = JSON.parse(body);
          expect(parsed.project).toBe('my-project');
          expect(parsed.branch).toBe('main');
          expect(parsed.repo_url).toBe('https://github.com/foo/bar.git');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, commit: 'abc123' }));
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        const result = await c.sync('my-project', 'main', 'https://github.com/foo/bar.git');
        expect(result.ok).toBe(true);
        expect(result.commit).toBe('abc123');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('throws on non-200 response', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        await expect(c.sync('proj', 'main')).rejects.toThrow('Sync failed (500)');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  // ─── run() ─────────────────────────────────────────────────────

  describe('run()', () => {
    it('parses streaming NDJSON response with stdout, stderr, and exit info', async () => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
          const parsed = JSON.parse(body);
          expect(parsed.command).toBe('echo');
          expect(parsed.args).toEqual(['hello']);
          expect(parsed.timeout_ms).toBe(120000);

          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ stream: 'stdout', data: 'hello\n' }) + '\n');
          res.write(JSON.stringify({ stream: 'stderr', data: 'warning\n' }) + '\n');
          res.write(JSON.stringify({ exit_code: 0, duration_ms: 42 }) + '\n');
          res.end();
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        const result = await c.run('echo', ['hello']);

        expect(result.success).toBe(true);
        expect(result.output).toBe('hello\n');
        expect(result.error).toBe('warning\n');
        expect(result.exitCode).toBe(0);
        expect(result.durationMs).toBe(42);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('handles non-zero exit code', async () => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ stream: 'stderr', data: 'not found\n' }) + '\n');
          res.write(JSON.stringify({ exit_code: 1, duration_ms: 100 }) + '\n');
          res.end();
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        const result = await c.run('ls', ['nonexistent']);

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.error).toBe('not found\n');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('throws "Agent at capacity" on 503', async () => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('busy');
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        await expect(c.run('echo', ['hi'])).rejects.toThrow('Agent at capacity');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('throws "Command not allowed" on 403', async () => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('forbidden');
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        await expect(c.run('rm', ['-rf', '/'])).rejects.toThrow('Command not allowed');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('handles chunked NDJSON where lines split across chunks', async () => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

          // Send data in chunks that split across NDJSON line boundaries
          const line1 = JSON.stringify({ stream: 'stdout', data: 'part1' });
          const line2 = JSON.stringify({ stream: 'stdout', data: 'part2' });
          const line3 = JSON.stringify({ exit_code: 0, duration_ms: 50 });

          // Split first line across two chunks
          const halfPoint = Math.floor(line1.length / 2);
          res.write(line1.substring(0, halfPoint));

          // Second chunk finishes first line and starts second
          setTimeout(() => {
            res.write(line1.substring(halfPoint) + '\n' + line2 + '\n');
            // Third chunk has exit info
            setTimeout(() => {
              res.write(line3 + '\n');
              res.end();
            }, 10);
          }, 10);
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        const result = await c.run('test', []);

        expect(result.success).toBe(true);
        expect(result.output).toBe('part1part2');
        expect(result.exitCode).toBe(0);
        expect(result.durationMs).toBe(50);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('sends X-Torque-Secret header', async () => {
      let receivedSecret = null;
      const server = http.createServer((req, res) => {
        receivedSecret = req.headers['x-torque-secret'];
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ exit_code: 0, duration_ms: 1 }) + '\n');
          res.end();
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 'my-secret-123' });
        await c.run('true', []);
        expect(receivedSecret).toBe('my-secret-123');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('passes cwd and env to agent', async () => {
      let receivedBody = null;
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ exit_code: 0, duration_ms: 1 }) + '\n');
          res.end();
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      try {
        const c = new RemoteAgentClient({ host: '127.0.0.1', port, secret: 's' });
        await c.run('npm', ['test'], {
          cwd: '/home/user/project',
          env: { NODE_ENV: 'test' },
          timeout: 60000,
        });

        expect(receivedBody.command).toBe('npm');
        expect(receivedBody.args).toEqual(['test']);
        expect(receivedBody.cwd).toBe('/home/user/project');
        expect(receivedBody.env).toEqual({ NODE_ENV: 'test' });
        expect(receivedBody.timeout_ms).toBe(60000);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
