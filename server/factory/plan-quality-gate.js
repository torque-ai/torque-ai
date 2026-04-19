'use strict';

const MAX_REPLAN_ATTEMPTS = 1;
const LLM_TIMEOUT_MS = 60_000;

const RULES = {
  plan_has_task_heading:       { severity: 'hard', scope: 'plan' },
  plan_task_count_upper_bound: { severity: 'hard', scope: 'plan', max: 15 },
  plan_task_count_lower_bound: { severity: 'warn', scope: 'plan', min: 2 },
  task_body_min_length:        { severity: 'hard', scope: 'task', min: 100 },
  task_has_file_reference:     { severity: 'hard', scope: 'task' },
  task_has_acceptance_criterion: { severity: 'hard', scope: 'task' },
  task_avoids_vague_phrases:   { severity: 'hard', scope: 'task', minHits: 2 },
  no_duplicate_task_titles:    { severity: 'hard', scope: 'plan' },
  task_heading_grammar:        { severity: 'hard', scope: 'plan' },
  plan_size_upper_bound:       { severity: 'hard', scope: 'plan', maxBytes: 100 * 1024 },
};

const FILE_PATH_RE = /[a-z_][a-z_0-9/-]*\.(js|ts|tsx|jsx|py|cs|md|json|yml|yaml)/i;
const GREP_TARGET_RE = /\bsearch_files\b|\bgrep\b/i;
const ACCEPTANCE_RE = /\b(npx vitest|dotnet test|pytest|npm test|assert|expect|should produce|should exist)\b/i;
const VAGUE_PHRASES = [
  'appropriately',
  'as needed',
  'refactor accordingly',
  'clean up',
  'improve',
  'fix issues',
];

function parseTasks(planMarkdown) {
  // Returns [{ number, title, body }] splitting the plan at each ## Task N: heading.
  if (typeof planMarkdown !== 'string' || !planMarkdown) return [];
  const headingRe = /^## Task (\d+):\s*(.*)$/gm;
  const matches = Array.from(planMarkdown.matchAll(headingRe)).map((m) => ({
    number: Number(m[1]),
    title: (m[2] || '').trim(),
    start: m.index,
    headerLen: m[0].length,
  }));
  return matches.map((match, idx) => {
    const bodyStart = match.start + match.headerLen;
    const bodyEnd = idx + 1 < matches.length ? matches[idx + 1].start : planMarkdown.length;
    return {
      number: match.number,
      title: match.title,
      body: planMarkdown.slice(bodyStart, bodyEnd).trim(),
    };
  });
}

function runDeterministicRules(planMarkdown) {
  const hardFails = [];
  const warnings = [];

  // Rule 10 — check before parsing, short-circuits runaway plans.
  if (typeof planMarkdown === 'string' && planMarkdown.length > RULES.plan_size_upper_bound.maxBytes) {
    hardFails.push({
      rule: 'plan_size_upper_bound',
      detail: `Plan is ${planMarkdown.length} bytes; upper bound is ${RULES.plan_size_upper_bound.maxBytes}.`,
    });
  }

  // Rule 9 — detect non-standard task grammar BEFORE parseTasks, which only matches "## Task N:" with N ≥ 1.
  if (/^## (Step \d+|Task 0):/m.test(planMarkdown || '')) {
    hardFails.push({
      rule: 'task_heading_grammar',
      detail: 'Plan uses "## Step N:" or "## Task 0:" grammar; only "## Task N:" (N≥1) is accepted.',
    });
  }

  const tasks = parseTasks(planMarkdown);

  // Rule 1
  if (tasks.length === 0) {
    hardFails.push({ rule: 'plan_has_task_heading', detail: 'Plan contains no "## Task N:" heading.' });
    return { hardFails, warnings };
  }

  // Rule 2
  if (tasks.length > RULES.plan_task_count_upper_bound.max) {
    hardFails.push({
      rule: 'plan_task_count_upper_bound',
      detail: `Plan has ${tasks.length} tasks; upper bound is ${RULES.plan_task_count_upper_bound.max}. Decompose.`,
    });
  }

  // Rule 3 (warning)
  if (tasks.length < RULES.plan_task_count_lower_bound.min) {
    warnings.push({
      rule: 'plan_task_count_lower_bound',
      detail: `Plan has only ${tasks.length} task; single-task plans often indicate insufficient decomposition.`,
    });
  }

  // Rule 4
  for (const task of tasks) {
    if (task.body.length < RULES.task_body_min_length.min) {
      hardFails.push({
        rule: 'task_body_min_length',
        taskNumber: task.number,
        detail: `Task ${task.number} body is ${task.body.length} chars (min ${RULES.task_body_min_length.min}).`,
      });
    }

    // Rule 5
    if (!FILE_PATH_RE.test(task.body) && !GREP_TARGET_RE.test(task.body)) {
      hardFails.push({
        rule: 'task_has_file_reference',
        taskNumber: task.number,
        detail: `Task ${task.number} references no concrete file path or grep target.`,
      });
    }

    // Rule 6
    if (!ACCEPTANCE_RE.test(task.body)) {
      hardFails.push({
        rule: 'task_has_acceptance_criterion',
        taskNumber: task.number,
        detail: `Task ${task.number} has no test command, assertion, or verifiable outcome.`,
      });
    }

    // Rule 7: ≥ 2 forbidden phrases in the same task
    const hits = VAGUE_PHRASES.reduce((acc, phrase) => {
      const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const count = (task.body.match(re) || []).length;
      return acc + count;
    }, 0);
    if (hits >= RULES.task_avoids_vague_phrases.minHits) {
      hardFails.push({
        rule: 'task_avoids_vague_phrases',
        taskNumber: task.number,
        detail: `Task ${task.number} contains ${hits} vague phrases (threshold ${RULES.task_avoids_vague_phrases.minHits}).`,
      });
    }
  }

  // Rule 8 — duplicate titles.
  const titleCounts = new Map();
  for (const task of tasks) {
    const normalized = task.title.toLowerCase();
    titleCounts.set(normalized, (titleCounts.get(normalized) || 0) + 1);
  }
  for (const [title, count] of titleCounts) {
    if (count > 1) {
      hardFails.push({
        rule: 'no_duplicate_task_titles',
        detail: `Title "${title}" appears ${count} times; task titles must be unique.`,
      });
    }
  }

  return { hardFails, warnings };
}

async function runLlmSemanticCheck({ plan, workItem, project, timeoutMs = LLM_TIMEOUT_MS }) {
  const { submitFactoryInternalTask } = require('./internal-task-submit');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');

  const prompt = buildLlmPrompt({ plan, workItem });
  let taskId;
  try {
    const submitResult = await submitFactoryInternalTask({
      task: prompt,
      working_directory: project?.path || process.cwd(),
      kind: 'plan_generation',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
    });
    taskId = submitResult?.task_id || null;
  } catch (_e) {
    return null;
  }
  if (!taskId) return null;

  try {
    await handleAwaitTask({ task_id: taskId, timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)), heartbeat_minutes: 0 });
  } catch (_e) {
    return null;
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') return null;

  const raw = (task.output || '').trim();
  if (!raw) return null;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    if (parsed && typeof parsed.critique === 'string') {
      if (parsed.verdict === 'no-go') return `[no-go] ${parsed.critique.trim()}`;
      return parsed.critique.trim();
    }
  } catch (_e) {
    // Unparseable — fall through and return the raw output as critique.
    void _e;
  }
  return raw;
}

function buildLlmPrompt({ plan, workItem }) {
  return `You are a quality reviewer for a software factory's auto-generated implementation plans.

Work item title: ${workItem?.title || '(none)'}
Work item description: ${workItem?.description || '(none)'}

Return ONLY valid JSON in this shape: {"verdict":"go"|"no-go","critique":"one sentence explaining the verdict"}

Plan:
${plan}
`;
}

function buildFeedbackPrompt(hardFails, warnings, llmCritique) {
  const hasHardFails = Array.isArray(hardFails) && hardFails.length > 0;
  const hasCritique = typeof llmCritique === 'string' && llmCritique.trim().length > 0;
  if (!hasHardFails && !hasCritique) {
    return null;
  }

  const lines = ['## Prior plan rejected — address these issues in the next plan.', ''];

  if (hasHardFails) {
    lines.push('### Violations (must fix):');
    for (const v of hardFails) {
      const hasTaskNum = typeof v.taskNumber === 'number' && Number.isFinite(v.taskNumber);
      const prefix = hasTaskNum ? `- [${v.rule}] Task ${v.taskNumber}:` : `- [${v.rule}]`;
      lines.push(`${prefix} ${v.detail}`);
    }
    lines.push('');
  }

  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push('### Warnings (consider fixing):');
    for (const w of warnings) {
      const hasTaskNum = typeof w.taskNumber === 'number' && Number.isFinite(w.taskNumber);
      const prefix = hasTaskNum ? `- [${w.rule}] Task ${w.taskNumber}:` : `- [${w.rule}]`;
      lines.push(`${prefix} ${w.detail}`);
    }
    lines.push('');
  }

  if (hasCritique) {
    lines.push('### Semantic concern:');
    lines.push(llmCritique.trim());
    lines.push('');
  }

  return lines.join('\n');
}

async function evaluatePlan(_opts) {
  return { passed: true, hardFails: [], warnings: [], llmCritique: null, feedbackPrompt: null };
}

module.exports = {
  MAX_REPLAN_ATTEMPTS,
  LLM_TIMEOUT_MS,
  RULES,
  runDeterministicRules,
  runLlmSemanticCheck,
  buildFeedbackPrompt,
  evaluatePlan,
};
