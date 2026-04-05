import { createRequire } from 'module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const require = createRequire(import.meta.url);
const { createSessionManager } = require('../plugins/auth/session-manager.js');

describe('server/plugins/auth/session-manager', () => {
  let managers;

  beforeEach(() => {
    managers = new Set();
  });

  afterEach(() => {
    for (const manager of managers) {
      manager.destroy();
    }
    managers.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeManager(options = {}) {
    const manager = createSessionManager(options);
    managers.add(manager);
    return manager;
  }

  function destroyManager(manager) {
    manager.destroy();
    managers.delete(manager);
  }

  function makeIdentity(id) {
    return {
      id,
      username: `user-${id}`,
    };
  }

  it('createSession returns { sessionId, csrfToken } with string values', () => {
    const manager = makeManager();

    const created = manager.createSession(makeIdentity('user-1'));

    expect(created).toEqual({
      sessionId: expect.any(String),
      csrfToken: expect.any(String),
    });
    expect(created.sessionId.length).toBeGreaterThan(0);
    expect(created.csrfToken.length).toBeGreaterThan(0);
  });

  it('getSession returns session data for a valid session ID', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const manager = makeManager({ sessionTtlMs: 5_000 });
    const identity = makeIdentity('user-1');
    const { sessionId, csrfToken } = manager.createSession(identity);

    vi.advanceTimersByTime(250);

    expect(manager.getSession(sessionId)).toEqual({
      identity,
      csrfToken,
      lastAccess: Date.now(),
    });
  });

  it('getSession returns null for an invalid or non-existent session ID', () => {
    const manager = makeManager();

    expect(manager.getSession('missing-session-id')).toBeNull();
  });

  it('getSession returns null for an empty string session ID', () => {
    const manager = makeManager();

    expect(manager.getSession('')).toBeNull();
  });

  it('destroySession removes the session so getSession returns null after', () => {
    const manager = makeManager();
    const { sessionId } = manager.createSession(makeIdentity('user-1'));

    expect(manager.destroySession(sessionId)).toBe(true);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(manager.getSessionCount()).toBe(0);
  });

  it('destroySessionsByIdentityId removes all sessions for that identity', () => {
    const manager = makeManager();
    const targetIdentity = makeIdentity('user-1');
    const otherIdentity = makeIdentity('user-2');
    const firstTarget = manager.createSession(targetIdentity);
    const secondTarget = manager.createSession(targetIdentity);
    const otherSession = manager.createSession(otherIdentity);

    expect(manager.destroySessionsByIdentityId(targetIdentity.id)).toBe(2);

    expect(manager.getSession(firstTarget.sessionId)).toBeNull();
    expect(manager.getSession(secondTarget.sessionId)).toBeNull();
    expect(manager.getSession(otherSession.sessionId)).toMatchObject({
      identity: otherIdentity,
    });
    expect(manager.getSessionCount()).toBe(1);
  });

  it('validateCsrf returns true for the correct token and false for the wrong token', () => {
    const manager = makeManager();
    const { sessionId, csrfToken } = manager.createSession(makeIdentity('user-1'));
    const wrongToken = `${csrfToken.slice(0, -1)}${csrfToken.endsWith('0') ? '1' : '0'}`;

    expect(manager.validateCsrf(sessionId, csrfToken)).toBe(true);
    expect(manager.validateCsrf(sessionId, wrongToken)).toBe(false);
  });

  it('getSessionCount returns the number of active sessions', () => {
    const manager = makeManager();
    const first = manager.createSession(makeIdentity('user-1'));
    manager.createSession(makeIdentity('user-2'));

    expect(manager.getSessionCount()).toBe(2);

    manager.destroySession(first.sessionId);

    expect(manager.getSessionCount()).toBe(1);
  });

  it('expires a session after sessionTtlMs when accessed past the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const manager = makeManager({ sessionTtlMs: 1_000 });
    const { sessionId } = manager.createSession(makeIdentity('user-1'));

    vi.advanceTimersByTime(1_001);

    expect(manager.getSession(sessionId)).toBeNull();
    expect(manager.getSessionCount()).toBe(0);
  });

  it('removes expired sessions during the periodic eviction sweep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const manager = makeManager({ sessionTtlMs: 1_000 });
    manager.createSession(makeIdentity('user-1'));

    vi.advanceTimersByTime(1_001);
    expect(manager.getSessionCount()).toBe(1);

    vi.advanceTimersByTime(600_000);

    expect(manager.getSessionCount()).toBe(0);
  });

  it('evicts the least recently used session when maxSessions is reached', () => {
    const manager = makeManager({ maxSessions: 2 });
    const first = manager.createSession(makeIdentity('user-1'));
    const second = manager.createSession(makeIdentity('user-2'));

    expect(manager.getSession(first.sessionId)).toMatchObject({
      identity: { id: 'user-1' },
    });

    const third = manager.createSession(makeIdentity('user-3'));

    expect(manager.getSession(first.sessionId)).toMatchObject({
      identity: { id: 'user-1' },
    });
    expect(manager.getSession(second.sessionId)).toBeNull();
    expect(manager.getSession(third.sessionId)).toMatchObject({
      identity: { id: 'user-3' },
    });
    expect(manager.getSessionCount()).toBe(2);
  });

  it('destroy() clears all sessions and stops the eviction interval', () => {
    vi.useFakeTimers();

    const baselineTimerCount = vi.getTimerCount();
    const manager = makeManager();
    manager.createSession(makeIdentity('user-1'));

    expect(manager.getSessionCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    destroyManager(manager);

    expect(manager.getSessionCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);

    vi.advanceTimersByTime(600_000);

    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });
});
