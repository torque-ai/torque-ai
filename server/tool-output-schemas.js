'use strict';

/**
 * Centralized registry of MCP outputSchema definitions.
 * Maps tool names to JSON Schema objects describing their structuredContent shape.
 * Only tools that return parseable structured data get schemas.
 *
 * Pattern: same as tool-annotations.js — centralized, auditable, startup-merged.
 */

const OUTPUT_SCHEMAS = {
  // ── Task lifecycle ──

  check_status: {
    type: 'object',
    properties: {
      pressure_level: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
      task: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'] },
          provider: { type: 'string' },
          model: { type: 'string' },
          progress: { type: 'number' },
          exit_code: { type: 'number' },
          elapsed_seconds: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['id', 'status'],
      },
      running_count: { type: 'number' },
      queued_count: { type: 'number' },
      running_tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            progress: { type: 'number' },
            is_stalled: { type: 'boolean' },
            last_activity_seconds: { type: 'number' },
            description: { type: 'string' },
          },
        },
      },
      queued_tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            priority: { type: 'number' },
            description: { type: 'string' },
          },
        },
      },
      recent_tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            model: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    required: ['pressure_level'],
  },

  task_info: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['status', 'result', 'progress'] },
      pressure_level: { type: 'string' },
      task: { type: 'object' },
      running_count: { type: 'number' },
      queued_count: { type: 'number' },
      running_tasks: { type: 'array' },
      queued_tasks: { type: 'array' },
      recent_tasks: { type: 'array' },
      id: { type: 'string' },
      status: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      exit_code: { type: 'number' },
      duration_seconds: { type: 'number' },
      output: { type: 'string' },
      error_output: { type: 'string' },
      files_modified: { type: 'array', items: { type: 'string' } },
      progress: { type: 'number' },
      elapsed_seconds: { type: 'number' },
      output_tail: { type: 'string' },
    },
    required: ['mode'],
  },

  list_tasks: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            priority: { type: 'number' },
            description: { type: 'string' },
            created_at: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['count', 'tasks'],
  },

  get_result: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      host_name: { type: 'string' },
      exit_code: { type: 'number' },
      duration_seconds: { type: 'number' },
      output: { type: 'string' },
      error_output: { type: 'string' },
      files_modified: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'status'],
  },

  get_progress: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string' },
      progress: { type: 'number' },
      elapsed_seconds: { type: 'number' },
      output_tail: { type: 'string' },
    },
    required: ['id', 'status', 'progress'],
  },

  // ── Workflows ──

  workflow_status: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      status: { type: 'string' },
      visibility: { type: 'string' },
      completed_count: { type: 'number' },
      running_count: { type: 'number' },
      queued_count: { type: 'number' },
      pending_count: { type: 'number' },
      blocked_count: { type: 'number' },
      failed_count: { type: 'number' },
      skipped_count: { type: 'number' },
      cancelled_count: { type: 'number' },
      open_count: { type: 'number' },
      total_count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            node_id: { type: 'string' },
            task_id: { type: 'string' },
            status: { type: 'string' },
            provider: { type: 'string' },
            progress: { type: 'number' },
            exit_code: { type: 'number' },
            depends_on: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['id', 'name', 'status', 'total_count'],
  },

  list_workflows: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      workflows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            status: { type: 'string' },
            visibility: { type: 'string' },
            total_tasks: { type: 'number' },
            completed_tasks: { type: 'number' },
            open_tasks: { type: 'number' },
            created_at: { type: 'string' },
          },
        },
      },
    },
    required: ['count', 'workflows'],
  },

  // ── Provider/Host ──

  list_ollama_hosts: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      hosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            url: { type: 'string' },
            status: { type: 'string', enum: ['healthy', 'down', 'degraded', 'unknown'] },
            enabled: { type: 'boolean' },
            running_tasks: { type: 'number' },
            max_concurrent: { type: 'number' },
            memory_limit_mb: { type: 'number' },
            models: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    required: ['count', 'hosts'],
  },

  get_context: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['queue', 'workflow'] },
      pressure_level: { type: 'string' },
      running: { type: 'object' },
      queued: { type: 'object' },
      recent_completed: { type: 'object' },
      recent_failed: { type: 'object' },
      active_workflows: { type: 'object' },
      provider_health: { type: 'object' },
      workflow: { type: 'object' },
      counts: { type: 'object' },
      completed_tasks: { type: 'array' },
      running_tasks: { type: 'array' },
      failed_tasks: { type: 'array' },
      blocked_tasks: { type: 'array' },
      next_actionable: { type: 'array' },
      alerts: { type: 'array' },
    },
    required: ['scope'],
  },

  // ── Phase 2: Provider/Cost/Monitoring ──

  provider_stats: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      total_tasks: { type: 'number' },
      successful_tasks: { type: 'number' },
      failed_tasks: { type: 'number' },
      success_rate: { type: 'number' },
      total_tokens: { type: 'number' },
      total_cost: { type: 'number' },
      avg_duration_seconds: { type: 'number' },
      enabled: { type: 'boolean' },
      priority: { type: 'number' },
      max_concurrent: { type: 'number' },
    },
    required: ['provider'],
  },

  success_rates: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      rates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            group_key: { type: 'string' },
            total: { type: 'number' },
            successful: { type: 'number' },
            failed: { type: 'number' },
            success_rate: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'rates'],
  },

  list_providers: {
    type: 'object',
    properties: {
      default_provider: { type: 'string' },
      count: { type: 'number' },
      providers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            enabled: { type: 'boolean' },
            priority: { type: 'number' },
            max_concurrent: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'providers'],
  },

  check_ollama_health: {
    type: 'object',
    properties: {
      healthy_count: { type: 'number' },
      total_count: { type: 'number' },
      hosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            url: { type: 'string' },
            status: { type: 'string' },
            running_tasks: { type: 'number' },
            models_count: { type: 'number' },
          },
        },
      },
    },
    required: ['healthy_count', 'total_count', 'hosts'],
  },

  get_cost_summary: {
    type: 'object',
    properties: {
      days: { type: 'number' },
      costs: { type: 'object' },
    },
    required: ['days'],
  },

  get_budget_status: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      budgets: { type: 'array' },
    },
    required: ['count', 'budgets'],
  },

  get_cost_forecast: {
    type: 'object',
    properties: {
      forecast: { type: 'object' },
    },
    required: ['forecast'],
  },

  get_concurrency_limits: {
    type: 'object',
    properties: {
      providers: { type: 'array' },
      hosts: { type: 'array' },
    },
    required: ['providers'],
  },

  check_stalled_tasks: {
    type: 'object',
    properties: {
      running_count: { type: 'number' },
      stalled_count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            elapsed_seconds: { type: 'number' },
            last_activity_seconds: { type: 'number' },
            is_stalled: { type: 'boolean' },
          },
        },
      },
    },
    required: ['running_count', 'stalled_count', 'tasks'],
  },

  check_task_progress: {
    type: 'object',
    properties: {
      running_count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            host: { type: 'string' },
            runtime_seconds: { type: 'number' },
            output_length: { type: 'number' },
            status: { type: 'string' },
          },
        },
      },
    },
    required: ['running_count', 'tasks'],
  },

  // ── Phase 3: Workflow History, Models, Archives, Health, Tags, Batch ──

  workflow_history: {
    type: 'object',
    properties: {
      workflow_id: { type: 'string' },
      count: { type: 'number' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            time: { type: 'string' },
            event: { type: 'string' },
            task_id: { type: 'string' },
            details: { type: 'string' },
          },
        },
      },
    },
    required: ['workflow_id', 'events'],
  },

  list_models: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      models: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            model_name: { type: 'string' },
            host_id: { type: 'string' },
            status: { type: 'string' },
            size_bytes: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'models'],
  },

  list_pending_models: {
    type: 'object',
    properties: {
      pending_count: { type: 'number' },
      models: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            model_name: { type: 'string' },
            host_id: { type: 'string' },
            size_bytes: { type: 'number' },
            first_seen_at: { type: 'string' },
          },
        },
      },
    },
    required: ['pending_count', 'models'],
  },

  list_model_roles: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            role: { type: 'string' },
            model_name: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
      },
    },
    required: ['count', 'roles'],
  },

  list_archived: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            description: { type: 'string' },
            archived_at: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
    required: ['count', 'tasks'],
  },

  get_archive_stats: {
    type: 'object',
    properties: {
      total_archived: { type: 'number' },
      by_status: { type: 'object' },
      by_reason: { type: 'object' },
    },
    required: ['total_archived'],
  },

  get_provider_health_trends: {
    type: 'object',
    properties: {
      trends: { type: 'array' },
    },
    required: ['trends'],
  },

  health_check: {
    type: 'object',
    properties: {
      check_type: { type: 'string' },
      status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
      response_time_ms: { type: 'number' },
      error_message: { type: 'string' },
      details: { type: 'object' },
    },
    required: ['status'],
  },

  integration_health: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      integrations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string' },
            latency_ms: { type: 'number' },
          },
        },
      },
    },
    required: ['count', 'integrations'],
  },

  list_tags: {
    type: 'object',
    properties: {
      total_unique: { type: 'number' },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            usage_count: { type: 'number' },
          },
        },
      },
    },
    required: ['total_unique', 'tags'],
  },

  start_oauth_flow: {
    type: 'object',
    properties: {
      toolkit: { type: 'string' },
      user_id: { type: 'string' },
      state: { type: 'string' },
      authorize_url: { type: 'string' },
    },
    required: ['toolkit', 'user_id', 'state', 'authorize_url'],
  },

  complete_oauth_flow: {
    type: 'object',
    properties: {
      toolkit: { type: 'string' },
      user_id: { type: 'string' },
      connected_account_id: { type: 'string' },
    },
    required: ['toolkit', 'user_id', 'connected_account_id'],
  },

  list_connected_accounts: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      accounts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            user_id: { type: 'string' },
            toolkit: { type: 'string' },
            auth_config_id: { type: 'string' },
            expires_at: { type: ['number', 'null'] },
            status: { type: 'string' },
            has_refresh_token: { type: 'boolean' },
            metadata: { type: 'object' },
            created_at: { type: 'number' },
            updated_at: { type: 'number' },
          },
          required: ['id', 'user_id', 'toolkit', 'auth_config_id', 'status', 'has_refresh_token', 'metadata', 'created_at', 'updated_at'],
        },
      },
    },
    required: ['count', 'accounts'],
  },

  disable_account: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      account_id: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['ok', 'account_id', 'status'],
  },

  delete_account: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      account_id: { type: 'string' },
    },
    required: ['ok', 'account_id'],
  },

  list_tools_by_hints: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      filters: {
        type: 'object',
        properties: {
          readOnlyHint: { type: 'boolean' },
          destructiveHint: { type: 'boolean' },
          idempotentHint: { type: 'boolean' },
          openWorldHint: { type: 'boolean' },
        },
      },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            readOnlyHint: { type: 'boolean' },
            destructiveHint: { type: 'boolean' },
            idempotentHint: { type: 'boolean' },
            openWorldHint: { type: 'boolean' },
            annotations: {
              type: 'object',
              properties: {
                readOnlyHint: { type: 'boolean' },
                destructiveHint: { type: 'boolean' },
                idempotentHint: { type: 'boolean' },
                openWorldHint: { type: 'boolean' },
              },
              required: ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'],
            },
          },
          required: ['name', 'description', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint', 'annotations'],
        },
      },
    },
    required: ['count', 'filters', 'tools'],
  },

  get_batch_summary: {
    type: 'object',
    properties: {
      workflow_id: { type: 'string' },
      workflow_status: { type: 'string' },
      completed_tasks: { type: 'number' },
      failed_tasks: { type: 'number' },
      total_tasks: { type: 'number' },
      duration_seconds: { type: 'number' },
      files_added: { type: 'number' },
      files_modified: { type: 'number' },
      test_count: { type: 'number' },
    },
    required: ['workflow_id', 'workflow_status'],
  },
};

/**
 * Get the output schema for a tool, or undefined if none declared.
 * @param {string} name - Tool name
 * @returns {object|undefined}
 */
function getOutputSchema(name) {
  if (typeof name !== 'string') return undefined;
  return OUTPUT_SCHEMAS[name];
}

/**
 * Validate that all declared schemas reference tools that exist.
 * @param {string[]} toolNames - All registered tool names
 * @returns {{ stale: string[] }} - stale = schema keys not in toolNames
 */
function validateSchemaCoverage(toolNames) {
  const nameSet = new Set(toolNames);
  const stale = [];
  for (const name of Object.keys(OUTPUT_SCHEMAS)) {
    if (!nameSet.has(name)) {
      stale.push(name);
    }
  }
  return { stale };
}

module.exports = {
  OUTPUT_SCHEMAS,
  getOutputSchema,
  validateSchemaCoverage,
};
