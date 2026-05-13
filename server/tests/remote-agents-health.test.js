'use strict';

const { getHealthPayload, normalizeRemoteOs } = require('../plugins/remote-agents/agent-server');
const { getHealthResponse } = require('../plugins/remote-agents/remote-test-routing');

const VALID_REMOTE_OS_VALUES = ['linux', 'windows', 'unknown'];

describe('normalizeRemoteOs', () => {
  it('maps linux to linux', () => {
    expect(normalizeRemoteOs('linux')).toBe('linux');
  });

  it('maps darwin (macOS) to linux', () => {
    expect(normalizeRemoteOs('darwin')).toBe('linux');
  });

  it('maps win32 to windows', () => {
    expect(normalizeRemoteOs('win32')).toBe('windows');
  });

  it('maps empty string to unknown', () => {
    expect(normalizeRemoteOs('')).toBe('unknown');
  });

  it('maps an unrecognized platform to unknown', () => {
    expect(normalizeRemoteOs('freebsd')).toBe('unknown');
  });
});

describe('getHealthPayload includes remote_os', () => {
  it('returns a remote_os field', () => {
    const payload = getHealthPayload();
    expect(payload).toHaveProperty('remote_os');
    expect(VALID_REMOTE_OS_VALUES).toContain(payload.remote_os);
  });

  it('remote_os is consistent with system.platform', () => {
    const payload = getHealthPayload();
    const expected = normalizeRemoteOs(payload.system.platform);
    expect(payload.remote_os).toBe(expected);
  });

  it('preserves existing fields alongside remote_os', () => {
    const payload = getHealthPayload(0, 4, Date.now());
    expect(payload).toHaveProperty('status');
    expect(payload).toHaveProperty('capacity');
    expect(payload).toHaveProperty('running_tasks');
    expect(payload).toHaveProperty('system');
    expect(payload).toHaveProperty('remote_os');
  });
});

describe('remote-agents health response (controller-side)', () => {
  it('includes remote_os field', () => {
    const health = getHealthResponse();
    expect(health).toHaveProperty('remote_os');
    expect(VALID_REMOTE_OS_VALUES).toContain(health.remote_os);
  });

  it('remote_os is one of the expected values', () => {
    const health = getHealthResponse();
    expect(['linux', 'windows', 'unknown']).toContain(health.remote_os);
  });
});
