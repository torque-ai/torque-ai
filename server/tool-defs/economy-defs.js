'use strict';

const tools = [
  {
    name: 'get_economy_status',
    description: 'Get current economy mode status, trigger reason, scope, and effective provider policy.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project working directory for project-level economy checks',
        },
        workflow_id: {
          type: 'string',
          description: 'Workflow ID for workflow-level economy checks',
        },
      },
    },
  },
  {
    name: 'set_economy_mode',
    description: 'Enable or disable economy mode for a specific scope (global, project, workflow).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project', 'workflow'],
          description: 'Economy policy scope to update',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether economy mode should be enabled',
        },
        working_directory: {
          type: 'string',
          description: 'Required for project scope; project working directory used for persistence key resolution',
        },
        workflow_id: {
          type: 'string',
          description: 'Required for workflow scope',
        },
        auto_trigger_threshold: {
          type: 'number',
          description: 'Optional manual override for auto trigger threshold percentage',
        },
        complexity_exempt: {
          type: 'boolean',
          description: 'Optional override for skipping economy mode on complex tasks',
        },
      },
      required: ['scope', 'enabled'],
    },
  },
];

module.exports = tools;
