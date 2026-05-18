import { describe, it, expect } from 'vitest';

import {
  DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES,
  PLAN_GENERATION_HARD_CAP_EXTENSION_MINUTES,
  DEFAULT_STALE_PENDING_PLAN_GENERATION_MS,
  OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES,
  resolvePlanGenerationTimeoutMinutes,
  buildPlanGenerationActivityTimeoutPolicy,
  clearPlanGenerationWaitFields,
} from '../factory/plan-generation/timeout-policy.js';

// Helper: build a project object whose getEffectiveProjectProvider resolves to
// the given provider name. The real function reads
// config.provider_lane_policy.expected_provider, so we embed that structure.
function projectWithProvider(provider, extraConfig = {}) {
  const cfg = { ...extraConfig };
  if (provider) {
    cfg.provider_lane_policy = { expected_provider: provider };
  }
  return { config_json: JSON.stringify(cfg) };
}

function projectWithProviderAndTimeout(provider, timeoutKey, timeoutValue) {
  const cfg = { [timeoutKey]: timeoutValue };
  if (provider) {
    cfg.provider_lane_policy = { expected_provider: provider };
  }
  return { config_json: JSON.stringify(cfg) };
}

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------
describe('exported constants', () => {
  it('DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES is 30', () => {
    expect(DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES).toBe(30);
  });

  it('PLAN_GENERATION_HARD_CAP_EXTENSION_MINUTES is 15', () => {
    expect(PLAN_GENERATION_HARD_CAP_EXTENSION_MINUTES).toBe(15);
  });

  it('DEFAULT_STALE_PENDING_PLAN_GENERATION_MS equals 30 * 60 * 1000', () => {
    expect(DEFAULT_STALE_PENDING_PLAN_GENERATION_MS).toBe(30 * 60 * 1000);
  });

  it('OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES is 10', () => {
    expect(OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// resolvePlanGenerationTimeoutMinutes
// ---------------------------------------------------------------------------
describe('resolvePlanGenerationTimeoutMinutes', () => {
  it('returns 30 when config_json is null and provider is not ollama', () => {
    expect(resolvePlanGenerationTimeoutMinutes({ config_json: null })).toBe(30);
  });

  it('returns 30 when config_json is undefined and provider is not ollama', () => {
    expect(resolvePlanGenerationTimeoutMinutes({})).toBe(30);
  });

  it('returns 30 when project is null', () => {
    expect(resolvePlanGenerationTimeoutMinutes(null)).toBe(30);
  });

  it('returns 30 when project is undefined', () => {
    expect(resolvePlanGenerationTimeoutMinutes(undefined)).toBe(30);
  });

  it('returns 10 when provider is ollama', () => {
    expect(resolvePlanGenerationTimeoutMinutes(projectWithProvider('ollama'))).toBe(10);
  });

  it('respects plan_generation_timeout_minutes in config_json string', () => {
    const project = { config_json: JSON.stringify({ plan_generation_timeout_minutes: 60 }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(60);
  });

  it('respects factory_plan_generation_timeout_minutes as fallback key', () => {
    const project = { config_json: JSON.stringify({ factory_plan_generation_timeout_minutes: 45 }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(45);
  });

  it('prefers plan_generation_timeout_minutes over factory_ variant', () => {
    const project = {
      config_json: JSON.stringify({
        plan_generation_timeout_minutes: 50,
        factory_plan_generation_timeout_minutes: 70,
      }),
    };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(50);
  });

  it('clamps configured value to minimum 1', () => {
    const project = { config_json: JSON.stringify({ plan_generation_timeout_minutes: 0.3 }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(1);
  });

  it('falls through to default when configured value is 0', () => {
    // 0 is not > 0, so Number.isFinite(0) && 0 > 0 is false — falls through
    const project = { config_json: JSON.stringify({ plan_generation_timeout_minutes: 0 }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(30);
  });

  it('falls through to default when configured value is negative', () => {
    const project = { config_json: JSON.stringify({ plan_generation_timeout_minutes: -5 }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(30);
  });

  it('clamps configured value to maximum 120', () => {
    const project = { config_json: JSON.stringify({ plan_generation_timeout_minutes: 999 }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(120);
  });

  it('ceils fractional values', () => {
    const project = { config_json: JSON.stringify({ plan_generation_timeout_minutes: 29.1 }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(30);
  });

  it('falls back to provider default on malformed config_json string', () => {
    const project = { config_json: 'not-json' };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(30);
  });

  it('falls back to ollama default on malformed config_json when provider is ollama', () => {
    // Malformed config_json means JSON.parse throws, so configured stays null.
    // But getEffectiveProjectProvider also parses config_json — and it also
    // catches the parse error and returns null. So even though the project is
    // "ollama", the malformed JSON prevents detection. The function correctly
    // falls through to the non-ollama default (30).
    // To get the ollama path with malformed config_json, supply a pre-parsed
    // config object (the real getEffectiveProjectProvider checks project.config
    // first before falling back to config_json).
    const project = {
      config_json: 'not-json',
      config: { provider_lane_policy: { expected_provider: 'ollama' } },
    };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(10);
  });

  it('treats non-numeric config value as unconfigured', () => {
    const project = { config_json: JSON.stringify({ plan_generation_timeout_minutes: 'fast' }) };
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(30);
  });

  it('overrides provider default when an explicit timeout is configured', () => {
    // Even if provider is ollama, a configured value wins
    const project = projectWithProviderAndTimeout('ollama', 'plan_generation_timeout_minutes', 60);
    expect(resolvePlanGenerationTimeoutMinutes(project)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// buildPlanGenerationActivityTimeoutPolicy
// ---------------------------------------------------------------------------
describe('buildPlanGenerationActivityTimeoutPolicy', () => {
  it('returns correct shape with kind and overrun_intake_problem', () => {
    const policy = buildPlanGenerationActivityTimeoutPolicy(30);
    expect(policy.kind).toBe('plan_generation');
    expect(policy.overrun_intake_problem).toBe('timeout_overrun_active');
  });

  it('given 30 returns timeout_minutes=30, max_wall_clock_minutes=60', () => {
    // doubled = 60, minimumHardCap = 45, max(60,45) = 60, min(60,120) = 60
    const policy = buildPlanGenerationActivityTimeoutPolicy(30);
    expect(policy.timeout_minutes).toBe(30);
    expect(policy.max_wall_clock_minutes).toBe(60);
  });

  it('given 1 (minimum boundary) returns timeout_minutes=1, max_wall_clock_minutes=16', () => {
    // doubled = 2, minimumHardCap = 1+15 = 16, max(2,16) = 16, min(16,120) = 16
    const policy = buildPlanGenerationActivityTimeoutPolicy(1);
    expect(policy.timeout_minutes).toBe(1);
    expect(policy.max_wall_clock_minutes).toBe(16);
  });

  it('given 120 (maximum boundary) returns timeout_minutes=120, max_wall_clock_minutes=120', () => {
    // doubled = 240, minimumHardCap = 135, max(240,135) = 240, min(240,120) = 120
    const policy = buildPlanGenerationActivityTimeoutPolicy(120);
    expect(policy.timeout_minutes).toBe(120);
    expect(policy.max_wall_clock_minutes).toBe(120);
  });

  it('given 10 (ollama default) returns timeout_minutes=10, max_wall_clock_minutes=25', () => {
    // doubled = 20, minimumHardCap = 10+15 = 25, max(20,25) = 25, min(25,120) = 25
    const policy = buildPlanGenerationActivityTimeoutPolicy(10);
    expect(policy.timeout_minutes).toBe(10);
    expect(policy.max_wall_clock_minutes).toBe(25);
  });

  it('given 8 (hard-cap dominates doubled) returns timeout_minutes=8, max_wall_clock_minutes=23', () => {
    // doubled = 16, minimumHardCap = 8+15 = 23, max(16,23) = 23, min(23,120) = 23
    const policy = buildPlanGenerationActivityTimeoutPolicy(8);
    expect(policy.timeout_minutes).toBe(8);
    expect(policy.max_wall_clock_minutes).toBe(23);
  });

  it('given 16 (doubled dominates hard-cap) returns timeout_minutes=16, max_wall_clock_minutes=32', () => {
    // doubled = 32, minimumHardCap = 16+15 = 31, max(32,31) = 32, min(32,120) = 32
    const policy = buildPlanGenerationActivityTimeoutPolicy(16);
    expect(policy.timeout_minutes).toBe(16);
    expect(policy.max_wall_clock_minutes).toBe(32);
  });

  it('clamps input above 120 to 120', () => {
    const policy = buildPlanGenerationActivityTimeoutPolicy(999);
    expect(policy.timeout_minutes).toBe(120);
    expect(policy.max_wall_clock_minutes).toBe(120);
  });

  it('ceils fractional input', () => {
    // 7.2 → ceil → 8
    const policy = buildPlanGenerationActivityTimeoutPolicy(7.2);
    expect(policy.timeout_minutes).toBe(8);
    expect(policy.max_wall_clock_minutes).toBe(23); // max(16, 23) = 23
  });

  it('falls back to default 30 for non-numeric input', () => {
    const policy = buildPlanGenerationActivityTimeoutPolicy('fast');
    expect(policy.timeout_minutes).toBe(30);
    expect(policy.max_wall_clock_minutes).toBe(60);
  });

  it('falls back to default 30 for null', () => {
    const policy = buildPlanGenerationActivityTimeoutPolicy(null);
    expect(policy.timeout_minutes).toBe(30);
  });

  it('falls back to default 30 for undefined', () => {
    const policy = buildPlanGenerationActivityTimeoutPolicy(undefined);
    expect(policy.timeout_minutes).toBe(30);
  });

  it('falls back to default 30 for zero', () => {
    const policy = buildPlanGenerationActivityTimeoutPolicy(0);
    expect(policy.timeout_minutes).toBe(30);
  });

  it('falls back to default 30 for negative input', () => {
    const policy = buildPlanGenerationActivityTimeoutPolicy(-10);
    expect(policy.timeout_minutes).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// clearPlanGenerationWaitFields
// ---------------------------------------------------------------------------

// The 10 plan_generation_* wait-field keys stripped by the function
const WAIT_FIELD_KEYS = [
  'plan_generation_task_id',
  'plan_generation_status',
  'plan_generation_wait_reason',
  'plan_generation_retry_after',
  'plan_generation_retry_count',
  'plan_generation_last_error',
  'plan_generation_updated_at',
  'plan_generation_provider_fallback_count',
  'plan_generation_provider_fallback_from',
  'plan_generation_provider_fallback_to',
  'plan_generation_provider_fallback_error',
];

describe('clearPlanGenerationWaitFields', () => {
  it('strips all 11 wait fields and preserves non-wait keys', () => {
    const origin = { id: 42, name: 'test-item' };
    for (const key of WAIT_FIELD_KEYS) origin[key] = `value-${key}`;
    const result = clearPlanGenerationWaitFields(origin);

    expect(result.id).toBe(42);
    expect(result.name).toBe('test-item');
    for (const key of WAIT_FIELD_KEYS) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it('returns a shallow copy when no wait fields are present', () => {
    const origin = { id: 1, status: 'pending', extra: true };
    const result = clearPlanGenerationWaitFields(origin);

    expect(result).toEqual(origin);
    expect(result).not.toBe(origin); // must be a copy
  });

  it('handles null without throwing', () => {
    const result = clearPlanGenerationWaitFields(null);
    expect(result).toEqual({});
  });

  it('handles undefined without throwing', () => {
    const result = clearPlanGenerationWaitFields(undefined);
    expect(result).toEqual({});
  });

  it('handles no arguments (relies on default parameter)', () => {
    const result = clearPlanGenerationWaitFields();
    expect(result).toEqual({});
  });

  it('handles non-object input gracefully', () => {
    const result = clearPlanGenerationWaitFields('a string');
    expect(result).toEqual({});
  });

  it('strips only present wait fields, preserves the rest', () => {
    const origin = {
      id: 7,
      plan_generation_task_id: 'task-abc',
      plan_generation_status: 'pending',
      // other wait fields intentionally absent
      custom_field: 'keep me',
    };
    const result = clearPlanGenerationWaitFields(origin);

    expect(result.id).toBe(7);
    expect(result.custom_field).toBe('keep me');
    expect(result).not.toHaveProperty('plan_generation_task_id');
    expect(result).not.toHaveProperty('plan_generation_status');
  });

  it('does not mutate the original object', () => {
    const origin = { id: 1, plan_generation_task_id: 'xyz' };
    clearPlanGenerationWaitFields(origin);
    expect(origin.plan_generation_task_id).toBe('xyz');
  });
});
