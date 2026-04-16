'use strict';

const HANDOFF_TAG = Symbol.for('torque.crew.handoff');

function createHandoff(agent, { contextPatch = {} } = {}) {
  if (!agent || typeof agent !== 'string') {
    throw new Error('createHandoff: agent name required');
  }

  return { [HANDOFF_TAG]: true, __handoff: true, agent, contextPatch };
}

function isHandoff(x) {
  return !!(x && typeof x === 'object' && x[HANDOFF_TAG] === true);
}

module.exports = { createHandoff, isHandoff, HANDOFF_TAG };
