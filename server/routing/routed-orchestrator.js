'use strict';

function requireFunction(value, fieldName) {
  if (typeof value !== 'function') {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeAgents(agents) {
  if (!agents || typeof agents !== 'object') {
    throw new Error('agents is required');
  }

  if (Array.isArray(agents)) {
    return Object.fromEntries(
      agents
        .filter((agent) => agent && typeof agent.id === 'string' && agent.id.trim().length > 0)
        .map((agent) => [agent.id, agent]),
    );
  }

  return agents;
}

function listAgents(agentsById) {
  return Object.values(agentsById)
    .filter((agent) => agent && typeof agent.id === 'string')
    .map((agent) => ({
      id: agent.id,
      description: typeof agent.description === 'string' ? agent.description : '',
    }));
}

function createRoutedOrchestrator({ classifier, storage, agents, defaultAgent } = {}) {
  if (!classifier || typeof classifier !== 'object') {
    throw new Error('classifier is required');
  }
  if (!storage || typeof storage !== 'object') {
    throw new Error('storage is required');
  }

  requireFunction(classifier.classify, 'classifier.classify');
  requireFunction(storage.append, 'storage.append');
  requireFunction(storage.readSpecialist, 'storage.readSpecialist');
  requireFunction(storage.readGlobal, 'storage.readGlobal');

  const agentsById = normalizeAgents(agents);

  async function routeTurn({ user_id, session_id, userInput }) {
    const history = storage.readGlobal({ user_id, session_id });
    const classification = await classifier.classify({
      userInput,
      history,
      agents: listAgents(agentsById),
    }) || {};
    const { agent_id = null, confidence = 0 } = classification;

    const chosen = (agent_id && agentsById[agent_id]) || agentsById[defaultAgent];
    if (!chosen) {
      throw new Error('no agent available (classifier returned null and no defaultAgent)');
    }
    requireFunction(chosen.respond, `agents.${chosen.id}.respond`);

    storage.append({ user_id, session_id, agent_id: chosen.id, role: 'user', content: userInput });

    const specialistHistory = storage.readSpecialist({ user_id, session_id, agent_id: chosen.id });
    const globalHistory = storage.readGlobal({ user_id, session_id });
    const response = await chosen.respond({
      userInput,
      specialistHistory,
      globalHistory,
    });

    storage.append({ user_id, session_id, agent_id: chosen.id, role: 'assistant', content: response });

    return {
      agent_id: chosen.id,
      response,
      confidence,
      routed: Boolean(agent_id),
    };
  }

  return { routeTurn };
}

module.exports = { createRoutedOrchestrator };
