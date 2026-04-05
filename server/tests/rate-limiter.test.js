import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { AuthRateLimiter } = require('../plugins/auth/rate-limiter.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('server/plugins/auth/rate-limiter', () => {
  it('check returns true for unknown IPs and falsy IP values', () => {
    const limiter = new AuthRateLimiter();

    expect(limiter.check('203.0.113.10')).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check(null)).toBe(true);
    expect(limiter.check('')).toBe(true);
  });

  it('recordFailure blocks an IP after maxAttempts failures', () => {
    const limiter = new AuthRateLimiter({
      maxAttempts: 3,
      windowMs: 50,
      blockMs: 50,
    });
    const ip = '198.51.100.25';

    expect(limiter.recordFailure(ip)).toBe(true);
    expect(limiter.recordFailure(ip)).toBe(true);
    expect(limiter.recordFailure(ip)).toBe(false);
    expect(limiter.check(ip)).toBe(false);
  });

  it('reset clears blocked state', () => {
    const limiter = new AuthRateLimiter({
      maxAttempts: 3,
      windowMs: 50,
      blockMs: 50,
    });
    const ip = '192.0.2.15';

    limiter.recordFailure(ip);
    limiter.recordFailure(ip);
    limiter.recordFailure(ip);

    expect(limiter.check(ip)).toBe(false);

    limiter.reset(ip);

    expect(limiter.check(ip)).toBe(true);
  });

  it('isLimited returns true when blocked and false when allowed', () => {
    const limiter = new AuthRateLimiter({
      maxAttempts: 2,
      windowMs: 50,
      blockMs: 50,
    });
    const ip = '203.0.113.44';

    expect(limiter.isLimited(ip)).toBe(false);

    limiter.recordFailure(ip);
    limiter.recordFailure(ip);

    expect(limiter.isLimited(ip)).toBe(true);
    expect(limiter.isLimited('198.51.100.55')).toBe(false);
  });

  it('unblocks an IP after blockMs expires', async () => {
    const limiter = new AuthRateLimiter({
      maxAttempts: 2,
      windowMs: 50,
      blockMs: 50,
    });
    const ip = '198.51.100.88';

    limiter.recordFailure(ip);
    limiter.recordFailure(ip);

    expect(limiter.check(ip)).toBe(false);

    await delay(70);

    expect(limiter.check(ip)).toBe(true);
    expect(limiter.isLimited(ip)).toBe(false);
  });
});
