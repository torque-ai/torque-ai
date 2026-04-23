'use strict';

const { randomUUID } = require('crypto');

function createApplication({
  actions,
  transitions = {},
  initialState = {},
  persister = null,
  app_id = `app_${randomUUID().slice(0, 10)}`,
  partition_key = '',
  resumeFrom = null,
} = {}) {
  if (!Array.isArray(actions)) {
    throw new Error('application: actions array required');
  }
  if (!transitions || typeof transitions !== 'object') {
    throw new Error('application: transitions object required');
  }

  const actionMap = buildActionMap(actions);
  let state = { ...initialState };
  let sequence_id = 0;
  let lastActionName = null;

  if (resumeFrom !== null) {
    if (!persister) throw new Error('application: persister required to resume');
    const snap = persister.loadAt({ app_id, partition_key, sequence_id: resumeFrom });
    if (!snap) throw new Error(`no snapshot at sequence_id=${resumeFrom}`);
    state = { ...snap.state };
    sequence_id = snap.sequence_id + 1;
    lastActionName = snap.action_name;
  }

  async function step(actionName, inputs = {}) {
    const action = actionMap.get(actionName);
    if (!action) throw new Error(`unknown action: ${actionName}`);

    const { result, patch } = await action.invoke(state, inputs);
    state = { ...state, ...(patch || {}) };
    if (persister) {
      persister.save({
        app_id,
        partition_key,
        sequence_id,
        action_name: actionName,
        state,
        result,
      });
    }
    sequence_id += 1;
    lastActionName = actionName;
    return { result, nextState: { ...state } };
  }

  function nextAction(afterAction) {
    const actionName = afterAction === undefined ? lastAction() : afterAction;
    const candidates = transitions[actionName];
    if (!Array.isArray(candidates)) return null;

    for (const { when, next } of candidates) {
      if (!when || when(state)) return next;
    }
    return null;
  }

  function lastAction() {
    const latest = persister?.loadLatest({ app_id, partition_key });
    return latest?.action_name || lastActionName;
  }

  return {
    app_id,
    partition_key,
    step,
    getState: () => ({ ...state }),
    getSequence: () => sequence_id,
    nextAction,
  };
}

function buildActionMap(actions) {
  const actionMap = new Map();
  for (const action of actions) {
    if (!action || typeof action.name !== 'string' || typeof action.invoke !== 'function') {
      throw new Error('application: action with name and invoke() required');
    }
    if (actionMap.has(action.name)) {
      throw new Error(`duplicate action: ${action.name}`);
    }
    actionMap.set(action.name, action);
  }
  return actionMap;
}

function fork({
  app_id,
  partition_key = '',
  sequence_id,
  persister,
  actions,
  transitions,
  new_app_id = `app_${randomUUID().slice(0, 10)}`,
  new_partition_key = '',
} = {}) {
  if (!persister) throw new Error('fork: persister required');
  const snap = persister.loadAt({ app_id, partition_key, sequence_id });
  if (!snap) throw new Error(`no snapshot at ${app_id}:${sequence_id}`);
  return createApplication({
    actions,
    transitions,
    initialState: snap.state,
    persister,
    app_id: new_app_id,
    partition_key: new_partition_key,
  });
}

module.exports = { createApplication, fork };
