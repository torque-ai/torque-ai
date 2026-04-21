'use strict';
const { nextBackoffMs, isWithinCooldown, BACKOFF_CAP_MS, BASE_BACKOFF_MS } =
  require('../factory/auto-recovery/backoff');

describe('auto-recovery backoff', () => {
  it('exports a 30-second base and 30-minute cap', () => {
    expect(BASE_BACKOFF_MS).toBe(30_000);
    expect(BACKOFF_CAP_MS).toBe(30 * 60 * 1000);
  });

  it('returns base for attempt 0', () => {
    expect(nextBackoffMs(0)).toBe(30_000);
  });

  it('doubles per attempt until cap', () => {
    expect(nextBackoffMs(1)).toBe(60_000);
    expect(nextBackoffMs(2)).toBe(120_000);
    expect(nextBackoffMs(3)).toBe(240_000);
    expect(nextBackoffMs(4)).toBe(480_000);
    expect(nextBackoffMs(5)).toBe(960_000);
  });

  it('caps at 30 minutes', () => {
    expect(nextBackoffMs(10)).toBe(30 * 60 * 1000);
    expect(nextBackoffMs(100)).toBe(30 * 60 * 1000);
  });

  it('treats non-finite attempts as 0', () => {
    expect(nextBackoffMs(NaN)).toBe(30_000);
    expect(nextBackoffMs(-1)).toBe(30_000);
    expect(nextBackoffMs(undefined)).toBe(30_000);
  });

  it('isWithinCooldown is true when now < lastAction + backoff', () => {
    const now = Date.parse('2026-04-21T12:00:00Z');
    expect(isWithinCooldown('2026-04-21T11:59:30Z', 1, now)).toBe(true);
  });

  it('isWithinCooldown is false when cooldown elapsed', () => {
    const now = Date.parse('2026-04-21T12:05:00Z');
    expect(isWithinCooldown('2026-04-21T11:59:30Z', 1, now)).toBe(false);
  });

  it('isWithinCooldown is false when lastAction is null', () => {
    expect(isWithinCooldown(null, 3, Date.now())).toBe(false);
  });

  it('isWithinCooldown is false when lastAction is unparseable', () => {
    expect(isWithinCooldown('not a date', 3, Date.now())).toBe(false);
  });
});
