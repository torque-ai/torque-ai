'use strict';

const tools = [
  {
    name: 'strategic_config_get',
    description: 'Get the current merged Strategic Brain configuration for a project. Shows where each value comes from (project, user, or default).',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project working directory (for project-level config lookup)',
        },
      },
    },
  },
  {
    name: 'strategic_config_set',
    description: 'Save Strategic Brain configuration for a project. Writes to .torque/strategic.json in the working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project working directory where .torque/strategic.json will be saved',
        },
        config: {
          type: 'object',
          description: 'Partial config object to save. Only include fields you want to override — unset fields inherit from user/default layers.',
        },
      },
      required: ['working_directory', 'config'],
    },
  },
  {
    name: 'strategic_config_templates',
    description: 'List available Strategic Brain templates (built-in + user-created). Templates provide domain-specific starting points for decomposition steps, review criteria, and diagnosis patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project working directory (to include project-level templates)',
        },
      },
    },
  },
  {
    name: 'strategic_config_apply_template',
    description: 'Apply a Strategic Brain template as the starting point for a project config. Writes the template values to .torque/strategic.json.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project working directory',
        },
        template_name: {
          type: 'string',
          description: 'Template name to apply (e.g., "game-dev", "web-api", "frontend", "cli-tool", "library")',
        },
      },
      required: ['working_directory', 'template_name'],
    },
  },
];

module.exports = tools;
