import { describe, it, expect, vi } from 'vitest';

const { sendV2SseHeaders } = require('../api/v2-core-handlers');

function dashboardOrigin(host = '127.0.0.1') {
  return `http://${host}:${process.env.TORQUE_DASHBOARD_PORT || '3456'}`;
}

function makeRes() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
  };
}

describe('sendV2SseHeaders CORS allowlist', () => {
  it('allowlisted 127.0.0.1 dashboard origin gets credentialed reflection', () => {
    const res = makeRes();
    const origin = dashboardOrigin();
    const req = { headers: { origin } };

    sendV2SseHeaders(res, req);

    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Access-Control-Allow-Origin']).toBe(origin);
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('allowlisted localhost dashboard origin gets credentialed reflection', () => {
    const res = makeRes();
    const origin = dashboardOrigin('localhost');
    const req = { headers: { origin } };

    sendV2SseHeaders(res, req);

    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Access-Control-Allow-Origin']).toBe(origin);
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
