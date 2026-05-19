'use strict';

/**
 * Centralized registry of MCP outputSchema definitions.
 * Maps tool names to JSON Schema objects describing their structuredContent shape.
 * Only tools that return parseable structured data get schemas.
 *
 * Pattern: same as tool-annotations.js — centralized, auditable, startup-merged.
 */

const WORK_ITEM_STATUS_COUNTS_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'number' },
};

const AUTOMATION_BLOCKER_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['code', 'message'],
};

const AUTOMATION_CONTROL_PLANE_STEP_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'object', additionalProperties: true },
    description: { type: 'string' },
    effect_scope: { type: 'string', enum: ['control_plane'] },
    mutates_control_plane: { type: 'boolean' },
    processes_project_work: { type: 'boolean' },
    enables_future_processing: { type: 'boolean' },
  },
  required: [
    'action',
    'tool',
    'args',
    'description',
    'effect_scope',
    'mutates_control_plane',
    'processes_project_work',
    'enables_future_processing',
  ],
};

const WORK_ITEM_AUTO_RECOVERY_HINT_SCHEMA = {
  type: 'object',
  properties: {
    strategy: { type: 'string' },
    reason: { type: 'string' },
    runs_on: { type: 'string' },
    requires_project_work_enabled: { type: 'boolean' },
    deferred_by_project_work_disabled: { type: 'boolean' },
  },
  required: [
    'strategy',
    'reason',
    'runs_on',
    'requires_project_work_enabled',
    'deferred_by_project_work_disabled',
  ],
};

const WORK_ITEM_AUTO_RECOVERY_CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    ...WORK_ITEM_AUTO_RECOVERY_HINT_SCHEMA.properties,
    count: { type: 'number' },
  },
  required: [
    ...WORK_ITEM_AUTO_RECOVERY_HINT_SCHEMA.required,
    'count',
  ],
};

const WORK_ITEM_BLOCKER_AUTO_RECOVERY_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    eligible_count: { type: 'number' },
    fully_eligible: { type: 'boolean' },
    candidates: {
      type: 'array',
      items: WORK_ITEM_AUTO_RECOVERY_CANDIDATE_SCHEMA,
    },
  },
  required: ['eligible_count', 'fully_eligible', 'candidates'],
};

const WORK_ITEM_AUTO_RECOVERY_COVERAGE_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    total_count: { type: 'number' },
    eligible_count: { type: 'number' },
    unmatched_count: { type: 'number' },
    deferred_count: { type: 'number' },
    fully_covered: { type: 'boolean' },
  },
  required: ['total_count', 'eligible_count', 'unmatched_count', 'deferred_count', 'fully_covered'],
};

const WORK_ITEM_AUTO_RECOVERY_COVERAGE_SCHEMA = {
  type: 'object',
  properties: {
    needs_review: WORK_ITEM_AUTO_RECOVERY_COVERAGE_ENTRY_SCHEMA,
    escalation_exhausted: WORK_ITEM_AUTO_RECOVERY_COVERAGE_ENTRY_SCHEMA,
  },
  required: ['needs_review', 'escalation_exhausted'],
};

const WORK_ITEM_BLOCKER_PREVIEW_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    title: { type: ['string', 'null'] },
    priority: { type: 'number' },
    reject_reason: { type: ['string', 'null'] },
    created_at: { type: ['string', 'null'] },
    updated_at: { type: ['string', 'null'] },
    known_auto_recovery: WORK_ITEM_AUTO_RECOVERY_HINT_SCHEMA,
  },
  required: ['id', 'title', 'priority', 'reject_reason', 'created_at', 'updated_at'],
};

const AUTOMATION_READINESS_SCHEMA = {
  type: 'object',
  properties: {
    ready: { type: 'boolean' },
    status: { type: 'string' },
    trust_level: { type: 'string' },
    auto_continue: { type: 'boolean' },
    auto_advance: { type: 'boolean' },
    operator_paused: { type: 'boolean' },
    approval_gates: { type: 'array', items: { type: 'string' } },
    blocker_codes: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: AUTOMATION_BLOCKER_SCHEMA },
    next_control_plane_action: { type: ['string', 'null'] },
    control_plane_actions: { type: 'array', items: { type: 'string' } },
    control_plane_plan: { type: 'array', items: AUTOMATION_CONTROL_PLANE_STEP_SCHEMA },
  },
  required: ['ready', 'status', 'trust_level', 'auto_continue', 'operator_paused', 'approval_gates', 'blocker_codes', 'blockers', 'control_plane_actions', 'control_plane_plan'],
};

const AUTOMATION_MANUAL_INTERVENTION_SCHEMA = {
  type: 'object',
  properties: {
    required: { type: 'boolean' },
    reason_codes: { type: 'array', items: { type: 'string' } },
    counts: {
      type: 'object',
      properties: {
        blocked_projects: { type: 'number' },
        operator_paused_projects: { type: 'number' },
        approval_gated_projects: { type: 'number' },
        pending_approval_tasks: { type: 'number' },
        needs_review_work_items: { type: 'number' },
        escalation_exhausted_work_items: { type: 'number' },
        scheduler_unarmed_projects: { type: 'number' },
        factory_project_work_enabled: { type: 'number' },
      },
      required: [
        'blocked_projects',
        'operator_paused_projects',
        'approval_gated_projects',
        'pending_approval_tasks',
        'needs_review_work_items',
        'escalation_exhausted_work_items',
        'scheduler_unarmed_projects',
        'factory_project_work_enabled',
      ],
    },
    project_ids: {
      type: 'object',
      properties: {
        scheduler_unarmed: { type: 'array', items: { type: 'string' } },
      },
      required: ['scheduler_unarmed'],
    },
    work_item_blockers: {
      type: 'object',
      properties: {
        needs_review: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              project_id: { type: ['string', 'null'] },
              project_name: { type: ['string', 'null'] },
              status: { type: 'string', enum: ['needs_review'] },
              count: { type: 'number' },
              oldest_created_at: { type: ['string', 'null'] },
              oldest_updated_at: { type: ['string', 'null'] },
              newest_updated_at: { type: ['string', 'null'] },
              reject_reason_counts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    reject_reason: { type: ['string', 'null'] },
                    count: { type: 'number' },
                  },
                  required: ['reject_reason', 'count'],
                },
              },
              oldest_items: {
                type: 'array',
                items: WORK_ITEM_BLOCKER_PREVIEW_ITEM_SCHEMA,
              },
              known_auto_recovery: WORK_ITEM_BLOCKER_AUTO_RECOVERY_SUMMARY_SCHEMA,
            },
            required: ['project_id', 'project_name', 'status', 'count'],
          },
        },
        escalation_exhausted: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              project_id: { type: ['string', 'null'] },
              project_name: { type: ['string', 'null'] },
              status: { type: 'string', enum: ['escalation_exhausted'] },
              count: { type: 'number' },
              oldest_created_at: { type: ['string', 'null'] },
              oldest_updated_at: { type: ['string', 'null'] },
              newest_updated_at: { type: ['string', 'null'] },
              reject_reason_counts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    reject_reason: { type: ['string', 'null'] },
                    count: { type: 'number' },
                  },
                  required: ['reject_reason', 'count'],
                },
              },
              oldest_items: {
                type: 'array',
                items: WORK_ITEM_BLOCKER_PREVIEW_ITEM_SCHEMA,
              },
              known_auto_recovery: WORK_ITEM_BLOCKER_AUTO_RECOVERY_SUMMARY_SCHEMA,
            },
            required: ['project_id', 'project_name', 'status', 'count'],
          },
        },
      },
      required: ['needs_review', 'escalation_exhausted'],
    },
    auto_recovery_coverage: WORK_ITEM_AUTO_RECOVERY_COVERAGE_SCHEMA,
  },
  required: ['required', 'reason_codes', 'counts', 'project_ids', 'work_item_blockers', 'auto_recovery_coverage'],
};

const AUTOMATION_READINESS_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    ready: { type: 'boolean' },
    hands_off_ready: { type: 'boolean' },
    total_projects: { type: 'number' },
    ready_projects: { type: 'number' },
    blocked_projects: { type: 'number' },
    auto_continue_enabled_projects: { type: 'number' },
    dark_trust_projects: { type: 'number' },
    operator_paused_projects: { type: 'number' },
    approval_gated_projects: { type: 'number' },
    project_work_enabled: { type: 'boolean' },
    blockers: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    project_ids: {
      type: 'object',
      properties: {
        ready: { type: 'array', items: { type: 'string' } },
        blocked: { type: 'array', items: { type: 'string' } },
      },
    },
    control_plane_plan: { type: 'array', items: AUTOMATION_CONTROL_PLANE_STEP_SCHEMA },
    manual_intervention: AUTOMATION_MANUAL_INTERVENTION_SCHEMA,
  },
  required: ['ready', 'hands_off_ready', 'total_projects', 'ready_projects', 'blocked_projects', 'project_work_enabled', 'blockers', 'project_ids', 'control_plane_plan', 'manual_intervention'],
};

const AUTOMATION_APPLY_STEP_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'object', additionalProperties: true },
    status: { type: 'string', enum: ['applied', 'dry_run', 'failed'] },
    effect_scope: { type: 'string', enum: ['control_plane'] },
    processes_project_work: { type: 'boolean' },
    mutates_control_plane: { type: 'boolean' },
    enables_future_processing: { type: 'boolean' },
    result: { type: ['object', 'null'], additionalProperties: true },
    error: { type: 'string' },
  },
  required: [
    'action',
    'tool',
    'args',
    'status',
    'effect_scope',
    'processes_project_work',
    'mutates_control_plane',
    'enables_future_processing',
  ],
};

const FACTORY_IDLE_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    label: { type: 'string' },
    project_ids: { type: 'array', items: { type: 'string' } },
    effect_scope: { type: 'string' },
    mutates_control_plane: { type: 'boolean' },
    processes_project_work: { type: 'boolean' },
  },
  required: ['type', 'label'],
};

const FACTORY_IDLE_DIAGNOSIS_SCHEMA = {
  type: 'object',
  properties: {
    idle: { type: 'boolean' },
    reason_code: { type: 'string' },
    message: { type: 'string' },
    counts: { type: 'object', additionalProperties: true },
    project_ids: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    actions: { type: 'array', items: FACTORY_IDLE_ACTION_SCHEMA },
  },
  required: ['idle', 'reason_code', 'message', 'counts', 'project_ids', 'actions'],
};

const FACTORY_PROJECT_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    path: { type: 'string' },
    trust_level: { type: 'string' },
    status: { type: 'string' },
    commits_today: { type: 'number' },
    loop_state: { type: 'string' },
    active_stage: { type: 'string' },
    active_task: { type: ['object', 'null'] },
    state_consistency: { type: 'object' },
    loop_paused_at_stage: { type: ['string', 'null'] },
    loop_last_action_at: { type: ['string', 'null'] },
    consecutive_empty_cycles: { type: 'number' },
    open_work_item_count: { type: 'number' },
    work_item_status_counts: WORK_ITEM_STATUS_COUNTS_SCHEMA,
    automation_readiness: AUTOMATION_READINESS_SCHEMA,
    alert_badge: { type: ['object', 'null'] },
    balance: { type: 'number' },
    weakest_dimension: { type: ['string', 'null'] },
    dimension_count: { type: 'number' },
    health_model_status: { type: 'string' },
    health_missing_dimensions: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name', 'path', 'trust_level', 'status', 'loop_state'],
};

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
          status: { type: 'string', enum: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'waiting', 'pending_approval', 'pending_provider_switch', 'retry_scheduled', 'skipped', 'blocked'] },
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

  // -- Factory --

  list_factory_projects: {
    type: 'object',
    properties: {
      projects: {
        type: 'array',
        items: FACTORY_PROJECT_SUMMARY_SCHEMA,
      },
      idle_diagnosis: FACTORY_IDLE_DIAGNOSIS_SCHEMA,
      automation_readiness: AUTOMATION_READINESS_SUMMARY_SCHEMA,
    },
    required: ['projects'],
  },

  factory_status: {
    type: 'object',
    properties: {
      projects: {
        type: 'array',
        items: FACTORY_PROJECT_SUMMARY_SCHEMA,
      },
      summary: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          running: { type: 'number' },
          paused: { type: 'number' },
          stalled: { type: 'number' },
          production_today: { type: 'number' },
          zero_commit_projects: { type: 'number' },
          active_internal_tasks: { type: 'number' },
          active_project_tasks: { type: 'number' },
          state_mismatch_projects: { type: 'number' },
          idle_diagnosis: FACTORY_IDLE_DIAGNOSIS_SCHEMA,
          automation_readiness: AUTOMATION_READINESS_SUMMARY_SCHEMA,
          work_item_status_counts: WORK_ITEM_STATUS_COUNTS_SCHEMA,
          needs_review_work_items: { type: 'number' },
          needs_replan_work_items: { type: 'number' },
        },
        required: ['total', 'running', 'paused', 'stalled'],
      },
    },
    required: ['projects', 'summary'],
  },

  factory_automation_plan: {
    type: 'object',
    properties: {
      ready: { type: 'boolean' },
      hands_off_ready: { type: 'boolean' },
      message: { type: 'string' },
      scope: {
        type: 'object',
        properties: {
          project: { type: ['string', 'null'] },
          status: { type: ['string', 'null'] },
          blocked_only: { type: 'boolean' },
        },
        required: ['project', 'status', 'blocked_only'],
      },
      summary: AUTOMATION_READINESS_SUMMARY_SCHEMA,
      work_item_status_counts: WORK_ITEM_STATUS_COUNTS_SCHEMA,
      needs_review_work_items: { type: 'number' },
      needs_replan_work_items: { type: 'number' },
      manual_intervention: AUTOMATION_MANUAL_INTERVENTION_SCHEMA,
      control_plane_plan: { type: 'array', items: AUTOMATION_CONTROL_PLANE_STEP_SCHEMA },
      projects: {
        type: 'array',
        items: FACTORY_PROJECT_SUMMARY_SCHEMA,
      },
    },
    required: ['ready', 'hands_off_ready', 'message', 'scope', 'summary', 'work_item_status_counts', 'needs_review_work_items', 'needs_replan_work_items', 'manual_intervention', 'control_plane_plan', 'projects'],
  },

  apply_factory_automation_plan: {
    type: 'object',
    properties: {
      completed: { type: 'boolean' },
      dry_run: { type: 'boolean' },
      scope: {
        type: 'object',
        properties: {
          project: { type: ['string', 'null'] },
          status: { type: ['string', 'null'] },
          blocked_only: { type: 'boolean' },
        },
        required: ['project', 'status', 'blocked_only'],
      },
      message: { type: 'string' },
      processes_project_work: { type: 'boolean' },
      enables_future_processing: { type: 'boolean' },
      planned_steps: { type: 'number' },
      applied_steps: { type: 'array', items: AUTOMATION_APPLY_STEP_SCHEMA },
      skipped_steps: { type: 'array', items: AUTOMATION_APPLY_STEP_SCHEMA },
      failed_steps: { type: 'array', items: AUTOMATION_APPLY_STEP_SCHEMA },
      before: {
        type: 'object',
        additionalProperties: true,
      },
      after: {
        type: 'object',
        additionalProperties: true,
      },
    },
    required: [
      'completed',
      'dry_run',
      'scope',
      'message',
      'processes_project_work',
      'enables_future_processing',
      'planned_steps',
      'applied_steps',
      'skipped_steps',
      'failed_steps',
      'before',
      'after',
    ],
  },

  arm_factory_tick: {
    type: 'object',
    properties: {
      project: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          trust_level: { type: 'string' },
        },
        required: ['id', 'name', 'status', 'trust_level'],
      },
      tick_active: { type: 'boolean' },
      started: { type: 'boolean' },
      already_active: { type: 'boolean' },
      interval_ms: { type: ['number', 'null'] },
      immediate_tick: { type: 'boolean' },
      processes_project_work: { type: 'boolean' },
      enables_future_processing: { type: 'boolean' },
      automation_readiness: AUTOMATION_READINESS_SCHEMA,
      message: { type: 'string' },
    },
    required: [
      'project',
      'tick_active',
      'started',
      'already_active',
      'interval_ms',
      'immediate_tick',
      'processes_project_work',
      'enables_future_processing',
      'automation_readiness',
      'message',
    ],
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
      fallback_provider: { type: 'string' },
      fallback_active: { type: 'boolean' },
      preferred_provider: { type: 'string' },
      preferred_available: { type: 'boolean' },
      remote_preferred: { type: 'boolean' },
      smart_routing_enabled: { type: 'boolean' },
      fallback_state: {
        type: 'object',
        properties: {
          preferred_provider: { type: 'string' },
          fallback_provider: { type: 'string' },
          fallback_active: { type: 'boolean' },
          preferred_available: { type: 'boolean' },
          remote_preferred: { type: 'boolean' },
          smart_routing_enabled: { type: 'boolean' },
          state: { type: 'string', enum: ['preferred_available', 'partial_degradation', 'fallback_active', 'unconfigured', 'unknown'] },
          health_status: { type: 'string', enum: ['healthy', 'warning', 'degraded', 'disabled', 'unknown'] },
          healthy_count: { type: 'number' },
          total_count: { type: 'number' },
          host_count: { type: 'number' },
          known_down_count: { type: 'number' },
          unknown_count: { type: 'number' },
          summary: { type: 'string' },
          hosts: { type: 'array' },
        },
        required: ['preferred_provider', 'fallback_provider', 'fallback_active', 'state', 'health_status', 'healthy_count', 'total_count', 'hosts'],
      },
      hosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: ['string', 'null'] },
            name: { type: 'string' },
            url: { type: 'string' },
            status: { type: 'string' },
            enabled: { type: 'boolean' },
            remote: { type: 'boolean' },
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

  reset_provider_health: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['all', 'provider'] },
      provider: { type: 'string' },
      reset_count: { type: 'number' },
    },
    required: ['scope', 'reset_count'],
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

  create_handoff_agent: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      wrapper_tool: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
      system_prompt: { type: 'string' },
      registered_at: { type: 'string' },
      updated_at: { type: 'string' },
    },
    required: ['name', 'wrapper_tool', 'tools', 'system_prompt', 'registered_at', 'updated_at'],
  },

  get_handoff_history: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      workflow_id: { type: ['string', 'null'] },
      count: { type: 'number' },
      history: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            at: { type: 'number' },
            patch: { type: 'object' },
            workflow_id: { type: ['string', 'null'] },
          },
          required: ['from', 'to', 'at', 'patch'],
        },
      },
    },
    required: ['task_id', 'count', 'history'],
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

  dispatch_subagent: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      session_id: { type: 'string' },
      claude_session_id: { type: ['string', 'null'] },
      output: { type: 'string' },
      usage: { type: 'object' },
      mode: { type: 'string' },
      skill: { type: ['string', 'null'] },
      error: { type: 'string' },
    },
    required: ['ok'],
  },

  resume_session: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      session: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['ok'],
  },

  fork_session: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      session: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['ok'],
  },

  list_sessions: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      count: { type: 'number' },
      sessions: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['ok'],
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
