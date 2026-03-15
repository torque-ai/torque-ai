module.exports = [
  {
    name: 'list_validation_rules',
    description: 'List all output validation rules. These rules check task output for quality issues like stub implementations, empty files, and truncation.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled_only: {
          type: 'boolean',
          description: 'Only show enabled rules (default: true)'
        },
        severity: {
          type: 'string',
          enum: [
            'info',
            'warning',
            'error',
            'critical'
          ],
          description: 'Filter by minimum severity level'
        }
      }
    }
  },
  {
    name: 'add_validation_rule',
    description: 'Add a new output validation rule.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique rule name'
        },
        description: {
          type: 'string',
          description: 'What this rule checks for'
        },
        rule_type: {
          type: 'string',
          enum: [
            'pattern',
            'size',
            'delta'
          ],
          description: 'Type of validation: pattern (regex), size (file size check), delta (change comparison)'
        },
        pattern: {
          type: 'string',
          description: 'Regex pattern to detect issues (for pattern type)'
        },
        condition: {
          type: 'string',
          description: 'JSON condition for size/delta rules (e.g., {"min_size": 100, "extensions": [".cs"]})'
        },
        severity: {
          type: 'string',
          enum: [
            'info',
            'warning',
            'error',
            'critical'
          ],
          description: 'How severe a violation is (default: warning)'
        },
        auto_fail: {
          type: 'boolean',
          description: 'Automatically mark task as failed if this rule triggers (default: false)'
        }
      },
      required: [
        'name',
        'description',
        'rule_type'
      ]
    }
  },
  {
    name: 'update_validation_rule',
    description: 'Update an existing validation rule.',
    inputSchema: {
      type: 'object',
      properties: {
        rule_id: {
          type: 'string',
          description: 'Rule ID to update'
        },
        enabled: {
          type: 'boolean',
          description: 'Enable or disable the rule'
        },
        severity: {
          type: 'string',
          enum: [
            'info',
            'warning',
            'error',
            'critical'
          ],
          description: 'Update severity level'
        },
        auto_fail: {
          type: 'boolean',
          description: 'Update auto-fail setting'
        }
      },
      required: [
        'rule_id'
      ]
    }
  },
  {
    name: 'validate_task_output',
    description: 'Run validation rules against a completed task to check for quality issues.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to validate'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'get_validation_results',
    description: 'Get validation results for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to get results for'
        },
        min_severity: {
          type: 'string',
          enum: [
            'info',
            'warning',
            'error',
            'critical'
          ],
          description: 'Minimum severity to include (default: warning)'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'add_failure_pattern',
    description: 'Add a new failure pattern to detect.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pattern name'
        },
        description: {
          type: 'string',
          description: 'What this pattern detects'
        },
        signature: {
          type: 'string',
          description: 'Regex signature to match in output'
        },
        provider: {
          type: 'string',
          description: 'Which provider this pattern applies to (empty for all)'
        },
        severity: {
          type: 'string',
          enum: [
            'low',
            'medium',
            'high',
            'critical'
          ],
          description: 'Severity when matched (default: medium)'
        }
      },
      required: [
        'name',
        'description',
        'signature'
      ]
    }
  },
  {
    name: 'get_failure_matches',
    description: 'Get failure pattern matches for a task or across all tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Filter by task ID (optional)'
        },
        pattern_id: {
          type: 'string',
          description: 'Filter by pattern ID (optional)'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 50)'
        }
      }
    }
  },
  {
    name: 'list_retry_rules',
    description: 'List adaptive retry rules. These rules automatically retry failed tasks with a different provider.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled_only: {
          type: 'boolean',
          description: 'Only show enabled rules (default: true)'
        }
      }
    }
  },
  {
    name: 'add_retry_rule',
    description: 'Add a new adaptive retry rule.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Rule name'
        },
        description: {
          type: 'string',
          description: 'When this rule triggers a retry'
        },
        rule_type: {
          type: 'string',
          enum: [
            'pattern',
            'validation_failure',
            'error_code',
            'failure_pattern'
          ],
          description: 'What triggers the retry'
        },
        trigger: {
          type: 'string',
          description: 'Pattern/code/condition that triggers retry'
        },
        fallback_provider: {
          type: 'string',
          description: 'Provider to retry with (default: claude-cli)'
        },
        max_retries: {
          type: 'number',
          description: 'Maximum retry attempts (default: 1)'
        }
      },
      required: [
        'name',
        'description',
        'rule_type',
        'trigger'
      ]
    }
  },
  {
    name: 'run_syntax_check',
    description: 'Run language-specific syntax validation on a file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to validate'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory'
        }
      },
      required: [
        'file_path',
        'working_directory'
      ]
    }
  },
  {
    name: 'list_syntax_validators',
    description: 'List available syntax validators and their status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'register_hook',
    description: 'Register a built-in post-tool hook for file writes or terminal task events.',
    inputSchema: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          enum: [
            'file_write',
            'task_complete',
            'task_fail'
          ],
          description: 'Hook event type to register'
        },
        hook_name: {
          type: 'string',
          description: 'Built-in hook name (defaults to the standard hook for the event type)'
        }
      },
      required: [
        'event_type'
      ]
    }
  },
  {
    name: 'list_hooks',
    description: 'List registered post-tool hooks.',
    inputSchema: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          enum: [
            'file_write',
            'task_complete',
            'task_fail'
          ],
          description: 'Optional event type filter'
        }
      }
    }
  },
  {
    name: 'remove_hook',
    description: 'Remove a registered post-tool hook by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        hook_id: {
          type: 'string',
          description: 'Hook ID to remove'
        }
      },
      required: [
        'hook_id'
      ]
    }
  },
  {
    name: 'preview_task_diff',
    description: 'Generate and preview the diff for a task before committing.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to preview'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'configure_diff_preview',
    description: 'Enable or disable diff preview requirement.',
    inputSchema: {
      type: 'object',
      properties: {
        required: {
          type: 'boolean',
          description: 'Whether diff preview is required before committing'
        }
      },
      required: [
        'required'
      ]
    }
  },
  {
    name: 'get_quality_score',
    description: 'Get the quality score for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to get score for'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'get_provider_quality',
    description: 'Get quality statistics for a provider.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider name (e.g., aider-ollama, claude-cli)'
        }
      },
      required: [
        'provider'
      ]
    }
  },
  {
    name: 'get_provider_stats',
    description: 'Get success/failure statistics per provider and task type.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Filter by provider (optional)'
        }
      }
    }
  },
  {
    name: 'get_best_provider',
    description: 'Get the recommended provider for a specific task type based on historical success rates.',
    inputSchema: {
      type: 'object',
      properties: {
        task_type: {
          type: 'string',
          description: 'Task type (e.g., feature, bugfix, documentation, testing)'
        }
      },
      required: [
        'task_type'
      ]
    }
  },
  {
    name: 'run_build_check',
    description: 'Run a build/compile check after a task to verify code compiles.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to check'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for the build'
        }
      },
      required: [
        'working_directory'
      ]
    }
  },
  {
    name: 'get_build_result',
    description: 'Get the build check result for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to get result for'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'configure_build_check',
    description: 'Enable or disable automatic build checks after tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Whether to run build checks after code tasks'
        }
      },
      required: [
        'enabled'
      ]
    }
  },
  {
    name: 'setup_precommit_hook',
    description: 'Set up a git pre-commit hook that runs validation before allowing commits.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Git repository directory'
        },
        checks: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'validation',
              'syntax',
              'build',
              'approval'
            ]
          },
          description: 'Checks to run in pre-commit hook'
        }
      },
      required: [
        'working_directory'
      ]
    }
  },
  {
    name: 'get_rate_limits',
    description: 'Get rate limit configuration for providers.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Filter by provider'
        }
      }
    }
  },
  {
    name: 'set_rate_limit',
    description: 'Set rate limit for a provider.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider name'
        },
        limit_type: {
          type: 'string',
          enum: [
            'requests',
            'concurrent'
          ],
          description: 'Type of limit'
        },
        max_value: {
          type: 'number',
          description: 'Maximum value'
        },
        window_seconds: {
          type: 'number',
          description: 'Time window in seconds (for requests type)'
        }
      },
      required: [
        'provider',
        'limit_type',
        'max_value'
      ]
    }
  },
  {
    name: 'get_cost_summary',
    description: 'Get cost summary for providers.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Filter by provider'
        },
        days: {
          type: 'number',
          description: 'Number of days to include (default: 30)'
        }
      }
    }
  },
  {
    name: 'get_budget_status',
    description: 'Get budget status and spending.',
    inputSchema: {
      type: 'object',
      properties: {
        budget_id: {
          type: 'string',
          description: 'Specific budget ID (optional)'
        }
      }
    }
  },
  {
    name: 'set_budget',
    description: 'Create or update a cost budget.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Budget name'
        },
        provider: {
          type: 'string',
          description: 'Provider (null for total)'
        },
        budget_usd: {
          type: 'number',
          description: 'Budget amount in USD'
        },
        period: {
          type: 'string',
          enum: [
            'daily',
            'weekly',
            'monthly'
          ],
          description: 'Budget period'
        },
        alert_threshold: {
          type: 'number',
          description: 'Alert when spending reaches this percent (default: 80)'
        }
      },
      required: [
        'name',
        'budget_usd'
      ]
    }
  },
  {
    name: 'get_cost_forecast',
    description: 'Get cost forecast based on historical spending. Shows daily average burn rate, projected monthly cost, and days until each budget is exhausted. Use to proactively manage spending before hitting limits.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days of history to analyze (default: 30)'
        }
      }
    }
  },
  {
    name: 'run_security_scan',
    description: 'Run security scan on task output or specific file.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to scan'
        },
        file_path: {
          type: 'string',
          description: 'Specific file to scan'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'get_security_results',
    description: 'Get security scan results for a task.',
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
    name: 'list_security_rules',
    description: 'List available security rules.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled_only: {
          type: 'boolean',
          description: 'Only show enabled rules'
        }
      }
    }
  },
  {
    name: 'get_file_locks',
    description: 'Get active file locks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Filter by task ID'
        }
      }
    }
  },
  {
    name: 'release_file_locks',
    description: 'Release file locks for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to release locks for'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'check_test_coverage',
    description: 'Check if files have corresponding test files.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        file_path: {
          type: 'string',
          description: 'File to check'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory'
        }
      },
      required: [
        'task_id',
        'file_path',
        'working_directory'
      ]
    }
  },
  {
    name: 'run_style_check',
    description: 'Run code style/linter check on a file.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        file_path: {
          type: 'string',
          description: 'File to check'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory'
        },
        auto_fix: {
          type: 'boolean',
          description: 'Automatically fix issues'
        }
      },
      required: [
        'task_id',
        'file_path',
        'working_directory'
      ]
    }
  },
  {
    name: 'analyze_change_impact',
    description: 'Analyze what other files might be affected by changes.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        changed_file: {
          type: 'string',
          description: 'File that was changed'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory'
        }
      },
      required: [
        'task_id',
        'changed_file',
        'working_directory'
      ]
    }
  },
  {
    name: 'get_timeout_alerts',
    description: 'Get tasks that have exceeded expected duration.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Filter by task ID'
        }
      }
    }
  },
  {
    name: 'configure_output_limits',
    description: 'Configure output size limits.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider (null for default)'
        },
        max_output_bytes: {
          type: 'number',
          description: 'Maximum output size in bytes'
        },
        max_file_size_bytes: {
          type: 'number',
          description: 'Maximum file size in bytes'
        }
      }
    }
  },
  {
    name: 'get_audit_trail',
    description: 'Get audit trail events.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          description: 'Filter by entity type (task, config, etc.)'
        },
        entity_id: {
          type: 'string',
          description: 'Filter by entity ID'
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 100)'
        }
      }
    }
  },
  {
    name: 'get_audit_summary',
    description: 'Get audit activity summary.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to summarize (default: 7)'
        }
      }
    }
  },
  {
    name: 'scan_vulnerabilities',
    description: 'Scan project dependencies for known vulnerabilities (CVEs). Supports npm, pip, dotnet.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to associate results with'
        },
        working_directory: {
          type: 'string',
          description: 'Project directory to scan'
        }
      },
      required: [
        'working_directory'
      ]
    }
  },
  {
    name: 'get_vulnerability_results',
    description: 'Get vulnerability scan results for a task.',
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
    name: 'analyze_complexity',
    description: 'Analyze code complexity metrics (cyclomatic complexity, nesting depth, maintainability index).',
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
    name: 'get_complexity_metrics',
    description: 'Get complexity analysis results for a task.',
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
    name: 'detect_dead_code',
    description: 'Detect potentially unused functions and variables in task output.',
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
    name: 'get_dead_code_results',
    description: 'Get dead code detection results for a task.',
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
    name: 'validate_api_contract',
    description: 'Validate OpenAPI/Swagger contract file.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        contract_file: {
          type: 'string',
          description: 'Path to OpenAPI/Swagger file'
        },
        working_directory: {
          type: 'string',
          description: 'Project directory'
        }
      },
      required: [
        'task_id',
        'contract_file',
        'working_directory'
      ]
    }
  },
  {
    name: 'check_doc_coverage',
    description: 'Check documentation coverage for public APIs (JSDoc, XML docs, docstrings).',
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
    name: 'get_doc_coverage_results',
    description: 'Get documentation coverage results for a task.',
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
    name: 'detect_regressions',
    description: 'Compare test results after changes to detect regressions.',
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
    name: 'detect_config_drift',
    description: 'Detect configuration file changes since baseline.',
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
    name: 'estimate_resources',
    description: 'Estimate resource usage (memory, CPU) from code patterns.',
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
    name: 'check_i18n',
    description: 'Check for hardcoded strings that should be internationalized.',
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
    name: 'check_accessibility',
    description: 'Check UI code for accessibility (WCAG) violations.',
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
    name: 'get_safeguard_tools',
    description: 'List available safeguard tool configurations.',
    inputSchema: {
      type: 'object',
      properties: {
        safeguard_type: {
          type: 'string',
          description: 'Filter by safeguard type (vulnerability, complexity, deadcode, api_contract, accessibility)'
        }
      }
    }
  },
  {
    name: 'set_expected_output_path',
    description: 'Set expected output directory for a task. Files created outside this path will trigger anomaly alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        expected_directory: {
          type: 'string',
          description: 'Expected output directory path'
        },
        allow_subdirs: {
          type: 'boolean',
          description: 'Allow files in subdirectories (default: true)'
        },
        file_patterns: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Optional file patterns to expect (e.g., ["*.cs", "*.xaml"])'
        }
      },
      required: [
        'task_id',
        'expected_directory'
      ]
    }
  },
  {
    name: 'check_file_locations',
    description: 'Check for files created outside expected directories after task completion.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory to check against'
        }
      },
      required: [
        'task_id',
        'working_directory'
      ]
    }
  },
  {
    name: 'check_duplicate_files',
    description: 'Scan for duplicate files (same filename in multiple locations) after task completion.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        working_directory: {
          type: 'string',
          description: 'Directory to scan for duplicates'
        },
        file_extensions: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'File extensions to check (default: .cs, .xaml, .ts, .tsx, .js, .jsx, .py)'
        }
      },
      required: [
        'task_id',
        'working_directory'
      ]
    }
  },
  {
    name: 'get_file_location_issues',
    description: 'Get all file location issues (anomalies and duplicates) for a task.',
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
    name: 'record_file_change',
    description: 'Record a file change made by a task (for tracking purposes).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        file_path: {
          type: 'string',
          description: 'Full path to the file'
        },
        change_type: {
          type: 'string',
          enum: [
            'created',
            'modified',
            'deleted'
          ],
          description: 'Type of change'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for relative path calculation'
        }
      },
      required: [
        'task_id',
        'file_path',
        'change_type'
      ]
    }
  },
  {
    name: 'resolve_file_location_issue',
    description: 'Mark a file location issue as resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_type: {
          type: 'string',
          enum: [
            'anomaly',
            'duplicate'
          ],
          description: 'Type of issue to resolve'
        },
        issue_id: {
          type: 'number',
          description: 'ID of the issue to resolve'
        }
      },
      required: [
        'issue_type',
        'issue_id'
      ]
    }
  },
  {
    name: 'verify_type_references',
    description: 'Verify that interfaces/types referenced in code exist in the codebase. Detects hallucinated types.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        file_path: {
          type: 'string',
          description: 'Path to file to verify'
        },
        content: {
          type: 'string',
          description: 'File content to analyze'
        },
        working_directory: {
          type: 'string',
          description: 'Codebase root to search in'
        }
      },
      required: [
        'task_id',
        'file_path',
        'content',
        'working_directory'
      ]
    }
  },
  {
    name: 'get_type_verification_results',
    description: 'Get type verification results for a task.',
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
    name: 'analyze_build_output',
    description: 'Analyze build output for common errors (namespace conflicts, missing types, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        build_output: {
          type: 'string',
          description: 'Build command output to analyze'
        }
      },
      required: [
        'task_id',
        'build_output'
      ]
    }
  },
  {
    name: 'get_build_error_analysis',
    description: 'Get build error analysis results for a task.',
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
    name: 'search_similar_files',
    description: 'Search for similar files in codebase before creating new ones. Prevents duplicate file creation.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        search_term: {
          type: 'string',
          description: 'Filename or class name to search for'
        },
        working_directory: {
          type: 'string',
          description: 'Codebase root to search in'
        },
        search_type: {
          type: 'string',
          enum: [
            'filename',
            'classname'
          ],
          description: 'Type of search (default: filename)'
        }
      },
      required: [
        'task_id',
        'search_term',
        'working_directory'
      ]
    }
  },
  {
    name: 'get_similar_file_results',
    description: 'Get similar file search results for a task.',
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
    name: 'calculate_task_complexity',
    description: 'Calculate complexity score for a task to determine optimal routing.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        task_description: {
          type: 'string',
          description: 'Task description to analyze'
        }
      },
      required: [
        'task_id',
        'task_description'
      ]
    }
  },
  {
    name: 'get_task_complexity_score',
    description: 'Get complexity score for a task.',
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
    name: 'validate_xaml_semantics',
    description: 'Validate XAML for semantic issues (TemplateBinding misuse, missing resources, etc.) that pass compilation but crash at runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        file_path: {
          type: 'string',
          description: 'Path to XAML file'
        },
        content: {
          type: 'string',
          description: 'XAML file content'
        }
      },
      required: [
        'task_id',
        'file_path',
        'content'
      ]
    }
  },
  {
    name: 'get_xaml_validation_results',
    description: 'Get XAML validation results for a task.',
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
    name: 'check_xaml_consistency',
    description: 'Check XAML/code-behind consistency (verify x:Name elements match code-behind field references).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        xaml_path: {
          type: 'string',
          description: 'Path to XAML file'
        },
        xaml_content: {
          type: 'string',
          description: 'XAML file content'
        },
        codebehind_content: {
          type: 'string',
          description: 'Code-behind (.xaml.cs) file content'
        }
      },
      required: [
        'task_id',
        'xaml_path',
        'xaml_content',
        'codebehind_content'
      ]
    }
  },
  {
    name: 'get_xaml_consistency_results',
    description: 'Get XAML/code-behind consistency check results.',
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
    name: 'run_app_smoke_test',
    description: 'Run app startup smoke test - launches app and verifies it does not crash within timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID'
        },
        working_directory: {
          type: 'string',
          description: 'Directory containing the project'
        },
        project_file: {
          type: 'string',
          description: 'Optional path to .csproj file'
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds (default: 10)'
        }
      },
      required: [
        'task_id',
        'working_directory'
      ]
    }
  },
  {
    name: 'get_smoke_test_results',
    description: 'Get smoke test results for a task.',
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
  }
];
