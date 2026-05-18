'use strict';

const tools = [
  {
    name: 'list_project_rules',
    description: 'List scoped TORQUE prompt rules from .torque/rules in a project root.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string' },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'preview_project_rules',
    description: 'Preview which .torque/rules entries would be injected for a task context.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['working_directory'],
    },
  },
];

module.exports = tools;
