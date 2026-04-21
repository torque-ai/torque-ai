'use strict';

const CHECKPOINT_TOOLS = [
  {
    name: 'list_checkpoints',
    description: 'List all task checkpoints (shadow-git snapshots) for a project.',
    inputSchema: {
      type: 'object',
      required: ['project_root'],
      properties: {
        project_root: { type: 'string' },
      },
    },
  },
  {
    name: 'rollback_task',
    description: 'Restore the working tree to the snapshot from a specific task. Does NOT touch the user-facing main git repo. Irreversible.',
    inputSchema: {
      type: 'object',
      required: ['project_root', 'task_id'],
      properties: {
        project_root: { type: 'string' },
        task_id: { type: 'string' },
      },
    },
  },
];

module.exports = CHECKPOINT_TOOLS;
module.exports.CHECKPOINT_TOOLS = CHECKPOINT_TOOLS;
