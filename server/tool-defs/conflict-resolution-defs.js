/**
 * Tool definitions for conflict resolution handlers
 */

module.exports = [
  {
    name: 'resolve_workflow_conflicts',
    description: 'Auto-merge files modified by multiple tasks in a workflow using tracked task snapshots and 3-way merge. Returns merged files and manual conflicts.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: {
          type: 'string',
          description: 'Workflow ID to resolve file conflicts for'
        }
      },
      required: ['workflow_id']
    }
  }
];
