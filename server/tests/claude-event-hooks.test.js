import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const vitestSetup = require('./vitest-setup');
const { setupTestDbOnly, teardownTestDb } = vitestSetup;

function makeReq(method, url, body = null) {
  const bodyStr = body ? JSON.stringify(body) : '';
  return {
    method,
    url,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(bodyStr)),
    },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr));
      if (event === 'end') cb();
      return this;
    },
  };
}

function makeRes() {
  let _status = 200;
  let _body = null;
  const _headers = {};
  return {
    writeHead(status, headers) { _status = status; Object.assign(_headers, headers); return this; },
    setHeader(k, v) { _headers[k] = v; },
    end(data) { _body = data; },
    get statusCode() { return _status; },
    get body() { return _body ? JSON.parse(_body) : null; },
    get headers() { return _headers; },
  };
}

let handleClaudeEvent;
let handleClaudeFiles;
let _claudeEventLog;

describe('Claude Code hook bridge', () => {
  beforeEach(() => {
    setupTestDbOnly('claude-event-hooks');
    const core = require('../api-server.core');
    handleClaudeEvent = core._testing.handleClaudeEvent;
    handleClaudeFiles = core._testing.handleClaudeFiles;
    _claudeEventLog = core._testing._claudeEventLog;
    _claudeEventLog.clear();
  });

  afterEach(() => {
    _claudeEventLog.clear();
    teardownTestDb();
  });

  // --- Route registration ---

  it('routes.js registers POST /api/hooks/claude-event', () => {
    const routes = require('../api/routes');
    const route = routes.find(r => r.path === '/api/hooks/claude-event');
    expect(route).toBeDefined();
    expect(route.method).toBe('POST');
    expect(route.handlerName).toBe('handleClaudeEvent');
  });

  it('routes.js registers GET /api/hooks/claude-files with mapQuery', () => {
    const routes = require('../api/routes');
    const route = routes.find(r => r.path === '/api/hooks/claude-files');
    expect(route).toBeDefined();
    expect(route.method).toBe('GET');
    expect(route.mapQuery).toBe(true);
  });

  // --- handleClaudeEvent ---

  it('accepts a file_write event and returns ok', async () => {
    const req = makeReq('POST', '/api/hooks/claude-event', {
      event_type: 'file_write',
      session_id: 'sess-abc',
      payload: { file_path: '/tmp/foo.ts', tool_name: 'Edit' },
    });
    const res = makeRes();

    await handleClaudeEvent(req, res, {});
    expect(res.body.status).toBe('ok');
    expect(res.body.event_type).toBe('file_write');
    expect(res.body.tracked_files).toBe(1);
  });

  it('tracks multiple files per session', async () => {
    for (const file of ['/tmp/a.ts', '/tmp/b.ts', '/tmp/c.ts']) {
      const req = makeReq('POST', '/api/hooks/claude-event', {
        event_type: 'file_write',
        session_id: 'sess-multi',
        payload: { file_path: file },
      });
      await handleClaudeEvent(req, makeRes(), {});
    }
    expect(_claudeEventLog.get('sess-multi').files.size).toBe(3);
    expect(_claudeEventLog.get('sess-multi').events.length).toBe(3);
  });

  it('deduplicates same file path in tracking set', async () => {
    for (let i = 0; i < 3; i++) {
      const req = makeReq('POST', '/api/hooks/claude-event', {
        event_type: 'file_write',
        session_id: 'sess-dup',
        payload: { file_path: '/tmp/same.ts' },
      });
      await handleClaudeEvent(req, makeRes(), {});
    }
    expect(_claudeEventLog.get('sess-dup').files.size).toBe(1);
    expect(_claudeEventLog.get('sess-dup').events.length).toBe(3);
  });

  it('handles unknown event type gracefully', async () => {
    const req = makeReq('POST', '/api/hooks/claude-event', {
      event_type: 'custom_event',
      session_id: 'sess-custom',
      payload: { data: 'test' },
    });
    const res = makeRes();
    await handleClaudeEvent(req, res, {});
    expect(res.body.status).toBe('ok');
    expect(res.body.event_type).toBe('custom_event');
    expect(res.body.tracked_files).toBe(0);
  });

  it('handles empty body gracefully', async () => {
    const req = makeReq('POST', '/api/hooks/claude-event', {});
    const res = makeRes();
    await handleClaudeEvent(req, res, {});
    expect(res.body.status).toBe('ok');
    expect(res.body.event_type).toBe('unknown');
  });

  it('caps event history at 500 per session', async () => {
    // Manually populate the log with 500 events
    _claudeEventLog.set('sess-cap', {
      files: new Set(['/tmp/cap.ts']),
      events: Array.from({ length: 500 }, (_, i) => ({ type: 'file_write', file: '/tmp/cap.ts', i })),
    });

    // Push one more → 501 total → triggers trim to last 250
    const req = makeReq('POST', '/api/hooks/claude-event', {
      event_type: 'file_write',
      session_id: 'sess-cap',
      payload: { file_path: '/tmp/cap.ts' },
    });
    await handleClaudeEvent(req, makeRes(), {});

    // After: push makes 501, which is >500, so slice(-250) → exactly 250
    const events = _claudeEventLog.get('sess-cap').events;
    expect(events.length).toBe(250);
  });

  // --- handleClaudeFiles ---

  it('returns files for a specific session', async () => {
    // Populate some data
    _claudeEventLog.set('sess-files', {
      files: new Set(['/a.ts', '/b.ts']),
      events: [{ type: 'file_write' }, { type: 'file_write' }],
    });

    const req = makeReq('GET', '/api/hooks/claude-files?session_id=sess-files');
    const res = makeRes();
    await handleClaudeFiles(req, res, {});

    expect(res.body.session_id).toBe('sess-files');
    expect(res.body.files).toContain('/a.ts');
    expect(res.body.files).toContain('/b.ts');
    expect(res.body.event_count).toBe(2);
  });

  it('returns empty files for unknown session', async () => {
    const req = makeReq('GET', '/api/hooks/claude-files?session_id=unknown');
    const res = makeRes();
    await handleClaudeFiles(req, res, {});

    expect(res.body.session_id).toBe('unknown');
    expect(res.body.files).toEqual([]);
    expect(res.body.event_count).toBe(0);
  });

  it('returns all sessions summary when no session_id', async () => {
    _claudeEventLog.set('s1', { files: new Set(['/a']), events: [{}] });
    _claudeEventLog.set('s2', { files: new Set(['/b', '/c']), events: [{}, {}] });

    const req = makeReq('GET', '/api/hooks/claude-files');
    const res = makeRes();
    await handleClaudeFiles(req, res, {});

    expect(res.body.sessions).toBeDefined();
    expect(res.body.sessions.s1.file_count).toBe(1);
    expect(res.body.sessions.s2.file_count).toBe(2);
    expect(res.body.sessions.s2.event_count).toBe(2);
  });
});
