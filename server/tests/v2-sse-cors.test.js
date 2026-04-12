'use strict';

const { describe, it, expect, vi } = require('vitest');
const { sendV2SseHeaders } = require('../api/v2-core-handlers');

function makeRes() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
  };
}

describe('sendV2SseHeaders CORS allowlist', () => {
  it('allowlisted origin http://127.0.0.1:3456 gets credentialed reflection', () => {
    const res = makeRes();
    const req = { headers: { origin: 'http://127.0.0.1:3456' } };

    sendV2SseHeaders(res, req);

    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:3456');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('allowlisted origin http://localhost:3456 gets credentialed reflection', () => {
    const res = makeRes();
    const req = { headers: { origin: 'http://localhost:3456' } };

    sendV2SseHeaders(res, req);

    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3456');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('disallowed origin http://attacker.example omits CORS headers', () => {
    const res = makeRes();
    const req = { headers: { origin: 'http://attacker.example' } };

    sendV2SseHeaders(res, req);

    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('no Origin header leaves CORS headers unset (direct curl)', () => {
    const res = makeRes();
    const req = { headers: {} };

    sendV2SseHeaders(res, req);

    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(headers['Content-Type']).toBe('text/event-stream');
  });

  it('null req leaves CORS headers unset', () => {
    const res = makeRes();

    sendV2SseHeaders(res, null);

    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Content-Type']).toBe('text/event-stream');
  });
});
