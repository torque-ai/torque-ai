/**
 * Tool definition for get_context — compact session context for LLM resume.
 */

module.exports = [
  {
    name: 'get_context',
    description: 'Compact session context for LLM resume. Returns a token-efficient digest of current state — what completed, what is running, what is next, any blockers. Use this when resuming a session or needing a quick situational overview instead of calling multiple status tools.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: {
          type: 'string',
          description: 'Workflow ID for workflow-scoped context. Omit for queue-wide context.',
        },
        include_output: {
          type: 'boolean',
          description: 'Include truncated output snippets from completed/failed tasks (default: false)',
          default: false,
        },
      },
    },
  },
];
