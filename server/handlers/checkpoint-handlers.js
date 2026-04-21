'use strict';

const { listCheckpoints, rollbackTask } = require('../checkpoints/rollback');

function handleListCheckpoints(args = {}) {
  const checkpoints = listCheckpoints(args.project_root);
  return {
    content: [{
      type: 'text',
      text: `${checkpoints.length} checkpoint(s):\n` + checkpoints.slice(0, 50)
        .map((checkpoint) => `- ${checkpoint.task_id || '(untagged)'} @ ${checkpoint.timestamp} - ${checkpoint.subject}`)
        .join('\n'),
    }],
    structuredData: { checkpoints },
  };
}

function handleRollbackTask(args = {}) {
  const result = rollbackTask(args);
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `Rollback failed: ${result.error}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `Restored project to snapshot for task ${args.task_id}` }],
    structuredData: result,
  };
}

module.exports = { handleListCheckpoints, handleRollbackTask };
