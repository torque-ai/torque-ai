'use strict';

const telemetryModule = require('../mcp/telemetry');

const {
  MCPPlatformTelemetry,
  summarizeLatency,
  incrementToolCall,
  incrementError,
  observeLatency,
  recordCall,
  getMetrics,
  snapshot,
  resetMetrics,
  reset,
} = telemetryModule;

const EMPTY_BUCKETS = {
  lt_10ms: 0,
  lt_50ms: 0,
  lt_100ms: 0,
  lt_500ms: 0,
  lt_1000ms: 0,
  gte_1000ms: 0,
};

function expectEmptyHistogram(histogram) {
  expect(histogram).toEqual({
    count: 0,
    min: 0,
    max: 0,
    sum: 0,
    buckets: EMPTY_BUCKETS,
  });
}

describe('summarizeLatency', () => {
  it('returns zeroed stats for empty input', () => {
    expect(summarizeLatency()).toEqual({ p50: 0, p95: 0, count: 0 });
    expect(summarizeLatency([])).toEqual({ p50: 0, p95: 0, count: 0 });
  });

  it('sorts values before calculating percentiles', () => {
    expect(summarizeLatency([100, 5, 25, 50, 10])).toEqual({
      p50: 25,
      p95: 50,
      count: 5,
    });
  });
});

describe('MCPPlatformTelemetry', () => {
  let telemetry;

  beforeEach(() => {
    telemetry = new MCPPlatformTelemetry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty metrics', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T15:00:00.000Z'));

    const metrics = telemetry.getMetrics();

    expect(metrics.generated_at).toBe('2026-03-09T15:00:00.000Z');
    expect(metrics.calls_total).toBe(0);
    expect(metrics.errors_total).toBe(0);
    expect(metrics.error_codes).toEqual({});
    expect(metrics.tools).toEqual({});
    expectEmptyHistogram(metrics.duration_histogram);
  });

  it('normalizes missing tool names when incrementing tool calls', () => {
    telemetry.incrementToolCall();
    telemetry.incrementToolCall('');

    const metrics = telemetry.getMetrics();

    expect(metrics.calls_total).toBe(2);
    expect(metrics.tools.unknown).toMatchObject({
      calls_total: 2,
      errors_total: 0,
    });
    expectEmptyHistogram(metrics.tools.unknown.duration_histogram);
  });

  it('tracks call counts independently per tool', () => {
    telemetry.incrementToolCall('torque.task.submit');
    telemetry.incrementToolCall('torque.task.submit');
    telemetry.incrementToolCall('torque.task.await');

    const metrics = telemetry.getMetrics();

    expect(metrics.calls_total).toBe(3);
    expect(metrics.tools['torque.task.submit'].calls_total).toBe(2);
    expect(metrics.tools['torque.task.await'].calls_total).toBe(1);
  });

  it('defaults unknown error codes to UNKNOWN_ERROR', () => {
    telemetry.incrementError();
    telemetry.incrementError('');

    const metrics = telemetry.getMetrics();

    expect(metrics.errors_total).toBe(2);
    expect(metrics.error_codes).toEqual({
      UNKNOWN_ERROR: 2,
    });
  });

  it('aggregates repeated error codes', () => {
    telemetry.incrementError('VALIDATION_FAILED');
    telemetry.incrementError('VALIDATION_FAILED');
    telemetry.incrementError('TIMEOUT');

    const metrics = telemetry.getMetrics();

    expect(metrics.errors_total).toBe(3);
    expect(metrics.error_codes).toEqual({
      VALIDATION_FAILED: 2,
      TIMEOUT: 1,
    });
  });

  it('normalizes invalid latency values to zero', () => {
    telemetry.observeLatency('torque.task.submit', -5);
    telemetry.observeLatency('torque.task.submit', 'not-a-number');
    telemetry.observeLatency('torque.task.submit', Infinity);

    const metrics = telemetry.getMetrics();
    const toolHistogram = metrics.tools['torque.task.submit'].duration_histogram;

    expect(metrics.duration_histogram).toMatchObject({
      count: 3,
      min: 0,
      max: 0,
      sum: 0,
      buckets: {
        ...EMPTY_BUCKETS,
        lt_10ms: 3,
      },
    });
    expect(toolHistogram).toMatchObject({
      count: 3,
      min: 0,
      max: 0,
      sum: 0,
      buckets: {
        ...EMPTY_BUCKETS,
        lt_10ms: 3,
      },
    });
  });

  it('assigns latency values to the expected histogram buckets', () => {
    const durations = [0, 9, 10, 49, 50, 99, 100, 499, 500, 999, 1000];

    for (const duration of durations) {
      telemetry.observeLatency('torque.task.submit', duration);
    }

    expect(telemetry.getMetrics().duration_histogram).toEqual({
      count: 11,
      min: 0,
      max: 1000,
      sum: 3315,
      buckets: {
        lt_10ms: 2,
        lt_50ms: 2,
        lt_100ms: 2,
        lt_500ms: 2,
        lt_1000ms: 2,
        gte_1000ms: 1,
      },
    });
  });

  it('creates tool metrics when latency is observed before any call count', () => {
    telemetry.observeLatency('torque.workflow.await', 25);

    const metrics = telemetry.getMetrics();
    const snap = telemetry.snapshot();

    expect(metrics.tools['torque.workflow.await']).toMatchObject({
      calls_total: 0,
      errors_total: 0,
      duration_histogram: expect.objectContaining({
        count: 1,
        min: 25,
        max: 25,
        sum: 25,
      }),
    });
    expect(snap.counters.tool_calls).toEqual({
      'torque.workflow.await': 0,
    });
    expect(snap.latency['torque.workflow.await']).toEqual({
      p50: 25,
      p95: 25,
      count: 1,
    });
  });

  it('records successful calls without incrementing error counters', () => {
    telemetry.recordCall('torque.task.submit', 42, true);

    const metrics = telemetry.getMetrics();

    expect(metrics.calls_total).toBe(1);
    expect(metrics.errors_total).toBe(0);
    expect(metrics.error_codes).toEqual({});
    expect(metrics.tools['torque.task.submit']).toMatchObject({
      calls_total: 1,
      errors_total: 0,
      duration_histogram: expect.objectContaining({
        count: 1,
        min: 42,
        max: 42,
        sum: 42,
      }),
    });
  });

  it('records failed calls and increments TOOL_CALL_FAILED', () => {
    telemetry.recordCall('torque.task.submit', 1200, false);

    const metrics = telemetry.getMetrics();

    expect(metrics.calls_total).toBe(1);
    expect(metrics.errors_total).toBe(1);
    expect(metrics.error_codes).toEqual({
      TOOL_CALL_FAILED: 1,
    });
    expect(metrics.tools['torque.task.submit']).toMatchObject({
      calls_total: 1,
      errors_total: 1,
      duration_histogram: expect.objectContaining({
        count: 1,
        min: 1200,
        max: 1200,
        sum: 1200,
      }),
    });
    expect(metrics.duration_histogram.buckets.gte_1000ms).toBe(1);
  });

  it('aggregates metrics independently across multiple tools', () => {
    telemetry.recordCall('torque.task.submit', 15, true);
    telemetry.recordCall('torque.task.submit', 45, false);
    telemetry.recordCall('torque.workflow.await', 600, true);

    const metrics = telemetry.getMetrics();

    expect(metrics.calls_total).toBe(3);
    expect(metrics.errors_total).toBe(1);
    expect(metrics.tools['torque.task.submit']).toMatchObject({
      calls_total: 2,
      errors_total: 1,
    });
    expect(metrics.tools['torque.workflow.await']).toMatchObject({
      calls_total: 1,
      errors_total: 0,
    });
    expect(metrics.tools['torque.task.submit'].duration_histogram.sum).toBe(60);
    expect(metrics.tools['torque.workflow.await'].duration_histogram.buckets.lt_1000ms).toBe(1);
  });

  it('returns cloned metric data rather than live references', () => {
    telemetry.recordCall('torque.task.submit', 12, false);

    const first = telemetry.getMetrics();
    first.duration_histogram.count = 999;
    first.duration_histogram.buckets.lt_50ms = 999;
    first.error_codes.TOOL_CALL_FAILED = 999;
    first.tools['torque.task.submit'].duration_histogram.sum = 999;

    const second = telemetry.getMetrics();

    expect(second.duration_histogram.count).toBe(1);
    expect(second.duration_histogram.buckets.lt_50ms).toBe(1);
    expect(second.error_codes.TOOL_CALL_FAILED).toBe(1);
    expect(second.tools['torque.task.submit'].duration_histogram.sum).toBe(12);
  });

  it('produces snapshot summaries with tool call counts and error counters', () => {
    for (const duration of [5, 25, 50, 100, 200]) {
      telemetry.observeLatency('torque.task.submit', duration);
    }
    telemetry.incrementToolCall('torque.task.submit');
    telemetry.incrementError('VALIDATION_FAILED');

    expect(telemetry.snapshot()).toMatchObject({
      counters: {
        tool_calls: {
          'torque.task.submit': 1,
        },
        errors: {
          VALIDATION_FAILED: 1,
        },
      },
      latency: {
        'torque.task.submit': {
          p50: 50,
          p95: 100,
          count: 5,
        },
      },
    });
  });

  it('timestamps snapshots with the current ISO time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T18:30:45.000Z'));

    telemetry.recordCall('torque.task.submit', 10, true);

    expect(telemetry.snapshot().generated_at).toBe('2026-03-09T18:30:45.000Z');
  });

  it('resets all aggregated metrics', () => {
    telemetry.recordCall('torque.task.submit', 20, false);
    telemetry.incrementError('VALIDATION_FAILED');

    telemetry.resetMetrics();

    const metrics = telemetry.getMetrics();
    const snap = telemetry.snapshot();

    expect(metrics.calls_total).toBe(0);
    expect(metrics.errors_total).toBe(0);
    expect(metrics.tools).toEqual({});
    expect(metrics.error_codes).toEqual({});
    expectEmptyHistogram(metrics.duration_histogram);
    expect(snap.counters).toEqual({
      tool_calls: {},
      errors: {},
    });
    expect(snap.latency).toEqual({});
  });

  it('records async concurrent calls without losing counts', async () => {
    const totalCalls = 40;

    await Promise.all(
      Array.from({ length: totalCalls }, (_, index) => Promise.resolve().then(() => {
        telemetry.recordCall(
          index % 2 === 0 ? 'torque.task.submit' : 'torque.workflow.await',
          index + 1,
          index % 5 !== 0,
        );
      })),
    );

    const metrics = telemetry.getMetrics();

    expect(metrics.calls_total).toBe(40);
    expect(metrics.errors_total).toBe(8);
    expect(metrics.error_codes).toEqual({
      TOOL_CALL_FAILED: 8,
    });
    expect(metrics.duration_histogram).toMatchObject({
      count: 40,
      min: 1,
      max: 40,
      sum: 820,
    });
    expect(metrics.tools['torque.task.submit']).toMatchObject({
      calls_total: 20,
      errors_total: 4,
    });
    expect(metrics.tools['torque.workflow.await']).toMatchObject({
      calls_total: 20,
      errors_total: 4,
    });
  });
});

describe('telemetry singleton helpers', () => {
  afterEach(() => {
    reset();
    vi.useRealTimers();
  });

  it('records metrics through incrementToolCall, observeLatency, and incrementError', () => {
    incrementToolCall('torque.task.get');
    observeLatency('torque.task.get', 20);
    incrementError('VALIDATION_FAILED');

    expect(getMetrics()).toMatchObject({
      calls_total: 1,
      errors_total: 1,
      error_codes: {
        VALIDATION_FAILED: 1,
      },
      tools: {
        'torque.task.get': expect.objectContaining({
          calls_total: 1,
          errors_total: 0,
        }),
      },
    });
  });

  it('records calls through the singleton recordCall helper', () => {
    recordCall('torque.task.submit', 1200, false);
    recordCall(null, -5, true);

    const metrics = getMetrics();

    expect(metrics.calls_total).toBe(2);
    expect(metrics.errors_total).toBe(1);
    expect(metrics.error_codes).toEqual({
      TOOL_CALL_FAILED: 1,
    });
    expect(metrics.tools['torque.task.submit']).toMatchObject({
      calls_total: 1,
      errors_total: 1,
    });
    expect(metrics.tools.unknown).toMatchObject({
      calls_total: 1,
      errors_total: 0,
    });
    expect(metrics.duration_histogram.buckets.gte_1000ms).toBe(1);
    expect(metrics.duration_histogram.buckets.lt_10ms).toBe(1);
  });

  it('returns singleton snapshots with counters and latency summaries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T21:15:00.000Z'));

    incrementToolCall('torque.task.get');
    observeLatency('torque.task.get', 15);
    observeLatency('torque.task.get', 35);

    expect(snapshot()).toEqual({
      generated_at: '2026-03-09T21:15:00.000Z',
      counters: {
        tool_calls: {
          'torque.task.get': 1,
        },
        errors: {},
      },
      latency: {
        'torque.task.get': {
          p50: 15,
          p95: 15,
          count: 2,
        },
      },
    });
  });

  it('clears singleton state through resetMetrics', () => {
    recordCall('torque.task.submit', 20, false);

    resetMetrics();

    const metrics = getMetrics();

    expect(metrics.calls_total).toBe(0);
    expect(metrics.errors_total).toBe(0);
    expect(metrics.tools).toEqual({});
    expect(metrics.error_codes).toEqual({});
    expectEmptyHistogram(metrics.duration_histogram);
  });

  it('clears singleton state through reset alias', () => {
    incrementToolCall('torque.task.submit');
    observeLatency('torque.task.submit', 20);

    reset();

    const metrics = getMetrics();

    expect(metrics.calls_total).toBe(0);
    expect(metrics.errors_total).toBe(0);
    expect(metrics.tools).toEqual({});
    expect(metrics.error_codes).toEqual({});
    expectEmptyHistogram(metrics.duration_histogram);
  });
});
