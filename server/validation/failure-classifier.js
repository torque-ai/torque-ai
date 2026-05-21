'use strict';

const RULES = [
  {
    class: 'canceled',
    confidence: 0.95,
    pattern: /\b(cancelled|canceled|aborted|user interrupt|SIGINT)\b/i,
  },
  {
    class: 'budget_exhausted',
    confidence: 0.95,
    pattern: /\b(rate limit|quota|insufficient[_\s-]?quota|token limit|context length|too many requests)\b|(?:\b(?:HTTP[/\s]*|status[:\s]*|error[:\s]*)429\b|\(429\)|\b429\b.{0,80}\b(?:too many requests|rate limit|quota)\b|\b(?:too many requests|rate limit|quota)\b.{0,80}\b429\b)/i,
  },
  {
    class: 'transient_infra',
    confidence: 0.85,
    pattern: /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout|timed out|network|temporar(?:y|ily)|5\d\d)\b/i,
  },
  {
    class: 'structural',
    confidence: 0.8,
    pattern: /\b(SyntaxError|TypeError|ReferenceError|module not found|cannot find module|parse error|schema|invalid json)\b/i,
  },
  {
    class: 'deterministic',
    confidence: 0.75,
    pattern: /\b(AssertionError|test failed|expect\(.*\)|vitest|jest|pytest|exit code 1|verification failed)\b/i,
  },
];

function textFromInput(input = {}) {
  if (typeof input === 'string') return input;
  const parts = [];
  for (const key of ['output', 'error_output', 'errorOutput', 'message', 'validation']) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    parts.push(typeof value === 'string' ? value : JSON.stringify(value));
  }
  return parts.join('\n');
}

function classifyFailure(input = {}) {
  const text = textFromInput(input);
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match) {
      return {
        class: rule.class,
        matched_pattern: match[0],
        confidence: rule.confidence,
      };
    }
  }
  return {
    class: 'unknown',
    matched_pattern: null,
    confidence: 0.25,
  };
}

module.exports = {
  RULES,
  classifyFailure,
};
