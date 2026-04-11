'use strict';

const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryArchitect = require('../db/factory-architect');
const { buildArchitectPrompt } = require('./architect-prompt');
const logger = require('../logger').child({ component: 'architect-runner' });

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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function buildWhy(item, match, weakDimensions) {
  const reasons = [];

  if (item && item.priority === 'user_override') {
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

  return reasons.join(' ');
}

function createBacklogEntry(item, match, weakDimensions, priorityRank) {
  return {
    work_item_id: item && item.id ? item.id : null,
    title: item && typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : `Work item ${priorityRank}`,
    why: buildWhy(item, match, weakDimensions),
    expected_impact: match ? { [match.dimension]: 'targeted' } : {},
    scope_budget: inferScopeBudget(item),
    priority_rank: priorityRank,
  };
}

function prioritizeByHealth(intakeItems, healthScores) {
  if (!Array.isArray(intakeItems)) {
    throw new TypeError('intakeItems must be an array');
  }

  const weakDimensions = getSortedWeakDimensions(healthScores);
  const rankedItems = intakeItems.map((item, index) => {
    const match = getWeakDimensionMatch(item, weakDimensions);
    return {
      item,
      index,
      isUserOverride: item && item.priority === 'user_override',
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
    createBacklogEntry(entry.item, entry.match, weakDimensions, index + 1)
  ));
}

function buildReasoning({ project, trigger, healthScores, intakeItems, backlog, prevCycle }) {
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
    'Ordering rules were deterministic: user_override items first, then work aligned to weak-dimension keywords in title/description, then oldest created_at first.',
    `Generated ${backlog.length} prioritized backlog item(s); top entries: ${prioritizedTitles}.`,
  ];

  if (prevCycle) {
    parts.push(`Previous cycle ${prevCycle.id} was included as prompt context for continuity.`);
  }

  return parts.join(' ');
}

/**
 * Submit the architect prompt to Codex and parse the JSON response.
 * Falls back to null if Codex is unavailable or response is unparseable.
 */
async function runCodexArchitect(prompt, project_id) {
  const taskManager = require('../task-manager');
  const taskCore = require('../db/task-core');
  const { v4: uuidv4 } = require('uuid');

  const taskId = uuidv4();
  const taskDescription = `You are the Architect for a software factory. Read the context below and return ONLY valid JSON output matching the specified format. No explanation outside the JSON.\n\n${prompt}`;

  taskCore.createTask({
    id: taskId,
    status: 'pending',
    task_description: taskDescription,
    working_directory: null,
    project: 'factory-architect',
    provider: 'codex',
    timeout_minutes: 10,
    metadata: JSON.stringify({ factory_internal: true, architect_cycle: true, project_id }),
  });

  // Start and await the task
  try {
    taskManager.startTask(taskId);
  } catch (err) {
    logger.warn(`Failed to start Codex architect task: ${err.message}`);
    return null;
  }

  // Wait for completion (up to 5 minutes)
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const task = taskCore.getTask(taskId);
    if (!task) break;
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
        logger.warn(`Failed to parse Codex architect output: ${parseErr.message}`);
      }
      return null;
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      return null;
    }
    // Brief wait before checking again
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  logger.warn('Codex architect task timed out');
  return null;
}

async function runArchitectCycle(project_id, trigger = 'manual') {
  if (!project_id) {
    throw new Error('project_id is required');
  }

  const project = factoryHealth.getProject(project_id);
  if (!project) {
    throw new Error(`Project not found: ${project_id}`);
  }

  const healthScores = normalizeHealthScores(factoryHealth.getLatestScores(project_id));
  // Query both 'pending' (migration v14 default) and 'intake' (original default) for compatibility
  const pendingItems = factoryIntake.listWorkItems({ project_id, status: 'pending' });
  const intakeStatusItems = factoryIntake.listWorkItems({ project_id, status: 'intake' });
  const intakeItems = normalizeIntakeItems([...pendingItems, ...intakeStatusItems]);
  const prevCycle = factoryArchitect.getLatestCycle(project_id);

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

  const prompt = buildArchitectPrompt({
    project,
    healthScores,
    intakeItems,
    previousBacklog: prevCycle ? prevCycle.backlog : [],
    previousReasoning: prevCycle ? prevCycle.reasoning : '',
    corrections,
  });

  logger.debug('Built architect prompt for cycle', {
    project_id,
    trigger,
    prompt_length: prompt.length,
    intake_count: intakeItems.length,
    health_dimension_count: healthScores.length,
    corrections_count: corrections.length,
    previous_cycle_id: prevCycle ? prevCycle.id : null,
  });

  // Try LLM-based prioritization via Codex, fall back to deterministic
  let backlog;
  let reasoning;
  let llmUsed = false;

  // Only attempt Codex LLM when a real task manager is available (not in tests)
  const hasTaskManager = (() => {
    try {
      const tm = require('../task-manager');
      return typeof tm.startTask === 'function';
    } catch { return false; }
  })();

  if (hasTaskManager) {
    try {
      const codexResult = await runCodexArchitect(prompt, project_id);
      if (codexResult && Array.isArray(codexResult.backlog) && codexResult.backlog.length > 0) {
        backlog = codexResult.backlog;
        reasoning = codexResult.reasoning || 'LLM-prioritized backlog';
        llmUsed = true;
        logger.info('Architect cycle used Codex LLM', { project_id, backlog_count: backlog.length });
      }
    } catch (err) {
      logger.info(`Codex architect failed, falling back to deterministic: ${err.message}`);
    }
  }

  if (!llmUsed) {
    backlog = prioritizeByHealth(intakeItems, healthScores);
    reasoning = buildReasoning({ project, trigger, healthScores, intakeItems, backlog, prevCycle });
  }
  const cycle = factoryArchitect.createCycle({
    project_id,
    input_snapshot: {
      healthScores,
      intakeItems: intakeItems.map((item) => ({
        id: item && item.id ? item.id : null,
        title: item && typeof item.title === 'string' ? item.title : null,
      })),
    },
    reasoning,
    backlog,
    flags: [],
    trigger,
  });

  for (const item of backlog) {
    if (!item.work_item_id) {
      continue;
    }
    factoryIntake.updateWorkItem(item.work_item_id, { status: 'prioritized' });
  }

  logger.info('Architect cycle completed', {
    project_id,
    cycle_id: cycle && cycle.id ? cycle.id : null,
    trigger,
    backlog_count: backlog.length,
  });

  return cycle;
}

module.exports = {
  runArchitectCycle,
  prioritizeByHealth,
};
