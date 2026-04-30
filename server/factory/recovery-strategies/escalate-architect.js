'use strict';

const reasonPatterns = [
  /^zero_diff_across_retries$/i,
  /^retry_off_scope$/i,
];

function readProviderChain(factoryHealth, projectId) {
  if (!factoryHealth || typeof factoryHealth.getProject !== 'function') return [];
  const project = factoryHealth.getProject(projectId);
  if (!project) return [];
  const raw = project.provider_chain_json;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : [];
  } catch {
    return [];
  }
}

function readLastUsedProvider(workItem) {
  const raw = workItem.constraints_json;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed.last_used_provider === 'string') {
      return parsed.last_used_provider;
    }
  } catch { /* ignore */ }
  return null;
}

async function replan({ workItem, deps }) {
  const { factoryHealth, logger } = deps;
  const chain = readProviderChain(factoryHealth, workItem.project_id);
  if (chain.length === 0) {
    return { outcome: 'unrecoverable', reason: 'escalate_refused: project provider_chain empty or missing' };
  }
  const lastUsed = readLastUsedProvider(workItem);
  let lastIdx = chain.indexOf(lastUsed);
  if (lastIdx < 0) lastIdx = 0;
  const nextIdx = lastIdx + 1;
  if (nextIdx >= chain.length) {
    return { outcome: 'unrecoverable', reason: 'escalate_refused: already at top of chain' };
  }
  const nextProvider = chain[nextIdx];
  if (logger?.info) {
    logger.info('escalate-architect: bumping provider', {
      work_item_id: workItem.id,
      from: lastUsed,
      to: nextProvider,
    });
  }
  return {
    outcome: 'escalated',
    updates: {
      constraints: {
        architect_provider_override: nextProvider,
        execution_provider_override: nextProvider,
      },
    },
  };
}

module.exports = {
  name: 'escalate-architect',
  reasonPatterns,
  replan,
};
