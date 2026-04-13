'use strict';

const DEFAULT_TIMEOUT_MINUTES = 5;
const DEFAULT_GENERATOR_PROVIDER = 'codex';

const REVIEWER_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'Claude CLI',
    provider: 'claude-cli',
    model: null,
    requires_enabled: true,
    requires_api_key: true,
  }),
  Object.freeze({
    name: 'Anthropic API',
    provider: 'anthropic',
    model: null,
    requires_enabled: false,
    requires_api_key: true,
  }),
  Object.freeze({
    name: 'DeepInfra Qwen 72B',
    provider: 'deepinfra',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    requires_enabled: true,
    requires_api_key: true,
  }),
]);

function normalizeString(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : '';
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizeProviderHealthEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      provider: normalizeString(entry.provider || entry.name),
      enabled: normalizeBoolean(entry.enabled, false),
      healthy: normalizeBoolean(entry.healthy, true),
      api_key_configured: normalizeBoolean(
        entry.api_key_configured ?? entry.apiKeyConfigured,
        false,
      ),
    }))
    .filter((entry) => entry.provider);
}

function selectReviewers(providerHealth, generatorProvider = DEFAULT_GENERATOR_PROVIDER) {
  const generator = normalizeString(generatorProvider).toLowerCase() || DEFAULT_GENERATOR_PROVIDER;
  const healthByProvider = new Map(
    normalizeProviderHealthEntries(providerHealth).map((entry) => [entry.provider.toLowerCase(), entry]),
  );

  return REVIEWER_DEFINITIONS.filter((reviewer) => {
    if (reviewer.provider === generator) {
      return false;
    }

    const health = healthByProvider.get(reviewer.provider);
    if (!health) {
      return false;
    }

    if (reviewer.requires_enabled && !health.enabled) {
      return false;
    }

    if (reviewer.requires_api_key && !health.api_key_configured) {
      return false;
    }

    return true;
  });
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeString(value))
    .filter(Boolean);
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const normalized = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function normalizeVerdict(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'approve' || normalized === 'request_changes' || normalized === 'block') {
    return normalized;
  }
  return 'request_changes';
}

function extractJsonObject(text) {
  const trimmed = normalizeString(text);
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    candidates.push(objectMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function buildPlanReviewPrompt({ workItem, planContent }) {
  const title = normalizeString(workItem?.title) || 'Untitled work item';
  const description = normalizeString(workItem?.description) || '(no description provided)';

  return [
    'You are reviewing an implementation plan before execution.',
    'Return ONLY valid JSON with this exact shape:',
    '{"verdict":"approve|request_changes|block","concerns":["..."],"suggestions":["..."],"confidence":0}',
    '',
    'Verdict guidance:',
    '- approve: the plan is coherent, grounded, and safe to execute as written.',
    '- request_changes: there are concerns or missing details, but execution could proceed with caution.',
    '- block: the plan is unsafe, hallucinated, or likely to land incorrect code.',
    '',
    'Review for scope drift, hallucinated files/APIs, missing validation/tests, unsafe assumptions, and sequencing risks.',
    '',
    `Work item title: ${title}`,
    'Work item description:',
    description,
    '',
    'Plan markdown:',
    planContent,
  ].join('\n');
}

function createFallbackReview(reviewer, taskId, reason) {
  return {
    name: reviewer.name,
    provider: reviewer.provider,
    model: reviewer.model || null,
    task_id: taskId || null,
    verdict: 'request_changes',
    concerns: ['reviewer_unavailable'],
    suggestions: [],
    confidence: 0,
    reason: 'reviewer_unavailable',
    error: normalizeString(reason) || null,
  };
}

function normalizeParsedReview(reviewer, taskId, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      name: reviewer.name,
      provider: reviewer.provider,
      model: reviewer.model || null,
      task_id: taskId || null,
      verdict: 'request_changes',
      concerns: ['invalid_review_response'],
      suggestions: [],
      confidence: 0,
      reason: 'invalid_review_response',
      error: 'reviewer did not return a valid JSON object',
    };
  }

  return {
    name: reviewer.name,
    provider: reviewer.provider,
    model: reviewer.model || null,
    task_id: taskId || null,
    verdict: normalizeVerdict(parsed.verdict),
    concerns: normalizeStringList(parsed.concerns),
    suggestions: normalizeStringList(parsed.suggestions),
    confidence: normalizeConfidence(parsed.confidence),
    reason: null,
    error: null,
  };
}

function aggregateOverall(reviews) {
  if (reviews.some((review) => review.verdict === 'block')) {
    return 'block';
  }

  if (reviews.some((review) => review.verdict === 'request_changes')) {
    return 'request_changes';
  }

  return 'approve';
}

async function submitReviewTasks({ reviewers, prompt, submit, workItem }) {
  return Promise.all(reviewers.map(async (reviewer) => {
    try {
      const result = await submit({
        task: prompt,
        provider: reviewer.provider,
        model: reviewer.model || undefined,
        timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
        version_intent: 'internal',
        tags: [
          'factory:internal',
          'factory:plan_review',
          `factory:project_id=${workItem?.project_id ?? 'unknown'}`,
          `factory:work_item_id=${workItem?.id ?? 'unknown'}`,
        ],
        task_metadata: {
          factory_internal: true,
          factory_plan_review: true,
          project_id: workItem?.project_id ?? null,
          work_item_id: workItem?.id ?? null,
          reviewer_provider: reviewer.provider,
          reviewer_name: reviewer.name,
        },
      });

      const taskId = normalizeString(result?.task_id);
      if (!taskId) {
        throw new Error(result?.content?.[0]?.text || 'plan review submission did not return task_id');
      }

      return {
        reviewer,
        task_id: taskId,
        error: null,
      };
    } catch (error) {
      return {
        reviewer,
        task_id: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

async function awaitSubmittedReview({ reviewer, task_id, error }, awaitTask) {
  if (error || !task_id) {
    return createFallbackReview(reviewer, task_id, error);
  }

  try {
    const result = await awaitTask({
      task_id,
      timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
    });

    if (result?.status !== 'completed') {
      return createFallbackReview(
        reviewer,
        task_id,
        result?.error || `review task ${task_id} did not complete successfully`,
      );
    }

    const parsed = extractJsonObject(result?.output || result?.text || '');
    return normalizeParsedReview(reviewer, task_id, parsed);
  } catch (awaitError) {
    return createFallbackReview(
      reviewer,
      task_id,
      awaitError instanceof Error ? awaitError.message : String(awaitError),
    );
  }
}

function createPlanReviewer({ submit, awaitTask, getProvidersHealth } = {}) {
  if (typeof submit !== 'function') {
    throw new TypeError('submit is required');
  }
  if (typeof awaitTask !== 'function') {
    throw new TypeError('awaitTask is required');
  }

  return {
    async review({ workItem, planContent }) {
      const providerHealth = typeof getProvidersHealth === 'function'
        ? await Promise.resolve(getProvidersHealth())
        : [];
      const generatorProvider = normalizeString(
        workItem?.origin?.plan_generator_provider
        || workItem?.origin?.generator
        || DEFAULT_GENERATOR_PROVIDER,
      ) || DEFAULT_GENERATOR_PROVIDER;
      const reviewers = selectReviewers(providerHealth, generatorProvider);

      if (reviewers.length === 0) {
        return {
          overall: 'approve',
          reviews: [],
          skipped: true,
        };
      }

      const prompt = buildPlanReviewPrompt({ workItem, planContent: String(planContent || '') });
      const submittedReviews = await submitReviewTasks({
        reviewers,
        prompt,
        submit,
        workItem,
      });
      const reviews = await Promise.all(
        submittedReviews.map((entry) => awaitSubmittedReview(entry, awaitTask)),
      );

      return {
        overall: aggregateOverall(reviews),
        reviews,
        skipped: false,
      };
    },
  };
}

module.exports = {
  buildPlanReviewPrompt,
  createPlanReviewer,
  selectReviewers,
};
