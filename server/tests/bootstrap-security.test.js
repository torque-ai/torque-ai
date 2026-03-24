'use strict';
// vitest globals (describe, it, expect) are available via globals: true in config
const { generateBootstrapScript, handleBootstrapWorkstation } = require('../api/bootstrap');

describe('bootstrap security', () => {
  describe('input validation', () => {
    it('rejects name with shell metacharacters', () => {
      const res = mockRes();
      handleBootstrapWorkstation(
        { url: '/api/bootstrap/workstation?name=x%22%0Acurl+evil', headers: { host: '127.0.0.1:3457' }, socket: { remoteAddress: '1.2.3.4' } },
        res
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects port with non-numeric value', () => {
      const res = mockRes();
      handleBootstrapWorkstation(
        { url: '/api/bootstrap/workstation?port=abc', headers: { host: '127.0.0.1:3457' }, socket: { remoteAddress: '1.2.3.5' } },
        res
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects port out of range', () => {
      const res = mockRes();
      handleBootstrapWorkstation(
        { url: '/api/bootstrap/workstation?port=99999', headers: { host: '127.0.0.1:3457' }, socket: { remoteAddress: '1.2.3.5' } },
        res
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects host header with shell metacharacters', () => {
      const res = mockRes();
      handleBootstrapWorkstation(
        { url: '/api/bootstrap/workstation', headers: { host: '127.0.0.1$(whoami):3457' }, socket: { remoteAddress: '1.2.3.7' } },
        res
      );
      expect(res.statusCode).toBe(400);
    });

    it('accepts valid name and port', () => {
      const res = mockRes();
      handleBootstrapWorkstation(
        { url: '/api/bootstrap/workstation?name=my-host&port=3460', headers: { host: '127.0.0.1:3457' }, socket: { remoteAddress: '1.2.3.6' } },
        res
      );
      expect(res.statusCode).toBe(200);
    });

    it('accepts empty name (defaults to hostname)', () => {
      const res = mockRes();
      handleBootstrapWorkstation(
        { url: '/api/bootstrap/workstation', headers: { host: '127.0.0.1:3457' }, socket: { remoteAddress: '1.2.3.8' } },
        res
      );
      expect(res.statusCode).toBe(200);
    });

    it('rejects name longer than 64 characters', () => {
      const res = mockRes();
      const longName = 'a'.repeat(65);
      handleBootstrapWorkstation(
        { url: `/api/bootstrap/workstation?name=${longName}`, headers: { host: '127.0.0.1:3457' }, socket: { remoteAddress: '1.2.3.9' } },
        res
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe('generated script security', () => {
    it('uses single-quoted assignments for baked-in values', () => {
      const script = generateBootstrapScript('127.0.0.1:3457', { name: 'test', port: '3460' });
      expect(script).toContain("TORQUE_HOST='127.0.0.1:3457'");
      expect(script).toContain("AGENT_PORT='3460'");
      expect(script).toContain("AGENT_NAME='test'");
    });

    it('does not use double-quoted assignments for baked-in values', () => {
      const script = generateBootstrapScript('127.0.0.1:3457', { name: 'test', port: '3460' });
      // Should NOT have double-quoted assignments that allow expansion
      expect(script).not.toMatch(/TORQUE_HOST="[^$]*"/);
      expect(script).not.toMatch(/AGENT_PORT="[^$]*"/);
      expect(script).not.toMatch(/AGENT_NAME="[^$]*"/);
    });
  });

  describe('embedded agent auth', () => {
    it('rejects requests when SECRET is empty', () => {
      const script = generateBootstrapScript('127.0.0.1:3457', {});
      // The embedded agent should use: if (!SECRET || ...)
      expect(script).toContain('if (!SECRET || ');
      expect(script).not.toContain('if (SECRET && ');
    });

    it('embedded agent has body size limit', () => {
      const script = generateBootstrapScript('127.0.0.1:3457', {});
      expect(script).toContain('MAX_BODY');
    });
  });
});

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(code, headers) { res.statusCode = code; Object.assign(res.headers, headers || {}); },
    end(data) { res.body = data || ''; },
  };
  return res;
}
