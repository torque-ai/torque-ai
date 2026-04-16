'use strict';

function createContextVariables(initial = {}) {
  let state = { ...initial };
  const log = [];

  return {
    get: (k) => state[k],
    set: (k, v) => { state[k] = v; },
    merge: (patch) => {
      state = { ...state, ...patch };
      log.push({ ...patch });
    },
    snapshot: () => ({ ...state }),
    history: () => log.slice(),
  };
}

module.exports = { createContextVariables };
