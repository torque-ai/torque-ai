'use strict';

function codeRouter(fn) {
  return {
    kind: 'code',
    async pick({ roles, state, turn }) {
      const name = await fn(state, turn);
      if (name === null || name === undefined) return null;
      if (!roles.find((role) => role.name === name)) {
        throw new Error(`codeRouter returned unknown agent: ${name}`);
      }
      return name;
    },
  };
}

function roundRobinRouter() {
  return {
    kind: 'round_robin',
    async pick({ roles, turn }) {
      return roles[turn.turn_count % roles.length].name;
    },
  };
}

function llmRouter({ name = 'router', callAgent, logger = console }) {
  return {
    kind: 'llm',
    async pick({ roles, state, turn }) {
      const prompt = `You are ${name}, the turn router for a multi-agent crew. Choose which agent should speak next, or stop the crew.

Available agents:
${roles.map((role) => `- ${role.name}${role.description ? `: ${role.description}` : ''}`).join('\n')}

Current state:
${JSON.stringify(state).slice(0, 2000)}

Recent turns (most recent last):
${(turn.history || []).slice(-6).map((entry) => `- ${entry.agent}: ${JSON.stringify(entry.output).slice(0, 200)}`).join('\n')}

Respond with strict JSON: { "next_agent": "<name>" | null, "reason": "..." }.
Return null when the crew's objective is complete or further turns would add nothing.`;

      let response;
      try {
        response = await callAgent({ prompt });
      } catch (err) {
        logger.warn?.('llmRouter call failed', err);
        return null;
      }

      let parsed;
      try {
        parsed = JSON.parse(response.content);
      } catch {
        logger.warn?.('llmRouter response not JSON', { content: response.content });
        return null;
      }

      if (parsed.next_agent === null || parsed.next_agent === undefined) {
        return null;
      }

      if (!roles.find((role) => role.name === parsed.next_agent)) {
        logger.warn?.('llmRouter picked unknown agent', { name: parsed.next_agent });
        return null;
      }

      return parsed.next_agent;
    },
  };
}

function hybridRouter({ shortlist, chooser, logger = console }) {
  return {
    kind: 'hybrid',
    async pick({ roles, state, turn }) {
      const narrow = await shortlist(state, turn);
      if (!narrow || narrow.length === 0) return null;
      if (narrow.length === 1) return narrow[0];
      const candidates = roles.filter((role) => narrow.includes(role.name));
      const llm = llmRouter({ callAgent: chooser.callAgent, logger });
      return llm.pick({ roles: candidates, state, turn });
    },
  };
}

module.exports = { codeRouter, llmRouter, hybridRouter, roundRobinRouter };
