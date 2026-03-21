'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const keyManager = require('../auth/key-manager');
const sseTickets = require('../auth/sse-tickets');

let apiServerCore;

function createMockResponse() {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const listeners = {};
  const writtenChunks = [];
  const response = {
    statusCode: null,
    headers: null,
    on: vi.fn((event, callback) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    }),
    emit: vi.fn((event, ...args) => {
      for (const callback of listeners[event] || []) {
        callback(...args);
      }
    }),
    setHeader: vi.fn(),
    write: vi.fn((chunk) => {
      writtenChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      if (body) {
        writtenChunks.push(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      }
      resolveDone();
    }),
    getBody: () => writtenChunks.join(''),
  };

  return { response, done };
}

describe('sse-tickets', () => {
  beforeAll(() => {
    setupTestDb('sse-tickets');

    const handle = rawDb();
    handle.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT,
        user_id TEXT
      )
    `);
    handle.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');

    keyManager.init(handle);
    apiServerCore = require('../api-server.core');
  });

  beforeEach(() => {
    const handle = rawDb();
    handle.prepare('DELETE FROM api_keys').run();
    handle.prepare("DELETE FROM config WHERE key = 'auth_server_secret'").run();
    sseTickets._resetForTests();
    keyManager._resetForTest();
    keyManager.init(handle);
  });

  afterEach(() => {
    vi.useRealTimers();
    sseTickets._resetForTests();
  });

  afterAll(() => {
    sseTickets._resetForTests();
    keyManager._resetForTest();
    teardownTestDb();
  });

  it('generates ticket with correct format and TTL', () => {
    vi.useFakeTimers();
    const issuedAt = new Date('2026-03-21T12:00:00.000Z');
    vi.setSystemTime(issuedAt);

    const result = sseTickets.generateTicket('key-123');

    expect(result.ticket).toMatch(/^sse_tk_[0-9a-f]{48}$/);
    expect(new Date(result.expiresAt).getTime() - issuedAt.getTime()).toBe(60 * 1000);
  });

  it('validates fresh ticket successfully', () => {
    const { ticket } = sseTickets.generateTicket('key-123');

    expect(sseTickets.validateTicket(ticket)).toEqual({
      valid: true,
      apiKeyId: 'key-123',
    });
  });

  it('rejects expired ticket', () => {
    vi.useFakeTimers();
    const issuedAt = new Date('2026-03-21T12:00:00.000Z');
    vi.setSystemTime(issuedAt);

    const { ticket } = sseTickets.generateTicket('key-123');
    vi.setSystemTime(new Date(issuedAt.getTime() + (60 * 1000) + 1));

    expect(sseTickets.validateTicket(ticket)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('rejects already-used ticket (one-time use)', () => {
    const { ticket } = sseTickets.generateTicket('key-123');

    expect(sseTickets.validateTicket(ticket)).toEqual({
      valid: true,
      apiKeyId: 'key-123',
    });
    expect(sseTickets.validateTicket(ticket)).toEqual({
      valid: false,
      reason: 'unknown',
    });
  });

  it('cleanupExpired removes old tickets', () => {
    vi.useFakeTimers();
    const issuedAt = new Date('2026-03-21T12:00:00.000Z');
    vi.setSystemTime(issuedAt);

    sseTickets.generateTicket('key-123');
    sseTickets.generateTicket('key-456');
    expect(sseTickets._getTicketCount()).toBe(2);

    vi.setSystemTime(new Date(issuedAt.getTime() + (60 * 1000) + 1));
    sseTickets.cleanupExpired();

    expect(sseTickets._getTicketCount()).toBe(0);
  });

  it('rejects unknown ticket', () => {
    expect(sseTickets.validateTicket('sse_tk_unknown')).toEqual({
      valid: false,
      reason: 'unknown',
    });
  });

  it('POST /api/auth/sse-ticket requires an Authorization bearer token', async () => {
    const { response, done } = createMockResponse();

    await apiServerCore._testing.handleCreateSseTicket({
      headers: {},
    }, response, {});
    await done;

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.getBody())).toEqual({
      error: 'Authorization header with Bearer token required',
    });
  });

  it('POST /api/auth/sse-ticket returns a short-lived ticket for a valid API key', async () => {
    const created = keyManager.createKey({ name: 'sse-ticket-test' });
    const { response, done } = createMockResponse();

    await apiServerCore._testing.handleCreateSseTicket({
      headers: {
        authorization: `Bearer ${created.key}`,
      },
    }, response, {});
    await done;

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.getBody())).toEqual({
      ticket: expect.stringMatching(/^sse_tk_[0-9a-f]{48}$/),
      expires_at: expect.any(String),
    });
  });
});
