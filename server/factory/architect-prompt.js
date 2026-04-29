'use strict';

const { normalizeVerifyFailureCategories } = require('../db/shared-factory-store');

const MAX_INTAKE_ITEMS = 20;
const MAX_SHARED_LEARNINGS = 8;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInlineText(value, fallback = '') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return fallback;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function formatMultilineText(value, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return fallback;
}

function indentBlock(value, prefix) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatScore(score) {
  const parsed = toFiniteNumber(score);
  return parsed === null ? 'unknown' : String(parsed);
}

function formatPreviousCycleValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getWeakestHealthIndex(healthScores) {
  let weakestIndex = -1;
  let weakestScore = Infinity;

  healthScores.forEach((entry, index) => {
    const score = toFiniteNumber(entry && entry.score);
    if (score === null) {
      if (weakestIndex === -1) {
        weakestIndex = index;
      }
      return;
    }

    if (score < weakestScore) {
      weakestScore = score;
      weakestIndex = index;
    }
  });

  return weakestIndex;
}

function formatHealthScores(healthScores) {
  if (healthScores.length === 0) {
    return {
      lines: ['- No health scores available.'],
      weakestSummary: 'No health scores available.',
    };
  }

  const weakestIndex = getWeakestHealthIndex(healthScores);
  const lines = healthScores.map((entry, index) => {
    const dimension = normalizeInlineText(entry && entry.dimension, `unknown_dimension_${index + 1}`);
    const suffix = index === weakestIndex ? ' <- weakest' : '';
    return `- ${dimension}: ${formatScore(entry && entry.score)}${suffix}`;
  });

  const weakestEntry = healthScores[weakestIndex];
  const weakestDimension = normalizeInlineText(
    weakestEntry && weakestEntry.dimension,
    `unknown_dimension_${weakestIndex + 1}`
  );

  return {
    lines,
    weakestSummary: `${weakestDimension} (${formatScore(weakestEntry && weakestEntry.score)})`,
  };
}

function getPriorityValue(item) {
  const priority = toFiniteNumber(item && item.priority);
  return priority === null ? Number.NEGATIVE_INFINITY : priority;
}

function sortByPriorityDescending(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const priorityDelta = getPriorityValue(right.item) - getPriorityValue(left.item);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

function formatIntakeItems(intakeItems) {
  if (intakeItems.length === 0) {
    return ['- No pending work items.'];
  }

  const lines = [];
  let itemsToRender = intakeItems;

  if (intakeItems.length > MAX_INTAKE_ITEMS) {
    itemsToRender = sortByPriorityDescending(intakeItems).slice(0, MAX_INTAKE_ITEMS);
    lines.push(
      `- Truncated intake queue from ${intakeItems.length} items to the top ${MAX_INTAKE_ITEMS} by priority.`
    );
  }

  itemsToRender.forEach((item, index) => {
    const id = item && item.id !== undefined && item.id !== null && String(item.id).trim().length > 0
      ? String(item.id).trim()
      : 'null';
    const title = normalizeInlineText(item && item.title, `Untitled work item ${index + 1}`);
    const description = formatMultilineText(item && item.description, 'No description provided.');
    const priority = toFiniteNumber(item && item.priority);
    const source = normalizeInlineText(item && item.source, 'unknown');

    lines.push(`- [${id}] ${title}`);
    lines.push(`  Priority: ${priority === null ? 'unknown' : String(priority)} | Source: ${source}`);
    lines.push(indentBlock(description, '  Description: '));
  });

  return lines;
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

function formatSharedLearnings(sharedLearnings) {
  if (!Array.isArray(sharedLearnings) || sharedLearnings.length === 0) {
    return ['- No active shared verify-failure learnings.'];
  }

  const rowsToRender = sharedLearnings
    .filter(isRecord)
    .slice(0, MAX_SHARED_LEARNINGS);
  if (rowsToRender.length === 0) {
    return ['- No active shared verify-failure learnings.'];
  }

  return rowsToRender.map((learning, index) => {
    const payload = parsePayloadJson(learning);
    const categories = normalizeVerifyFailureCategories([
      ...(Array.isArray(learning.categories) ? learning.categories : []),
      ...(Array.isArray(payload.failure_categories) ? payload.failure_categories : []),
      learning.primary_category,
      payload.failure_category,
    ]);
    const categoryText = categories.length > 0 ? categories.join(', ') : 'verify_failure_pattern';
    const techStack = normalizeInlineText(learning.tech_stack || payload.tech_stack, 'unknown');
    const provider = normalizeInlineText(learning.provider, 'unknown');
    const source = normalizeInlineText(learning.project_source, 'unknown');
    const confidence = formatScore(learning.confidence);
    const sampleCount = toFiniteNumber(learning.sample_count);
    return `- ${index + 1}. ${categoryText} | stack=${techStack} | provider=${provider} | confidence=${confidence} | samples=${sampleCount === null ? 'unknown' : sampleCount} | source=${source}`;
  });
}

function buildArchitectPrompt(options = {}) {
  if (!isRecord(options)) {
    throw new TypeError('buildArchitectPrompt requires an options object');
  }

  const {
    project,
    healthScores,
    intakeItems,
    sharedLearnings,
    previousBacklog,
    previousReasoning,
    corrections,
  } = options;

  if (!isRecord(project)) {
    throw new TypeError('project must be an object');
  }

  const safeHealthScores = ensureArray(healthScores, 'healthScores');
  const safeIntakeItems = ensureArray(intakeItems, 'intakeItems');
  const healthSection = formatHealthScores(safeHealthScores);
  const intakeSection = formatIntakeItems(safeIntakeItems);
  const sharedLearningSection = formatSharedLearnings(sharedLearnings);
  const projectBrief = formatMultilineText(project.brief, 'No project brief provided.');
  const previousBacklogText = formatPreviousCycleValue(previousBacklog);
  const previousReasoningText = formatPreviousCycleValue(previousReasoning);
  const includePreviousCycle = previousBacklogText.length > 0 && previousReasoningText.length > 0;

  const sections = [
    '## System context',
    'You are the Architect for a software factory. Your job is to prioritize work items based on project health, product sense, and user intent.',
    '',
    '## Project brief',
    projectBrief,
    '',
    '## Health scores',
    ...healthSection.lines,
    `Weakest dimension: ${healthSection.weakestSummary}`,
    '',
    '## Shared verify-failure learnings',
    'Use these cross-project verification failures as deprioritization signals. Do not drop matching work; attach a learning_penalty and explain it in why.',
    ...sharedLearningSection,
    '',
    '## Intake queue',
    ...intakeSection,
  ];

  if (includePreviousCycle) {
    sections.push(
      '',
      '## Previous cycle',
      'Previous reasoning:',
      previousReasoningText,
      '',
      'Previous backlog:',
      previousBacklogText
    );
  }

  // Human corrections — calibration data from the product owner
  if (Array.isArray(corrections) && corrections.length > 0) {
    sections.push(
      '',
      '## Human corrections (calibration)',
      'The product owner has overridden or corrected previous architect decisions. Learn from these:',
    );
    for (const c of corrections.slice(0, 10)) {
      const correction = typeof c === 'string' ? c : (c.description || c.reason || JSON.stringify(c));
      sections.push(`- ${correction}`);
    }
    sections.push(
      '',
      'Adjust your prioritization to reflect these corrections. If a pattern is repeated, it is a strong signal.'
    );
  }

  sections.push(
    '',
    '## Product-sense questions',
    '- What does a new user encounter first? Is that path solid?',
    '- What breaks the experience if it fails? Is that hardened?',
    '- What has been over-invested relative to its importance? What has been neglected?',
    '- If this shipped today, what would embarrass you?',
    '',
    '## Output format instructions',
    'Return JSON output only. Use this exact shape:',
    '```json',
    '{',
    '  "reasoning": "Human-readable explanation...",',
    '  "backlog": [',
    '    {',
    '      "work_item_id": "id or null",',
    '      "title": "What to do",',
    '      "why": "Which health dimension, user journey, or risk",',
    '      "expected_impact": { "dimension": "score_delta" },',
    '      "scope_budget": 5,',
    '      "learning_penalty": 0,',
    '      "priority_rank": 1',
    '    }',
    '  ],',
    '  "flags": [',
    '    { "item": "description", "reason": "why uncertain" }',
    '  ]',
    '}',
    '```'
  );

  return sections.join('\n');
}

module.exports = {
  buildArchitectPrompt,
};
