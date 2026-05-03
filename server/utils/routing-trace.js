'use strict';

/**
 * Routing decision trace.
 *
 * The routing pipeline runs through ~11 layered stages, any of which can
 * override the prior provider choice. Historically the only audit trail
 * was a single `routing_reason` string at submit time, which made
 * "who moved my task and why?" effectively unanswerable when more than
 * one stage acted.
 *
 * This module produces a structured trace — an ordered list of the
 * stages that actually changed the selection, plus the final provider
 * — and stores it on task metadata under `routing_decision_trace`.
 *
 * Each entry carries:
 *   stage  : machine-readable stage name (see KNOWN_STAGES)
 *   from   : provider before this step (null on the first step)
 *   to     : provider after this step (may equal `from` for null-overrides)
 *   reason : human-readable explanation
 *   rule?  : optional rule / template name
 *
 * Rules of the road:
 *   - createTrace() returns a fresh array; pass it through the pipeline.
 *   - Stages that DON'T change the provider should still record a step
 *     when they evaluated and explicitly chose to keep the current
 *     selection (e.g. "lane_policy: codex allowed, no swap"). Stages
 *     that aren't even reached should NOT record anything.
 *   - The trace is a flat array, not nested. Order = call order.
 *   - At submit time, the trace lives on the task row in metadata; the
 *     dashboard renders it as a vertical timeline at the top of the
 *     task detail drawer.
 *
 * The helper is pure and synchronous. No I/O.
 */

// Canonical stage names. Keep in sync with the dashboard's
// formatRoutingTraceStage() so unknown labels can still render
// gracefully.
const KNOWN_STAGES = Object.freeze({
  TEMPLATE_PER_TASK: 'template_per_task',
  TEMPLATE_ACTIVE: 'template_active',
  TEMPLATE_LEGACY_FALLBACK: 'template_legacy_fallback',
  PATTERN_MATCH: 'pattern_match',
  COMPLEXITY: 'complexity',
  LEGACY_RULE: 'legacy_rule',
  DEFAULT_PROVIDER: 'default_provider',
  MODIFICATION: 'modification',
  TEST_TASK: 'test_task',
  CODEX_EXHAUSTED: 'codex_exhausted',
  HEALTH_GATE: 'health_gate',
  LANE_POLICY: 'lane_policy',
  USER_OVERRIDE: 'user_override',
  FALLBACK: 'fallback',
});

const VALID_STAGE_VALUES = new Set(Object.values(KNOWN_STAGES));
const MAX_TRACE_ENTRIES = 64; // safety bound — pipeline is ~11 stages, anything over that is a runaway loop
const MAX_REASON_LENGTH = 500;

/**
 * Create a fresh trace array.
 * @returns {Array<RoutingDecisionEntry>}
 */
function createTrace() {
  return [];
}

/**
 * Append a decision entry to the trace.
 *
 * @param {Array} trace - the trace array (mutated)
 * @param {object} entry
 * @param {string} entry.stage - canonical stage name (see KNOWN_STAGES)
 * @param {string|null} [entry.from] - provider before this step (null for first)
 * @param {string|null} entry.to - provider after this step
 * @param {string} entry.reason - human-readable reason
 * @param {string|null} [entry.rule] - optional rule / template name
 * @returns {boolean} true if recorded, false if dropped (invalid input or bound exceeded)
 */
function recordRoutingDecision(trace, entry) {
  if (!Array.isArray(trace)) return false;
  if (trace.length >= MAX_TRACE_ENTRIES) return false;
  if (!entry || typeof entry !== 'object') return false;

  const stage = typeof entry.stage === 'string' ? entry.stage : null;
  if (!stage) return false;
  // Unknown stages are accepted (so plugins / future code can extend
  // the set without coordinating here), but we tag them so the
  // dashboard can render them as "(unknown stage)".
  const isKnown = VALID_STAGE_VALUES.has(stage);

  const reason = typeof entry.reason === 'string'
    ? entry.reason.slice(0, MAX_REASON_LENGTH)
    : null;
  if (!reason) return false;

  const normalized = {
    stage,
    from: entry.from == null ? null : String(entry.from),
    to: entry.to == null ? null : String(entry.to),
    reason,
  };
  if (entry.rule != null) {
    normalized.rule = String(entry.rule);
  }
  if (!isKnown) {
    normalized._unknown_stage = true;
  }
  trace.push(normalized);
  return true;
}

/**
 * Whether a trace's last entry's `to` matches a provider — useful for
 * stages that want to know "what's the current selection?" without
 * grepping through the array.
 *
 * @param {Array} trace
 * @returns {string|null} the most recent `to` provider, or null if empty
 */
function getCurrentProvider(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return null;
  return trace[trace.length - 1].to || null;
}

/**
 * Render a trace as a compact, human-readable string for embedding in
 * markdown (e.g. the get_result text response).
 *
 * @param {Array} trace
 * @returns {string} multiline string, one entry per line
 */
function formatTraceAsMarkdown(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return '(no routing decisions recorded)';
  return trace.map((entry, idx) => {
    const arrow = entry.from && entry.to && entry.from !== entry.to
      ? `${entry.from} → ${entry.to}`
      : (entry.to || '(no provider)');
    const ruleSuffix = entry.rule ? ` [${entry.rule}]` : '';
    return `${idx + 1}. **${entry.stage}** — ${arrow}: ${entry.reason}${ruleSuffix}`;
  }).join('\n');
}

/**
 * Validate a trace shape (e.g. when reading back from persisted
 * metadata that may have been corrupted). Returns the trace if valid,
 * or an empty array otherwise.
 *
 * @param {*} candidate
 * @returns {Array}
 */
function normalizeTrace(candidate) {
  if (!Array.isArray(candidate)) return [];
  const out = [];
  for (const entry of candidate) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.stage !== 'string' || typeof entry.reason !== 'string') continue;
    out.push({
      stage: entry.stage,
      from: entry.from == null ? null : String(entry.from),
      to: entry.to == null ? null : String(entry.to),
      reason: entry.reason,
      ...(entry.rule != null ? { rule: String(entry.rule) } : {}),
      ...(entry._unknown_stage ? { _unknown_stage: true } : {}),
    });
    if (out.length >= MAX_TRACE_ENTRIES) break;
  }
  return out;
}

module.exports = {
  KNOWN_STAGES,
  MAX_TRACE_ENTRIES,
  MAX_REASON_LENGTH,
  createTrace,
  recordRoutingDecision,
  getCurrentProvider,
  formatTraceAsMarkdown,
  normalizeTrace,
};
