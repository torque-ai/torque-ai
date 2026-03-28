'use strict';
const { defaultContainer } = require('../container');

async function handleGetCircuitBreakerStatus(args) {
  const cb = defaultContainer.get('circuitBreaker');
  if (!cb) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Circuit breaker not initialized' }) }] };
  }
  if (args.provider) {
    const state = cb.getState(args.provider);
    return { content: [{ type: 'text', text: JSON.stringify(state) }] };
  }
  const states = cb.getAllStates();
  return { content: [{ type: 'text', text: JSON.stringify({ tripped_providers: states }) }] };
}

module.exports = { handleGetCircuitBreakerStatus };
