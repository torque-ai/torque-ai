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
