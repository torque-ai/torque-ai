'use strict';

class AuthRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 60000 } = {}) {
    this._attempts = new Map();
    this._maxAttempts = maxAttempts;
    this._windowMs = windowMs;
  }

  recordFailure(ip) {
    const now = Date.now();
    const attempts = this._attempts.get(ip) || [];
    const recent = attempts.filter((timestamp) => now - timestamp < this._windowMs);
    recent.push(now);
    this._attempts.set(ip, recent);
    return recent.length <= this._maxAttempts;
  }

  isLimited(ip) {
    const now = Date.now();
    const attempts = this._attempts.get(ip) || [];
    const recent = attempts.filter((timestamp) => now - timestamp < this._windowMs);
    return recent.length >= this._maxAttempts;
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, attempts] of this._attempts) {
      const recent = attempts.filter((timestamp) => now - timestamp < this._windowMs);
      if (recent.length === 0) this._attempts.delete(ip);
      else this._attempts.set(ip, recent);
    }
  }
}

module.exports = { AuthRateLimiter };
