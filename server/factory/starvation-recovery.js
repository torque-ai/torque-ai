'use strict';

const { LOOP_STATES } = require('./loop-states');

const DEFAULT_DWELL_MS = 15 * 60 * 1000;
const MAX_DWELL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_SCOUT_TIMEOUT_MINUTES = 12;
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

    const scope = [
      'Factory starvation recovery scout.',
      'The project reached STARVED after repeated PRIORITIZE cycles found no open work items.',
      'Inspect configured plans, recent findings, rejected items, and repo-local TODOs.',
      'Return concrete, code-changing factory work items or explain why the queue should remain empty.',
      'Use the scout signal format with actionable transformation patterns; avoid meta-work about creating more intake.',
      'Keep the pass bounded: inspect at most 80 candidate files, prefer plan/findings/docs evidence first, and only inspect source files referenced by that evidence.',
      `Current no-yield scout backoff count: ${noYieldScoutCount}.`,
    ].join(' ');

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

    const scout = await submitScout({
      project_id: project.id,
      project_path: project.path,
      working_directory: project.path,
      reason: 'factory_starvation_recovery',
      ...(scoutProvider ? { provider: scoutProvider } : {}),
      timeout_minutes: scoutTimeoutMinutes,
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
  DEFAULT_SCOUT_FILE_PATTERNS,
  countConsecutiveNoYieldScouts,
  computeBackoffDwellMs,
  isNoYieldScoutTask,
  createStarvationRecovery,
};
