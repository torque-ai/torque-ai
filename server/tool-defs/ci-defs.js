/**
 * Tool definitions for CI monitoring and diagnostics
 */

const tools = [
  {
    name: 'await_ci_run',
    description: 'Block until a CI run completes and return structured diagnosis data.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'CI run identifier to wait for'
        },
        commit_sha: {
          type: 'string',
          description: 'Commit SHA associated with the CI run'
        },
        branch: {
          type: 'string',
          description: 'Branch name to watch for the CI run'
        },
        repo: {
          type: 'string',
          description: 'Repository name in owner/repo format'
        },
        provider: {
          type: 'string',
          description: 'CI provider name (default: github-actions)',
          default: 'github-actions'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Maximum wait time in minutes (default: 30)',
          default: 30,
          minimum: 1,
          maximum: 60
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Poll interval in milliseconds (default: 15000)',
          default: 15000
        },
        diagnose: {
          type: 'boolean',
          description: 'Run diagnosis automatically once the run completes (default: true)',
          default: true
        }
      },
      required: ['run_id']
    }
  },
  {
    name: 'watch_ci_repo',
    description: 'Start background polling for CI failures in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name in owner/repo format'
        },
        provider: {
          type: 'string',
          description: 'CI provider name (default: github-actions)',
          default: 'github-actions'
        },
        branch: {
          type: 'string',
          description: 'Optional branch filter'
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Polling interval in milliseconds (default: 30000)',
          default: 30000
        },
        auto_diagnose: {
          type: 'boolean',
          description: 'Automatically diagnose failures when they are detected (default: true)',
          default: true
        }
      },
      required: ['repo']
    }
  },
  {
    name: 'stop_ci_watch',
    description: 'Stop an active background CI watch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name in owner/repo format'
        },
        watch_id: {
          type: 'string',
          description: 'Identifier of the running watch job'
        }
      },
      oneOf: [
        { required: ['repo'] },
        { required: ['watch_id'] }
      ]
    }
  },
  {
    name: 'ci_run_status',
    description: 'Quickly fetch the status of a single CI run.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'CI run identifier'
        },
        repo: {
          type: 'string',
          description: 'Repository name in owner/repo format'
        },
        provider: {
          type: 'string',
          description: 'CI provider name (default: github-actions)',
          default: 'github-actions'
        }
      },
      required: ['run_id']
    }
  },
  {
    name: 'diagnose_ci_failure',
    description: 'Pull CI logs for a run, categorize failure signals, and generate a triage report.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'CI run identifier'
        },
        repo: {
          type: 'string',
          description: 'Repository name in owner/repo format'
        },
        provider: {
          type: 'string',
          description: 'CI provider name (default: github-actions)',
          default: 'github-actions'
        }
      },
      required: ['run_id']
    }
  },
  {
    name: 'list_ci_runs',
    description: 'List recent CI runs with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name in owner/repo format'
        },
        branch: {
          type: 'string',
          description: 'Optional branch filter'
        },
        status: {
          type: 'string',
          description: 'Run status filter',
          enum: ['queued', 'in_progress', 'completed']
        },
        limit: {
          type: 'number',
          description: 'Maximum number of runs to return (default: 10)',
          default: 10
        },
        provider: {
          type: 'string',
          description: 'CI provider name (default: github-actions)',
          default: 'github-actions'
        }
      },
      required: ['repo']
    }
  },
  {
    name: 'configure_ci_provider',
    description: 'Configure CI provider defaults and behavior settings.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'CI provider name (default: github-actions)',
          default: 'github-actions'
        },
        default_repo: {
          type: 'string',
          description: 'Default repository in owner/repo format'
        },
        webhook_secret: {
          type: 'string',
          description: 'Webhook secret used for provider notifications'
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Default polling interval in milliseconds'
        },
        auto_diagnose: {
          type: 'boolean',
          description: 'Enable automatic diagnosis on failures by default'
        }
      }
    }
  }
];

module.exports = tools;
