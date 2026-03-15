'use strict';

const { PEEK_SENSOR_TYPES, validatePeekInvestigationBundleEnvelope } = require('../contracts/peek');
const { FIXTURE_CATALOG, WPF_FIXTURE } = require('../contracts/peek-fixtures');
const { EVIDENCE_WEIGHTS, scoreBundle } = require('../handlers/peek/quality-score');

const SENSOR_FIXTURES = Object.entries(FIXTURE_CATALOG);
const PERFORMANCE_COUNTER_FIELDS = ['cpu_percent', 'memory_bytes', 'handle_count', 'thread_count', 'uptime_seconds'];

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('peek sensor contracts', () => {
  it('exports a frozen two-entry sensor catalog', () => {
    expect(Object.keys(PEEK_SENSOR_TYPES)).toEqual(['performance_counters', 'accessibility_tree_diff']);
    expect(Object.keys(PEEK_SENSOR_TYPES)).toHaveLength(2);
    expect(Object.isFrozen(PEEK_SENSOR_TYPES)).toBe(true);
  });

  it('describes the performance_counters sensor contract', () => {
    expect(PEEK_SENSOR_TYPES.performance_counters).toEqual({
      name: 'performance_counters',
      description: 'Process CPU, memory, and handle metrics captured alongside the screenshot',
      fields: PERFORMANCE_COUNTER_FIELDS,
      optional: true,
    });
  });

  it('describes the accessibility_tree_diff sensor contract', () => {
    expect(PEEK_SENSOR_TYPES.accessibility_tree_diff).toEqual({
      name: 'accessibility_tree_diff',
      description: 'UIA tree diff before and after a recovery action',
      fields: [
        'before_tree_hash',
        'after_tree_hash',
        'diff_summary',
        'nodes_added',
        'nodes_removed',
        'nodes_changed',
      ],
      optional: true,
    });
  });

  it.each(SENSOR_FIXTURES)('includes performance counter data for the %s fixture', (_name, fixture) => {
    expect(fixture.performance_counters).toEqual({
      cpu_percent: expect.any(Number),
      memory_bytes: expect.any(Number),
      handle_count: expect.any(Number),
      thread_count: expect.any(Number),
      uptime_seconds: expect.any(Number),
    });
    expect(Object.keys(fixture.performance_counters)).toEqual(PERFORMANCE_COUNTER_FIELDS);
  });

  it.each(SENSOR_FIXTURES)('pins realistic performance counter values for the %s fixture', (_name, fixture) => {
    const counters = fixture.performance_counters;

    expect(counters.cpu_percent).toBeGreaterThanOrEqual(0);
    expect(counters.cpu_percent).toBeLessThan(100);
    expect(counters.memory_bytes).toBeGreaterThan(0);
    expect(Number.isInteger(counters.handle_count)).toBe(true);
    expect(counters.handle_count).toBeGreaterThan(0);
    expect(Number.isInteger(counters.thread_count)).toBe(true);
    expect(counters.thread_count).toBeGreaterThan(0);
    expect(Number.isInteger(counters.uptime_seconds)).toBe(true);
    expect(counters.uptime_seconds).toBeGreaterThan(0);
  });

  it.each(SENSOR_FIXTURES)('keeps the %s fixture valid against the bundle contract', (_name, fixture) => {
    expect(validatePeekInvestigationBundleEnvelope(fixture)).toEqual([]);
  });

  it('treats performance counters as app_type_extras quality evidence', () => {
    const bundle = cloneValue(WPF_FIXTURE);
    delete bundle.visual_tree;
    delete bundle.property_bag;

    const result = scoreBundle(bundle);

    expect(result.breakdown.app_type_extras).toBe(EVIDENCE_WEIGHTS.app_type_extras);
    expect(result.missing).not.toContain('app_type_extras');
    expect(result.score).toBe(100);
  });
});
