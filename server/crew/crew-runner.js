'use strict';

const { createContextVariables } = require('./context-variables');
const { isHandoff, recordHandoffHistory } = require('./handoff');
const { normalizeMetadata } = require('../utils/normalize-metadata');

function getTaskCore() {
  try {
    return require('../container').defaultContainer.get('taskCore');
  } catch (_err) {
    try {
      return require('../db/task-core');
    } catch (_innerErr) {
      return null;
    }
  }
}

function normalizeExecutionId(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveExecutionContext(opts = {}, state = {}) {
  return {
    taskId: normalizeExecutionId(
      opts.taskId
      ?? opts.task_id
      ?? opts.__taskId
      ?? state.taskId
      ?? state.task_id
      ?? process.env.TORQUE_TASK_ID
    ),
    workflowId: normalizeExecutionId(
      opts.workflowId
      ?? opts.workflow_id
      ?? opts.__workflowId
      ?? state.workflowId
      ?? state.workflow_id
      ?? process.env.TORQUE_WORKFLOW_ID
    ),
  };
}

function persistTaskHandoffHistory(taskId, history) {
  if (!taskId || !Array.isArray(history) || history.length === 0) {
    return;
  }

  const taskCore = getTaskCore();
  if (!taskCore || typeof taskCore.getTask !== 'function' || typeof taskCore.patchTaskMetadata !== 'function') {
    return;
  }

  const task = taskCore.getTask(taskId);
  if (!task) {
    return;
  }

  const metadata = normalizeMetadata(task.metadata);
  const existingHistory = Array.isArray(metadata.handoff_history) ? metadata.handoff_history : [];
  const mergedHistory = [...existingHistory, ...history];
  const dedupedHistory = [];
  const seen = new Set();
  for (const entry of mergedHistory) {
    const normalizedEntry = {
      from: entry.from,
      to: entry.to,
      at: entry.at,
      patch: entry.patch && typeof entry.patch === 'object' && !Array.isArray(entry.patch) ? { ...entry.patch } : {},
      workflow_id: entry.workflow_id || null,
    };
    const key = `${normalizedEntry.from}|${normalizedEntry.to}|${normalizedEntry.at}|${normalizedEntry.workflow_id || ''}|${JSON.stringify(normalizedEntry.patch)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedupedHistory.push(normalizedEntry);
  }

  metadata.handoff_history = dedupedHistory.map((entry) => ({
    from: entry.from,
    to: entry.to,
    at: entry.at,
    patch: entry.patch && typeof entry.patch === 'object' && !Array.isArray(entry.patch) ? { ...entry.patch } : {},
    workflow_id: entry.workflow_id || null,
  }));
  taskCore.patchTaskMetadata(taskId, metadata);
}

function getAgent(agents, agentName) {
  const agent = agents?.[agentName];

  if (!agent || typeof agent !== 'object') {
    throw new Error(`runCrewTurn: unknown active agent "${agentName}"`);
  }

  return agent;
}

function getTool(agent, agentName, toolName) {
  const tool = agent?.tools?.[toolName];

  if (typeof tool !== 'function') {
    throw new Error(`runCrewTurn: agent "${agentName}" does not implement tool "${toolName}"`);
  }

  return tool;
}

async function runCrewTurn(opts = {}) {
  const { agents, state, toolCall } = opts;

  if (!agents || typeof agents !== 'object') {
    throw new Error('runCrewTurn: agents map required');
  }
  if (!state || typeof state !== 'object') {
    throw new Error('runCrewTurn: state required');
  }
  if (!state.activeAgent || typeof state.activeAgent !== 'string') {
    throw new Error('runCrewTurn: state.activeAgent required');
  }
  if (!toolCall || typeof toolCall.name !== 'string' || toolCall.name.length === 0) {
    throw new Error('runCrewTurn: toolCall.name required');
  }

  if (!state.contextVariables) {
    state.contextVariables = createContextVariables();
  }

  const agentName = state.activeAgent;
  const agent = getAgent(agents, agentName);
  const tool = getTool(agent, agentName, toolCall.name);
  const result = await tool(toolCall.args ?? {}, state.contextVariables);

  if (isHandoff(result)) {
    const executionContext = resolveExecutionContext(opts, state);
    getAgent(agents, result.agent);
    state.activeAgent = result.agent;
    if (result.contextPatch) {
      state.contextVariables.merge(result.contextPatch);
    }

    state.handoffHistory = Array.isArray(state.handoffHistory) ? state.handoffHistory : [];
    const handoffEntry = {
      from: agent.name || agentName,
      to: result.agent,
      at: Date.now(),
      patch: result.contextPatch,
      workflow_id: executionContext.workflowId,
    };
    state.handoffHistory.push(handoffEntry);

    if (executionContext.taskId) {
      const persistedHistory = recordHandoffHistory(executionContext.taskId, handoffEntry);
      persistTaskHandoffHistory(executionContext.taskId, persistedHistory);
    }

    if (opts.chainAutomatically) {
      const maxHandoffs = opts.maxHandoffs ?? 10;
      const handoffCount = (opts._handoffCount ?? 0) + 1;

      if (handoffCount > maxHandoffs) {
        throw new Error(`handoff chain exceeded maxHandoffs=${maxHandoffs}`);
      }

      const nextAgent = agents[result.agent];
      const canReuseTool = typeof nextAgent?.tools?.[toolCall.name] === 'function';

      // Auto-chaining only reuses the current tool; selecting a different next
      // tool is the responsibility of the higher-level crew/model loop.
      if (canReuseTool) {
        return runCrewTurn({ ...opts, _handoffCount: handoffCount });
      }
    }

    return { activeAgent: result.agent, handedOff: true };
  }

  return { activeAgent: state.activeAgent, result };
}

module.exports = { runCrewTurn };
