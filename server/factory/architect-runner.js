'use strict';

const fs = require('node:fs');
const path = require('node:path');

const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryArchitect = require('../db/factory-architect');
const { buildArchitectPrompt } = require('./architect-prompt');
const { lintPlanContent } = require('./plan-lint');
const { createScoutFindingsIntake } = require('./scout-findings-intake');
const { guardIntakeItem } = require('./meta-intake-guard');
const { composeGuide } = require('./plan-authoring-guide');
const {
  createSharedFactoryStore,
  deriveVerifyFailurePattern,
  normalizeVerifyFailureCategories,
  DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
  SHARED_FACTORY_DB_ENV,
} = require('../db/shared-factory-store');
const logger = require('../logger').child({ component: 'architect-runner' });
const CLOSED_WORK_ITEM_STATUSES = new Set(['completed', 'rejected', 'shipped']);
const PRIORITIZABLE_WORK_ITEM_STATUSES = new Set([
  'pending',
  'triaged',
  'in_progress',
  'intake',
  'prioritized',
  'planned',
  'executing',
  'verifying',
]);

// Items created through the DB store priority as INTEGER (see migration v14);
// unit-test fixtures and legacy callers may still pass the string form.
// Accept both to keep architect prioritization consistent across call paths.
const USER_OVERRIDE_NUMERIC = 100;
function isUserOverridePriority(item) {
  if (!item) return false;
  const { priority } = item;
  return priority === 'user_override' || priority === USER_OVERRIDE_NUMERIC;
}

const VERIFY_LEARNING_MIN_CONFIDENCE = 0.35;
const VERIFY_LEARNING_MIN_SAMPLES = 1;
const VERIFY_LEARNING_MAX_PENALTY = 5;
const GENERIC_VERIFY_FAILURE_CATEGORIES = new Set([
  'generic_verify_failure',
  'test_verify_failure',
  'dotnet_verify_failure',
  'node_verify_failure',
]);

let sharedFactoryStore = null;
let ownedSharedFactoryStore = null;

const DIMENSION_KEYWORDS = {
  structural: ['structural', 'architecture', 'architectural', 'module', 'modules', 'layer', 'layers', 'boundary', 'boundaries', 'coupling'],
  test_coverage: ['test', 'tests', 'coverage', 'unit test', 'integration test', 'regression', 'qa'],
  security: ['security', 'auth', 'authentication', 'authorization', 'permission', 'permissions', 'secret', 'secrets', 'vulnerability', 'csrf', 'xss'],
  user_facing: ['user', 'users', 'user facing', 'ux', 'ui', 'onboarding', 'experience', 'workflow', 'screen', 'screens'],
  api_completeness: ['api', 'apis', 'endpoint', 'endpoints', 'contract', 'contracts', 'schema', 'schemas', 'payload', 'interface'],
  documentation: ['docs', 'doc', 'documentation', 'readme', 'guide', 'guides', 'runbook'],
  dependency_health: ['dependency', 'dependencies', 'package', 'packages', 'upgrade', 'upgrades', 'version', 'versions', 'library', 'libraries'],
  build_ci: ['build', 'ci', 'pipeline', 'pipelines', 'lint', 'workflow', 'workflows', 'github actions', 'compile'],
  performance: ['performance', 'slow', 'latency', 'throughput', 'optimize', 'optimization', 'cache', 'caching', 'speed'],
  debt_ratio: ['debt', 'cleanup', 'clean up', 'simplify', 'simplification', 'maintainability', 'legacy'],
};

const SCOPE_BUDGET_RULES = [
  { budget: 8, keywords: ['refactor', 'rewrite', 'overhaul'] },
  { budget: 3, keywords: ['fix', 'bug'] },
  { budget: 5, keywords: ['add', 'feature', 'new'] },
];

function loadPlanAuthoringGuide(projectPath) {
  if (!projectPath) {
    return '';
  }

  const projectGuidePath = path.join(projectPath, 'docs', 'plan-authoring.md');
  try {
    return fs.readFileSync(projectGuidePath, 'utf8').trim();
  } catch {}

  try {
    if (fs.existsSync(path.join(projectPath, 'server', 'factory'))) {
      const torqueGuidePath = path.join(__dirname, '..', '..', 'docs', 'superpowers', 'plan-authoring.md');
      return fs.readFileSync(torqueGuidePath, 'utf8').trim();
    }
  } catch {}

  return '';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function injectPlanAuthoringGuide(prompt, guide) {
  if (!guide) {
    return prompt;
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return guide;
  }
  return `${guide}\n\n---\n\n${prompt}`;
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function formatDimensionLabel(dimension) {
  return String(dimension || '')
    .replace(/[_-]+/g, ' ')
    .trim() || 'unknown dimension';
}

function normalizeHealthScores(healthScores) {
  if (Array.isArray(healthScores)) {
    return healthScores
      .filter((entry) => isRecord(entry) && entry.dimension)
      .map((entry) => ({ dimension: String(entry.dimension), score: entry.score }));
  }

  if (healthScores == null) {
    return [];
  }

  if (isRecord(healthScores)) {
    return Object.entries(healthScores).map(([dimension, score]) => ({ dimension, score }));
  }

  throw new TypeError('healthScores must be an array, object map, or null');
}

function normalizeIntakeItems(intakeItems) {
  if (Array.isArray(intakeItems)) {
    return intakeItems.slice();
  }

  if (intakeItems == null) {
    return [];
  }

  if (isRecord(intakeItems) && Array.isArray(intakeItems.items)) {
    return intakeItems.items.slice();
  }

  throw new TypeError('intakeItems must be an array, { items: [] }, or null');
}

function getSortedWeakDimensions(healthScores) {
  return normalizeHealthScores(healthScores)
    .map((entry) => ({
      dimension: entry.dimension,
      score: toFiniteNumber(entry.score),
    }))
    .sort((left, right) => {
      const leftScore = left.score === null ? Number.POSITIVE_INFINITY : left.score;
      const rightScore = right.score === null ? Number.POSITIVE_INFINITY : right.score;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return left.dimension.localeCompare(right.dimension);
    });
}

function getDimensionKeywords(dimension) {
  const dimensionKey = String(dimension || '').trim();
  const label = formatDimensionLabel(dimensionKey);
  return uniqueStrings([
    ...(DIMENSION_KEYWORDS[dimensionKey] || []),
    dimensionKey,
    label,
    ...label.split(' '),
  ]);
}

function getItemSearchText(item) {
  return normalizeText([
    item && typeof item.title === 'string' ? item.title : '',
    item && typeof item.description === 'string' ? item.description : '',
  ].join(' '));
}

function includesKeyword(searchText, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return false;
  }

  return ` ${searchText} `.includes(` ${normalizedKeyword} `);
}

function parsePayloadJson(row) {
  if (!row || typeof row.payload_json !== 'string') return {};
  try {
    const parsed = JSON.parse(row.payload_json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeVerifyLearningRow(row) {
  if (!isRecord(row) || row.signal_type !== DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE) {
    return null;
  }
  const payload = parsePayloadJson(row);
  const categories = normalizeVerifyFailureCategories([
    ...(Array.isArray(payload.failure_categories) ? payload.failure_categories : []),
    payload.failure_category,
    payload.primary_category,
  ]);
  const confidence = toFiniteNumber(row.confidence) ?? 0;
  const sampleCount = toFiniteNumber(row.sample_count) ?? 0;

  return {
    id: row.id || null,
    signal_type: row.signal_type,
    scope_key: row.scope_key || null,
    provider: row.provider || null,
    tech_stack: row.tech_stack || payload.tech_stack || null,
    failure_pattern: row.failure_pattern || null,
    pattern_hash: payload.pattern_hash || row.failure_pattern || null,
    normalized_pattern: payload.normalized_pattern || null,
    categories,
    primary_category: categories[0] || null,
    confidence,
    sample_count: sampleCount,
    project_source: row.project_source || null,
  };
}

function setSharedFactoryStore(store) {
  sharedFactoryStore = store || null;
}

function getSharedFactoryStore() {
  if (sharedFactoryStore) return sharedFactoryStore;

  try {
    const { defaultContainer } = require('../container');
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && typeof defaultContainer.get === 'function'
      && defaultContainer.has('sharedFactoryStore')
    ) {
      return defaultContainer.get('sharedFactoryStore');
    }
  } catch (_err) {
    // Container may be unavailable or not booted in isolated tests.
  }

  if (ownedSharedFactoryStore) return ownedSharedFactoryStore;
  if (!process.env[SHARED_FACTORY_DB_ENV]) return null;

  try {
    ownedSharedFactoryStore = createSharedFactoryStore();
    return ownedSharedFactoryStore;
  } catch (_err) {
    return null;
  }
}

function loadActiveVerifyFailureLearnings(options = {}) {
  const store = options.sharedFactoryStore || getSharedFactoryStore();
  if (!store || typeof store.listLearnings !== 'function') return [];

  let rows;
  try {
    rows = store.listLearnings({
      signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
      minConfidence: VERIFY_LEARNING_MIN_CONFIDENCE,
      now: options.now,
      limit: options.limit || 50,
    });
  } catch (err) {
    logger.debug(`Could not load shared verify-failure learnings: ${err.message}`);
    return [];
  }

  return (Array.isArray(rows) ? rows : [])
    .map(normalizeVerifyLearningRow)
    .filter((learning) => (
      learning
      && learning.categories.length > 0
      && learning.confidence >= VERIFY_LEARNING_MIN_CONFIDENCE
      && learning.sample_count >= VERIFY_LEARNING_MIN_SAMPLES
    ));
}

function hasSpecificCategoryOverlap(leftCategories, rightCategories) {
  const right = new Set(rightCategories);
  return leftCategories.some((category) => (
    right.has(category) && !GENERIC_VERIFY_FAILURE_CATEGORIES.has(category)
  ));
}

function computeLearningPenalty(learning) {
  const confidence = Math.max(0, Math.min(1, Number(learning?.confidence) || 0));
  const sampleCount = Math.max(1, Math.trunc(Number(learning?.sample_count) || 1));
  const confidencePenalty = Math.max(1, Math.ceil(confidence * 3));
  const samplePenalty = sampleCount >= 5 ? 2 : (sampleCount >= 2 ? 1 : 0);
  return Math.min(VERIFY_LEARNING_MAX_PENALTY, confidencePenalty + samplePenalty);
}

function getLearningPenaltyMatch(item, sharedLearnings, project) {
  if (!Array.isArray(sharedLearnings) || sharedLearnings.length === 0) return null;
  const pattern = deriveVerifyFailurePattern({
    title: item && typeof item.title === 'string' ? item.title : '',
    description: item && typeof item.description === 'string'
      ? item.description
      : (item && typeof item.why === 'string' ? item.why : ''),
    workingDirectory: project && typeof project.path === 'string' ? project.path : '',
    metadata: item && isRecord(item) ? {
      constraints: item.constraints || item.constraints_json || null,
      origin: item.origin || item.origin_json || null,
    } : {},
  });
  if (!pattern || !Array.isArray(pattern.categories) || pattern.categories.length === 0) {
    return null;
  }

  const matches = [];
  for (const learning of sharedLearnings) {
    if (!learning) continue;
    const learningStack = learning.tech_stack || null;
    const itemStack = pattern.tech_stack || null;
    if (learningStack && itemStack && learningStack !== itemStack) continue;

    const sameHash = learning.pattern_hash && pattern.pattern_hash && learning.pattern_hash === pattern.pattern_hash;
    const specificOverlap = hasSpecificCategoryOverlap(pattern.categories, learning.categories);
    if (!sameHash && !specificOverlap) continue;

    matches.push({
      ...learning,
      matched_categories: learning.categories.filter((category) => pattern.categories.includes(category)),
      penalty: computeLearningPenalty(learning),
    });
  }

  if (matches.length === 0) return null;
  const penalty = Math.min(
    VERIFY_LEARNING_MAX_PENALTY,
    matches.reduce((total, match) => total + match.penalty, 0),
  );
  const matchedCategories = normalizeVerifyFailureCategories(matches.flatMap((match) => match.matched_categories));
  const strongest = matches
    .slice()
    .sort((left, right) => right.confidence - left.confidence || right.sample_count - left.sample_count)[0];

  return {
    penalty,
    categories: matchedCategories.length > 0 ? matchedCategories : normalizeVerifyFailureCategories(matches.flatMap((match) => match.categories)),
    strongest,
    matches,
  };
}

function formatLearningPenaltyNote(learningMatch) {
  if (!learningMatch || !learningMatch.penalty) return '';
  const category = learningMatch.categories[0] || learningMatch.strongest?.primary_category || 'verify_failure_pattern';
  const provider = learningMatch.strongest?.provider ? ` provider ${learningMatch.strongest.provider}` : '';
  const source = learningMatch.strongest?.project_source ? ` from ${learningMatch.strongest.project_source}` : '';
  const confidence = Number.isFinite(learningMatch.strongest?.confidence)
    ? ` confidence ${learningMatch.strongest.confidence.toFixed(2)}`
    : '';
  return `Shared verify-failure learning penalty ${learningMatch.penalty} applied for ${category}${provider}${source}${confidence}.`;
}

function getWeakDimensionMatch(item, weakDimensions) {
  const searchText = getItemSearchText(item);
  if (!searchText) {
    return null;
  }

  for (let index = 0; index < weakDimensions.length; index += 1) {
    const weakDimension = weakDimensions[index];
    const keywords = getDimensionKeywords(weakDimension.dimension);
    if (keywords.some((keyword) => includesKeyword(searchText, keyword))) {
      return {
        dimension: weakDimension.dimension,
        score: weakDimension.score,
        rank: index,
      };
    }
  }

  return null;
}

function getCreatedAtValue(item) {
  const createdAt = item && item.created_at ? Date.parse(item.created_at) : Number.NaN;
  return Number.isFinite(createdAt) ? createdAt : Number.POSITIVE_INFINITY;
}

function inferScopeBudget(item) {
  const searchText = getItemSearchText(item);
  for (const rule of SCOPE_BUDGET_RULES) {
    if (rule.keywords.some((keyword) => includesKeyword(searchText, keyword))) {
      return rule.budget;
    }
  }
  return 5;
}

function buildWhy(item, match, weakDimensions, learningMatch = null) {
  const reasons = [];

  if (isUserOverridePriority(item)) {
    reasons.push('User override priority takes precedence.');
  }

  if (match) {
    const weakestDimension = weakDimensions[0] ? weakDimensions[0].dimension : null;
    if (weakestDimension && weakestDimension === match.dimension) {
      reasons.push(`Aligned to weakest health dimension ${formatDimensionLabel(match.dimension)}.`);
    } else {
      reasons.push(`Aligned to weak health dimension ${formatDimensionLabel(match.dimension)}.`);
    }
  } else if (weakDimensions.length > 0) {
    reasons.push('No direct weak-dimension keyword match; ordered by age after stronger signals.');
  } else {
    reasons.push('No health scores available; ordered by override status and age.');
  }

  const learningNote = formatLearningPenaltyNote(learningMatch);
  if (learningNote) {
    reasons.push(learningNote);
  }

  return reasons.join(' ');
}

function createBacklogEntry(item, match, weakDimensions, priorityRank, learningMatch = null) {
  const learningPenalty = learningMatch?.penalty || 0;
  return {
    work_item_id: item && item.id ? item.id : null,
    title: item && typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : `Work item ${priorityRank}`,
    why: buildWhy(item, match, weakDimensions, learningMatch),
    expected_impact: match ? { [match.dimension]: 'targeted' } : {},
    scope_budget: inferScopeBudget(item),
    learning_penalty: learningPenalty,
    learning_categories: learningPenalty > 0 ? learningMatch.categories : [],
    priority_rank: priorityRank,
  };
}

function prioritizeByHealth(intakeItems, healthScores, options = {}) {
  if (!Array.isArray(intakeItems)) {
    throw new TypeError('intakeItems must be an array');
  }

  const weakDimensions = getSortedWeakDimensions(healthScores);
  const sharedLearnings = Array.isArray(options.sharedLearnings)
    ? options.sharedLearnings
      .map((learning) => (learning && Array.isArray(learning.categories) ? learning : normalizeVerifyLearningRow(learning)))
      .filter(Boolean)
    : [];
  const project = isRecord(options.project) ? options.project : null;
  const rankedItems = intakeItems.map((item, index) => {
    const match = getWeakDimensionMatch(item, weakDimensions);
    const learningMatch = getLearningPenaltyMatch(item, sharedLearnings, project);
    return {
      item,
      index,
      isUserOverride: isUserOverridePriority(item),
      learningPenalty: learningMatch?.penalty || 0,
      learningMatch,
      matchRank: match ? match.rank : Number.POSITIVE_INFINITY,
      match,
      createdAt: getCreatedAtValue(item),
      id: item && item.id ? String(item.id) : '',
      title: item && typeof item.title === 'string' ? item.title : '',
    };
  });

  rankedItems.sort((left, right) => {
    if (left.isUserOverride !== right.isUserOverride) {
      return left.isUserOverride ? -1 : 1;
    }

    if (left.learningPenalty !== right.learningPenalty) {
      return left.learningPenalty - right.learningPenalty;
    }

    if (left.matchRank !== right.matchRank) {
      return left.matchRank - right.matchRank;
    }

    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }

    const idComparison = left.id.localeCompare(right.id);
    if (idComparison !== 0) {
      return idComparison;
    }

    const titleComparison = left.title.localeCompare(right.title);
    if (titleComparison !== 0) {
      return titleComparison;
    }

    return left.index - right.index;
  });

  return rankedItems.map((entry, index) => (
    createBacklogEntry(entry.item, entry.match, weakDimensions, index + 1, entry.learningMatch)
  ));
}

function buildReasoning({ project, trigger, healthScores, intakeItems, backlog, prevCycle, sharedLearnings = [] }) {
  const weakDimensions = getSortedWeakDimensions(healthScores);
  const weakestSummary = weakDimensions.length > 0
    ? weakDimensions
      .slice(0, 3)
      .map((entry) => `${formatDimensionLabel(entry.dimension)} (${entry.score === null ? 'unknown' : entry.score})`)
      .join(', ')
    : 'none available';

  const prioritizedTitles = backlog
    .slice(0, 3)
    .map((entry) => entry.title)
    .join(', ') || 'none';

  const parts = [
    `Architect cycle for ${project.name || project.id || project.project_id || 'project'} triggered by ${trigger}.`,
    `Evaluated ${intakeItems.length} intake item(s) against ${healthScores.length} health dimension(s); weakest dimensions: ${weakestSummary}.`,
    'Ordering rules were deterministic: user_override items first, then active shared verify-failure learning penalties, then work aligned to weak-dimension keywords in title/description, then oldest created_at first.',
    `Generated ${backlog.length} prioritized backlog item(s); top entries: ${prioritizedTitles}.`,
  ];

  const penalized = backlog.filter((entry) => entry && Number(entry.learning_penalty) > 0);
  if (sharedLearnings.length > 0 && penalized.length === 0) {
    parts.push(`Loaded ${sharedLearnings.length} active shared verify-failure learning(s); none matched the current intake queue.`);
  } else if (penalized.length > 0) {
    const penaltySummary = penalized
      .slice(0, 3)
      .map((entry) => `${entry.title} (${(entry.learning_categories || []).join(', ') || 'verify_failure_pattern'} penalty ${entry.learning_penalty})`)
      .join('; ');
    parts.push(`Applied shared verify-failure learning penalties to ${penalized.length} item(s): ${penaltySummary}.`);
  }

  if (prevCycle) {
    parts.push(`Previous cycle ${prevCycle.id} was included as prompt context for continuity.`);
  }

  return parts.join(' ');
}

function annotateBacklogWithSharedLearningPenalties(backlog, sharedLearnings, project) {
  if (!Array.isArray(backlog) || !Array.isArray(sharedLearnings) || sharedLearnings.length === 0) {
    return Array.isArray(backlog) ? backlog : [];
  }

  return backlog.map((entry) => {
    if (!isRecord(entry)) return entry;
    const learningMatch = getLearningPenaltyMatch(entry, sharedLearnings, project);
    if (!learningMatch || !learningMatch.penalty) return entry;

    const learningNote = formatLearningPenaltyNote(learningMatch);
    const existingWhy = typeof entry.why === 'string' ? entry.why.trim() : '';
    const why = existingWhy.includes(learningNote)
      ? existingWhy
      : [existingWhy, learningNote].filter(Boolean).join(' ');
    return {
      ...entry,
      why,
      learning_penalty: learningMatch.penalty,
      learning_categories: learningMatch.categories,
    };
  });
}

function appendSharedLearningReasoning(reasoning, backlog, sharedLearnings) {
  const base = typeof reasoning === 'string' && reasoning.trim() ? reasoning.trim() : 'Architect backlog generated.';
  const penalized = Array.isArray(backlog)
    ? backlog.filter((entry) => entry && Number(entry.learning_penalty) > 0)
    : [];

  if (penalized.length > 0) {
    return `${base} Shared verify-failure learning penalties were attached to ${penalized.length} backlog item(s).`;
  }
  if (Array.isArray(sharedLearnings) && sharedLearnings.length > 0) {
    return `${base} Active shared verify-failure learnings were loaded but did not match the selected backlog.`;
  }
  return base;
}

/**
 * Submit the architect prompt to <git-user> and parse the JSON response.
 * Falls back to null if <git-user> is unavailable or response is unparseable.
 */
// Submit the architect prompt via smart routing. The classifier detects
// this as 'plan_generation' (structured text output, no file actions), and
// the active routing template picks an appropriate text-gen provider chain.
// Do NOT hardcode a provider here — that would violate the dispatch spirit
// and force this JSON-generation task onto action-agent providers.
async function runArchitectLLM(prompt, project_id, projectPath) {
  const taskCore = require('../db/task-core');
  const { submitFactoryInternalTask } = require('./internal-task-submit');

  const taskDescription = `You are the Architect for a software factory. Read the context below and return ONLY valid JSON output matching the specified format. No explanation outside the JSON.\n\n${prompt}`;

  let taskId;
  try {
    const { task_id } = await submitFactoryInternalTask({
      task: taskDescription,
      working_directory: projectPath,
      kind: 'architect_cycle',
      project_id,
      // 0 = no enforced wall-clock timeout. The architect-runner polls
      // until the task reaches a terminal state (completed/failed/cancelled)
      // or the row vanishes. Provider-layer stall detection (see
      // configure_stall_detection) is the bound on hung tasks; hardcoded
      // wall-clock budgets here previously killed viable codex work that
      // exceeded the inner timeout while the outer poll still had budget
      // (Phase T/W aligned the layers; 2026-05-02 confirmed the alignment
      // itself was the wrong shape — kill destruction, keep polling).
      timeout_minutes: 0,
    });
    taskId = task_id;
    if (!taskId) {
      logger.warn(`[architect-cycle] no_task_id project_id=${project_id}: submit returned without a task_id`);
      return null;
    }
  } catch (err) {
    logger.warn(`[architect-cycle] submit_failed project_id=${project_id}: ${err.message}`);
    return null;
  }

  // Poll until the task reaches a terminal state. No wall-clock deadline:
  // stall detection at the provider layer is what bounds hung tasks.
  while (true) {
    const task = taskCore.getTask(taskId);
    if (!task) {
      logger.warn(`[architect-cycle] task_vanished project_id=${project_id} task_id=${taskId}: task row not found mid-poll`);
      return null;
    }
    if (task.status === 'completed') {
      const output = task.output || '';
      try {
        // Extract JSON from output (may be wrapped in markdown code blocks)
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.backlog && Array.isArray(parsed.backlog)) {
            return parsed;
          }
        }
      } catch (parseErr) {
        logger.warn(`[architect-cycle] parse_failed project_id=${project_id} task_id=${taskId}: ${parseErr.message}`);
      }
      return null;
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      const errSnippet = (task.error_output || '').slice(-200);
      logger.warn(`[architect-cycle] task_${task.status} project_id=${project_id} task_id=${taskId} provider=${task.provider || '?'}: error_tail=${JSON.stringify(errSnippet)}`);
      return null;
    }
    // Brief wait before checking again
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

async function submitArchitectJsonPrompt(prompt, project_id, projectPath, kind = 'architect_json') {
  const taskCore = require('../db/task-core');
  const { submitFactoryInternalTask } = require('./internal-task-submit');

  const taskDescription = `You are the Architect for a software factory. Read the context below and return ONLY valid JSON output matching the specified format. No explanation outside the JSON.\n\n${prompt}`;
  const recoveryJsonTask = kind === 'replan_rewrite' || kind === 'replan_decompose' || kind === 'architect_json';

  // Phase Q (2026-04-30): every null-return path used to be silent except
  // submit_failed (which logged a single warn). Downstream parseStrictJson
  // would then throw "provider response was not a string" — completely
  // hiding which of the 5 distinct upstream failures actually triggered
  // the null. Tag each path with a structured warn so we can grep
  // "[architect-submit]" in logs and see the real distribution of
  // failure modes (DLPhone replan_recovery_strategy_failed at 03:29:15
  // motivated this).
  let taskId;
  try {
    const { task_id } = await submitFactoryInternalTask({
      task: taskDescription,
      working_directory: projectPath,
      kind,
      project_id,
      // Recovery JSON prompts (replan_rewrite / replan_decompose /
      // architect_json) already contain the full rejected item and prior
      // failure context — context-stuffing on top of that pushed Codex into
      // exploring the repo for a "JSON only" rewrite (2026-05-02 live).
      ...(recoveryJsonTask ? { context_stuff: false, study_context: false } : {}),
      // 0 = no enforced wall-clock timeout. Polling below bounds the wait
      // by terminal task state, not by an arbitrary minute count. Stall
      // detection is the safety net against hung tasks.
      timeout_minutes: 0,
    });
    taskId = task_id;
    if (!taskId) {
      logger.warn(`[architect-submit] no_task_id kind=${kind} project_id=${project_id}: submit returned without a task_id`);
      return null;
    }
  } catch (err) {
    logger.warn(`[architect-submit] submit_failed kind=${kind} project_id=${project_id}: ${err.message}`);
    return null;
  }

  // Poll until the task reaches a terminal state. No wall-clock deadline:
  // stall detection at the provider layer is what bounds hung tasks.
  while (true) {
    const task = taskCore.getTask(taskId);
    if (!task) {
      logger.warn(`[architect-submit] task_vanished kind=${kind} project_id=${project_id} task_id=${taskId}: task row not found mid-poll (cleaned up?)`);
      return null;
    }
    if (task.status === 'completed') return task.output || '';
    if (task.status === 'failed' || task.status === 'cancelled') {
      const errSnippet = (task.error_output || '').slice(-200);
      logger.warn(`[architect-submit] task_${task.status} kind=${kind} project_id=${project_id} task_id=${taskId} provider=${task.provider || '?'}: error_tail=${JSON.stringify(errSnippet)}`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

// Phase P (2026-04-30): map a reject_reason to actionable guidance the
// architect should use when rewriting the work item. Without this, the
// architect's rewrite prompt only sees a generic "Prior failure reason:
// X" line and tends to produce variations on the same broken plan
// instead of actually pivoting based on WHY the previous attempt failed.
//
// Patterns are evaluated in order; the first match wins. Returns an
// empty string when no specific guidance applies (the generic
// "rewrite to be specific" instructions still apply).
function getFailureModeGuidance(priorReason) {
  if (typeof priorReason !== 'string' || !priorReason.trim()) return '';
  const reason = priorReason.trim();

  // Phase N's pre-submission existence guard fired. The plan referenced
  // files that don't exist in the worktree.
  if (/^task_targets_missing_files/i.test(reason)) {
    return [
      '',
      'FAILURE-MODE GUIDANCE: The previous plan referenced files that do not exist in the factory worktree.',
      'When rewriting, do ONE of these:',
      '- Reframe as "Create file X with content Y" (greenfield) — make the create intent EXPLICIT in the description.',
      '- Identify the ACTUAL paths in the repo that contain this functionality. The phantom path was probably a guess; the real file may have a similar name (e.g. `Foo.cs` vs `FooImpl.cs`, or in a subdirectory).',
      '- Drop references to the phantom file entirely and rescope to a related file that does exist.',
      'Do NOT keep the same phantom path — the worker will fail again with the same error.',
    ].join('\n');
  }

  // The heavy-local-validation guard fired. Plan tried to run dotnet
  // test / pytest / etc. inline in a step instead of letting the host's
  // verify_command handle it.
  if (/^task_avoids_local_heavy_validation/i.test(reason)) {
    return [
      '',
      'FAILURE-MODE GUIDANCE: The previous plan included a heavy local validation command (e.g. `dotnet test`, `pytest`, `npm test`) inside a task step.',
      'When rewriting, remove all heavy validation steps from the plan. The host runs `verify_command` automatically after EXECUTE — do not duplicate it inside individual task steps.',
      'Keep "git commit" steps but drop "run tests" / "build" / "validate" steps from the task body.',
    ].join('\n');
  }

  // Plan generation timed out or the provider failed. Usually means
  // the work item is too ambitious for one cycle.
  if (/^cannot_generate_plan/i.test(reason)) {
    return [
      '',
      'FAILURE-MODE GUIDANCE: The architect could not produce a viable plan from the previous description.',
      'When rewriting:',
      '- Cut scope by ~50%. The previous attempt was likely too ambitious or too vague.',
      '- Name 1-3 SPECIFIC files (not directories or patterns).',
      '- Acceptance criteria must be checkable in <30 seconds (one targeted test, not a full suite).',
      '- If the work spans multiple files, pick the ONE file with the highest leverage and defer the rest to follow-up items.',
    ].join('\n');
  }

  // Plan generated but failed the deterministic specificity gate.
  if (/^pre_written_plan_rejected_by_quality_gate/i.test(reason)) {
    return [
      '',
      'FAILURE-MODE GUIDANCE: A previous plan was rejected by the deterministic quality gate (insufficient specificity).',
      'When rewriting, ensure the description includes:',
      '- Backtick-wrapped paths to specific files (e.g. `src/foo/bar.ts`)',
      '- Approximate line numbers when known ("around line 450")',
      '- The exact verification command (e.g. `dotnet test --filter NameOfTest`)',
      '- Step-by-step actions with file paths inline, not high-level goals',
    ].join('\n');
  }

  return '';
}

function buildRewritePrompt({ workItem, history }) {
  const recoveryLog = (history.recoveryRecords || [])
    .map((r) => `  - attempt ${r.attempt}: strategy="${r.strategy}" outcome="${r.outcome}" at ${r.timestamp}`)
    .join('\n') || '  (none)';
  const priorReason = history.priorReason || workItem.reject_reason || '(unknown)';
  const failureModeGuidance = getFailureModeGuidance(priorReason);
  return [
    'You are reviewing a factory work item that failed to plan. Your job is to rewrite the title and description so the architect can produce a plannable, testable, atomic unit.',
    '',
    `Original title: ${workItem.title}`,
    'Original description:',
    workItem.description || '(empty)',
    '',
    `Prior failure reason: ${priorReason}`,
    'Prior recovery attempts:',
    recoveryLog,
    failureModeGuidance,
    '',
    'Do not inspect the repository or run shell commands. Rewrite using only the supplied title, description, failure reason, and recovery history.',
    '',
    'Rewrite to be specific, scoped, and testable. Output strict JSON ONLY (no prose, no markdown fence) of the form:',
    '{ "title": "...", "description": "...", "acceptance_criteria": ["...", "..."] }',
    '',
    'The description must be at least 100 characters and describe what changes, where, and why.',
    'Acceptance criteria must be concrete, testable, and at least 1 entry.',
  ].join('\n');
}

function buildDecomposePrompt({ workItem, history: _history, priorPlans }) {
  const planLog = (priorPlans || [])
    .map((p) => `### Attempt ${p.attempt}\n${p.planMarkdown || '(empty)'}\nLint errors: ${(p.lintErrors || []).join('; ') || '(none)'}`)
    .join('\n\n') || '(no prior plans)';
  return [
    'You are reviewing a factory work item whose plan failed quality checks twice. Your job is to split it into 2-4 atomic child items, each independently plannable.',
    '',
    `Parent title: ${workItem.title}`,
    'Parent description:',
    workItem.description || '(empty)',
    '',
    'Prior plan attempts and lint failures:',
    planLog,
    '',
    'Split into 2-4 children. Each child must be independently plannable, declare its own acceptance criteria, and reference the parent context where useful.',
    'Output strict JSON ONLY of the form:',
    '{ "children": [ { "title": "...", "description": "...", "acceptance_criteria": ["..."], "depends_on_index": 0 } ] }',
    '',
    'depends_on_index is optional and refers to a sibling index (0-based). Do not create cycles.',
    'Each child description must be at least 100 characters.',
  ].join('\n');
}

function parseStrictJson(raw, label) {
  if (typeof raw !== 'string') {
    throw new Error(`${label}: provider response was not a string`);
  }
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : raw;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`${label}: provider returned invalid JSON: ${err.message}`);
  }
}

async function rewriteWorkItem({ workItem, history, _testProviderCall, projectPath }) {
  const prompt = buildRewritePrompt({ workItem, history });
  const providerCall = _testProviderCall
    || ((p) => submitArchitectJsonPrompt(p, workItem.project_id, projectPath, 'replan_rewrite'));
  const raw = await providerCall(prompt, { mode: 'rewrite_work_item' });
  return parseStrictJson(raw, 'rewriteWorkItem');
}

async function decomposeWorkItem({ workItem, history, priorPlans, _testProviderCall, projectPath }) {
  const prompt = buildDecomposePrompt({ workItem, history, priorPlans });
  const providerCall = _testProviderCall
    || ((p) => submitArchitectJsonPrompt(p, workItem.project_id, projectPath, 'replan_decompose'));
  const raw = await providerCall(prompt, { mode: 'decompose_work_item' });
  return parseStrictJson(raw, 'decomposeWorkItem');
}

function getArchitectItemPriority(priorityRank) {
  const rank = toFiniteNumber(priorityRank);
  if (rank === null) {
    return 50;
  }

  return Math.max(0, Math.min(100, Math.round(100 - rank)));
}

async function promoteBacklogToIntake(project, cycle, backlog) {
  let promoted = 0;
  let skippedExisting = 0;

  for (const entry of backlog) {
    if (!isRecord(entry)) {
      continue;
    }

    if (entry.work_item_id !== null && entry.work_item_id !== undefined) {
      skippedExisting += 1;
      continue;
    }

    const guard = await guardIntakeItem({ title: entry.title });
    if (!guard.ok) {
      try {
        const { logDecision } = require('./decision-log');
        logDecision({
          project_id: project.id,
          stage: 'execute',
          actor: 'architect',
          action: 'intake_generation_meta_rejected',
          reasoning: `Architect proposed meta title '${entry.title}'; skipped to avoid zero-diff retry storm`,
          outcome: { title: entry.title, reason: guard.reason },
          confidence: 1,
        });
      } catch (_err) {
        // decision logging is best-effort
      }
      continue;
    }

    try {
      const created = factoryIntake.createWorkItem({
        project_id: project.id,
        title: entry.title,
        description: entry.why || entry.title,
        source: 'architect',
        origin_json: JSON.stringify({
          architect_cycle_id: cycle.id,
          priority_rank: entry.priority_rank,
          scope_budget: entry.scope_budget,
          expected_impact: entry.expected_impact || {},
          learning_penalty: entry.learning_penalty || 0,
          learning_categories: entry.learning_categories || [],
        }),
        status: 'pending',
        priority: getArchitectItemPriority(entry.priority_rank),
      });
      entry.work_item_id = created.id;
      promoted += 1;
    } catch (error) {
      logger.warn('architect_backlog_promotion_failed', {
        project_id: project.id,
        cycle_id: cycle.id,
        title: entry.title || null,
        error: error.message,
      });
    }
  }

  let storedCycle = cycle;
  if (promoted > 0) {
    storedCycle = factoryArchitect.updateCycle(cycle.id, {
      backlog_json: JSON.stringify(backlog),
    });
  } else {
    storedCycle.backlog = backlog;
    storedCycle.backlog_json = JSON.stringify(backlog);
  }

  logger.info('architect_backlog_promoted_to_intake', {
    project_id: project.id,
    cycle_id: cycle.id,
    promoted,
    skipped_existing: skippedExisting,
  });

  return storedCycle;
}

function updateBacklogWorkItemStatuses(backlog) {
  for (const item of backlog) {
    if (!item || !item.work_item_id) {
      continue;
    }

    const currentItem = factoryIntake.getWorkItem(item.work_item_id);
    if (!currentItem) {
      continue;
    }

    if (CLOSED_WORK_ITEM_STATUSES.has(currentItem.status)) {
      logger.debug('skipped prioritization update on closed item', {
        work_item_id: item.work_item_id,
        status: currentItem.status,
      });
      continue;
    }

    if (!PRIORITIZABLE_WORK_ITEM_STATUSES.has(currentItem.status)) {
      continue;
    }

    factoryIntake.updateWorkItem(item.work_item_id, { status: 'prioritized' });
  }
}

async function ingestScoutFindings(project) {
  if (!project || !project.path) return;
  try {
    let database;
    try {
      const { defaultContainer } = require('../container');
      database = defaultContainer.get('db');
    } catch {
      database = require('../database');
    }
    const db = typeof database.getDbInstance === 'function' ? database.getDbInstance() : null;
    if (!db) return;
    const findings_dir = path.join(project.path, 'docs', 'findings');
    const intake = createScoutFindingsIntake({ db, factoryIntake });
    const result = await intake.scan({ project_id: project.id, findings_dir });
    if (result.created.length > 0 || result.skipped.length > 0) {
      logger.info('scout_findings_ingested', {
        project_id: project.id,
        created: result.created.length,
        skipped: result.skipped.length,
        scanned: result.scanned,
      });
    }
  } catch (err) {
    logger.warn({ err, project_id: project.id }, 'scout findings ingestion failed; continuing cycle');
  }
}

async function runArchitectCycle(project_id, trigger = 'manual') {
  if (!project_id) {
    throw new Error('project_id is required');
  }

  const project = factoryHealth.getProject(project_id);
  if (!project) {
    throw new Error(`Project not found: ${project_id}`);
  }

  // Scan docs/findings/ for scout output and promote each finding to intake.
  // Fail soft: a broken scan must not stall the architect cycle.
  await ingestScoutFindings(project);

  const healthScores = normalizeHealthScores(factoryHealth.getLatestScores(project_id));
  const openItems = factoryIntake.listOpenWorkItems({ project_id });
  const intakeItems = normalizeIntakeItems(openItems.filter((item) => !CLOSED_WORK_ITEM_STATUSES.has(item.status)));

  if (trigger === 'loop_plan' && intakeItems.length === 0) {
    logger.info('Architect cycle skipping LLM; intake is empty', { project_id });
    const cycle = factoryArchitect.createCycle({
      project_id,
      input_snapshot: {
        healthScores,
        intakeItems: [],
      },
      reasoning: 'no open work items during loop_plan; architect LLM skipped',
      backlog: [],
      flags: [],
      llm_used: false,
      trigger,
    });
    return cycle;
  }

  const prevCycle = factoryArchitect.getLatestCycle(project_id);
  const sharedVerifyFailureLearnings = loadActiveVerifyFailureLearnings({
    project,
  });

  // Load human corrections for architect calibration
  let corrections = [];
  try {
    const factoryFeedback = require('../db/factory-feedback');
    const feedbackRecords = factoryFeedback.listFeedback ? factoryFeedback.listFeedback(project_id, 10) : [];
    corrections = feedbackRecords
      .filter(r => r.human_corrections_json)
      .map(r => {
        try { return JSON.parse(r.human_corrections_json); } catch { return null; }
      })
      .filter(Boolean)
      .flat()
      .slice(0, 10);
  } catch (err) {
    logger.debug(`Could not load corrections: ${err.message}`);
  }

  // Prefer the composed guide (RULES + examples) for first-pass plan-quality
  // compliance. Fall back to the file-based guide if composition fails so the
  // architect never stalls on a guide-authoring bug.
  let guide;
  try {
    guide = composeGuide();
  } catch (err) {
    logger.warn('plan_authoring_guide_compose_failed', {
      err: err && err.message,
      project_id,
    });
    guide = loadPlanAuthoringGuide(project.path);
  }
  const prompt = injectPlanAuthoringGuide(buildArchitectPrompt({
    project,
    healthScores,
    intakeItems,
    sharedLearnings: sharedVerifyFailureLearnings,
    previousBacklog: prevCycle ? prevCycle.backlog : [],
    previousReasoning: prevCycle ? prevCycle.reasoning : '',
    corrections,
  }), guide);

  logger.debug('Built architect prompt for cycle', {
    project_id,
    trigger,
    prompt_length: prompt.length,
    intake_count: intakeItems.length,
    health_dimension_count: healthScores.length,
    corrections_count: corrections.length,
    previous_cycle_id: prevCycle ? prevCycle.id : null,
  });

  // Try LLM-based prioritization via smart routing, fall back to deterministic.
  // The routing template decides which provider handles architect cycles —
  // 'plan_generation' category maps to text-gen providers (cerebras/groq/ollama)
  // in default templates, explicitly avoiding action-agent providers.
  let backlog;
  let reasoning;
  let llmUsed = false;

  // Only attempt LLM when a real task manager is available (not in tests)
  const hasTaskManager = (() => {
    try {
      const tm = require('../task-manager');
      return typeof tm.startTask === 'function';
    } catch { return false; }
  })();

  if (hasTaskManager) {
    try {
      const llmResult = await runArchitectLLM(prompt, project_id, project.path);
      if (llmResult && Array.isArray(llmResult.backlog) && llmResult.backlog.length > 0) {
        backlog = annotateBacklogWithSharedLearningPenalties(llmResult.backlog, sharedVerifyFailureLearnings, project);
        reasoning = appendSharedLearningReasoning(
          llmResult.reasoning || 'LLM-prioritized backlog',
          backlog,
          sharedVerifyFailureLearnings,
        );
        llmUsed = true;
        logger.info('Architect cycle used LLM', { project_id, backlog_count: backlog.length });
      }
    } catch (err) {
      logger.info(`Architect LLM failed, falling back to deterministic: ${err.message}`);
    }
  }

  if (!llmUsed) {
    backlog = prioritizeByHealth(intakeItems, healthScores, {
      project,
      sharedLearnings: sharedVerifyFailureLearnings,
    });
    reasoning = buildReasoning({
      project,
      trigger,
      healthScores,
      intakeItems,
      backlog,
      prevCycle,
      sharedLearnings: sharedVerifyFailureLearnings,
    });
  }
  const cycle = factoryArchitect.createCycle({
    project_id,
    input_snapshot: {
      healthScores,
      intakeItems: intakeItems.map((item) => ({
        id: item && item.id ? item.id : null,
        title: item && typeof item.title === 'string' ? item.title : null,
      })),
      sharedVerifyFailureLearnings: sharedVerifyFailureLearnings.map((learning) => ({
        provider: learning.provider,
        tech_stack: learning.tech_stack,
        categories: learning.categories,
        confidence: learning.confidence,
        sample_count: learning.sample_count,
        project_source: learning.project_source,
      })),
    },
    reasoning,
    backlog,
    flags: [],
    trigger,
  });

  updateBacklogWorkItemStatuses(backlog);
  const storedCycle = await promoteBacklogToIntake(project, cycle, backlog);

  logger.info('Architect cycle completed', {
    project_id,
    cycle_id: storedCycle && storedCycle.id ? storedCycle.id : null,
    trigger,
    backlog_count: backlog.length,
  });

  return storedCycle;
}

module.exports = {
  loadPlanAuthoringGuide,
  injectPlanAuthoringGuide,
  lintPlanContent,
  runArchitectCycle,
  prioritizeByHealth,
  updateBacklogWorkItemStatuses,
  rewriteWorkItem,
  decomposeWorkItem,
  // Phase P (2026-04-30): expose pure helpers for unit testing.
  buildRewritePrompt,
  getFailureModeGuidance,
  _internalForTests: {
    runArchitectLLM,
    loadActiveVerifyFailureLearnings,
    setSharedFactoryStore,
    normalizeVerifyLearningRow,
    // Phase Q (2026-04-30): exposed for failure-mode logging tests.
    submitArchitectJsonPrompt,
  },
};
