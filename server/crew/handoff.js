'use strict';

const HANDOFF_TAG = Symbol.for('torque.crew.handoff');
const handoffAgents = new Map();
const handoffHistoryByTask = new Map();

function clonePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return {};
  }
  return { ...patch };
}

function requireAgentName(agent) {
  if (!agent || typeof agent !== 'string' || agent.trim().length === 0) {
    throw new Error('createHandoff: agent name required');
  }
  return agent.trim();
}

function normalizeRegistryKey(agentName) {
  return requireAgentName(agentName).toLowerCase();
}

function normalizeToolList(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  const normalized = [];
  for (const toolName of tools) {
    if (typeof toolName !== 'string') {
      continue;
    }
    const trimmed = toolName.trim();
    if (!trimmed || normalized.includes(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function buildHandoffToolName(agentName) {
  const normalizedAgent = requireAgentName(agentName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `handoff_to_${normalizedAgent || 'agent'}`;
}

function createHandoff(agent, { contextPatch = {} } = {}) {
  const normalizedAgent = requireAgentName(agent);
  const normalizedPatch = clonePatch(contextPatch);

  return { [HANDOFF_TAG]: true, __handoff: true, agent: normalizedAgent, contextPatch: normalizedPatch };
}

function isHandoff(x) {
  return !!(x && typeof x === 'object' && x[HANDOFF_TAG] === true);
}

function createHandoffWrapper(agentName) {
  const normalizedAgent = requireAgentName(agentName);
  return function handoffWrapper(args = {}) {
    const normalizedArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const patchSource = normalizedArgs.context_patch ?? normalizedArgs.contextPatch ?? {};
    return createHandoff(normalizedAgent, { contextPatch: patchSource });
  };
}

function registerHandoffAgent({ name, systemPrompt, tools = [] }) {
  const normalizedName = requireAgentName(name);
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
    throw new Error('registerHandoffAgent: systemPrompt required');
  }

  const now = new Date().toISOString();
  const key = normalizeRegistryKey(normalizedName);
  const existing = handoffAgents.get(key);
  const record = {
    name: normalizedName,
    systemPrompt: systemPrompt.trim(),
    tools: normalizeToolList(tools),
    wrapperTool: buildHandoffToolName(normalizedName),
    wrapper: existing?.wrapper || createHandoffWrapper(normalizedName),
    registeredAt: existing?.registeredAt || now,
    updatedAt: now,
  };
  handoffAgents.set(key, record);
  return { ...record, tools: [...record.tools] };
}

function getHandoffAgent(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return null;
  }
  const record = handoffAgents.get(normalizeRegistryKey(name));
  return record ? { ...record, tools: [...record.tools] } : null;
}

function getHandoffWrapper(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return null;
  }
  return handoffAgents.get(normalizeRegistryKey(name))?.wrapper || null;
}

function recordHandoffHistory(taskId, entry) {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    return [];
  }
  const normalizedTaskId = taskId.trim();
  const historyEntry = {
    from: typeof entry?.from === 'string' && entry.from.trim().length > 0 ? entry.from.trim() : 'unknown',
    to: requireAgentName(entry?.to),
    at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
    patch: clonePatch(entry?.patch ?? entry?.contextPatch),
    workflow_id: typeof entry?.workflow_id === 'string' && entry.workflow_id.trim().length > 0
      ? entry.workflow_id.trim()
      : null,
  };

  const current = handoffHistoryByTask.get(normalizedTaskId) || [];
  current.push(historyEntry);
  handoffHistoryByTask.set(normalizedTaskId, current);
  return current.map((item) => ({ ...item, patch: clonePatch(item.patch) }));
}

function getHandoffHistory(taskId) {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    return [];
  }
  const current = handoffHistoryByTask.get(taskId.trim()) || [];
  return current.map((item) => ({ ...item, patch: clonePatch(item.patch) }));
}

function resetHandoffState() {
  handoffAgents.clear();
  handoffHistoryByTask.clear();
}

module.exports = {
  createHandoff,
  isHandoff,
  HANDOFF_TAG,
  buildHandoffToolName,
  createHandoffWrapper,
  registerHandoffAgent,
  getHandoffAgent,
  getHandoffWrapper,
  recordHandoffHistory,
  getHandoffHistory,
  resetHandoffState,
};
