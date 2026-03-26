'use strict';

const crypto = require('crypto');

function createSessionManager({ maxSessions = 50, sessionTtlMs = 86400000 } = {}) {
  const sessions = new Map(); // sessionId => { identity, csrfToken, lastAccess }

  function createSession(identity) {
    if (sessions.size >= maxSessions) {
      let oldestSessionId = null;
      let oldestAccess = Number.POSITIVE_INFINITY;

      for (const [sessionId, entry] of sessions) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess;
          oldestSessionId = sessionId;
        }
      }

      if (oldestSessionId) {
        sessions.delete(oldestSessionId);
      }
    }

    const sessionId = crypto.randomUUID();
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const now = Date.now();

    sessions.set(sessionId, { identity, csrfToken, lastAccess: now });

    return { sessionId, csrfToken };
  }

  function getSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.lastAccess > sessionTtlMs) {
      sessions.delete(sessionId);
      return null;
    }

    entry.lastAccess = now;
    sessions.delete(sessionId);
    sessions.set(sessionId, entry); // reorder for LRU behavior

    return {
      identity: entry.identity,
      csrfToken: entry.csrfToken,
      lastAccess: entry.lastAccess,
    };
  }

  function destroySession(sessionId) {
    sessions.delete(sessionId);
  }

  function destroySessionsByIdentityId(identityId) {
    for (const [sessionId, entry] of sessions) {
      if (entry.identity && entry.identity.id === identityId) {
        sessions.delete(sessionId);
      }
    }
  }

  function validateCsrf(sessionId, csrfToken) {
    const entry = sessions.get(sessionId);
    if (!entry || typeof csrfToken !== 'string') {
      return false;
    }

    const expected = Buffer.from(entry.csrfToken, 'utf8');
    const actual = Buffer.from(csrfToken, 'utf8');

    if (expected.length !== actual.length) return false;

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
