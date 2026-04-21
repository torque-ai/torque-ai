'use strict';

const PROVIDER_CHAINS = {
  codex: ['deepinfra', 'hyperbolic', 'claude-cli'],
  'codex-spark': ['deepinfra', 'codex'],
  'claude-cli': ['codex', 'deepinfra'],
  ollama: ['cerebras', 'groq', 'deepinfra'],
  deepinfra: ['hyperbolic', 'codex'],
  hyperbolic: ['deepinfra', 'codex'],
  groq: ['cerebras', 'ollama'],
  cerebras: ['groq', 'ollama'],
};
const DEFAULT_FALLBACK = ['deepinfra', 'codex'];

module.exports = {
  name: 'fallback_provider',
  applicable_categories: ['plan_failure', 'sandbox_interrupt', 'provider_overload'],
  max_attempts_per_project: 2,

  async run({ project, decision, services }) {
    if (typeof services.smartSubmitTask !== 'function') {
      throw new Error('fallback_provider requires services.smartSubmitTask');
    }
    const lastProvider = decision?.outcome?.last_provider || decision?.outcome?.provider || null;
    const candidates = (PROVIDER_CHAINS[lastProvider] || DEFAULT_FALLBACK)
      .filter((p) => p !== lastProvider);
    const providerHint = candidates[0] || 'deepinfra';
    const workItemId = decision?.outcome?.work_item_id || null;

    await services.smartSubmitTask({
      project_id: project.id, work_item_id: workItemId,
      provider_hint: providerHint,
      original_stage: decision?.stage || 'plan',
      context: 'auto_recovery_fallback_provider',
    });

    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'fallback_provider', prev_provider: lastProvider, new_provider: providerHint },
    };
  },
};
