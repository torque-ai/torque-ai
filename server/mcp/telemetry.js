'use strict';

const HISTOGRAM_BUCKETS = Object.freeze([
  { label: 'lt_10ms', upperBound: 10 },
  { label: 'lt_50ms', upperBound: 50 },
  { label: 'lt_100ms', upperBound: 100 },
  { label: 'lt_500ms', upperBound: 500 },
  { label: 'lt_1000ms', upperBound: 1000 },
  { label: 'gte_1000ms', upperBound: Number.POSITIVE_INFINITY },
]);

function normalizeToolName(toolName) {
  return toolName || 'unknown';
}

function normalizeDuration(durationMs) {
  const numeric = Number(durationMs);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return numeric;
}

function createHistogram() {
  const buckets = {};
  for (const bucket of HISTOGRAM_BUCKETS) {
    buckets[bucket.label] = 0;
  }
  return {
    count: 0,
    min: 0,
    max: 0,
    sum: 0,
    buckets,
  };
}

function recordHistogramValue(histogram, durationMs) {
  const duration = normalizeDuration(durationMs);
  histogram.count += 1;
  histogram.sum += duration;
  histogram.min = histogram.count === 1 ? duration : Math.min(histogram.min, duration);
  histogram.max = histogram.count === 1 ? duration : Math.max(histogram.max, duration);

  for (const bucket of HISTOGRAM_BUCKETS) {
    if (duration < bucket.upperBound) {
      histogram.buckets[bucket.label] += 1;
      return;
    }
  }
}

function cloneHistogram(histogram) {
  return {
    count: histogram.count,
    min: histogram.min,
    max: histogram.max,
    sum: histogram.sum,
    buckets: { ...histogram.buckets },
  };
}

function summarizeLatency(values) {
  if (!values || values.length === 0) return { p50: 0, p95: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const p50Index = Math.floor((sorted.length - 1) * 0.5);
  const p95Index = Math.floor((sorted.length - 1) * 0.95);
  return {
    p50: sorted[p50Index],
    p95: sorted[p95Index],
    count: sorted.length,
  };
}

class MCPPlatformTelemetry {
  constructor() {
    this.resetMetrics();
  }

  _getToolEntry(toolName) {
    const normalized = normalizeToolName(toolName);
    if (!this.toolMetrics.has(normalized)) {
      this.toolMetrics.set(normalized, {
        calls_total: 0,
        errors_total: 0,
        duration_histogram: createHistogram(),
      });
    }
    return this.toolMetrics.get(normalized);
  }

  incrementToolCall(toolName) {
    const normalized = normalizeToolName(toolName);
    this.callsTotal += 1;
    const entry = this._getToolEntry(normalized);
    entry.calls_total += 1;
  }

  incrementError(errorCode) {
    const code = errorCode || 'UNKNOWN_ERROR';
    this.errorsTotal += 1;
    const next = (this.errorCounters.get(code) || 0) + 1;
    this.errorCounters.set(code, next);
  }

  observeLatency(toolName, latencyMs) {
    const normalized = normalizeToolName(toolName);
    const duration = normalizeDuration(latencyMs);
    if (!this.latencyByTool.has(normalized)) {
      this.latencyByTool.set(normalized, []);
    }
    this.latencyByTool.get(normalized).push(duration);
    recordHistogramValue(this.durationHistogram, duration);
    recordHistogramValue(this._getToolEntry(normalized).duration_histogram, duration);
  }

  recordCall(toolName, durationMs, success) {
    const normalized = normalizeToolName(toolName);
    this.incrementToolCall(normalized);
    this.observeLatency(normalized, durationMs);
    if (!success) {
      this._getToolEntry(normalized).errors_total += 1;
      this.incrementError('TOOL_CALL_FAILED');
    }
  }

  getMetrics() {
    const tools = {};
    for (const [toolName, entry] of this.toolMetrics.entries()) {
      tools[toolName] = {
        calls_total: entry.calls_total,
        errors_total: entry.errors_total,
        duration_histogram: cloneHistogram(entry.duration_histogram),
      };
    }

    return {
      generated_at: new Date().toISOString(),
      calls_total: this.callsTotal,
      errors_total: this.errorsTotal,
      duration_histogram: cloneHistogram(this.durationHistogram),
      error_codes: Object.fromEntries(this.errorCounters.entries()),
      tools,
    };
  }

  snapshot() {
    const latency = {};
    for (const [tool, values] of this.latencyByTool.entries()) {
      latency[tool] = summarizeLatency(values);
    }

    const toolCalls = {};
    for (const [toolName, entry] of this.toolMetrics.entries()) {
      toolCalls[toolName] = entry.calls_total;
    }

    return {
      generated_at: new Date().toISOString(),
      counters: {
        tool_calls: toolCalls,
        errors: Object.fromEntries(this.errorCounters.entries()),
      },
      latency,
    };
  }

  resetMetrics() {
    this.callsTotal = 0;
    this.errorsTotal = 0;
    this.durationHistogram = createHistogram();
    this.toolMetrics = new Map();
    this.errorCounters = new Map();
    this.latencyByTool = new Map();
  }
}

const defaultTelemetry = new MCPPlatformTelemetry();

function incrementToolCall(toolName) {
  defaultTelemetry.incrementToolCall(toolName);
}

function incrementError(errorCode) {
  defaultTelemetry.incrementError(errorCode);
}

function observeLatency(toolName, latencyMs) {
  defaultTelemetry.observeLatency(toolName, latencyMs);
}

function recordCall(toolName, durationMs, success) {
  defaultTelemetry.recordCall(toolName, durationMs, success);
}

function getMetrics() {
  return defaultTelemetry.getMetrics();
}

function snapshot() {
  return defaultTelemetry.snapshot();
}

function resetMetrics() {
  defaultTelemetry.resetMetrics();
}

function reset() {
  defaultTelemetry.resetMetrics();
}

module.exports = {
  MCPPlatformTelemetry,
  incrementToolCall,
  incrementError,
  observeLatency,
  recordCall,
  getMetrics,
  summarizeLatency,
  snapshot,
  resetMetrics,
  reset,
};
