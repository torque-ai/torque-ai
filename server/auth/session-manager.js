'use strict';
const crypto = require('crypto');

const _sessions = new Map(); // sessionId → { identity, csrfToken, lastAccess }
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function createSession(identity) {
  // Evict LRU if at cap
  if (_sessions.size >= MAX_SESSIONS) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [key, val] of _sessions) {
      if (val.lastAccess < oldestTime) { oldestTime = val.lastAccess; oldestKey = key; }
    }
    if (oldestKey) _sessions.delete(oldestKey);
  }
  const sessionId = crypto.randomUUID();
  const csrfToken = crypto.randomBytes(32).toString('hex');
  _sessions.set(sessionId, { identity, csrfToken, lastAccess: Date.now() });
  return { sessionId, csrfToken };
}

function getSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.lastAccess > SESSION_TTL_MS) {
    _sessions.delete(sessionId);
    return null;
  }
  entry.lastAccess = Date.now(); // sliding window
  return entry;
}

function destroySession(sessionId) {
  _sessions.delete(sessionId);
}

function validateCsrf(sessionId, csrfToken) {
  const entry = _sessions.get(sessionId);
  return !!(entry && entry.csrfToken === csrfToken);
}

function getSessionCount() { return _sessions.size; }

// For testing
function _reset() { _sessions.clear(); }

module.exports = { createSession, getSession, destroySession, validateCsrf, getSessionCount, _reset };
