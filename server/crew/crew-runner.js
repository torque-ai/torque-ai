'use strict';

const { createContextVariables } = require('./context-variables');
const { isHandoff } = require('./handoff');

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
    getAgent(agents, result.agent);
    state.activeAgent = result.agent;
    if (result.contextPatch) {
      state.contextVariables.merge(result.contextPatch);
    }

    state.handoffHistory = Array.isArray(state.handoffHistory) ? state.handoffHistory : [];
    state.handoffHistory.push({
      from: agent.name || agentName,
      to: result.agent,
      at: Date.now(),
      patch: result.contextPatch,
    });

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
