/**
 * Tests for smart quota overflow routing in FreeQuotaTracker.
 *
 * Covers:
 * - estimateTokenNeed() heuristic
 * - recordLatency() ring buffer
 * - getAverageLatency() with and without data
 * - getAvailableProvidersSmart() scoring formula
 * - Complexity-aware provider preference (simple → fast, complex → high-capacity)
 * - Token budget estimation skipping providers with insufficient quota
 * - Latency tiebreaker behavior
 * - Backward compatibility of getAvailableProviders()
 * - Integration with queue-scheduler quota overflow path
 */

const FreeQuotaTracker = require('../free-quota-tracker');

// ---------------------------------------------------------------------------
// estimateTokenNeed
// ---------------------------------------------------------------------------
describe('estimateTokenNeed', () => {
  const { estimateTokenNeed } = FreeQuotaTracker;

  it('returns a positive number for valid description length', () => {
    const result = estimateTokenNeed(400);
    expect(result).toBeGreaterThan(0);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('returns 500 for zero or negative length', () => {
    expect(estimateTokenNeed(0)).toBe(500);
    expect(estimateTokenNeed(-10)).toBe(500);
  });

  it('returns 500 for non-number input', () => {
    expect(estimateTokenNeed(null)).toBe(500);
    expect(estimateTokenNeed(undefined)).toBe(500);
    expect(estimateTokenNeed('hello')).toBe(500);
  });

  it('scales with description length', () => {
    const short = estimateTokenNeed(100);
    const long = estimateTokenNeed(10000);
    expect(long).toBeGreaterThan(short);
  });

  it('returns an integer', () => {
    const result = estimateTokenNeed(137);
    expect(result).toBe(Math.ceil(result));
  });
});

// ---------------------------------------------------------------------------
// recordLatency + getAverageLatency
// ---------------------------------------------------------------------------
describe('latency tracking', () => {
  function makeTracker(providers) {
    return new FreeQuotaTracker(providers.map(p => ({
      provider: p, rpd_limit: 100, rpm_limit: 10,
    })));
  }

  it('returns DEFAULT_LATENCY_MS when no latency recorded', () => {
    const tracker = makeTracker(['groq']);
    expect(tracker.getAverageLatency('groq')).toBe(FreeQuotaTracker.DEFAULT_LATENCY_MS);
  });

  it('returns DEFAULT_LATENCY_MS for unknown provider', () => {
    const tracker = makeTracker(['groq']);
    expect(tracker.getAverageLatency('nonexistent')).toBe(FreeQuotaTracker.DEFAULT_LATENCY_MS);
  });

  it('tracks single latency correctly', () => {
    const tracker = makeTracker(['groq']);
    tracker.recordLatency('groq', 1200);
    expect(tracker.getAverageLatency('groq')).toBe(1200);
  });

  it('averages multiple latencies', () => {
    const tracker = makeTracker(['groq']);
    tracker.recordLatency('groq', 1000);
    tracker.recordLatency('groq', 3000);
    expect(tracker.getAverageLatency('groq')).toBe(2000);
  });

  it('uses ring buffer of size LATENCY_RING_SIZE', () => {
    const tracker = makeTracker(['groq']);
    const ringSize = FreeQuotaTracker.LATENCY_RING_SIZE;

    // Fill ring with 1000ms values
    for (let i = 0; i < ringSize; i++) {
      tracker.recordLatency('groq', 1000);
    }
    expect(tracker.getAverageLatency('groq')).toBe(1000);

    // Overwrite all with 2000ms values
    for (let i = 0; i < ringSize; i++) {
      tracker.recordLatency('groq', 2000);
    }
    expect(tracker.getAverageLatency('groq')).toBe(2000);
  });

  it('ring buffer wraps around correctly', () => {
    const tracker = makeTracker(['groq']);
    const ringSize = FreeQuotaTracker.LATENCY_RING_SIZE;

    // Fill ring completely with 1000ms
    for (let i = 0; i < ringSize; i++) {
      tracker.recordLatency('groq', 1000);
    }

    // Overwrite half with 3000ms
    const half = Math.floor(ringSize / 2);
    for (let i = 0; i < half; i++) {
      tracker.recordLatency('groq', 3000);
    }

    // Average should be between 1000 and 3000
    const avg = tracker.getAverageLatency('groq');
    expect(avg).toBeGreaterThan(1000);
    expect(avg).toBeLessThan(3000);
  });

  it('ignores non-finite latency values', () => {
    const tracker = makeTracker(['groq']);
    tracker.recordLatency('groq', 1000);
    tracker.recordLatency('groq', NaN);
    tracker.recordLatency('groq', Infinity);
    tracker.recordLatency('groq', -500);
    tracker.recordLatency('groq', 0);
    // Only the first valid recording should count
    expect(tracker.getAverageLatency('groq')).toBe(1000);
  });

  it('ignores unknown provider in recordLatency', () => {
    const tracker = makeTracker(['groq']);
    // Should not throw
    tracker.recordLatency('unknown', 500);
    expect(tracker.getAverageLatency('unknown')).toBe(FreeQuotaTracker.DEFAULT_LATENCY_MS);
  });

  it('tracks latency per provider independently', () => {
    const tracker = makeTracker(['groq', 'cerebras']);
    tracker.recordLatency('groq', 800);
    tracker.recordLatency('cerebras', 2000);
    expect(tracker.getAverageLatency('groq')).toBe(800);
    expect(tracker.getAverageLatency('cerebras')).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// getAvailableProviders (backward compatibility)
// ---------------------------------------------------------------------------
describe('getAvailableProviders (backward compat)', () => {
  it('still returns providers sorted by dailyRemainingPct', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
      { provider: 'cerebras', rpd_limit: 100, rpm_limit: 10 },
    ]);

    // Use some quota on groq
    tracker.recordUsage('groq', 0);
    tracker.recordUsage('groq', 0);

    const providers = tracker.getAvailableProviders();
    expect(providers.length).toBe(2);
    // cerebras should be first (more remaining)
    expect(providers[0].provider).toBe('cerebras');
    expect(providers[1].provider).toBe('groq');
  });

  it('does not include score field (old API shape)', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
    ]);
    const providers = tracker.getAvailableProviders();
    expect(providers[0]).not.toHaveProperty('score');
    expect(providers[0]).toHaveProperty('dailyRemainingPct');
  });
});

// ---------------------------------------------------------------------------
// getAvailableProvidersSmart
// ---------------------------------------------------------------------------
describe('getAvailableProvidersSmart', () => {
  function makeTracker(providerConfigs) {
    return new FreeQuotaTracker(providerConfigs);
  }

  it('returns scored providers sorted by score descending', () => {
    const tracker = makeTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      { provider: 'google-ai', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
    ]);

    const results = tracker.getAvailableProvidersSmart({ complexity: 'normal', descriptionLength: 200 });
    expect(results.length).toBe(2);
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('avgLatencyMs');
    expect(results[0]).toHaveProperty('estimatedTokens');
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('returns empty array when no providers can submit', () => {
    const tracker = makeTracker([
      { provider: 'groq', rpd_limit: 1, rpm_limit: 10 },
    ]);
    tracker.recordUsage('groq', 0); // Exhaust daily limit
    const results = tracker.getAvailableProvidersSmart({ complexity: 'simple' });
    expect(results).toEqual([]);
  });

  it('defaults to normal complexity when not specified', () => {
    const tracker = makeTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
    ]);
    const results = tracker.getAvailableProvidersSmart({});
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('works with empty taskMeta', () => {
    const tracker = makeTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
    ]);
    const results = tracker.getAvailableProvidersSmart();
    expect(results.length).toBe(1);
  });

  describe('complexity-aware preferences', () => {
    it('prefers fast providers (groq/cerebras) for simple tasks', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
        { provider: 'google-ai', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      ]);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'simple', descriptionLength: 100 });
      expect(results.length).toBe(2);
      // Groq has speed=10 vs google-ai speed=6; simple tasks weight speed at 0.7
      expect(results[0].provider).toBe('groq');
    });

    it('prefers high-capacity providers (google-ai/openrouter) for complex tasks', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
        { provider: 'openrouter', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      ]);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'complex', descriptionLength: 5000 });
      expect(results.length).toBe(2);
      // openrouter has tokenCapacity=10 vs groq tokenCapacity=4; complex tasks weight capacity at 0.8
      expect(results[0].provider).toBe('openrouter');
    });

    it('gives balanced scores for normal complexity', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
        { provider: 'google-ai', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      ]);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'normal', descriptionLength: 500 });
      // Both should score, difference should be smaller than simple/complex extremes
      expect(results.length).toBe(2);
      const scoreDiff = Math.abs(results[0].score - results[1].score);
      expect(scoreDiff).toBeLessThan(0.15); // Scores are close for balanced routing
    });
  });

  describe('token budget estimation', () => {
    it('penalizes providers with insufficient token quota', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 500 },   // Very low token limit
        { provider: 'cerebras', rpd_limit: 100, rpm_limit: 10, tpd_limit: 500000 }, // High token limit
      ]);

      // Use up most of groq's token budget
      tracker.recordUsage('groq', 450);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'normal', descriptionLength: 200 });
      expect(results.length).toBe(2);
      // cerebras should score higher due to better token capacity fit
      expect(results[0].provider).toBe('cerebras');
    });

    it('gives full tokenCapacityFit when no tpd_limit is set', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10 }, // No tpd_limit → unlimited
      ]);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'normal', descriptionLength: 50000 });
      expect(results.length).toBe(1);
      // Score should still be reasonable (tokenCapacityFit = 1.0)
      expect(results[0].score).toBeGreaterThan(0.5);
    });

    it('sets tokenCapacityFit to 0 when daily tokens exhausted', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 1000 },
        { provider: 'cerebras', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      ]);

      // Exhaust groq's tokens completely
      tracker.recordUsage('groq', 1000);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'normal', descriptionLength: 200 });
      // groq should not appear (canSubmit fails due to tpd_limit reached)
      const groqResult = results.find(r => r.provider === 'groq');
      expect(groqResult).toBeUndefined();
    });
  });

  describe('latency tiebreaker', () => {
    it('prefers faster provider when quota and traits are equal', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
        { provider: 'cerebras', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      ]);

      // cerebras records much lower latency
      tracker.recordLatency('cerebras', 200);
      tracker.recordLatency('cerebras', 300);
      tracker.recordLatency('groq', 4000);
      tracker.recordLatency('groq', 5000);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'simple', descriptionLength: 100 });
      expect(results.length).toBe(2);

      // groq has higher speed trait (10 vs 9) but cerebras has much better latency
      // With ~4500ms avg for groq and ~250ms avg for cerebras, latency component:
      //   groq: min(1, 1000/4500) ≈ 0.222
      //   cerebras: min(1, 1000/250) = 1.0
      // The latency difference (0.3 * 0.778 = 0.233) should outweigh the trait diff
      expect(results[0].provider).toBe('cerebras');
    });

    it('uses DEFAULT_LATENCY_MS when no latency data exists', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
      ]);

      const results = tracker.getAvailableProvidersSmart({ complexity: 'normal' });
      expect(results[0].avgLatencyMs).toBe(FreeQuotaTracker.DEFAULT_LATENCY_MS);
    });
  });

  describe('score components', () => {
    it('score is between 0 and ~1.15 (base max 1.0 + trait bonus up to 0.15)', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      ]);
      tracker.recordLatency('groq', 500); // fast

      const results = tracker.getAvailableProvidersSmart({ complexity: 'simple', descriptionLength: 50 });
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].score).toBeLessThanOrEqual(1.2); // generous upper bound
    });

    it('includes estimatedTokens in result', () => {
      const tracker = makeTracker([
        { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
      ]);

      const results = tracker.getAvailableProvidersSmart({ descriptionLength: 400 });
      expect(results[0].estimatedTokens).toBeGreaterThan(0);
      expect(results[0].estimatedTokens).toBe(FreeQuotaTracker.estimateTokenNeed(400));
    });
  });
});

// ---------------------------------------------------------------------------
// getStatus includes avg_latency_ms
// ---------------------------------------------------------------------------
describe('getStatus latency inclusion', () => {
  it('includes avg_latency_ms in status output', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
    ]);
    tracker.recordLatency('groq', 750);
    tracker.recordLatency('groq', 1250);

    const status = tracker.getStatus();
    expect(status.groq.avg_latency_ms).toBe(1000);
  });

  it('shows DEFAULT_LATENCY_MS when no latency recorded', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
    ]);

    const status = tracker.getStatus();
    expect(status.groq.avg_latency_ms).toBe(FreeQuotaTracker.DEFAULT_LATENCY_MS);
  });
});

// ---------------------------------------------------------------------------
// Static exports
// ---------------------------------------------------------------------------
describe('static exports', () => {
  it('exports estimateTokenNeed as static method', () => {
    expect(typeof FreeQuotaTracker.estimateTokenNeed).toBe('function');
  });

  it('exports PROVIDER_TRAITS', () => {
    expect(FreeQuotaTracker.PROVIDER_TRAITS).toBeDefined();
    expect(FreeQuotaTracker.PROVIDER_TRAITS.groq).toHaveProperty('speed');
    expect(FreeQuotaTracker.PROVIDER_TRAITS.groq).toHaveProperty('tokenCapacity');
  });

  it('exports COMPLEXITY_WEIGHTS', () => {
    expect(FreeQuotaTracker.COMPLEXITY_WEIGHTS).toBeDefined();
    expect(FreeQuotaTracker.COMPLEXITY_WEIGHTS.simple).toHaveProperty('speedWeight');
    expect(FreeQuotaTracker.COMPLEXITY_WEIGHTS.complex).toHaveProperty('capacityWeight');
  });

  it('COMPLEXITY_WEIGHTS cover simple/normal/complex', () => {
    expect(FreeQuotaTracker.COMPLEXITY_WEIGHTS).toHaveProperty('simple');
    expect(FreeQuotaTracker.COMPLEXITY_WEIGHTS).toHaveProperty('normal');
    expect(FreeQuotaTracker.COMPLEXITY_WEIGHTS).toHaveProperty('complex');
  });

  it('PROVIDER_TRAITS cover expected quota providers', () => {
    const traits = FreeQuotaTracker.PROVIDER_TRAITS;
    expect(traits).toHaveProperty('groq');
    expect(traits).toHaveProperty('cerebras');
    expect(traits).toHaveProperty('google-ai');
    expect(traits).toHaveProperty('openrouter');
  });
});

// ---------------------------------------------------------------------------
// Queue scheduler integration (unit-level mock test)
// ---------------------------------------------------------------------------
describe('queue-scheduler quota overflow integration', () => {
  // This tests the logic path in queue-scheduler.js that calls
  // getAvailableProvidersSmart when available

  it('getAvailableProvidersSmart is called with task metadata when available', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      { provider: 'google-ai', rpd_limit: 100, rpm_limit: 10, tpd_limit: 200000 },
    ]);

    // Simulate what queue-scheduler does: check for smart method, call with task metadata
    const hasSmart = typeof tracker.getAvailableProvidersSmart === 'function';
    expect(hasSmart).toBe(true);

    const taskComplexity = 'simple';
    const descriptionLength = 150;

    const freeProviders = hasSmart
      ? tracker.getAvailableProvidersSmart({ complexity: taskComplexity, descriptionLength })
      : tracker.getAvailableProviders();

    expect(freeProviders.length).toBe(2);
    expect(freeProviders[0]).toHaveProperty('score');
    // For simple tasks, groq (speed=10) should beat google-ai (speed=6)
    expect(freeProviders[0].provider).toBe('groq');
  });

  it('falls back to getAvailableProviders for trackers without smart method', () => {
    // Simulate an old tracker instance that doesn't have the smart method
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
    ]);

    // Delete the smart method to simulate old version
    const smartFn = tracker.getAvailableProvidersSmart;
    tracker.getAvailableProvidersSmart = undefined;

    const hasSmart = typeof tracker.getAvailableProvidersSmart === 'function';
    expect(hasSmart).toBe(false);

    const freeProviders = hasSmart
      ? tracker.getAvailableProvidersSmart({ complexity: 'normal' })
      : tracker.getAvailableProviders();

    expect(freeProviders.length).toBe(1);
    expect(freeProviders[0]).not.toHaveProperty('score');
    expect(freeProviders[0]).toHaveProperty('dailyRemainingPct');

    // Restore
    tracker.getAvailableProvidersSmart = smartFn;
  });

  it('complex overflow task routes to high-capacity provider', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
      { provider: 'openrouter', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
    ]);

    const results = tracker.getAvailableProvidersSmart({
      complexity: 'complex',
      descriptionLength: 3000,
    });

    expect(results[0].provider).toBe('openrouter');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('edge cases', () => {
  it('handles provider with no traits gracefully', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'custom-unknown', rpd_limit: 100, rpm_limit: 10 },
    ]);

    // Should not throw — unknown providers just don't get trait bonus
    const results = tracker.getAvailableProvidersSmart({ complexity: 'simple' });
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('handles unknown complexity gracefully (defaults to normal weights)', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 100, rpm_limit: 10 },
    ]);

    const results = tracker.getAvailableProvidersSmart({ complexity: 'unknown-level' });
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('handles many providers correctly', () => {
    const providers = ['groq', 'cerebras', 'google-ai', 'openrouter', 'deepinfra', 'hyperbolic', 'anthropic'];
    const tracker = new FreeQuotaTracker(
      providers.map(p => ({ provider: p, rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 }))
    );

    const results = tracker.getAvailableProvidersSmart({ complexity: 'normal', descriptionLength: 500 });
    expect(results.length).toBe(providers.length);

    // Verify sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('quota consumption affects smart routing rankings', () => {
    const tracker = new FreeQuotaTracker([
      { provider: 'groq', rpd_limit: 10, rpm_limit: 10, tpd_limit: 100000 },
      { provider: 'cerebras', rpd_limit: 100, rpm_limit: 10, tpd_limit: 100000 },
    ]);

    // Use up 90% of groq's daily request quota
    for (let i = 0; i < 9; i++) {
      tracker.recordUsage('groq', 100);
    }

    const results = tracker.getAvailableProvidersSmart({ complexity: 'simple', descriptionLength: 100 });
    expect(results.length).toBe(2);
    // Despite groq having better speed traits, cerebras should win due to quota
    expect(results[0].provider).toBe('cerebras');
  });
});
