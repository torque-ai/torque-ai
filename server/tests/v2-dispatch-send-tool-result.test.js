'use strict';
/* global describe, it, expect, vi */

// Regression for the v2 dispatch's "always 200" response shape that masked
// handler errors as fake successes (see CHANGELOG entry for the
// concurrency-handlers fix). The new sendToolResult helper inspects the
// MCP tool-result `isError` flag and routes failures through the
// dispatcher's standard error path (a thrown Error with a status field
// that normalizeError maps to a non-2xx response).

vi.mock('../container', () => ({ defaultContainer: {} }));

const { sendToolResult, throwToolResultError } = require('../api/v2-dispatch');

function mockRes() {
  return {
    statusCode: 200,
    _headers: {},
    _body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this._headers, headers || {});
    },
    setHeader(k, v) { this._headers[k] = v; },
    end(body) { this._body = body; return this; },
  };
}

function mockReq() {
  return { headers: { 'content-type': 'application/json' }, requestId: 'rid-test' };
}

describe('sendToolResult — isError-aware response mapping', () => {
  it('throws via throwToolResultError when result.isError is true (status from result)', () => {
    const result = {
      content: [{ type: 'text', text: 'Provider not found' }],
      isError: true,
      status: 404,
      code: 'provider_not_found',
    };

    let caught = null;
    try {
      sendToolResult(mockRes(), mockReq(), { requestId: 'rid' }, result, { mode: 'message' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.status).toBe(404);
    expect(caught?.code).toBe('provider_not_found');
    expect(caught?.message).toBe('Provider not found');
    // v2 marker tells normalizeError to preserve the message verbatim.
    // Without it, the dashboard sees "Internal server error" instead of
    // the actionable handler message — defeating the entire isError path.
    expect(caught?.v2).toBe(true);
  });

  it('defaults isError responses to status 400 when no status is set', () => {
    const result = {
      content: [{ type: 'text', text: 'scope is required' }],
      isError: true,
    };

    let caught = null;
    try {
      sendToolResult(mockRes(), mockReq(), { requestId: 'rid' }, result, { mode: 'message' });
    } catch (err) {
      caught = err;
    }

    expect(caught?.status).toBe(400);
    expect(caught?.code).toBe('operation_failed');
  });

  it('returns mode=message envelope on success (status 200, {data: {message}})', () => {
    const res = mockRes();
    const result = { content: [{ type: 'text', text: 'Set max_concurrent for codex to 3.' }] };

    sendToolResult(res, mockReq(), { requestId: 'rid' }, result, { mode: 'message' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.data).toEqual({ message: 'Set max_concurrent for codex to 3.' });
    expect(body.meta?.request_id).toBe('rid');
  });

  it('returns mode=json envelope on success (parses content[0].text as JSON)', () => {
    const res = mockRes();
    const payload = { vram_overhead_factor: 0.95, providers: [{ provider: 'codex', max_concurrent: 3 }] };
    const result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };

    sendToolResult(res, mockReq(), { requestId: 'rid' }, result, { mode: 'json' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.data).toEqual(payload);
  });

  it('throws 500 in mode=json when content is not parseable as JSON', () => {
    const result = { content: [{ type: 'text', text: 'not json at all' }] };

    let caught = null;
    try {
      sendToolResult(mockRes(), mockReq(), { requestId: 'rid' }, result, { mode: 'json' });
    } catch (err) {
      caught = err;
    }

    expect(caught?.status).toBe(500);
    expect(caught?.code).toBe('operation_failed');
  });

  it('honors a custom successStatus on success', () => {
    const res = mockRes();
    const result = { content: [{ type: 'text', text: 'created' }] };

    sendToolResult(res, mockReq(), { requestId: 'rid' }, result, { mode: 'message', successStatus: 201 });

    expect(res.statusCode).toBe(201);
  });
});

describe('throwToolResultError — defaults', () => {
  it('uses fallback message when content is missing', () => {
    let caught = null;
    try { throwToolResultError({}); } catch (err) { caught = err; }
    expect(caught?.message).toBe('Operation failed');
    expect(caught?.status).toBe(400);
    expect(caught?.code).toBe('operation_failed');
  });
});
