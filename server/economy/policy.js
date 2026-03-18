// Economy Mode — routing policy for cost-aware provider selection

'use strict';

const { safeJsonParse } = require('../utils/json');

function getDb() {
  return require('../database');
}

const DEFAULT_POLICY = {
  enabled: false,
  trigger: null,
  reason: null,
  auto_trigger_threshold: 85,
  auto_lift_conditions: {
    budget_reset: true,
    codex_recovered: true,
    utilization_below: 50,
  },
  complexity_exempt: true,
  provider_tiers: {
    preferred: ['hashline-ollama', 'aider-ollama', 'ollama', 'google-ai', 'groq', 'openrouter', 'ollama-cloud', 'cerebras'],
    allowed: ['deepinfra', 'hyperbolic'],
    blocked: ['codex', 'claude-cli'],
  },
};

function getDefaultPolicy() {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY));
}

function getGlobalEconomyPolicy() {
  const db = getDb();
  try {
    const raw = db.getConfig('economy_policy');
    if (!raw) return null;
    return safeJsonParse(raw, null);
  } catch {
    return null;
  }
}

function setGlobalEconomyPolicy(policy) {
  const db = getDb();
  if (policy === null) {
    db.setConfig('economy_policy', null);
    return;
  }

  const defaults = getDefaultPolicy();
  const merged = { ...defaults, ...policy };
  if (policy.provider_tiers && typeof policy.provider_tiers === 'object') {
    merged.provider_tiers = { ...defaults.provider_tiers, ...policy.provider_tiers };
  }
  db.setConfig('economy_policy', JSON.stringify(merged));
}

function getWorkflowEconomyPolicy(workflowId) {
  const db = getDb();
  if (!workflowId) return null;

  try {
    const wf = db.getWorkflow(workflowId);
    if (!wf || !wf.economy_policy) return null;
    return safeJsonParse(wf.economy_policy, null);
  } catch {
    return null;
  }
}

function getProjectEconomyPolicy(workingDirectory) {
  const db = getDb();
  if (!workingDirectory) return null;

  try {
    const config = db.getProjectConfig(workingDirectory);
    if (!config || !config.economy_policy) return null;
    return typeof config.economy_policy === 'string'
      ? safeJsonParse(config.economy_policy, null)
      : config.economy_policy;
  } catch {
    return null;
  }
}

/**
 * Resolve effective economy policy. First non-null wins:
 * task > workflow > project > global
 *
 * @param {Object} taskArgs - Task submission args (may have .economy)
 * @param {string|null} workflowId
 * @param {string|null} workingDirectory
 * @returns {Object|null} Resolved policy or null (economy off)
 */
function resolveEconomyPolicy(taskArgs, workflowId, workingDirectory) {
  const taskEconomy = taskArgs ? taskArgs.economy : undefined;

  if (taskEconomy === false) return null;
  if (taskEconomy === true) return { ...getDefaultPolicy(), enabled: true, trigger: 'manual' };
  if (taskEconomy && typeof taskEconomy === 'object') {
    return { ...getDefaultPolicy(), trigger: 'manual', ...taskEconomy, enabled: true };
  }

  const wfPolicy = getWorkflowEconomyPolicy(workflowId);
  if (wfPolicy) return wfPolicy.enabled ? { ...getDefaultPolicy(), ...wfPolicy } : null;

  const projPolicy = getProjectEconomyPolicy(workingDirectory);
  if (projPolicy) return projPolicy.enabled ? { ...getDefaultPolicy(), ...projPolicy } : null;

  const globalPolicy = getGlobalEconomyPolicy();
  if (globalPolicy && globalPolicy.enabled) return { ...getDefaultPolicy(), ...globalPolicy };

  return null;
}

/**
 * Filter providers based on economy policy tiers.
 * Returns { providers, preferred, allowed, blocked, isEconomy } or null if no filtering needed.
 */
function filterProvidersForEconomy(policy) {
  if (!policy || !policy.enabled) return null;

  const { preferred, allowed, blocked } = policy.provider_tiers;
  const providers = [...(preferred || []), ...(allowed || [])];

  return {
    providers,
    preferred: preferred || [],
    allowed: allowed || [],
    blocked: blocked || [],
    isEconomy: true,
  };
}

const ECONOMY_STATE = {
  OFF: 'off',
  AUTO: 'auto',
  MANUAL: 'manual',
};

function getEconomyState() {
  const policy = getGlobalEconomyPolicy();
  if (!policy || !policy.enabled) return ECONOMY_STATE.OFF;
  return policy.trigger === 'auto' ? ECONOMY_STATE.AUTO : ECONOMY_STATE.MANUAL;
}

module.exports = {
  DEFAULT_POLICY,
  ECONOMY_STATE,
  getDefaultPolicy,
  getGlobalEconomyPolicy,
  setGlobalEconomyPolicy,
  getWorkflowEconomyPolicy,
  getProjectEconomyPolicy,
  resolveEconomyPolicy,
  filterProvidersForEconomy,
  getEconomyState,
};
