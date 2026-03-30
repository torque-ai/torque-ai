'use strict';
const { defaultContainer } = require('../container');

async function handleGetCircuitBreakerStatus(args) {
  try {
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
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Circuit breaker error: ${err.message}` }] };
  }
}

module.exports = { handleGetCircuitBreakerStatus };
