'use strict';

const crypto = require('crypto');

function createSessionManager(options = {}) {
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : 50;
  const sessionTtlMs = Number.isFinite(options.sessionTtlMs) && options.sessionTtlMs >= 0
    ? options.sessionTtlMs
    : 86400000;
  const sessions = new Map();

  function getActiveEntry(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.lastAccess > sessionTtlMs) {
      sessions.delete(sessionId);
      return null;
    }

    return entry;
  }

  function touchSession(sessionId, entry) {
    entry.lastAccess = Date.now();
    sessions.delete(sessionId);
    sessions.set(sessionId, entry);
  }

  function evictLeastRecentlyUsed() {
    while (sessions.size >= maxSessions) {
      const oldestSessionId = sessions.keys().next().value;
      if (!oldestSessionId) {
        return;
      }
      sessions.delete(oldestSessionId);
    }
  }

  function createSession(identity) {
    evictLeastRecentlyUsed();

    const sessionId = crypto.randomUUID();
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const now = Date.now();

    sessions.set(sessionId, {
      identity,
      csrfToken,
      lastAccess: now,
    });

    return { sessionId, csrfToken };
  }

  function getSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return null;
    }

    const entry = getActiveEntry(sessionId);
    if (!entry) {
      return null;
    }

    touchSession(sessionId, entry);

    return {
      identity: entry.identity,
      csrfToken: entry.csrfToken,
      lastAccess: entry.lastAccess,
    };
  }

  function destroySession(sessionId) {
    return sessions.delete(sessionId);
  }

  function destroySessionsByIdentityId(identityId) {
    let destroyed = 0;

    for (const [sessionId, entry] of Array.from(sessions.entries())) {
      if (entry.identity && entry.identity.id === identityId) {
        sessions.delete(sessionId);
        destroyed += 1;
      }
    }

    return destroyed;
  }

  function validateCsrf(sessionId, csrfToken) {
    if (typeof sessionId !== 'string' || typeof csrfToken !== 'string') {
      return false;
    }

    const entry = getActiveEntry(sessionId);
    if (!entry) {
      return false;
    }

    const expected = Buffer.from(entry.csrfToken, 'utf8');
    const actual = Buffer.from(csrfToken, 'utf8');

    if (expected.length !== actual.length) {
      return false;
    }

    try {
      return crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  function getSessionCount() {
    return sessions.size;
  }

  return {
    createSession,
    getSession,
    destroySession,
    destroySessionsByIdentityId,
    validateCsrf,
    getSessionCount,
  };
}

module.exports = {
  createSessionManager,
};
