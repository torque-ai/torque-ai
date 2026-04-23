'use strict';

const HEURISTIC_RULES = [
  { agent_id: 'billing', keywords: ['refund', 'invoice', 'charge', 'billing', 'payment'] },
  { agent_id: 'support', keywords: ['login', 'cannot', 'error', 'broken', 'password', 'support'] },
  { agent_id: 'sales', keywords: ['price', 'pricing', 'upgrade', 'plan', 'sales'] },
];

const FOLLOW_UP_RE = /^(again|tell me more|more|continue)$/i;

function hasAgent(agents, agentId) {
  return agents.some((agent) => agent && agent.id === agentId);
}

function heuristicClassify({ userInput, history = [], agents = [] } = {}) {
  const normalizedInput = typeof userInput === 'string' ? userInput.trim() : '';
  const text = normalizedInput.toLowerCase();
  const transcript = Array.isArray(history) ? history : [];
  const availableAgents = Array.isArray(agents) ? agents : [];

  if (FOLLOW_UP_RE.test(normalizedInput)) {
    const last = [...transcript]
      .reverse()
      .find((message) => message && message.agent_id && hasAgent(availableAgents, message.agent_id));

    if (last) {
      return { agent_id: last.agent_id, confidence: 0.6 };
    }
  }

  for (const rule of HEURISTIC_RULES) {
    if (!hasAgent(availableAgents, rule.agent_id)) continue;
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      return { agent_id: rule.agent_id, confidence: 0.8 };
    }
  }

  return { agent_id: null, confidence: 0 };
}

function createTurnClassifier({ adapter = 'heuristic', classifyFn } = {}) {
  return {
    async classify(args = {}) {
      if (adapter === 'heuristic') return heuristicClassify(args);

      if (adapter === 'llm') {
        if (typeof classifyFn !== 'function') {
          throw new Error('llm adapter requires classifyFn');
        }
        return classifyFn(args);
      }

      throw new Error(`unknown adapter: ${adapter}`);
    },
  };
}

module.exports = { createTurnClassifier };
