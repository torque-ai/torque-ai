'use strict';

const newToolDefs = [
  {
    name: 'peek_verify',
    description: 'Run verification checks for a target window and optionally capture current evidence against the configured branch baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          type: 'object',
          description: 'Window selector object understood by peek_server verification endpoints.',
        },
        checks: {
          type: 'array',
          description: 'Verification checks to execute for the target window.',
          items: { type: 'string' },
        },
        capture: {
          type: 'boolean',
          description: 'Capture fresh evidence during verification. Defaults to true.',
        },
        name: {
          type: 'string',
          description: 'Optional saved verification spec name.',
        },
        branch: {
          type: 'string',
          description: 'Baseline branch name. Defaults to "main".',
        },
      },
      required: ['window', 'checks'],
    },
  },
  {
    name: 'peek_verify_run',
    description: 'Run a saved verification spec by name, optionally overriding the target window and baseline branch.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_name: {
          type: 'string',
          description: 'Saved verification spec name to execute.',
        },
        window: {
          type: 'object',
          description: 'Optional window selector override for the saved spec.',
        },
        branch: {
          type: 'string',
          description: 'Baseline branch name. Defaults to "main".',
        },
      },
      required: ['spec_name'],
    },
  },
  {
    name: 'peek_verify_specs',
    description: 'Manage saved verification specs by saving, listing, fetching, or deleting definitions stored by peek_server.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'get', 'delete'],
          description: 'Verification spec action to perform.',
        },
        key: {
          type: 'string',
          description: 'Spec identifier for get, delete, or save operations.',
        },
        spec: {
          type: 'object',
          description: 'Verification spec payload to save.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'peek_baselines',
    description: 'Approve, fetch, or list verification baselines managed by peek_server.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['approve', 'get', 'list'],
          description: 'Baseline action to perform.',
        },
        key: {
          type: 'string',
          description: 'Baseline key for approve or get operations.',
        },
        window: {
          type: 'object',
          description: 'Optional window selector when approving or resolving a baseline.',
        },
        branch: {
          type: 'string',
          description: 'Baseline branch name.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'peek_history',
    description: 'Retrieve verification run history or trend summaries for a saved verification spec.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['runs', 'trend'],
          description: 'History query type.',
        },
        spec_name: {
          type: 'string',
          description: 'Saved verification spec name to query.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of records to return.',
        },
      },
      required: ['action', 'spec_name'],
    },
  },
  {
    name: 'peek_watch_add',
    description: 'Create a watch that periodically verifies an application against one or more specs and optional recovery rules.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique watch name.',
        },
        app: {
          type: 'object',
          description: 'Application target configuration for the watch.',
        },
        specs: {
          type: 'array',
          description: 'Verification specs the watch should evaluate.',
          items: { type: 'string' },
        },
        interval_seconds: {
          type: 'integer',
          description: 'Polling interval in seconds.',
        },
        alert: {
          type: 'object',
          description: 'Alert configuration for failures or regressions.',
        },
        recovery: {
          type: 'array',
          description: 'Recovery actions the watch may execute.',
          items: { type: 'object' },
        },
      },
      required: ['name', 'app', 'specs'],
    },
  },
  {
    name: 'peek_watch_remove',
    description: 'Remove an existing verification watch by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Watch name to remove.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'peek_watch_status',
    description: 'List active watches and their latest status from peek_server.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'peek_watch_control',
    description: 'Start or stop the watch scheduler on peek_server.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop'],
          description: 'Watch scheduler action.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'peek_recovery_execute',
    description: 'Execute a named recovery action through peek_server with optional simulation mode.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Recovery action name to execute.',
        },
        params: {
          type: 'object',
          description: 'Recovery action parameters.',
        },
        simulate: {
          type: 'boolean',
          description: 'If true, return the planned recovery action without executing it.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'peek_recovery_log',
    description: 'Read recent recovery execution records, optionally filtered to a specific watch.',
    inputSchema: {
      type: 'object',
      properties: {
        watch_name: {
          type: 'string',
          description: 'Optional watch name to filter recovery log entries.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of recovery log records to return.',
        },
      },
    },
  },
];

module.exports = newToolDefs;
