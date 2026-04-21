'use strict';

const DEFAULT_PROMOTION_CONFIG = Object.freeze({
  severity_floor: 'HIGH',
  score_trigger: Object.freeze({
    structural: 60,
    security: 75,
    user_facing: 60,
    performance: 70,
    test_coverage: 60,
    documentation: 50,
    dependency_health: 70,
    debt_ratio: 50,
  }),
  stale_probe_enabled: true,
  stale_max_repicks: 3,
  stale_churn_threshold: 5,
});

const ALL_DIMS = Object.freeze(Object.keys(DEFAULT_PROMOTION_CONFIG.score_trigger));

const SCORE_MAP = Object.freeze({
  security:      Object.freeze(['security', 'debt_ratio']),
  quality:       Object.freeze(['structural', 'debt_ratio', 'test_coverage']),
  performance:   Object.freeze(['performance', 'structural']),
  visual:        Object.freeze(['user_facing']),
  accessibility: Object.freeze(['user_facing']),
  'test-coverage': Object.freeze(['test_coverage']),
  documentation: Object.freeze(['documentation']),
  dependency:    Object.freeze(['dependency_health']),
});

const SEVERITY_RANK = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
});

const SOURCE_TIEBREAK = Object.freeze({
  scout: 0,
  manual: 1,
  plan_file: 2,
  architect: 2,
  conversation: 3,
  conversational: 3,
});

function normalizeSeverity(severity) {
  if (typeof severity !== 'string') return null;
  const upper = severity.trim().toUpperCase();
  return SEVERITY_RANK.hasOwnProperty(upper) ? upper : null;
}

function severityBucket(item) {
  if (item?.source !== 'scout') return 4;
  const sev = normalizeSeverity(item.origin?.severity);
  return sev === null ? 4 : SEVERITY_RANK[sev];
}

function computeTier(item, projectScores, promotionConfig) {
  const cfg = mergeConfig(promotionConfig);
  if (!item || item.source !== 'scout') return 1;
  const severity = normalizeSeverity(item.origin?.severity);
  if (severity === null) return 1;
  if (severity === 'CRITICAL') return 0;
  const floorRank = SEVERITY_RANK[cfg.severity_floor] ?? SEVERITY_RANK.HIGH;
  if (SEVERITY_RANK[severity] > floorRank) return 1;
  const variant = item.origin?.variant;
  const relevantDims = SCORE_MAP[variant] || ALL_DIMS;
  const scores = projectScores || {};
  const triggered = relevantDims.some((dim) => {
    const score = scores[dim];
    const threshold = cfg.score_trigger?.[dim];
    return typeof score === 'number' && typeof threshold === 'number' && score < threshold;
  });
  return triggered ? 0 : 1;
}

function mergeConfig(overrides) {
  if (!overrides || typeof overrides !== 'object') return DEFAULT_PROMOTION_CONFIG;
  return {
    ...DEFAULT_PROMOTION_CONFIG,
    ...overrides,
    score_trigger: {
      ...DEFAULT_PROMOTION_CONFIG.score_trigger,
      ...(overrides.score_trigger || {}),
    },
  };
}

function createdAtMs(item) {
  if (!item?.created_at) return Number.MAX_SAFE_INTEGER;
  const ms = Date.parse(item.created_at);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function rankIntake(items, {
  projectScores = {},
  promotionConfig = DEFAULT_PROMOTION_CONFIG,
  now = new Date(),
} = {}) {
  void now;
  if (!Array.isArray(items)) return [];
  const cfg = mergeConfig(promotionConfig);
  const decorated = items.map((item) => {
    const tier = computeTier(item, projectScores, cfg);
    // Severity only breaks ties WITHIN the promoted tier. For tier-1 items
    // (non-promoted scouts + all non-scouts), treat severity as neutral so a
    // HIGH scout with healthy scores doesn't pre-empt a higher-priority
    // plan_file. See tests "HIGH scout ranks below plan_file when scores are
    // healthy" and "missing projectScores ... HIGH stays tier 1".
    const severityKey = tier === 0 ? severityBucket(item) : 4;
    return {
      item,
      key: [
        tier,
        severityKey,
        -(Number(item?.priority) || 0),
        SOURCE_TIEBREAK[item?.source] ?? 4,
        createdAtMs(item),
      ],
    };
  });
  decorated.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) {
      if (a.key[i] < b.key[i]) return -1;
      if (a.key[i] > b.key[i]) return 1;
    }
    return 0;
  });
  return decorated.map((d) => d.item);
}

module.exports = {
  rankIntake,
  computeTier,
  mergeConfig,
  normalizeSeverity,
  DEFAULT_PROMOTION_CONFIG,
  SCORE_MAP,
  SEVERITY_RANK,
  SOURCE_TIEBREAK,
  ALL_DIMS,
};
