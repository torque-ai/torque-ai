'use strict';

const { LOOP_STATES } = require('./loop-states');

const DEFAULT_DWELL_MS = 15 * 60 * 1000;
const MAX_DWELL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_SCOUT_TIMEOUT_MINUTES = 12;
// Codex does deeper recon than ollama (full directory tree walks, multi-tool
// reasoning) and routinely needs ~15-25 min on a fresh repo. The 12-minute
// default works for ollama (which converges fast — sometimes by hallucinating)
// but kills codex mid-investigation; a real DLPhone scout was observed
// timing out at 12m while it was still emitting __PATTERNS_READY__ deferrals
// and actively reading real source files (2026-04-30, c0f278ca).
const SCOUT_TIMEOUT_MINUTES_BY_PROVIDER = Object.freeze({
  codex: 30,
  'codex-spark': 30,
  'claude-cli': 30,
});
const ACTIVE_SCOUT_STATUSES = new Set(['pending', 'pending_approval', 'queued', 'running', 'waiting']);
const TERMINAL_SCOUT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const SCOUT_SIGNAL_MARKERS = [
  '__SCOUT_COMPLETE__',
  '__PATTERNS_READY__',
  '__SCOUT_DISCOVERY__',
];
const DEFAULT_SCOUT_FILE_PATTERNS = [
  'docs/superpowers/plans/**/*.md',
  'docs/findings/**/*.md',
  'docs/**/*.md',
  'README*',
  'CHANGELOG*',
  'TODO*',
];

function parseLastActionMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the scope text for a starvation recovery scout.
 *
 * Two failure modes drove the rewrite of the original scope text on
 * 2026-04-29 (DLPhone scouts e50cfe25 and c6549cc0, both run on
 * qwen3-coder:30b):
 *
 *  1. The original scope led with "Factory starvation recovery scout."
 *     Small models read "factory" as a domain noun and produced
 *     patterns about *factory infrastructure* (queue monitoring,
 *     starvation recovery plans, work-item prioritization rules) for
 *     a Unity/.NET multiplayer game project. The model never realized
 *     "factory" was the autonomous build pipeline.
 *
 *  2. The example-rich scout system prompt seduced the model into
 *     emitting plausible-looking exemplar_files without ever calling
 *     read_file or list_directory. Without explicit "your output must
 *     be grounded in real tool calls" wording, qwen3-coder defaulted
 *     to invention.
 *
 * The new scope leads with the project's own brief (so "factory"
 * lands as "automated build pipeline, not your topic"), names the
 * project explicitly, and adds an evidence requirement: exemplar_files
 * MUST come from list_directory / search_files results, and an empty
 * patterns array is a valid signal when nothing actionable shows up.
 *
 * Phase B's existence guard at the intake boundary still catches any
 * residual hallucination — this scope change just stops feeding the
 * model the wrong frame in the first place.
 */
function buildStarvationRecoveryScope({ project, noYieldScoutCount }) {
  const projectName = (project?.name || '').trim() || 'this project';
  const rawBrief = (project?.brief || '').trim();
  const brief = rawBrief ? rawBrief : null;

  const lines = [
    `You are scouting the **${projectName}** codebase to seed new work items for the autonomous build pipeline.`,
    '',
  ];

  if (brief) {
    lines.push('## Project context');
    lines.push(brief);
    lines.push('');
  }

  lines.push('## Disambiguation');
  lines.push(
    `In this scope, "factory" refers to the autonomous build pipeline that processes work items — NOT to ${projectName}'s domain. ` +
    `Your work items must be about ${projectName}'s actual code (its source tree, tests, config, docs), ` +
    `not about queue monitoring, starvation recovery, or generic factory/pipeline concepts.`
  );
  lines.push('');

  lines.push('## Why we are scouting');
  lines.push(
    `${projectName}'s build pipeline queue is empty after repeated PRIORITIZE cycles found no open work items. ` +
    `Walk the actual codebase, find concrete code-level transformations the project genuinely needs, ` +
    'and produce work items that name real files in the tree.'
  );
  lines.push('');

  lines.push('## Output format — prefer concrete work items');
  lines.push(
    `Two output formats are available; for ${projectName} you should strongly prefer the second.`
  );
  lines.push('');
  lines.push(
    '**Loose patterns** (`__PATTERNS_READY__`) describe a transformation pattern that spans many files. ' +
    'These are useful for sweep-style refactors but the architect that consumes them has trouble ' +
    'turning a pattern description into a concrete plan that passes the deterministic plan-quality ' +
    'gate. Each loose pattern downstream consumes 5 architect retries before being auto-rejected.'
  );
  lines.push('');
  lines.push(
    '**Concrete work items** (`__SCOUT_COMPLETE__` with a `concrete_factory_work_items` array) ' +
    'are tightly-scoped, single-batch units of work. Each item should include:'
  );
  lines.push('  - `title` — short imperative ("Add X test for Y in Z.cs")');
  lines.push('  - `why` — one-sentence motivation (the missing coverage / bug / inconsistency)');
  lines.push('  - `description` — what the worker will do, naming the exact files to change');
  lines.push('  - `allowed_files` — array of repo-relative paths the worker MAY touch');
  lines.push('  - `verification` — exact command (e.g. `dotnet test ... --filter ...`)');
  lines.push('');
  lines.push(
    `Concrete items succeed at much higher rates than loose patterns because the architect can use ` +
    `\`allowed_files\` and \`verification\` directly in plan tasks. Aim for 3-5 small concrete items ` +
    `over 1-2 sweeping patterns. If you only have evidence for sweeping patterns, emit them — but ` +
    `concrete is preferred.`
  );
  lines.push('');

  lines.push('## Evidence requirement (CRITICAL)');
  lines.push(
    'Every pattern OR concrete item MUST have at least one path you observed via `list_directory` ' +
    'or `search_files`. You may NOT invent file paths. Before emitting any signal, call ' +
    '`list_directory` on the working directory at least once. ' +
    `If after exploring you cannot find concrete code-level work specific to ${projectName}, ` +
    'return an empty `patterns` array AND an empty `concrete_factory_work_items` array. ' +
    'An empty result is a valid signal — invented work is not.'
  );
  lines.push('');

  lines.push('## Scope bounds');
  lines.push(
    'Inspect at most 80 candidate files. Prefer existing test files, docs, recent plan files, and TODO comments as evidence sources. ' +
    'Avoid meta-work about creating more intake or improving the scout itself.'
  );
  lines.push('');

  lines.push(`No-yield scout backoff count: ${noYieldScoutCount}.`);

  return lines.join('\n');
}

function normalizeCount(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getCreatedCount(result) {
  if (!result) {
    return 0;
  }
  if (Array.isArray(result.created)) {
    return result.created.length;
  }
  return normalizeCount(result.created_count);
}

function normalizeTasks(tasks) {
  return Array.isArray(tasks) ? tasks.filter(Boolean) : [];
}

function getTaskStatus(task) {
  return String(task?.status || '').trim().toLowerCase();
}

function getTaskId(task) {
  return typeof task?.id === 'string' && task.id.trim() ? task.id.trim() : null;
}

function scoutOutputHasActionableSignal(task) {
  const text = [
    task?.output,
    task?.partial_output,
  ].filter((value) => typeof value === 'string' && value.length > 0).join('\n');
  return SCOUT_SIGNAL_MARKERS.some((marker) => text.includes(marker));
}

function isNoYieldScoutTask(task) {
  const status = getTaskStatus(task);
  if (!TERMINAL_SCOUT_STATUSES.has(status)) {
    return false;
  }
  if (status === 'completed') {
    return !scoutOutputHasActionableSignal(task);
  }
  return true;
}

function countConsecutiveNoYieldScouts(tasks) {
  let count = 0;
  for (const task of normalizeTasks(tasks)) {
    const status = getTaskStatus(task);
    if (ACTIVE_SCOUT_STATUSES.has(status)) {
      continue;
    }
    if (!TERMINAL_SCOUT_STATUSES.has(status)) {
      continue;
    }
    if (!isNoYieldScoutTask(task)) {
      break;
    }
    count += 1;
  }
  return count;
}

function computeBackoffDwellMs(baseDwellMs, noYieldScoutCount, maxDwellMs = MAX_DWELL_MS) {
  const base = Number.isFinite(Number(baseDwellMs)) && Number(baseDwellMs) > 0
    ? Number(baseDwellMs)
    : DEFAULT_DWELL_MS;
  const failures = Math.max(0, Number(noYieldScoutCount) || 0);
  return Math.min(base * (2 ** failures), maxDwellMs);
}

function summarizeActiveScout(tasks) {
  const active = normalizeTasks(tasks).filter((task) => ACTIVE_SCOUT_STATUSES.has(getTaskStatus(task)));
  const first = active[0] || null;
  return {
    active,
    existing_task_id: getTaskId(first),
    active_scout_count: active.length,
  };
}

function createStarvationRecovery({
  submitScout,
  updateLoopState,
  countOpenWorkItems,
  ingestScoutFindings,
  ingestScoutOutputs,
  listActiveScouts,
  listRecentScouts,
  resolveScoutProvider,
  dwellMs = DEFAULT_DWELL_MS,
  maxDwellMs = MAX_DWELL_MS,
  scoutTimeoutMinutes = DEFAULT_SCOUT_TIMEOUT_MINUTES,
  scoutFilePatterns = DEFAULT_SCOUT_FILE_PATTERNS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (typeof submitScout !== 'function') {
    throw new Error('submitScout is required');
  }
  if (typeof updateLoopState !== 'function') {
    throw new Error('updateLoopState is required');
  }

  async function activeScouts(project) {
    if (typeof listActiveScouts !== 'function') {
      return [];
    }
    try {
      return normalizeTasks(await listActiveScouts(project));
    } catch (err) {
      logger.warn?.('Starvation recovery active scout lookup failed', {
        project_id: project.id,
        err: err.message,
      });
      return [];
    }
  }

  async function recentScouts(project) {
    if (typeof listRecentScouts !== 'function') {
      return [];
    }
    try {
      return normalizeTasks(await listRecentScouts(project));
    } catch (err) {
      logger.warn?.('Starvation recovery scout history lookup failed', {
        project_id: project.id,
        err: err.message,
      });
      return [];
    }
  }

  async function openWorkItemCount(project) {
    if (typeof countOpenWorkItems !== 'function') {
      return 0;
    }
    try {
      return normalizeCount(await countOpenWorkItems(project.id, project));
    } catch (err) {
      logger.warn?.('Starvation recovery open-work-item count failed', {
        project_id: project.id,
        err: err.message,
      });
      return 0;
    }
  }

  async function moveToSense(project, reason, extra = {}) {
    const recoveredAt = new Date(now()).toISOString();
    await updateLoopState(project.id, {
      loop_state: LOOP_STATES.SENSE,
      loop_last_action_at: recoveredAt,
      loop_paused_at_stage: null,
      consecutive_empty_cycles: 0,
    });

    return {
      recovered: true,
      reason,
      ...extra,
    };
  }

  async function parkStarved(project) {
    const checkedAt = new Date(now()).toISOString();
    const emptyCycles = Number(project.consecutive_empty_cycles);
    await updateLoopState(project.id, {
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: checkedAt,
      loop_paused_at_stage: null,
      consecutive_empty_cycles: Number.isFinite(emptyCycles)
        ? emptyCycles
        : 0,
    });
  }

  async function maybeRecover(project, options = {}) {
    if (!project || project.loop_state !== LOOP_STATES.STARVED) {
      return { recovered: false, reason: 'not_starved' };
    }

    const force = options.force === true || options.skipDwell === true;
    const trigger = typeof options.trigger === 'string' && options.trigger.trim()
      ? options.trigger.trim()
      : null;
    const context = {
      ...(force ? { forced: true } : {}),
      ...(trigger ? { trigger } : {}),
    };

    const initialOpenCount = await openWorkItemCount(project);
    if (initialOpenCount > 0) {
      return moveToSense(project, 'open_intake_available', {
        open_work_items: initialOpenCount,
        ...context,
      });
    }

    const activeScoutState = summarizeActiveScout(await activeScouts(project));
    if (activeScoutState.active_scout_count > 0) {
      return {
        recovered: false,
        reason: 'scout_already_running',
        existing_task_id: activeScoutState.existing_task_id,
        active_scout_count: activeScoutState.active_scout_count,
        ...context,
      };
    }

    const scoutHistory = await recentScouts(project);
    const noYieldScoutCount = countConsecutiveNoYieldScouts(scoutHistory);
    const effectiveDwellMs = computeBackoffDwellMs(dwellMs, noYieldScoutCount, maxDwellMs);

    const lastActionMs = parseLastActionMs(project.loop_last_action_at);
    const elapsedMs = lastActionMs === null ? Infinity : now() - lastActionMs;
    if (!force && elapsedMs < effectiveDwellMs) {
      return {
        recovered: false,
        reason: 'dwell_not_elapsed',
        elapsed_ms: elapsedMs,
        dwell_ms: effectiveDwellMs,
        base_dwell_ms: dwellMs,
        no_yield_scout_count: noYieldScoutCount,
      };
    }

    let findingsIngest = null;
    if (typeof ingestScoutFindings === 'function') {
      try {
        findingsIngest = await ingestScoutFindings(project);
      } catch (err) {
        logger.warn?.('Starvation recovery scout findings ingest failed', {
          project_id: project.id,
          err: err.message,
        });
      }
    }

    const createdFromFindings = getCreatedCount(findingsIngest);
    if (createdFromFindings > 0) {
      return moveToSense(project, 'scout_findings_ingested', {
        created_count: createdFromFindings,
        findings_ingest: findingsIngest,
        ...context,
      });
    }

    let scoutOutputIngest = null;
    if (typeof ingestScoutOutputs === 'function') {
      try {
        scoutOutputIngest = await ingestScoutOutputs(project);
      } catch (err) {
        logger.warn?.('Starvation recovery scout output ingest failed', {
          project_id: project.id,
          err: err.message,
        });
      }
    }

    const createdFromScoutOutputs = getCreatedCount(scoutOutputIngest);
    if (createdFromScoutOutputs > 0) {
      return moveToSense(project, 'scout_outputs_ingested', {
        created_count: createdFromScoutOutputs,
        scout_output_ingest: scoutOutputIngest,
        findings_ingest: findingsIngest,
        ...context,
      });
    }

    const postIngestOpenCount = await openWorkItemCount(project);
    if (postIngestOpenCount > 0) {
      return moveToSense(project, 'open_intake_available_after_findings_scan', {
        open_work_items: postIngestOpenCount,
        findings_ingest: findingsIngest,
        scout_output_ingest: scoutOutputIngest,
        ...context,
      });
    }

    const scope = buildStarvationRecoveryScope({ project, noYieldScoutCount });

    let scoutProvider = null;
    if (typeof resolveScoutProvider === 'function') {
      try {
        const resolved = await resolveScoutProvider(project);
        scoutProvider = typeof resolved === 'string' && resolved.trim() ? resolved.trim() : null;
      } catch (err) {
        logger.warn?.('Starvation recovery scout provider resolution failed', {
          project_id: project.id,
          err: err.message,
        });
      }
    }

    const effectiveScoutTimeout = (scoutProvider
      && SCOUT_TIMEOUT_MINUTES_BY_PROVIDER[scoutProvider])
      || scoutTimeoutMinutes;

    const scout = await submitScout({
      project_id: project.id,
      project_path: project.path,
      working_directory: project.path,
      reason: 'factory_starvation_recovery',
      ...(scoutProvider ? { provider: scoutProvider } : {}),
      timeout_minutes: effectiveScoutTimeout,
      scope,
      file_patterns: Array.isArray(scoutFilePatterns) && scoutFilePatterns.length > 0
        ? scoutFilePatterns
        : DEFAULT_SCOUT_FILE_PATTERNS,
    });

    if (scout?.errorCode || scout?.error_code || scout?.isError) {
      logger.warn?.('Starvation recovery scout submission failed', {
        project_id: project.id,
        error: scout.errorMessage || scout.message || scout.error_code || scout.errorCode,
      });
      return {
        recovered: false,
        reason: 'scout_submission_failed',
        scout,
        ...context,
      };
    }

    await parkStarved(project);

    return {
      recovered: false,
      reason: 'scout_submitted_waiting_for_intake',
      scout,
      no_yield_scout_count: noYieldScoutCount,
      dwell_ms: effectiveDwellMs,
      findings_ingest: findingsIngest,
      scout_output_ingest: scoutOutputIngest,
      ...context,
    };
  }

  return { maybeRecover };
}

module.exports = {
  DEFAULT_DWELL_MS,
  MAX_DWELL_MS,
  DEFAULT_SCOUT_TIMEOUT_MINUTES,
  SCOUT_TIMEOUT_MINUTES_BY_PROVIDER,
  DEFAULT_SCOUT_FILE_PATTERNS,
  buildStarvationRecoveryScope,
  countConsecutiveNoYieldScouts,
  computeBackoffDwellMs,
  isNoYieldScoutTask,
  createStarvationRecovery,
};
