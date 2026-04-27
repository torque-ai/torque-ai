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

async function handleTripCodexBreaker(args) {
  try {
    const cb = defaultContainer.get('circuitBreaker');
    if (!cb) {
      return { isError: true, content: [{ type: 'text', text: 'Circuit breaker not initialized' }] };
    }
    const reason = (args && args.reason) || 'manual';
    cb.trip('codex', reason);
    const state = cb.getState('codex');
    return {
      content: [{
        type: 'text',
        text: `Codex breaker tripped (state=${state.state}, reason=${reason})`,
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `trip failed: ${err.message}` }] };
  }
}

async function handleUntripCodexBreaker(args) {
  try {
    const cb = defaultContainer.get('circuitBreaker');
    if (!cb) {
      return { isError: true, content: [{ type: 'text', text: 'Circuit breaker not initialized' }] };
    }
    const reason = (args && args.reason) || 'manual';
    cb.untrip('codex', reason);
    const state = cb.getState('codex');
    return {
      content: [{
        type: 'text',
        text: `Codex breaker untripped (state=${state.state}, reason=${reason})`,
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `untrip failed: ${err.message}` }] };
  }
}

async function handleGetCodexBreakerStatus(_args) {
  try {
    let state = null;
    if (defaultContainer.has('circuitBreaker')) {
      const cb = defaultContainer.get('circuitBreaker');
      if (cb) state = cb.getState('codex');
    }
    let persisted = null;
    if (defaultContainer.has('providerCircuitBreakerStore')) {
      const store = defaultContainer.get('providerCircuitBreakerStore');
      if (store && typeof store.getState === 'function') {
        persisted = store.getState('codex');
      }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ provider: 'codex', state, persisted }, null, 2),
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `status failed: ${err.message}` }] };
  }
}

async function handleConfigureCodexPolicy(args) {
  try {
    if (!args || !args.project_id) {
      return { isError: true, content: [{ type: 'text', text: 'project_id is required' }] };
    }
    if (!args.mode) {
      return { isError: true, content: [{ type: 'text', text: 'mode is required' }] };
    }
    const { setCodexFallbackPolicy } = require('../db/factory-intake');
    const dbDep = defaultContainer.get('db');
    const dbInstance = dbDep && typeof dbDep.getDbInstance === 'function'
      ? dbDep.getDbInstance()
      : dbDep;
    setCodexFallbackPolicy({ db: dbInstance, projectId: args.project_id, policy: args.mode });
    return {
      content: [{
        type: 'text',
        text: `Codex fallback policy for ${args.project_id}: ${args.mode}`,
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `policy update failed: ${err.message}` }] };
  }
}

module.exports = {
  handleGetCircuitBreakerStatus,
  handleTripCodexBreaker,
  handleUntripCodexBreaker,
  handleGetCodexBreakerStatus,
  handleConfigureCodexPolicy,
};
