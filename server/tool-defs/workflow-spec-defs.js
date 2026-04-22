'use strict';

const WORKFLOW_SPEC_TOOLS = [
  {
    name: 'list_workflow_specs',
    description: 'List workflow specs discovered in <working_directory>/workflows/. Each spec is a version-controlled YAML file defining a DAG of tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project root. Defaults to current project working directory.',
        },
      },
    },
  },
  {
    name: 'validate_workflow_spec',
    description: 'Parse and validate a workflow spec YAML file against the schema. Returns parse errors if invalid.',
    inputSchema: {
      type: 'object',
      required: ['spec_path'],
      properties: {
        spec_path: {
          type: 'string',
          description: 'Path to the YAML file (relative to working_directory or absolute).',
        },
        working_directory: {
          type: 'string',
          description: 'Project root for resolving relative paths.',
        },
      },
    },
  },
  {
    name: 'run_workflow_spec',
    description: 'Create and run a workflow from a YAML spec file. Equivalent to create_workflow + run_workflow in one call.',
    inputSchema: {
      type: 'object',
      required: ['spec_path'],
      properties: {
        spec_path: {
          type: 'string',
          description: 'Path to the YAML file (relative to working_directory or absolute).',
        },
        working_directory: {
          type: 'string',
          description: 'Project root. Overrides the working_directory in the spec if provided.',
        },
        goal: {
          type: 'string',
          description: 'Optional run goal - overrides the spec description for this run.',
        },
      },
    },
  },
];

module.exports = { WORKFLOW_SPEC_TOOLS };
