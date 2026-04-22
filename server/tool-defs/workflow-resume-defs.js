'use strict';

const WORKFLOW_RESUME_TOOLS = [
  {
    name: 'resume_workflow',
    description: 'Re-evaluate a workflow: unblock tasks whose dependencies are now satisfied, finalize the workflow if all tasks are terminal. Useful when a workflow got stuck after a restart or a manual DB edit.',
    inputSchema: {
      type: 'object',
      required: ['workflow_id'],
      properties: {
        workflow_id: { type: 'string' },
      },
    },
  },
  {
    name: 'resume_all_workflows',
    description: 'Re-evaluate every workflow in running status. Returns counts of workflows touched and tasks unblocked.',
    inputSchema: { type: 'object', properties: {} },
  },
];

module.exports = { WORKFLOW_RESUME_TOOLS };
