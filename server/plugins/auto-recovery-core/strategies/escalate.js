'use strict';

module.exports = {
  name: 'escalate',
  applicable_categories: ['unknown', 'terminal', 'any'],
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    if (typeof services.pauseProject === 'function') {
      await services.pauseProject({ project_id: project.id, reason: 'auto_recovery_exhausted' });
    }
    return {
      success: true, next_action: 'escalate',
      outcome: { strategy: 'escalate', last_decision_action: decision?.action || null },
    };
  },
};
