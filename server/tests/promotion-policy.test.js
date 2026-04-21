import { describe, it, expect } from 'vitest';

const {
  rankIntake,
  computeTier,
  DEFAULT_PROMOTION_CONFIG,
  SCORE_MAP,
} = require('../factory/promotion-policy');

function mkItem(over = {}) {
  return {
    id: over.id ?? 1,
    source: over.source ?? 'plan_file',
    priority: over.priority ?? 50,
    created_at: over.created_at ?? '2026-04-20T00:00:00Z',
    origin: over.origin ?? null,
  };
}

describe('promotion-policy.computeTier', () => {
  const lowScores = { structural: 40, security: 60, user_facing: 40, performance: 50, test_coverage: 40, documentation: 40, dependency_health: 50, debt_ratio: 30 };
  const healthyScores = { structural: 95, security: 95, user_facing: 95, performance: 95, test_coverage: 95, documentation: 95, dependency_health: 95, debt_ratio: 95 };

  it('non-scout items are always tier 1', () => {
    const item = mkItem({ source: 'plan_file' });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('CRITICAL scout is always tier 0, even with healthy scores', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'CRITICAL', variant: 'security' } });
    expect(computeTier(item, healthyScores, DEFAULT_PROMOTION_CONFIG)).toBe(0);
  });

  it('HIGH scout is tier 0 when a relevant score is below threshold', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'security' } });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(0);
  });

  it('HIGH scout is tier 1 when all relevant scores are healthy', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'security' } });
    expect(computeTier(item, healthyScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('MEDIUM scout is never tier 0, even with low scores', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'MEDIUM', variant: 'quality' } });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('LOW scout is never tier 0', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'LOW', variant: 'quality' } });
    expect(computeTier(item, lowScores, DEFAULT_PROMOTION_CONFIG)).toBe(1);
  });

  it('unknown variant falls back to ALL_DIMS — any dim below threshold triggers', () => {
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'made-up-variant' } });
    const singleLowScore = { ...healthyScores, security: 30 };
    expect(computeTier(item, singleLowScore, DEFAULT_PROMOTION_CONFIG)).toBe(0);
  });

  it('severity_floor config tightens promotion', () => {
    const tighter = { ...DEFAULT_PROMOTION_CONFIG, severity_floor: 'CRITICAL' };
    const item = mkItem({ source: 'scout', origin: { severity: 'HIGH', variant: 'security' } });
    expect(computeTier(item, lowScores, tighter)).toBe(1);
  });
});

describe('promotion-policy.rankIntake', () => {
  const lowScores = { structural: 40, security: 60 };
  const healthyScores = { structural: 95, security: 95 };

  it('CRITICAL scout beats plan_file with higher priority', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 90 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'CRITICAL', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
    expect(ranked[1].id).toBe(1);
  });

  it('HIGH scout beats plan_file when relevant score is low', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 70 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'HIGH', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: { ...lowScores, security: 60 } });
    expect(ranked[0].id).toBe(2);
  });

  it('HIGH scout ranks below plan_file when scores are healthy', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 70 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'HIGH', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(1);
  });

  it('within same tier: higher priority wins', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 50 }),
      mkItem({ id: 2, source: 'plan_file', priority: 70 }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
  });

  it('within same tier+priority: scout source beats plan_file', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 50 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'MEDIUM', variant: 'quality' } }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
  });

  it('within same tier+priority+source: older item wins', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 50, created_at: '2026-04-20T10:00:00Z' }),
      mkItem({ id: 2, source: 'plan_file', priority: 50, created_at: '2026-04-19T10:00:00Z' }),
    ];
    const ranked = rankIntake(items, { projectScores: healthyScores });
    expect(ranked[0].id).toBe(2);
  });

  it('missing projectScores uses empty object (no dim triggers, HIGH stays tier 1)', () => {
    const items = [
      mkItem({ id: 1, source: 'plan_file', priority: 70 }),
      mkItem({ id: 2, source: 'scout', priority: 50, origin: { severity: 'HIGH', variant: 'security' } }),
    ];
    const ranked = rankIntake(items, { projectScores: {} });
    expect(ranked[0].id).toBe(1);
  });

  it('malformed promotionConfig uses defaults', () => {
    const items = [
      mkItem({ id: 1, source: 'scout', priority: 50, origin: { severity: 'CRITICAL', variant: 'security' } }),
      mkItem({ id: 2, source: 'plan_file', priority: 90 }),
    ];
    const ranked = rankIntake(items, { projectScores: { structural: 99 }, promotionConfig: null });
    expect(ranked[0].id).toBe(1);
  });

  it('empty items returns empty array', () => {
    expect(rankIntake([], { projectScores: {} })).toEqual([]);
  });
});

describe('promotion-policy.SCORE_MAP', () => {
  it('covers the canonical scout variants', () => {
    for (const variant of ['security', 'quality', 'performance', 'visual', 'accessibility', 'test-coverage', 'documentation', 'dependency']) {
      expect(Array.isArray(SCORE_MAP[variant])).toBe(true);
      expect(SCORE_MAP[variant].length).toBeGreaterThan(0);
    }
  });
});
