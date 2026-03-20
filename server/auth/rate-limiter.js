'use strict';

class AuthRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 60000 } = {}) {
    this._attempts = new Map(); // ip → [timestamps]
    this._maxAttempts = maxAttempts;
    this._windowMs = windowMs;
  }

  // Record a failed attempt. Returns true if under limit, false if over.
  recordFailure(ip) {
    const now = Date.now();
    const attempts = this._attempts.get(ip) || [];
    // Remove old entries outside window
    const recent = attempts.filter(t => now - t < this._windowMs);
    recent.push(now);
    this._attempts.set(ip, recent);
    return recent.length <= this._maxAttempts;
  }

  // Check if IP is currently rate-limited (without recording)
  isLimited(ip) {
    const now = Date.now();
    const attempts = this._attempts.get(ip) || [];
    const recent = attempts.filter(t => now - t < this._windowMs);
    return recent.length >= this._maxAttempts;
  }

  // Cleanup old entries (call periodically)
  cleanup() {
    const now = Date.now();
    for (const [ip, attempts] of this._attempts) {
      const recent = attempts.filter(t => now - t < this._windowMs);
      if (recent.length === 0) this._attempts.delete(ip);
      else this._attempts.set(ip, recent);
    }
  }

  // For testing
  _reset() { this._attempts.clear(); }
}

// Pre-configured instances
const loginLimiter = new AuthRateLimiter({ maxAttempts: 5, windowMs: 60000 });
const restAuthLimiter = new AuthRateLimiter({ maxAttempts: 10, windowMs: 60000 });

module.exports = { AuthRateLimiter, loginLimiter, restAuthLimiter };
