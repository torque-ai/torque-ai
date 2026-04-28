'use strict';

const { createStreamParser } = require('./stream-parser');

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function truthyFlag(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function taskHasStreamingActions(task) {
  const metadata = parseMetadata(task?.metadata);
  const taskMetadata = parseMetadata(task?.task_metadata);
  return truthyFlag(task?.streaming_actions)
    || truthyFlag(task?.streamingActions)
    || truthyFlag(metadata.streaming_actions)
    || truthyFlag(metadata.streamingActions)
    || truthyFlag(taskMetadata.streaming_actions)
    || truthyFlag(taskMetadata.streamingActions);
}

function resolveActionApplier(logger) {
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer && typeof defaultContainer.get === 'function' && defaultContainer.has('actionApplier')) {
      return defaultContainer.get('actionApplier');
    }
  } catch (err) {
    logger?.warn?.('action applier unavailable for streaming actions', { err });
  }
  return null;
}

function createProviderActionStream({ task, taskId, workflowId = null, logger, applier = null } = {}) {
  if (!taskHasStreamingActions(task)) return null;

  const actionApplier = applier || resolveActionApplier(logger);
  if (!actionApplier || typeof actionApplier.apply !== 'function') {
    logger?.warn?.('streaming actions enabled but actionApplier is unavailable', { taskId });
    return null;
  }

  let pendingApply = Promise.resolve();
  const parser = createStreamParser({
    onAction: (action) => {
      const effectiveAction = action.type === 'state_patch' && !action.workflow_id && workflowId
        ? { ...action, workflow_id: workflowId }
        : action;
      pendingApply = pendingApply
        .then(() => actionApplier.apply({ taskId, workflowId, action: effectiveAction }))
        .catch((err) => {
          logger?.warn?.('action apply failed', { err, taskId, actionType: action.type });
        });
    },
  });

  return {
    feed(chunk) {
      if (chunk === undefined || chunk === null) return;
      parser.feed(String(chunk));
    },
    end() {
      parser.end();
      return pendingApply;
    },
  };
}

module.exports = {
  createProviderActionStream,
  taskHasStreamingActions,
};
