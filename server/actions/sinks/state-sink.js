'use strict';

function createStateSink({ workflowState }) {
  if (!workflowState || typeof workflowState.applyPatch !== 'function') {
    throw new Error('state sink requires workflowState.applyPatch');
  }

  return async ({ attrs, content }) => {
    if (!attrs.workflow_id || !attrs.key) {
      throw new Error('state_patch action requires workflow_id + key');
    }
    const value = tryParseJson(content);
    const patch = { [attrs.key]: value };
    const result = workflowState.applyPatch(attrs.workflow_id, patch);
    if (!result.ok) {
      throw new Error(`state patch rejected: ${(result.errors || []).join(', ')}`);
    }
    return { ok: true };
  };
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

module.exports = { createStateSink };
