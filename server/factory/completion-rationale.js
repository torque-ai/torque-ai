'use strict';

const HEURISTIC_PATTERNS = {
  already_in_place: [
    'already in place',
    'already present',
    'no changes needed',
    'no modifications required',
    'nothing to change',
    'change is already',
    'already satisfies',
    'already applied',
    'code already implements',
    'no changes were made',
  ],
  blocked: [
    'cannot proceed',
    'blocked by',
    'refusing to',
    'unable to locate',
    'permission denied',
    'read-only',
    'outside the worktree',
    'sandbox denied',
  ],
  precondition_missing: [
    'file does not exist',
    'no such file',
    'path not found',
    'module not found',
    'not initialized',
    'prerequisite',
  ],
};

function matchHeuristic(text) {
  const lower = String(text || '').toLowerCase();
  for (const [reason, patterns] of Object.entries(HEURISTIC_PATTERNS)) {
    for (const p of patterns) {
      if (lower.includes(p)) {
        return { reason, source: 'heuristic', confidence: 1.0 };
      }
    }
  }
  return null;
}

const VALID_REASONS = new Set(['already_in_place', 'blocked', 'precondition_missing', 'unknown']);

function buildLlmPrompt(tail) {
  return [
    'Classify this Codex stdout tail from a task that produced no file changes.',
    'Answer with one word from this set: already_in_place, blocked, precondition_missing, unknown.',
    'No other text.',
    '',
    'Tail:',
    '```',
    String(tail || '').slice(-1200),
    '```',
  ].join('\n');
}

function parseLlmResponse(text) {
  const m = String(text || '').trim().toLowerCase().match(/^([a-z_]+)/);
  if (!m) return 'unknown';
  const candidate = m[1];
  return VALID_REASONS.has(candidate) ? candidate : 'unknown';
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('llm_timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function invokeLlmFallback({ stdout_tail, llmRouter, timeoutMs }) {
  try {
    const prompt = buildLlmPrompt(stdout_tail);
    const raw = await withTimeout(Promise.resolve(llmRouter(prompt)), timeoutMs);
    const reason = parseLlmResponse(raw);
    return { reason, source: 'llm', confidence: 0.7 };
  } catch {
    return { reason: 'unknown', source: 'llm', confidence: 0 };
  }
}

async function classifyZeroDiff({
  stdout_tail = '',
  attempt = 1,
  llmRouter = null,
  timeoutMs = 30000,
} = {}) {
  const fallback = { reason: 'unknown', source: 'none', confidence: 0 };
  try {
    const heuristic = matchHeuristic(stdout_tail);
    let result = heuristic;

    if (!result && typeof llmRouter === 'function') {
      result = await invokeLlmFallback({ stdout_tail, llmRouter, timeoutMs });
    }

    if (!result) result = fallback;

    if (result.reason === 'already_in_place' && attempt > 1) {
      return { ...result, confidence: 0 };
    }
    return result;
  } catch {
    return fallback;
  }
}

module.exports = {
  classifyZeroDiff, matchHeuristic, HEURISTIC_PATTERNS,
  parseLlmResponse, buildLlmPrompt,
};
