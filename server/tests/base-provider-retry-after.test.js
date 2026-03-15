const BaseProvider = require('../providers/base');

describe('BaseProvider.getRetryAfterSeconds', () => {
  it('extracts integer Retry-After header', () => {
    const p = new BaseProvider({ name: 'test' });
    const res = { headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '60' : null } };
    expect(p.getRetryAfterSeconds(res)).toBe(60);
  });
  it('returns null when no header', () => {
    const p = new BaseProvider({ name: 'test' });
    expect(p.getRetryAfterSeconds({ headers: { get: () => null } })).toBeNull();
  });
  it('returns null for non-numeric', () => {
    const p = new BaseProvider({ name: 'test' });
    expect(p.getRetryAfterSeconds({ headers: { get: () => 'Wed, 21 Oct 2026' } })).toBeNull();
  });
  it('returns null for null response', () => {
    const p = new BaseProvider({ name: 'test' });
    expect(p.getRetryAfterSeconds(null)).toBeNull();
    expect(p.getRetryAfterSeconds({})).toBeNull();
  });
});
