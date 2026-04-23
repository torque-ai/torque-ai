'use strict';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reduceField(strategy, current, incoming) {
  switch (strategy) {
    case 'append': {
      if (incoming === undefined) {
        return Array.isArray(current) ? [...current] : (current === undefined ? [] : [current]);
      }
      const base = Array.isArray(current) ? [...current] : (current === undefined ? [] : [current]);
      return Array.isArray(incoming) ? base.concat(incoming) : base.concat([incoming]);
    }
    case 'merge_object': {
      const base = isPlainObject(current) ? current : {};
      const next = isPlainObject(incoming) ? incoming : {};
      return { ...base, ...next };
    }
    case 'numeric_sum': {
      const left = typeof current === 'number' ? current : 0;
      const right = typeof incoming === 'number' ? incoming : 0;
      return left + right;
    }
    case 'last_write_wins':
    case 'replace':
    default:
      return incoming === undefined ? current : incoming;
  }
}

function reduceState(currentState, patch, reducers = {}) {
  const current = isPlainObject(currentState) ? currentState : {};
  const next = { ...current };

  for (const [key, value] of Object.entries(patch || {})) {
    next[key] = reduceField(reducers[key] || 'replace', current[key], value);
  }

  return next;
}

module.exports = { reduceField, reduceState };
