'use strict';

module.exports = [
  {
    name: 'get_file_risk',
    description: 'Retrieve the persisted risk score and reasons for a single file path.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path to query (stored against this working directory).',
        },
        working_directory: {
          type: 'string',
          description: 'Working directory used to scope file risk scoring.',
        },
      },
      required: ['file_path', 'working_directory'],
    },
  },
  {
    name: 'get_task_risk_summary',
    description: 'Get the file risk summary for all files changed by a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task identifier to summarize risk across changed files.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'set_file_risk_override',
    description: 'Manually override the persisted risk level for a file path.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path to set the manual risk override for.',
        },
        working_directory: {
          type: 'string',
          description: 'Working directory used to scope file risk scoring.',
        },
        risk_level: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Override risk level.',
        },
        reason: {
          type: 'string',
          description: 'Short reason for the manual override.',
        },
      },
      required: ['file_path', 'working_directory', 'risk_level', 'reason'],
    },
  },
  {
    name: 'get_high_risk_files',
    description: 'List files at or above a minimum risk threshold for a working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Working directory used to scope risk scoring.',
        },
        min_level: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Minimum level to include (default: high).',
        },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'get_verification_ledger',
    description: 'Query verification checks for a task. Returns all recorded build, test, lint, review, and safeguard check results.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
        phase: { type: 'string', enum: ['baseline', 'after', 'review'], description: 'Filter by phase' },
        check_name: { type: 'string', description: 'Filter by check name (e.g. build, test, safeguard)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_verification_summary',
    description: 'Aggregate pass/fail counts for all check types across a workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'get_adversarial_reviews',
    description: 'Get all adversarial reviews for a task. Returns reviewer provider, verdict, confidence, and detailed issues.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'request_adversarial_review',
    description: 'Manually trigger an adversarial review for any completed task. Spawns a review task on a different provider.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to review' },
        provider: { type: 'string', description: 'Specific provider to use for review (must differ from original)' },
        working_directory: { type: 'string', description: 'Project working directory' },
      },
      required: ['task_id', 'working_directory'],
    },
  },
];
