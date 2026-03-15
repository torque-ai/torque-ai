module.exports = [
  {
    name: 'capture_file_baselines',
    description: 'Capture file size/line baselines for truncation detection. Run before tasks to establish baseline state.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Directory to scan for files'
        },
        extensions: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'File extensions to capture (default: .cs, .xaml, .ts, .js, .py)'
        }
      },
      required: [
        'working_directory'
      ]
    }
  },
  {
    name: 'compare_file_baseline',
    description: 'Compare current file against its baseline to detect truncation or significant changes.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for the file'
        }
      },
      required: [
        'file_path',
        'working_directory'
      ]
    }
  },
  {
    name: 'list_rollbacks',
    description: 'List task rollback history.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [
            'pending',
            'completed',
            'failed'
          ],
          description: 'Filter by status'
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 50)'
        }
      }
    }
  },
  {
    name: 'list_backups',
    description: 'List file backups for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'restore_backup',
    description: 'Restore a file from backup.',
    inputSchema: {
      type: 'object',
      properties: {
        backup_id: {
          type: 'string',
          description: 'Backup ID to restore'
        }
      },
      required: [
        'backup_id'
      ]
    }
  },
  {
    name: 'capture_test_baseline',
    description: 'Capture test results baseline before making changes (for regression detection).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        working_directory: {
          type: 'string',
          description: 'Project directory'
        }
      },
      required: [
        'task_id',
        'working_directory'
      ]
    }
  },
  {
    name: 'capture_config_baselines',
    description: 'Capture configuration file baselines for drift detection.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project directory'
        }
      },
      required: [
        'working_directory'
      ]
    }
  },
  {
    name: 'perform_auto_rollback',
    description: 'Automatically rollback task changes (restore files from git or delete created files).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for git operations'
        },
        trigger_reason: {
          type: 'string',
          description: 'Reason for rollback (e.g., build_failure, type_verification_failed)'
        }
      },
      required: [
        'task_id',
        'working_directory',
        'trigger_reason'
      ]
    }
  },
  {
    name: 'get_auto_rollback_history',
    description: 'Get auto-rollback history for a task or all recent rollbacks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Optional task ID to filter by'
        }
      }
    }
  }
];
