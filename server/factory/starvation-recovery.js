'use strict';

const { LOOP_STATES } = require('./loop-states');

const DEFAULT_DWELL_MS = 15 * 60 * 1000;

function parseLastActionMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function createStarvationRecovery({
  submitScout,
  updateLoopState,
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

  async function maybeRecover(project) {
    if (!project || project.loop_state !== LOOP_STATES.STARVED) {
      return { recovered: false, reason: 'not_starved' };
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

    const scope = [
      'Factory starvation recovery scout.',
      'The project reached STARVED after repeated PRIORITIZE cycles found no open work items.',
      'Inspect configured plans, recent findings, rejected items, and repo-local TODOs.',
      'Return concrete factory work items or explain why the queue should remain empty.',
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

    const recoveredAt = new Date(now()).toISOString();
    await updateLoopState(project.id, {
      loop_state: LOOP_STATES.SENSE,
      loop_last_action_at: recoveredAt,
      loop_paused_at_stage: null,
      consecutive_empty_cycles: 0,
    });

    return {
      recovered: true,
      reason: 'scout_submitted',
      scout,
    };
  }

  return { maybeRecover };
}

module.exports = {
  DEFAULT_DWELL_MS,
  createStarvationRecovery,
};
