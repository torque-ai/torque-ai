'use strict';

const UNKNOWN_CLASSIFICATION = Object.freeze({
  category: 'unknown',
  matched_rule: null,
  confidence: 0,
  suggested_strategies: ['retry', 'escalate'],
});

function getOutcomePath(outcome, pathStr) {
  if (!outcome || !pathStr) return null;
  let cur = outcome;
  for (const p of String(pathStr).split('.')) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur == null ? null : String(cur);
}

function matchDeclarative(rule, decision) {
  const m = rule.match || {};
  if (m.stage && decision.stage !== m.stage) return false;
  if (m.action && decision.action !== m.action) return false;
  if (m.reasoning_regex) {
    const re = new RegExp(m.reasoning_regex);
    if (!decision.reasoning || !re.test(decision.reasoning)) return false;
  }
  if (m.outcome_regex) {
    const target = m.outcome_path
      ? getOutcomePath(decision.outcome, m.outcome_path)
      : JSON.stringify(decision.outcome || {});
    if (target == null) return false;
    if (!new RegExp(m.outcome_regex, 'i').test(target)) return false;
  }
  return true;
}

function ruleMatches(rule, decision) {
  if (!rule || typeof rule !== 'object') return false;
  if (!rule.name || !rule.category) return false;
  if (typeof rule.match_fn === 'function') {
    try { return !!rule.match_fn(decision); } catch { return false; }
  }
  if (!rule.match || typeof rule.match !== 'object') return false;
  return matchDeclarative(rule, decision);
}

function createClassifier({ rules }) {
  const sorted = Array.isArray(rules)
    ? [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0))
    : [];

  function classify(decision) {
    if (!decision || typeof decision !== 'object') return UNKNOWN_CLASSIFICATION;
    for (const rule of sorted) {
      if (ruleMatches(rule, decision)) {
        return {
          category: rule.category,
          matched_rule: rule.name,
          confidence: typeof rule.confidence === 'number' ? rule.confidence : 0.5,
          suggested_strategies: Array.isArray(rule.suggested_strategies)
            ? [...rule.suggested_strategies]
            : ['retry', 'escalate'],
        };
      }
    }
    return UNKNOWN_CLASSIFICATION;
  }

  return { classify };
}

module.exports = { createClassifier, UNKNOWN_CLASSIFICATION };
