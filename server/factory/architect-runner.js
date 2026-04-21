'use strict';

const fs = require('node:fs');
const path = require('node:path');

const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryArchitect = require('../db/factory-architect');
const { buildArchitectPrompt } = require('./architect-prompt');
const { lintPlanContent } = require('./plan-lint');
const { createScoutFindingsIntake } = require('./scout-findings-intake');
const { composeGuide } = require('./plan-authoring-guide');
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
      isUserOverride: isUserOverridePriority(item),
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
      timeout_minutes: 10,
    });
    taskId = task_id;
    if (!taskId) {
      logger.warn('Architect task submission returned no task_id');
      return null;
    }
  } catch (err) {
    logger.warn(`Failed to submit architect task: ${err.message}`);
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
        logger.warn(`Failed to parse architect output: ${parseErr.message}`);
      }
      return null;
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      return null;
    }
    // Brief wait before checking again
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  logger.warn('Architect task timed out');
  return null;
}

function getArchitectItemPriority(priorityRank) {
  const rank = toFiniteNumber(priorityRank);
  if (rank === null) {
    return 50;
  }

  return Math.max(0, Math.min(100, Math.round(100 - rank)));
}

function promoteBacklogToIntake(project, cycle, backlog) {
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

function ingestScoutFindings(project) {
  if (!project || !project.path) return;
  try {
    const database = require('../database');
    const db = typeof database.getDbInstance === 'function' ? database.getDbInstance() : null;
    if (!db) return;
    const findings_dir = path.join(project.path, 'docs', 'findings');
    const intake = createScoutFindingsIntake({ db, factoryIntake });
    const result = intake.scan({ project_id: project.id, findings_dir });
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
  ingestScoutFindings(project);

  const healthScores = normalizeHealthScores(factoryHealth.getLatestScores(project_id));
  const openItems = factoryIntake.listOpenWorkItems({ project_id });
  const intakeItems = normalizeIntakeItems(openItems.filter((item) => !CLOSED_WORK_ITEM_STATUSES.has(item.status)));
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
        backlog = llmResult.backlog;
        reasoning = llmResult.reasoning || 'LLM-prioritized backlog';
        llmUsed = true;
        logger.info('Architect cycle used LLM', { project_id, backlog_count: backlog.length });
      }
    } catch (err) {
      logger.info(`Architect LLM failed, falling back to deterministic: ${err.message}`);
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

  updateBacklogWorkItemStatuses(backlog);
  const storedCycle = promoteBacklogToIntake(project, cycle, backlog);

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
};
