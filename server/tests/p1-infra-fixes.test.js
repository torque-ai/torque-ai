const { EventEmitter } = require('events');
const http = require('http');

const { getDbInstance } = require('../database');
const configCore = require('../db/config-core');
const taskCore = require('../db/task-core');
const dbCoord = require('../db/coordination');
const eventDispatch = require('../hooks/event-dispatch');
const mcpSse = require('../mcp-sse');

const { setupTestDb, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

function createMockResponse() {
  const chunks = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const listeners = {};
  const response = {
    statusCode: null,
    headers: {},
    writableEnded: false,
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    setHeader: vi.fn((name, value) => {
      response.headers[name] = value;
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      if (headers) Object.assign(response.headers, headers);
    }),
    write: vi.fn((data) => {
      chunks.push(data);
      return true;
    }),
    end: vi.fn((body = '') => {
      if (body) chunks.push(body);
      response.writableEnded = true;
      resolveDone();
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach(cb => cb(...args));
    }),
    getBody: () => chunks.join(''),
  };

  return { response, done };
}

async function dispatchRequest(handler, { method, url, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    req.emit('end');
  });

  await handlerPromise;
  if (!response.writableEnded) {
    await new Promise(resolve => setTimeout(resolve, 20));
  } else {
    await done;
  }

  return { response, req };
}

function rawDb() {
  return _rawDb();
}

describe('P1 infra fixes', () => {
  describe('Coordination lock stale detection uses lease expiry', () => {
    beforeAll(() => {
      setupTestDb('p1-coord');
      dbCoord.setDb(getDbInstance());
      dbCoord.setGetTask(taskCore.getTask);

      rawDb().prepare('DELETE FROM distributed_locks').run();
    });

    afterAll(() => {
      teardownTestDb();
    });

    beforeEach(() => {
      rawDb().prepare('DELETE FROM distributed_locks').run();
    });

    it('uses lease expiry even when heartbeat is stale', () => {
      const freshExpiry = new Date(Date.now() + 120000).toISOString();
      const staleHeartbeat = new Date(Date.now() - 120000).toISOString();

      dbCoord.acquireLock('lease-stale-heartbeat', 'holder-old', 300);
      rawDb().prepare('UPDATE distributed_locks SET last_heartbeat = ?, expires_at = ? WHERE lock_name = ?')
        .run(staleHeartbeat, freshExpiry, 'lease-stale-heartbeat');

      const takeoverAttempt = dbCoord.acquireLock('lease-stale-heartbeat', 'holder-new', 30);
      expect(takeoverAttempt.acquired).toBe(false);
      expect(takeoverAttempt.holder).toBe('holder-old');

      const staleCheck = dbCoord.checkLock('lease-stale-heartbeat');
      expect(staleCheck.held).toBe(true);
      expect(staleCheck.expired).toBe(false);
    });

    it('permits takeover only when lease has expired', () => {
      const expired = new Date(Date.now() - 120000).toISOString();
      const stillFreshHeartbeat = new Date(Date.now() - 120000).toISOString();

      dbCoord.acquireLock('lease-expired', 'holder-old', 300);
      rawDb().prepare('UPDATE distributed_locks SET last_heartbeat = ?, expires_at = ? WHERE lock_name = ?')
        .run(stillFreshHeartbeat, expired, 'lease-expired');

      const takeoverAttempt = dbCoord.acquireLock('lease-expired', 'holder-new', 30);
      const check = dbCoord.checkLock('lease-expired');

      expect(takeoverAttempt.acquired).toBe(true);
      expect(check.holder).toBe('holder-new');
      expect(check.held).toBe(true);
    });
  });

  describe('SSE reconnect and shutdown gating', () => {
    let handleHttpRequest;
    let getTaskEventsSpy;
    const mockServer = {
      on: vi.fn(),
      close: vi.fn(),
      listen: vi.fn((port, host, cb) => {
        if (cb) cb();
      }),
    };

    beforeAll(async () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
      vi.spyOn(http, 'createServer').mockImplementation((handler) => {
        handleHttpRequest = handler;
        return mockServer;
      });

      getTaskEventsSpy = vi.spyOn(eventDispatch, 'getTaskEvents');
      await mcpSse.start({ port: 0 });
    });

    afterAll(async () => {
      mcpSse.stop();
      vi.restoreAllMocks();
    });

    beforeEach(() => {
      getTaskEventsSpy.mockReset();
      mcpSse.setShuttingDown(false);
    });

    it('replays based on Last-Event-ID header when reconnecting', async () => {
      getTaskEventsSpy.mockReturnValue([
        {
          id: 6,
          task_id: 'task-replay',
          event_type: 'completed',
          new_value: 'completed',
          event_data: JSON.stringify({ exit_code: 0 }),
          created_at: '2026-01-01T00:00:01.000Z',
        },
      ]);

      await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: {
          host: 'localhost:3458',
          'last-event-id': '5',
        },
      });

      expect(getTaskEventsSpy).toHaveBeenCalledTimes(1);
      expect(getTaskEventsSpy.mock.calls[0][0]).toMatchObject({ sinceId: 5 });
    });

    it('returns 503 for SSE requests while shutting down', async () => {
      mcpSse.setShuttingDown(true);
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: {
          host: 'localhost:3458',
        },
      });

      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.getBody())).toEqual({
        error: 'SSE service is shutting down',
      });
    });
  });
});
