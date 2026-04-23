'use strict';

const { LOOP_STATES } = require('./loop-states');

const DEFAULT_DWELL_MS = 15 * 60 * 1000;

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

function createStarvationRecovery({
  submitScout,
  updateLoopState,
  countOpenWorkItems,
  ingestScoutFindings,
  dwellMs = DEFAULT_DWELL_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (typeof submitScout !== 'function') {
    throw new Error('submitScout is required');
  }
  if (typeof updateLoopState !== 'function') {
    throw new Error('updateLoopState is required');
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

  async function maybeRecover(project) {
    if (!project || project.loop_state !== LOOP_STATES.STARVED) {
      return { recovered: false, reason: 'not_starved' };
    }

    const initialOpenCount = await openWorkItemCount(project);
    if (initialOpenCount > 0) {
      return moveToSense(project, 'open_intake_available', {
        open_work_items: initialOpenCount,
      });
    }

    const lastActionMs = parseLastActionMs(project.loop_last_action_at);
    const elapsedMs = lastActionMs === null ? Infinity : now() - lastActionMs;
    if (elapsedMs < dwellMs) {
      return {
        recovered: false,
        reason: 'dwell_not_elapsed',
        elapsed_ms: elapsedMs,
        dwell_ms: dwellMs,
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
      });
    }

    const postIngestOpenCount = await openWorkItemCount(project);
    if (postIngestOpenCount > 0) {
      return moveToSense(project, 'open_intake_available_after_findings_scan', {
        open_work_items: postIngestOpenCount,
        findings_ingest: findingsIngest,
      });
    }

    const scope = [
      'Factory starvation recovery scout.',
      'The project reached STARVED after repeated PRIORITIZE cycles found no open work items.',
      'Inspect configured plans, recent findings, rejected items, and repo-local TODOs.',
      'Return concrete, code-changing factory work items or explain why the queue should remain empty.',
      'Use the scout signal format with actionable transformation patterns; avoid meta-work about creating more intake.',
    ].join(' ');

    const scout = await submitScout({
      project_id: project.id,
      project_path: project.path,
      working_directory: project.path,
      reason: 'factory_starvation_recovery',
      provider: 'codex',
      timeout_minutes: 30,
      scope,
      file_patterns: [
        'docs/superpowers/plans/**/*.md',
        'docs/findings/**/*.md',
        'server/**/*.js',
        'dashboard/src/**/*.{js,jsx,ts,tsx}',
      ],
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
      };
    }

    await parkStarved(project);

    return {
      recovered: false,
      reason: 'scout_submitted_waiting_for_intake',
      scout,
      findings_ingest: findingsIngest,
    };
  }

  return { maybeRecover };
}

module.exports = {
  DEFAULT_DWELL_MS,
  createStarvationRecovery,
};
