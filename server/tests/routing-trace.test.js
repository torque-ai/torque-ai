'use strict';

const {
  KNOWN_STAGES,
  MAX_TRACE_ENTRIES,
  createTrace,
  recordRoutingDecision,
  getCurrentProvider,
  formatTraceAsMarkdown,
  normalizeTrace,
} = require('../utils/routing-trace');

describe('routing-trace helper', () => {
  it('createTrace returns a fresh empty array each call', () => {
    const a = createTrace();
    const b = createTrace();
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(a).not.toBe(b);
  });

  it('recordRoutingDecision appends a normalized entry', () => {
    const trace = createTrace();
    const ok = recordRoutingDecision(trace, {
      stage: KNOWN_STAGES.TEMPLATE_ACTIVE,
      from: null,
      to: 'codex',
      reason: "Template 'Quality First': architectural -> codex",
      rule: 'Quality First',
    });
    expect(ok).toBe(true);
    expect(trace).toEqual([{
      stage: 'template_active',
      from: null,
      to: 'codex',
      reason: "Template 'Quality First': architectural -> codex",
      rule: 'Quality First',
    }]);
  });

  it('records a from→to swap with both providers', () => {
    const trace = createTrace();
    recordRoutingDecision(trace, {
      stage: KNOWN_STAGES.LANE_POLICY,
      from: 'codex',
      to: 'ollama',
      reason: 'Project lane policy disallows codex — swapped to ollama',
    });
    expect(trace[0].from).toBe('codex');
    expect(trace[0].to).toBe('ollama');
  });

  it('drops entries with missing required fields', () => {
    const trace = createTrace();
    expect(recordRoutingDecision(trace, null)).toBe(false);
    expect(recordRoutingDecision(trace, {})).toBe(false);
    expect(recordRoutingDecision(trace, { stage: 'foo' })).toBe(false); // missing reason
    expect(recordRoutingDecision(trace, { reason: 'no stage' })).toBe(false);
    expect(trace).toEqual([]);
  });

  it('truncates very long reason strings', () => {
    const trace = createTrace();
    const longReason = 'x'.repeat(2000);
    recordRoutingDecision(trace, {
      stage: KNOWN_STAGES.PATTERN_MATCH,
      to: 'groq',
      reason: longReason,
    });
    expect(trace[0].reason.length).toBeLessThanOrEqual(500);
  });

  it('caps the trace at MAX_TRACE_ENTRIES to prevent runaway loops', () => {
    const trace = createTrace();
    for (let i = 0; i < MAX_TRACE_ENTRIES + 5; i++) {
      recordRoutingDecision(trace, {
        stage: KNOWN_STAGES.FALLBACK,
        to: 'codex',
        reason: `step ${i}`,
      });
    }
    expect(trace.length).toBe(MAX_TRACE_ENTRIES);
  });

  it('accepts unknown stages but tags them with _unknown_stage', () => {
    const trace = createTrace();
    recordRoutingDecision(trace, {
      stage: 'plugin_custom_stage',
      to: 'cerebras',
      reason: 'plugin override',
    });
    expect(trace[0].stage).toBe('plugin_custom_stage');
    expect(trace[0]._unknown_stage).toBe(true);
  });

  it('getCurrentProvider returns the most recent `to` provider', () => {
    const trace = createTrace();
    expect(getCurrentProvider(trace)).toBeNull();
    recordRoutingDecision(trace, { stage: KNOWN_STAGES.TEMPLATE_ACTIVE, to: 'codex', reason: 'a' });
    expect(getCurrentProvider(trace)).toBe('codex');
    recordRoutingDecision(trace, { stage: KNOWN_STAGES.LANE_POLICY, from: 'codex', to: 'ollama', reason: 'b' });
    expect(getCurrentProvider(trace)).toBe('ollama');
  });

  it('formatTraceAsMarkdown renders a numbered list with from→to arrows', () => {
    const trace = createTrace();
    recordRoutingDecision(trace, {
      stage: KNOWN_STAGES.TEMPLATE_ACTIVE,
      from: null,
      to: 'codex',
      reason: 'template picked codex',
      rule: 'Quality First',
    });
    recordRoutingDecision(trace, {
      stage: KNOWN_STAGES.LANE_POLICY,
      from: 'codex',
      to: 'ollama',
      reason: 'lane swap',
    });
    const md = formatTraceAsMarkdown(trace);
    expect(md).toContain('1. **template_active** — codex: template picked codex [Quality First]');
    expect(md).toContain('2. **lane_policy** — codex → ollama: lane swap');
  });

  it('formatTraceAsMarkdown handles empty trace', () => {
    expect(formatTraceAsMarkdown([])).toMatch(/no routing decisions/i);
    expect(formatTraceAsMarkdown(null)).toMatch(/no routing decisions/i);
  });

  it('normalizeTrace recovers a corrupted persisted trace', () => {
    const dirty = [
      { stage: 'template_active', from: null, to: 'codex', reason: 'ok' },
      'not an object',
      { stage: 'pattern_match' }, // missing reason — drop
      null,
      { stage: 'lane_policy', from: 'codex', to: 'ollama', reason: 'swap', rule: 'X' },
    ];
    const cleaned = normalizeTrace(dirty);
    expect(cleaned).toHaveLength(2);
    expect(cleaned[0].to).toBe('codex');
    expect(cleaned[1].rule).toBe('X');
  });

  it('normalizeTrace returns [] for non-array input', () => {
    expect(normalizeTrace(null)).toEqual([]);
    expect(normalizeTrace('not array')).toEqual([]);
    expect(normalizeTrace({ trace: [] })).toEqual([]);
  });
});
