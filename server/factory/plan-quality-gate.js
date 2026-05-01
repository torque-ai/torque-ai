'use strict';

const { findHeavyLocalValidationCommand } = require('../utils/heavy-validation-guard');
const { deterministicVerify } = require('./plan-augmenter');
const { checkPlanImpact } = require('./codegraph-plan-augmenter');

const MAX_REPLAN_ATTEMPTS = 1;
const LLM_TIMEOUT_MS = 60_000;

const RULES = {
  plan_has_task_heading: {
    severity: 'hard', scope: 'plan',
    description: 'Each task must begin with a "### Task N: ..." heading using imperative grammar.',
  },
  plan_task_count_upper_bound: {
    severity: 'hard', scope: 'plan', max: 15,
    description: 'A plan must contain at most 15 tasks. Split larger work into multiple plans.',
  },
  plan_task_count_lower_bound: {
    severity: 'warn', scope: 'plan', min: 2,
    description: 'A plan should contain at least 2 tasks (soft rule - single-task plans are tolerated).',
  },
  task_body_min_length: {
    severity: 'hard', scope: 'task', min: 100,
    description: 'Task bodies must be at least 100 characters of concrete instruction.',
  },
  task_has_file_reference: {
    severity: 'hard', scope: 'task',
    description: 'Every task body must reference at least one file path (e.g. `src/foo.ts`).',
  },
  task_has_acceptance_criterion: {
    severity: 'hard', scope: 'task',
    description: 'Every task must state an acceptance criterion - a test command, an assertion, or a specific observable outcome.',
  },
  task_avoids_local_heavy_validation: {
    severity: 'hard', scope: 'task',
    description: 'Heavy validation/build commands in task bodies must use torque-remote or be left to the orchestrator verify step.',
  },
  task_avoids_vague_phrases: {
    severity: 'hard', scope: 'task', minHits: 1,
    description: 'Avoid vague phrases ("improve", "update", "clean up", "refactor accordingly") unless accompanied by a concrete file path, function name, or symbol.',
  },
  task_avoids_nested_worktree_setup: {
    severity: 'hard', scope: 'task',
    description: 'Factory plan tasks must not instruct workers to create or switch to another git worktree; factory execution already runs in an isolated worktree.',
  },
  no_duplicate_task_titles: {
    severity: 'hard', scope: 'plan',
    description: 'Task titles must be unique within a plan.',
  },
  task_heading_grammar: {
    severity: 'hard', scope: 'plan',
    description: 'Task headings must use imperative grammar ("Add foo", not "Added foo" or "Adding foo").',
  },
  plan_size_upper_bound: {
    severity: 'hard', scope: 'plan', maxBytes: 100 * 1024,
    description: 'Plan file size must not exceed 100 KB.',
  },
};

const FILE_PATH_RE = /[A-Za-z0-9_./\\-]+\.(?:csproj|fsproj|vbproj|targets|props|tsx|jsx|cjs|mjs|yaml|yml|json|sql|xaml|axaml|xml|resx|psm1|ps1|sln|js|ts|py|cs|sh|md)\b/i;
const GREP_TARGET_RE = /\bsearch_files\b|\bgrep\b/i;
const VALIDATION_COMMAND_TARGET_RE = /\b(?:npx\s+vitest(?:\s+run)?|vitest(?:\s+run)?|pytest|python\s+-m\s+pytest|npm(?:\s+--prefix\s+\S+)?\s+(?:run\s+)?test\s+--)\s+[`'"]?([A-Za-z0-9_.][A-Za-z0-9_./\\-]*)(?=[`'"\s]|$)/i;
const ACCEPTANCE_RE = /\b(npx vitest|dotnet test|pytest|npm(?:\s+--prefix\s+\S+)?\s+(?:run\s+)?test|assert|expect|acceptance criteria\s*:|validation\s*:|must\s+(?:pass|return|include|not\s+include|not\s+read|call|not\s+call)|should\s+(?:pass|report|produce|exist|include|not\s+include))\b/i;
const CONCRETE_FILE_PATH_RE = /(?:^|[\s`'"([])(?:[A-Za-z]:)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:csproj|fsproj|vbproj|targets|props|cjs|cs|css|go|html|java|js|json|jsx|md|mjs|psm1|ps1|py|rb|resx|rs|sh|sln|sql|ts|tsx|txt|xaml|axaml|xml|ya?ml)\b/i;
const CONCRETE_BACKTICK_RE = /`[^`\n]+`/;
const CONCRETE_QUOTED_RE = /"[^"\n]+"|'[^'\n]+'/;
const CONCRETE_IDENTIFIER_RE = /\b(?:[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g;
const NESTED_WORKTREE_SETUP_PATTERNS = [
  {
    label: 'create worktree before editing',
    re: /\bcreate\s+(?:a\s+)?(?:(?:dedicated|feature|separate|new)\s+){0,3}(?:git\s+)?worktree\b[\s\S]{0,240}\bgit\s+worktree\s+add\b/i,
  },
  {
    label: 'run worktree add and continue in another path',
    re: /\b(?:run|execute|use)\b[\s\S]{0,80}\bgit\s+worktree\s+add\b[\s\S]{0,220}\b(?:before editing|then work|work only inside|work inside|inside that path|branch first)\b/i,
  },
  {
    label: 'worktree add before editing',
    re: /\bgit\s+worktree\s+add\b[\s\S]{0,220}\b(?:before editing|then work|work only inside|work inside|inside that path|branch first)\b/i,
  },
];
const WORKTREE_SETUP_CRITIQUE_RE = /\b(?:omit(?:s|ted|ting)?|missing|lack(?:s|ed|ing)?|without|does\s+not\s+(?:include|mention|require)|no\s+(?:dedicated\s+)?worktree)\b[\s\S]{0,180}\b(?:worktree|feature\s+branch|branch)\b/i;
const VAGUE_PHRASES = [
  { label: 'appropriately', re: /\bappropriately\b/gi },
  { label: 'as needed', re: /\bas\s+needed\b/gi },
  { label: 'refactor accordingly', re: /\brefactor\s+accordingly\b/gi },
  { label: 'clean up', re: /\bclean\s+up\b/gi },
  { label: 'improve', re: /\bimprov(?:e|es|ed|ing)\b/gi },
  { label: 'update', re: /\bupdat(?:e|es|ed|ing)\b/gi },
  { label: 'modify', re: /\bmodif(?:y|ies|ied|ying)\b/gi },
  { label: 'fix issues', re: /\bfix\s+issues\b/gi },
];

function hasConcreteObject(text) {
  const value = String(text || '');
  if (CONCRETE_FILE_PATH_RE.test(value)
    || CONCRETE_BACKTICK_RE.test(value)
    || CONCRETE_QUOTED_RE.test(value)) {
    return true;
  }

  CONCRETE_IDENTIFIER_RE.lastIndex = 0;
  return Array.from(value.matchAll(CONCRETE_IDENTIFIER_RE)).some((match) => match[0].length >= 4);
}

function findUnqualifiedVaguePhrases(text) {
  const value = String(text || '');
  const hits = [];

  for (const phrase of VAGUE_PHRASES) {
    phrase.re.lastIndex = 0;
    for (const match of value.matchAll(phrase.re)) {
      const start = Math.max(0, match.index - 80);
      const end = Math.min(value.length, match.index + match[0].length + 120);
      if (!hasConcreteObject(value.slice(start, end))) {
        hits.push(phrase.label);
      }
    }
  }

  return hits;
}

function findNestedWorktreeSetup(text) {
  const value = String(text || '');
  for (const pattern of NESTED_WORKTREE_SETUP_PATTERNS) {
    if (pattern.re.test(value)) {
      return pattern.label;
    }
  }
  return null;
}

function hasConcreteTaskScope(text) {
  const value = String(text || '');
  if (FILE_PATH_RE.test(value) || GREP_TARGET_RE.test(value)) {
    return true;
  }

  const validationTarget = value.match(VALIDATION_COMMAND_TARGET_RE)?.[1] || '';
  return /[\\/]/.test(validationTarget) || /\.[A-Za-z0-9]+$/.test(validationTarget);
}

function isUnsupportedWorktreeSetupCritique(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return WORKTREE_SETUP_CRITIQUE_RE.test(value);
}

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
    if (!hasConcreteTaskScope(task.body)) {
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

    const heavyLocalValidation = findHeavyLocalValidationCommand(task.body);
    if (heavyLocalValidation) {
      hardFails.push({
        rule: 'task_avoids_local_heavy_validation',
        taskNumber: task.number,
        detail: `Task ${task.number} includes heavyweight local validation (${heavyLocalValidation}). Use torque-remote for .NET/build-wrapper validation, or leave the full verify command to the orchestrator.`,
      });
    }

    // Rule 7: vague verbs must be paired with nearby object-level detail.
    const unqualifiedVaguePhrases = findUnqualifiedVaguePhrases(`${task.title || ''}\n${task.body || ''}`);
    if (unqualifiedVaguePhrases.length >= RULES.task_avoids_vague_phrases.minHits) {
      const labels = [...new Set(unqualifiedVaguePhrases)];
      hardFails.push({
        rule: 'task_avoids_vague_phrases',
        taskNumber: task.number,
        detail: `Task ${task.number} contains vague phrase(s) without object-level detail: ${labels.join(', ')}.`,
      });
    }

    const nestedWorktreeSetup = findNestedWorktreeSetup(task.body);
    if (nestedWorktreeSetup) {
      hardFails.push({
        rule: 'task_avoids_nested_worktree_setup',
        taskNumber: task.number,
        detail: `Task ${task.number} instructs the worker to create or switch to another git worktree (${nestedWorktreeSetup}). Factory execution already provides the isolated worktree; remove the nested worktree setup.`,
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

Factory execution already creates an isolated git worktree and feature branch for each batch.
Do NOT reject a plan because it omits worktree or branch setup instructions.
Do reject a plan only for semantic mismatch with the work item, missing concrete implementation scope, or unsafe/incorrect execution guidance.

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

/**
 * Augments a plan markdown string by appending acceptance-criterion lines to
 * tasks that lack one, using the project's verify_command as the basis.
 * Only runs when projectConfig.verify_command is set.
 * Returns { plan: string, augmented: number }.
 */
function augmentPlanMarkdown(planMarkdown, projectConfig, logger) {
  const verify = projectConfig && typeof projectConfig.verify_command === 'string'
    ? projectConfig.verify_command.trim()
    : '';
  if (!verify || typeof planMarkdown !== 'string') return { plan: planMarkdown, augmented: 0 };

  const headingRe = /^## Task \d+:/m;
  if (!headingRe.test(planMarkdown)) return { plan: planMarkdown, augmented: 0 };

  // Split at task headings, augment bodies that lack acceptance criterion.
  const parts = planMarkdown.split(/(^## Task \d+:.*$)/m);
  // parts alternates: [pre, heading, body, heading, body, ...]
  let augmented = 0;
  const out = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Is this part a task heading?
    if (/^## Task \d+:/.test(part)) {
      out.push(part);
    } else if (i > 0 && /^## Task \d+:/.test(parts[i - 1])) {
      // This part is the body following a heading.
      if (!ACCEPTANCE_RE.test(part)) {
        const verifyLine = deterministicVerify(verify);
        // Append the verify line (preserve trailing newline behaviour).
        const trimmed = part.trimEnd();
        out.push(trimmed + '\n' + verifyLine + '\n');
        augmented += 1;
      } else {
        out.push(part);
      }
    } else {
      out.push(part);
    }
  }

  if (augmented > 0) {
    logger?.info?.('[codex-fallback-3] plan-quality-gate augmented task bodies', { count: augmented });
  }

  return { plan: out.join(''), augmented };
}

async function evaluatePlan({ plan, workItem, project, projectConfig }) {
  // Auto-augment: inject acceptance criterion into tasks that lack one.
  let activePlan = plan;
  if (projectConfig && projectConfig.verify_command) {
    try {
      const aug = augmentPlanMarkdown(activePlan, projectConfig, null);
      activePlan = aug.plan;
    } catch (err) {
      // Fall through with original plan on unexpected augmentation error.
      void err;
    }
  }
  const { hardFails, warnings } = runDeterministicRules(activePlan);
  if (hardFails.length > 0) {
    const feedbackPrompt = buildFeedbackPrompt(hardFails, warnings, null);
    return { passed: false, hardFails, warnings, llmCritique: null, feedbackPrompt };
  }
  const critique = await module.exports.runLlmSemanticCheck({ plan: activePlan, workItem, project });
  const isNoGo = typeof critique === 'string' && critique.startsWith('[no-go]');
  if (isNoGo) {
    const cleanCritique = critique.replace(/^\[no-go\]\s*/, '');
    if (isUnsupportedWorktreeSetupCritique(cleanCritique)) {
      return { passed: true, hardFails: [], warnings, llmCritique: null, feedbackPrompt: null };
    }
    const feedbackPrompt = buildFeedbackPrompt([], warnings, cleanCritique);
    return { passed: false, hardFails: [], warnings, llmCritique: cleanCritique, feedbackPrompt };
  }
  // Codegraph augmentation: only when the gate already approved the plan,
  // because we don't want to spend SQLite roundtrips on plans that need a
  // rewrite anyway. checkPlanImpact is non-throwing and returns [] silently
  // when codegraph isn't available, so a missing index can't stall the gate.
  const codegraphWarnings = await checkPlanImpact({
    plan: activePlan,
    repoPath: project && typeof project.path === 'string' ? project.path : null,
  });
  const allWarnings = codegraphWarnings.length > 0
    ? warnings.concat(codegraphWarnings)
    : warnings;
  return { passed: true, hardFails: [], warnings: allWarnings, llmCritique: critique, feedbackPrompt: null };
}

module.exports = {
  MAX_REPLAN_ATTEMPTS,
  LLM_TIMEOUT_MS,
  RULES,
  runDeterministicRules,
  runLlmSemanticCheck,
  buildFeedbackPrompt,
  isUnsupportedWorktreeSetupCritique,
  augmentPlanMarkdown,
  evaluatePlan,
};
