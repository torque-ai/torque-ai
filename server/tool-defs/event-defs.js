'use strict';

const EVENT_TOOLS = [
  {
    name: 'list_task_events',
    description: 'List the typed event log for a task (or workflow). Use this for replay, debugging, and audit trails.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        workflow_id: { type: 'string' },
        type: { type: 'string' },
        since: { type: 'string', description: 'ISO8601 timestamp' },
        limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
      },
    },
  },
];

module.exports = EVENT_TOOLS;
module.exports.EVENT_TOOLS = EVENT_TOOLS;
