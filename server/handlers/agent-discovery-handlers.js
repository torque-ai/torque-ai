'use strict';

async function handleDiscoverAgents() {
  try {
    const { discoverAgents } = require('../utils/agent-discovery');
    return discoverAgents();
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Agent discovery failed: ${error.message}` }],
      isError: true,
    };
  }
}

function createAgentDiscoveryHandlers() {
  return { handleDiscoverAgents };
}

module.exports = {
  handleDiscoverAgents,
  createAgentDiscoveryHandlers,
};
