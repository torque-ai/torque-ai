'use strict';

function createStarvationRecovery({ submitScout, updateLoopState, dwellMs, now = () => Date.now() }) {
  async function maybeRecover(project) {
    if (!project || project.loop_state !== 'STARVED') {
      return { recovered: false, reason: 'not_starved' };
    }
    const lastActionMs = project.loop_last_action_at
      ? new Date(project.loop_last_action_at).getTime()
      : 0;
    if (now() - lastActionMs < dwellMs) {
      return { recovered: false, reason: 'dwell_not_elapsed' };
    }

    await submitScout({
      project_id: project.id,
      project_path: project.path,
      variants: ['quality', 'security', 'performance', 'documentation', 'test-coverage', 'dependency'],
      reason: 'factory_starvation_recovery',
    });

    updateLoopState(project.id, {
      loop_state: 'SENSE',
      last_action_at: new Date(now()).toISOString(),
    });

    return { recovered: true };
  }

  return { maybeRecover };
}

module.exports = { createStarvationRecovery };
