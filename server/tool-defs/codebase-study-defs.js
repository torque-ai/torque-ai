'use strict';

const tools = [
  {
    name: 'run_codebase_study',
    description: 'Run one incremental local-first codebase study cycle for a repository and update the LLM-oriented architecture and expertise artifacts in docs/architecture.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root to study',
        },
        max_batches: {
          type: 'integer',
          description: 'Optional number of local study batches to process in one invocation. Defaults to 1; manual Run Now uses a higher internal default.',
          minimum: 1,
        },
        force_refresh: {
          type: 'boolean',
          description: 'When true, recompute the derived study artifacts even when the repository has no new tracked-file delta. Manual Run Now enables this automatically for study schedules.',
          default: false,
        },
        project: {
          type: 'string',
          description: 'Optional project name used when auto-submitting follow-up proposals.',
        },
        submit_proposals: {
          type: 'boolean',
          description: 'When true, submit a bounded number of follow-up TORQUE tasks based on the generated study delta.',
          default: false,
        },
        proposal_significance_level: {
          type: 'string',
          description: 'Minimum delta significance required before study proposals are submitted.',
          enum: ['none', 'baseline', 'low', 'moderate', 'high', 'critical'],
          default: 'moderate',
        },
        proposal_min_score: {
          type: 'integer',
          description: 'Minimum delta score required before study proposals are submitted.',
          minimum: 0,
          default: 0,
        },
        proposal_limit: {
          type: 'integer',
          description: 'Maximum number of follow-up proposals to submit when submit_proposals is true.',
          minimum: 1,
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'get_study_status',
    description: 'Get the current local-first codebase study progress, coverage, and expertise-pack status for a repository.',
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
    name: 'evaluate_codebase_study',
    description: 'Evaluate whether the current study artifacts are strong enough to make another LLM productive quickly, and refresh the persisted study evaluation.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root for the study artifacts',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'benchmark_codebase_study',
    description: 'Run the empirical study benchmark against the current knowledge pack and persist study-benchmark.json.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root for the study artifacts',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'get_codebase_study_profile_override',
    description: 'Read the repo-local study profile override scaffold or override file, along with the effective detected study profile.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root for the study profile override',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'save_codebase_study_profile_override',
    description: 'Create, replace, or clear the repo-local study profile override JSON file used by the shared study engine.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root for the study profile override',
        },
        override: {
          type: 'object',
          description: 'JSON object to write to docs/architecture/study-profile.override.json. Omit only when clear is true.',
        },
        clear: {
          type: 'boolean',
          description: 'When true, delete the repo-local override file instead of writing one.',
          default: false,
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'preview_codebase_study_bootstrap',
    description: 'Preview the detected study profile, schedule plan, and optional repo-local override scaffold before bootstrapping a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root to preview',
        },
        project: {
          type: 'string',
          description: 'Optional project name for the suggested schedule and study proposals.',
        },
        name: {
          type: 'string',
          description: 'Optional schedule name. Defaults to codebase-study:<folder-name>.',
        },
        cron_expression: {
          type: 'string',
          description: 'Optional cron expression for the suggested schedule. Defaults to */15 * * * *.',
        },
        version_intent: {
          type: 'string',
          description: 'Version intent for the suggested schedule. Defaults to "fix".',
          enum: ['feature', 'fix', 'breaking', 'internal'],
          default: 'fix',
        },
        initial_max_batches: {
          type: 'integer',
          description: 'Optional cap for the recommended initial study run.',
          minimum: 1,
        },
        submit_proposals: {
          type: 'boolean',
          description: 'Whether the suggested schedule should auto-submit significant study proposals.',
          default: false,
        },
        proposal_significance_level: {
          type: 'string',
          description: 'Minimum delta significance required before suggested study proposals are auto-submitted.',
          enum: ['none', 'baseline', 'low', 'moderate', 'high', 'critical'],
          default: 'moderate',
        },
        proposal_min_score: {
          type: 'integer',
          description: 'Minimum delta score required before suggested study proposals are auto-submitted.',
          minimum: 0,
          default: 0,
        },
        proposal_limit: {
          type: 'integer',
          description: 'Maximum number of study proposals to auto-submit per scheduled run.',
          minimum: 1,
        },
        timezone: {
          type: 'string',
          description: 'Optional IANA timezone for cron evaluation.',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'bootstrap_codebase_study',
    description: 'Detect the repo study profile, run an initial study pass, benchmark the resulting artifacts, and optionally create the recurring study schedule for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Repository root to bootstrap',
        },
        project: {
          type: 'string',
          description: 'Optional project name for the generated schedule and study proposals.',
        },
        name: {
          type: 'string',
          description: 'Optional schedule name. Defaults to codebase-study:<folder-name>.',
        },
        cron_expression: {
          type: 'string',
          description: 'Optional cron expression for the created schedule. Defaults to */15 * * * *.',
        },
        version_intent: {
          type: 'string',
          description: 'Version intent for the generated schedule. Defaults to "fix".',
          enum: ['feature', 'fix', 'breaking', 'internal'],
          default: 'fix',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the generated schedule should be enabled.',
          default: true,
        },
        create_schedule: {
          type: 'boolean',
          description: 'Whether to create or update the recurring study schedule.',
          default: true,
        },
        run_initial_study: {
          type: 'boolean',
          description: 'Whether to run the initial local-first study during bootstrap.',
          default: true,
        },
        run_benchmark: {
          type: 'boolean',
          description: 'Whether to persist the study benchmark during bootstrap.',
          default: true,
        },
        write_profile_scaffold: {
          type: 'boolean',
          description: 'When true, write a repo-local study-profile.override.json scaffold if one does not already exist.',
          default: false,
        },
        initial_max_batches: {
          type: 'integer',
          description: 'Optional cap for the initial study run. Defaults to a profile-based recommendation.',
          minimum: 1,
        },
        submit_proposals: {
          type: 'boolean',
          description: 'Whether the generated schedule should auto-submit significant study proposals.',
          default: false,
        },
        proposal_significance_level: {
          type: 'string',
          description: 'Minimum delta significance required before study proposals are auto-submitted.',
          enum: ['none', 'baseline', 'low', 'moderate', 'high', 'critical'],
          default: 'moderate',
        },
        proposal_min_score: {
          type: 'integer',
          description: 'Minimum delta score required before study proposals are auto-submitted.',
          minimum: 0,
          default: 0,
        },
        proposal_limit: {
          type: 'integer',
          description: 'Maximum number of study proposals to auto-submit per scheduled run.',
          minimum: 1,
        },
        timezone: {
          type: 'string',
          description: 'Optional IANA timezone for cron evaluation.',
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
    description: 'Create or update a 15-minute cron schedule that refreshes the local-first codebase intelligence and expertise pack directly inside TORQUE.',
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
        version_intent: {
          type: 'string',
          description: 'Version intent for scheduled runs. Defaults to "fix".',
          enum: ['feature', 'fix', 'breaking', 'internal'],
          default: 'fix',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the schedule is enabled',
          default: true,
        },
        submit_proposals: {
          type: 'boolean',
          description: 'Whether scheduled runs should auto-submit bounded follow-up TORQUE tasks when the study delta is significant.',
          default: false,
        },
        proposal_significance_level: {
          type: 'string',
          description: 'Minimum delta significance required before scheduled study proposals are submitted.',
          enum: ['none', 'baseline', 'low', 'moderate', 'high', 'critical'],
          default: 'moderate',
        },
        proposal_min_score: {
          type: 'integer',
          description: 'Minimum delta score required before scheduled study proposals are submitted.',
          minimum: 0,
          default: 0,
        },
        proposal_limit: {
          type: 'integer',
          description: 'Maximum number of follow-up TORQUE tasks to submit per scheduled study run.',
          minimum: 1,
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
