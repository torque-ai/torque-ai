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
  {
    name: 'bench_workflow_specs',
    description: 'Run multiple workflow specs against the same goal and produce a comparison report.',
    inputSchema: {
      type: 'object',
      required: ['goal', 'specs'],
      properties: {
        goal: {
          type: 'string',
          description: 'Shared benchmark goal used for every workflow-spec run.',
        },
        specs: {
          type: 'array',
          description: 'Workflow spec paths to compare. Provide at least two variants.',
          items: {
            type: 'string',
          },
          minItems: 2,
        },
        runs_per_variant: {
          type: 'integer',
          description: 'How many sequential runs to execute for each variant.',
          minimum: 1,
          maximum: 10,
          default: 1,
        },
        working_directory: {
          type: 'string',
          description: 'Project root for resolving relative spec paths.',
        },
      },
    },
  },
];

module.exports = WORKFLOW_SPEC_TOOLS;
