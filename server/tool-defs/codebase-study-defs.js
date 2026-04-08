'use strict';

const tools = [
  {
    name: 'run_codebase_study',
    description: 'Run one incremental codebase study cycle for a repository and update docs/architecture outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root to study',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'get_study_status',
    description: 'Get the current codebase study progress for a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root for the study state',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'reset_codebase_study',
    description: 'Clear the persisted codebase study state for a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root for the study state',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'configure_study_schedule',
    description: 'Create or update a 15-minute cron schedule that runs the codebase study loop directly inside TORQUE.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root to study on each scheduled run',
        },
        name: {
          type: 'string',
          description: 'Optional schedule name. Defaults to codebase-study:<folder-name>',
        },
        cron_expression: {
          type: 'string',
          description: 'Optional cron expression. Defaults to */15 * * * *',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the schedule is enabled',
          default: true,
        },
        timezone: {
          type: 'string',
          description: 'Optional IANA timezone for cron evaluation',
        },
      },
      required: ['working_directory'],
    },
  },
];

module.exports = tools;
