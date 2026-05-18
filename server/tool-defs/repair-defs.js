'use strict';

module.exports = [
  {
    name: 'record_repair_candidate',
    description: 'Record a candidate patch with its validator score for a task. Used by the surgical-repair loop to persist each verify-retry diff so the orchestrator can pick the highest-quality patch when multiple attempts are made.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'integer',
          description: 'The original failing task ID'
        },
        attempt: {
          type: 'integer',
          description: '1-indexed attempt number'
        },
        diffText: {
          type: 'string',
          description: 'Unified diff of the candidate patch'
        },
        validatorScore: {
          type: 'number',
          description: 'Quality score 0.0–1.0'
        },
        verifyExitCode: {
          type: 'integer',
          description: 'Exit code from the verify command'
        },
        verifyOutput: {
          type: 'string',
          description: 'Verify-command output (truncated to 8 KB on storage)'
        }
      },
      required: ['taskId', 'attempt']
    }
  },
  {
    name: 'list_repair_candidates',
    description: 'List all candidate patches for a task, ranked by validator score descending.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'integer',
          description: 'Task ID to list candidates for'
        }
      },
      required: ['taskId']
    }
  },
  {
    name: 'select_best_repair_candidate',
    description: 'Mark the highest-scoring candidate patch as selected for a task. Selection criteria: lowest verify_exit_code first, then highest validator_score as tiebreaker.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'integer',
          description: 'Task ID to select the best candidate for'
        }
      },
      required: ['taskId']
    }
  },
  {
    name: 'get_fault_localization',
    description: 'Run SBFL fault localization on verify-command output and return ranked suspicious files. Parses vitest/jest JSON, dotnet TRX, or plain-text test output to compute per-file Ochiai suspiciousness scores.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'integer',
          description: 'Task ID to associate the localization with'
        },
        verifyOutput: {
          type: 'string',
          description: 'Raw verify-command output to analyze'
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for relative path resolution'
        }
      },
      required: ['taskId', 'verifyOutput']
    }
  }
];
