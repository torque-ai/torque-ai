'use strict';

const Ajv = require('ajv');
const { createContextVariables } = require('./context-variables');
const { isHandoff, recordHandoffHistory } = require('./handoff');
const { roundRobinRouter } = require('./routers');
const { normalizeMetadata } = require('../utils/normalize-metadata');

const ajv = new Ajv({ allErrors: true, strict: false });

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

function reducer(state, turn) {
  return { ...state, [turn.role]: turn.output };
}

function extractRoleOutput(result) {
  return result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'output')
    ? result.output
    : result;
}

async function runCrew(opts = {}) {
  const {
    objective,
    roles,
    mode = 'round_robin',
    max_rounds = 5,
    output_schema,
    router = null,
    callRole,
  } = opts;

  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('runCrew: roles must be a non-empty array');
  }
  if (typeof callRole !== 'function') {
    throw new Error('runCrew: callRole must be a function');
  }
  if (!Number.isInteger(max_rounds) || max_rounds < 1) {
    throw new Error('runCrew: max_rounds must be a positive integer');
  }

  const activeRouter = router || roundRobinRouter();
  if (!activeRouter || typeof activeRouter.pick !== 'function') {
    throw new Error('runCrew: router must implement pick({ roles, state, turn })');
  }

  const validate = output_schema ? ajv.compile(output_schema) : null;
  const history = [];

  for (let turn_count = 0; turn_count < max_rounds * roles.length; turn_count += 1) {
    const nextAgentName = await activeRouter.pick({
      roles,
      state: history.reduce(reducer, {}),
      turn: { turn_count, history, mode },
    });
    if (nextAgentName === null) {
      return {
        terminated_by: 'router_stopped',
        rounds: turn_count,
        history,
        final_output: history[history.length - 1]?.output || null,
      };
    }

    const role = roles.find((entry) => entry.name === nextAgentName);
    if (!role) {
      throw new Error(`runCrew: router returned unknown role "${nextAgentName}"`);
    }

    const result = await callRole({ role, history, objective });
    const output = extractRoleOutput(result);
    history.push({ role: role.name, agent: role.name, turn_count, output });

    if (validate && validate(output)) {
      return {
        terminated_by: 'output_matched_schema',
        rounds: turn_count + 1,
        history,
        final_output: output,
      };
    }
  }

  return {
    terminated_by: 'max_rounds',
    rounds: max_rounds,
    history,
    final_output: history[history.length - 1]?.output || null,
  };
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

module.exports = { runCrew, runCrewTurn };
