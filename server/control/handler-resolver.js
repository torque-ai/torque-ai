'use strict';

const REDUCERS = new Set(['replace', 'append', 'merge_object', 'last_write_wins', 'numeric_sum']);

function resolveHandler(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('state.') || spec === 'state.') {
    return null;
  }

  const rest = spec.slice('state.'.length);
  const parts = rest.split('.');
  if (parts.length === 0 || parts.some((part) => part === '')) {
    return null;
  }

  const tail = parts[parts.length - 1];
  if (REDUCERS.has(tail)) {
    if (parts.length < 2) {
      return null;
    }

    return {
      kind: 'write',
      statePath: parts.slice(0, -1).join('.'),
      reducer: tail,
    };
  }

  return {
    kind: 'query',
    statePath: parts.join('.'),
  };
}

module.exports = { resolveHandler, REDUCERS };
