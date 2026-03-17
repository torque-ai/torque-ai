'use strict';

const providerRouting = require('../db/provider-routing-core');
const db = require('../database');
const {
  getDefaultPolicy,
  getGlobalEconomyPolicy,
  getProjectEconomyPolicy,
  getWorkflowEconomyPolicy,
  resolveEconomyPolicy,
  filterProvidersForEconomy,
  setGlobalEconomyPolicy,
  deactivateEconomyMode,
} = require('../economy/policy');

function makeTextResult(message, isError = false) {
  const payload = [{ type: 'text', text: message }];
  return isError ? { isError: true, content: payload } : { content: payload };
}

function normalizeScope(scope) {
  return typeof scope === 'string' ? scope.trim().toLowerCase() : '';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizePositiveNumber(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveProjectName(workingDirectory) {
  const wd = normalizeString(workingDirectory);
  if (!wd) return '';
  if (typeof db.getCurrentProject === 'function') return db.getCurrentProject(wd) || '';
  if (typeof db.getProjectFromPath === 'function') return db.getProjectFromPath(wd) || '';
  return '';
}

function unique(values) {
  return Array.from(new Set(values.filter((v) => typeof v === 'string' && v)));
}

function isProviderAvailable(providerId) {
  if (!providerId || !providerRouting) return false;
  if (typeof providerRouting.getProvider !== 'function' || typeof providerRouting.isProviderHealthy !== 'function') {
    return false;
  }

  const provider = providerRouting.getProvider(providerId);
  if (!provider || provider.enabled === false) return false;

  try {
    return Boolean(providerRouting.isProviderHealthy(providerId));
  } catch {
    return Boolean(provider.enabled);
  }
}

function buildPolicy(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  return { ...getDefaultPolicy(), ...payload };
}

function getProjectEconomyLayer(projectName) {
  if (!projectName) return null;
  return buildPolicy(getProjectEconomyPolicy(projectName));
}

function getWorkflowEconomyLayer(workflowId) {
  if (!workflowId) return null;
  return buildPolicy(getWorkflowEconomyPolicy(workflowId));
}

function getGlobalEconomyLayer() {
  return buildPolicy(getGlobalEconomyPolicy());
}

function getEconomyStatusContext(args = {}) {
  const workflowId = normalizeString(args.workflow_id);
  const projectName = resolveProjectName(args.working_directory);

  const workflowPolicy = workflowId ? getWorkflowEconomyLayer(workflowId) : null;
  const projectPolicy = projectName ? getProjectEconomyLayer(projectName) : null;
  const globalPolicy = getGlobalEconomyLayer();

  if (workflowPolicy && workflowPolicy.enabled) {
    return { scope: 'workflow', policy: workflowPolicy };
  }

  if (projectPolicy && projectPolicy.enabled) {
    return { scope: 'project', policy: projectPolicy };
  }

  if (globalPolicy && globalPolicy.enabled) {
    return { scope: 'global', policy: globalPolicy };
  }

  const fallback = workflowPolicy || projectPolicy || globalPolicy || null;
  if (fallback) {
    return {
      scope: workflowId ? 'workflow' : projectName ? 'project' : 'global',
      policy: fallback,
    };
  }

  const resolved = resolveEconomyPolicy(args, workflowId, projectName || args.working_directory);
  if (!resolved) {
    return { scope: workflowId ? 'workflow' : projectName ? 'project' : 'global', policy: null };
  }

  return { scope: 'global', policy: buildPolicy(resolved) };
}

function parseEffectiveProviders(policy) {
  const econFilter = filterProvidersForEconomy(policy);
  const preferred = unique(Array.isArray(econFilter?.preferred) ? econFilter.preferred : []);
  const allowed = unique(Array.isArray(econFilter?.allowed) ? econFilter.allowed : []);
  const blocked = unique(Array.isArray(econFilter?.blocked) ? econFilter.blocked : []);

  const effectiveProviders = unique([...preferred, ...allowed]).filter(isProviderAvailable);

  return {
    blocked,
    preferred,
    effectiveProviders,
  };
}

function rerouteQueuedTasks(policy, workflowId, workingDirectory) {
  try {
    // eslint-disable-next-line global-require
    const queueReroute = require('../economy/queue-reroute');
    if (typeof queueReroute?.rerouteQueuedTasks === 'function') {
      return queueReroute.rerouteQueuedTasks(policy, workflowId, workingDirectory);
    }
  } catch {
    // Optional queue reroute module is currently optional until Task 7 is completed.
  }

  return null;
}

function buildManualPolicy(scope, args = {}) {
  const currentPolicy = getGlobalEconomyPolicy() || getDefaultPolicy();
  const next = {
    ...getDefaultPolicy(),
    ...currentPolicy,
    enabled: true,
    trigger: 'manual',
    reason: `Manual (${scope})`,
  };

  const nextThreshold = normalizePositiveNumber(args.auto_trigger_threshold);
  if (nextThreshold !== undefined) {
    next.auto_trigger_threshold = nextThreshold;
  }

  const complexityExempt = normalizeBoolean(args.complexity_exempt);
  if (complexityExempt !== undefined) {
    next.complexity_exempt = complexityExempt;
  }

  return next;
}

function getEconomyStatus(args = {}) {
  const context = getEconomyStatusContext(args);
  const { scope, policy } = context;
  const effectivePolicy = policy && policy.enabled
    ? buildPolicy(policy)
    : null;
  const enabled = Boolean(effectivePolicy?.enabled);
  const trigger = effectivePolicy?.trigger || null;
  const reason = effectivePolicy?.reason || null;

  const base = {
    state: enabled ? (trigger === 'auto' ? 'auto' : 'manual') : 'off',
    enabled,
    trigger,
    scope,
    reason,
    blocked_providers: [],
    preferred_providers: [],
    effective_providers_available: [],
  };

  if (!effectivePolicy) {
    return base;
  }

  const { blocked, preferred, effectiveProviders } = parseEffectiveProviders(effectivePolicy);
  base.blocked_providers = blocked;
  base.preferred_providers = preferred;
  base.effective_providers_available = effectiveProviders;
  return base;
}

function handleGetEconomyStatus(args = {}) {
  const status = getEconomyStatus(args);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(status),
    }],
  };
}

function handleSetEconomyMode(args = {}) {
  const scope = normalizeScope(args.scope);
  const enabled = normalizeBoolean(args.enabled);
  const workingDirectory = normalizeString(args.working_directory);
  const workflowId = normalizeString(args.workflow_id);

  if (!['global', 'project', 'workflow'].includes(scope)) {
    return makeTextResult(`Invalid scope "${scope || ''}". Expected: global, project, or workflow.`, true);
  }

  if (enabled === undefined) {
    return makeTextResult('enabled is required and must be true or false.', true);
  }

  if (scope === 'project') {
    if (!workingDirectory) {
      return makeTextResult('working_directory is required for project scope.', true);
    }

    const project = resolveProjectName(workingDirectory);
    if (!project) {
      return makeTextResult(`Unable to resolve project from working_directory: ${workingDirectory}`, true);
    }

    if (enabled) {
      const policy = buildManualPolicy('project', args);
      db.setProjectConfig(project, { economy_policy: JSON.stringify(policy) });
      rerouteQueuedTasks(policy, null, workingDirectory);
      return makeTextResult('Economy mode enabled at project scope.');
    }

    db.setProjectConfig(project, { economy_policy: null });
    return makeTextResult('Economy mode disabled at project scope.');
  }

  if (scope === 'workflow') {
    if (!workflowId) {
      return makeTextResult('workflow_id is required for workflow scope.', true);
    }

    if (enabled) {
      const policy = buildManualPolicy('workflow', args);
      const updatedWorkflow = db.updateWorkflow(workflowId, { economy_policy: JSON.stringify(policy) });
      if (!updatedWorkflow) {
        return makeTextResult(`Workflow not found: ${workflowId}`, true);
      }
      rerouteQueuedTasks(policy, workflowId, workingDirectory || null);
      return makeTextResult('Economy mode enabled at workflow scope.');
    }

    const updatedWorkflow = db.updateWorkflow(workflowId, { economy_policy: null });
    if (!updatedWorkflow) {
      return makeTextResult(`Workflow not found: ${workflowId}`, true);
    }
    return makeTextResult('Economy mode disabled at workflow scope.');
  }

  if (enabled) {
    const policy = buildManualPolicy('global', args);
    setGlobalEconomyPolicy(policy);
    rerouteQueuedTasks(policy, null, workingDirectory || null);
    return makeTextResult('Economy mode enabled at global scope.');
  }

  deactivateEconomyMode('Manually disabled via set_economy_mode');
  return makeTextResult('Economy mode disabled at global scope.');
}

module.exports = {
  handleGetEconomyStatus,
  handleSetEconomyMode,
  buildManualPolicy,
  getEconomyStatus,
};
