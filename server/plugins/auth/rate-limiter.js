'use strict';

class AuthRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 60000, blockMs = 60000 } = {}) {
    this._entries = new Map();
    this._maxAttempts = maxAttempts;
    this._windowMs = windowMs;
    this._blockMs = blockMs;
  }

  _pruneEntry(ip, now) {
    const entry = this._entries.get(ip);
    if (!entry) {
      return null;
    }

    const attempts = entry.attempts.filter((timestamp) => now - timestamp < this._windowMs);
    const blockedUntil = entry.blockedUntil > now ? entry.blockedUntil : 0;

    if (attempts.length === 0 && blockedUntil === 0) {
      this._entries.delete(ip);
      return null;
    }

    entry.attempts = attempts;
    entry.blockedUntil = blockedUntil;
    return entry;
  }

  cleanup(now = Date.now()) {
    for (const ip of this._entries.keys()) {
      this._pruneEntry(ip, now);
    }
  }

  check(ip) {
    if (!ip) {
      return true;
    }

    const now = Date.now();
    this.cleanup(now);
    const entry = this._entries.get(ip);
    return !entry || entry.blockedUntil <= now;
  }

  isLimited(ip) {
    return !this.check(ip);
  }

  recordFailure(ip) {
    if (!ip) {
      return true;
    }

    const now = Date.now();
    const entry = this._pruneEntry(ip, now) || { attempts: [], blockedUntil: 0 };
    entry.attempts.push(now);

    if (entry.attempts.length >= this._maxAttempts) {
      entry.blockedUntil = now + this._blockMs;
    }

    this._entries.set(ip, entry);
    return this.check(ip);
  }

  reset(ip) {
    if (!ip) {
      return;
    }

    this._entries.delete(ip);
  }
}

module.exports = { AuthRateLimiter };
