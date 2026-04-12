'use strict';

const tools = [
  {
    name: 'register_factory_project',
    description: 'Register a project with the software factory. Creates a project entry with a health model that tracks 10 quality dimensions. Projects start in supervised trust level and paused status.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable project name' },
        path: { type: 'string', description: 'Absolute path to the project root directory' },
        brief: { type: 'string', description: 'Project brief — what it is, who it is for, critical user journeys. Used by the Architect agent for product-sense prioritization.' },
        trust_level: {
          type: 'string',
          enum: ['supervised', 'guided', 'autonomous', 'dark'],
          description: 'Initial trust level. supervised=human approves priorities+plan+verify+ship, guided=human approves plan+ship, autonomous=human approves ship only, dark=fully autonomous. Default: supervised.',
        },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'list_factory_projects',
    description: 'List all projects registered with the software factory, including their trust level, status, and latest health summary.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'paused', 'idle'],
          description: 'Filter by factory status',
        },
      },
    },
  },
  {
    name: 'project_health',
    description: 'Get the current health model for a factory project. Returns scores for all 10 dimensions, balance score (standard deviation - lower is more balanced), weakest dimension, and optional trend data.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        include_trends: { type: 'boolean', description: 'Include score history for each dimension (default: false)' },
        include_findings: { type: 'boolean', description: 'Include detailed findings for each dimension (default: false)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'scan_project_health',
    description: 'Run a health scan on a factory project. Scores the specified dimensions (or all 10) using scouts and static analysis. Stores results as time-series snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Dimensions to scan. Default: all 10.',
        },
        scan_type: {
          type: 'string',
          enum: ['full', 'incremental'],
          description: 'Full = deep scan (expensive). Incremental = quick re-score. Default: incremental.',
        },
        batch_id: { type: 'string', description: 'Link this scan to a specific batch for pre/post comparison' },
      },
      required: ['project'],
    },
  },
  {
    name: 'set_factory_trust_level',
    description: 'Change the trust level for a factory project. Higher trust = more autonomy.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        trust_level: {
          type: 'string',
          enum: ['supervised', 'guided', 'autonomous', 'dark'],
          description: 'New trust level',
        },
      },
      required: ['project', 'trust_level'],
    },
  },
  {
    name: 'pause_project',
    description: 'Pause a factory project. Freezes the factory loop. One-action emergency control.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'resume_project',
    description: 'Resume a paused factory project. The factory loop restarts from the Sense stage.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'pause_all_projects',
    description: 'Emergency stop — pause ALL factory projects immediately.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'factory_status',
    description: 'Overview of all factory projects — name, trust level, status, health balance score. Air traffic control view.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_work_item',
    description: 'Create a new work item in the factory intake queue. Accepts work from any source (conversation, GitHub, scouts, CI, webhooks). Deduplicates by title within the same project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        source: { type: 'string', enum: ['conversation', 'github', 'scout', 'ci', 'webhook', 'manual'], description: 'Where this work item originated' },
        title: { type: 'string', description: 'Short title for the work item' },
        description: { type: 'string', description: 'Detailed description of the work' },
        priority: { type: 'integer', description: 'Priority 1-100 (higher = more urgent). Default: 50' },
        requestor: { type: 'string', description: 'Who requested this work' },
        origin: { type: 'object', description: 'Raw origin data (GitHub issue, scout finding, etc.)' },
        constraints: { type: 'object', description: 'Constraints (deadline, budget, etc.)' },
      },
      required: ['project', 'source', 'title'],
    },
  },
  {
    name: 'list_work_items',
    description: 'List work items in the factory intake queue, sorted by priority (highest first). Filter by project and/or status.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        status: { type: 'string', enum: ['pending', 'triaged', 'in_progress', 'completed', 'rejected'], description: 'Filter by status' },
        limit: { type: 'integer', description: 'Max items to return. Default: 50' },
        offset: { type: 'integer', description: 'Offset for pagination' },
      },
      required: ['project'],
    },
  },
  {
    name: 'update_work_item',
    description: 'Update a work item in the intake queue. Can change title, description, priority, status, or link to another item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Work item ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        priority: { type: 'integer', description: 'New priority (1-100)' },
        status: { type: 'string', enum: ['pending', 'triaged', 'in_progress', 'completed', 'rejected'], description: 'New status' },
        batch_id: { type: 'string', description: 'Link to a TORQUE batch/workflow' },
        linked_item_id: { type: 'integer', description: 'Link to another work item' },
      },
      required: ['id'],
    },
  },
  {
    name: 'reject_work_item',
    description: 'Reject a work item with a reason. Moves it to rejected status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Work item ID' },
        reason: { type: 'string', description: 'Why this work item was rejected' },
      },
      required: ['id'],
    },
  },
  {
    name: 'intake_from_findings',
    description: 'Bulk import findings (from scouts, security scans, etc.) into the intake queue. Deduplicates by title. Maps severity to priority automatically. Accepts findings as an explicit array, from a markdown file in docs/findings/, or by dimension name (latest file matching the dimension is used).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              message: { type: 'string' },
              description: { type: 'string' },
              details: { type: 'string' },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
              priority: { type: 'integer' },
            },
          },
          description: 'Array of finding objects to import. At least one of findings/findings_file/dimension is required.',
        },
        findings_file: {
          type: 'string',
          description: 'Path to a findings markdown file (absolute or relative to cwd). Parses H3 headers as titles and H2 sections as severity buckets.',
        },
        dimension: {
          type: 'string',
          description: 'Dimension name (e.g. "accessibility", "security"). Resolves to the latest matching file under docs/findings/.',
        },
        source: { type: 'string', description: 'Override source (default: scout)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'poll_github_issues',
    description: 'Import matching open GitHub issues into the factory intake queue for a project. Reads github_repo and github_labels from the project config, with optional label overrides for this poll.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional label override for this poll. When omitted, uses project config github_labels.',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'trigger_architect',
    description: 'Run an architect prioritization cycle for a factory project. Reads health scores and intake queue, produces a ranked backlog with reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'architect_backlog',
    description: 'Get the current prioritized backlog for a factory project from the latest architect cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'architect_log',
    description: 'Get the architect reasoning history for a factory project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        limit: { type: 'integer', description: 'Number of entries to return (default 10)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_project_policy',
    description: 'Get the current policy configuration for a factory project. Returns budget ceilings, scope limits, blast radius, restricted paths, escalation rules, work hours, and provider restrictions - merged with defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'set_project_policy',
    description: 'Configure policy overrides for a factory project. Accepts any subset of policy fields - unspecified fields keep their defaults. Validates all fields before saving.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        policy: {
          type: 'object',
          description: 'Policy overrides. Fields: budget_ceiling (number|null), scope_ceiling ({max_tasks, max_files_per_task}), blast_radius_percent (1-100), restricted_paths (string[]), required_checks (string[]), escalation_rules ({security_findings, health_drop_threshold, breaking_changes, budget_warning_percent}), work_hours ({start: 0-23, end: 0-23, timezone?}|null), provider_restrictions (string[])',
          properties: {
            budget_ceiling: { type: ['number', 'null'] },
            scope_ceiling: { type: 'object', properties: { max_tasks: { type: 'integer' }, max_files_per_task: { type: 'integer' } } },
            blast_radius_percent: { type: 'number', minimum: 1, maximum: 100 },
            restricted_paths: { type: 'array', items: { type: 'string' } },
            required_checks: { type: 'array', items: { type: 'string' } },
            escalation_rules: { type: 'object' },
            work_hours: {},
            provider_restrictions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['project', 'policy'],
    },
  },
  {
    name: 'guardrail_status',
    description: 'Get guardrail status for a factory project. Returns traffic-light (green/yellow/red) status per guardrail category and latest events.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'run_guardrail_check',
    description: 'Manually trigger guardrail checks for a factory project. Specify the phase (pre_batch, post_batch, pre_ship) and provide required context.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        phase: { type: 'string', enum: ['pre_batch', 'post_batch', 'pre_ship'], description: 'Which phase of checks to run' },
        batch_plan: { type: 'object', description: 'Batch plan (required for pre_batch). Object with tasks array and scope_budget.' },
        batch_id: { type: 'string', description: 'Batch/workflow ID (required for post_batch and pre_ship)' },
        files_changed: { type: 'array', items: { type: 'string' }, description: 'Changed file paths (for post_batch)' },
        test_results: { type: 'object', description: 'Test results { passed, failed, skipped } (for pre_ship)' },
      },
      required: ['project', 'phase'],
    },
  },
  {
    name: 'guardrail_events',
    description: 'Get guardrail event history for a factory project. Returns recent guardrail check results with optional filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        category: { type: 'string', description: 'Filter by category (scope, quality, resource, silent_failure, security, conflict, control)' },
        status: { type: 'string', enum: ['pass', 'warn', 'fail'], description: 'Filter by result status' },
        limit: { type: 'number', description: 'Max events to return (default: 50)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'start_factory_loop',
    description: 'Start the factory SENSE→PRIORITIZE→PLAN→EXECUTE→VERIFY→LEARN cycle for a project. Begins at SENSE stage.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'advance_factory_loop',
    description: 'Advance the factory loop to its next stage. Checks trust-level approval gates before transitioning.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'approve_factory_gate',
    description: 'Approve a paused factory loop gate. Required when the trust level mandates human approval before a stage.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        stage: { type: 'string', enum: ['PRIORITIZE', 'PLAN', 'VERIFY', 'LEARN'], description: 'The stage to approve' },
      },
      required: ['project', 'stage'],
    },
  },
  {
    name: 'factory_loop_status',
    description: 'Get current factory loop state for a project — which stage it is in, whether paused, pending approvals, and trust-level gates.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'analyze_batch',
    description: 'Run post-batch feedback analysis for a factory project. Compares pre/post health scores, measures execution efficiency, and records the results.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        batch_id: { type: 'string', description: 'Batch/workflow ID to analyze' },
        task_count: { type: 'integer', description: 'Number of tasks in the batch' },
        retry_count: { type: 'integer', description: 'Number of retries/remediations' },
        duration_seconds: { type: 'number', description: 'Total batch duration in seconds' },
        estimated_cost: { type: 'number', description: 'Estimated cost of the batch' },
        human_corrections: { type: 'array', items: { type: 'object' }, description: 'Any human corrections applied during the batch' },
      },
      required: ['project', 'batch_id'],
    },
  },
  {
    name: 'factory_drift_status',
    description: 'Check for systemic drift patterns in a factory project. Detects priority oscillation, diminishing returns, scope creep, and cost creep.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        window: { type: 'integer', description: 'Number of recent batches to analyze (default: 10)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'record_correction',
    description: 'Record a human correction/override for architect calibration. Logged against the most recent feedback entry.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        type: { type: 'string', enum: ['priority_override', 'scope_change', 'plan_rejection', 'trust_adjustment'], description: 'Type of correction' },
        description: { type: 'string', description: 'What was changed and why' },
      },
      required: ['project', 'type', 'description'],
    },
  },
  {
    name: 'factory_cost_metrics',
    description: 'Get cost efficiency metrics for a factory project. Returns average cost per analyzed cycle, cost per health point gained, and provider efficiency grouped by cost per task.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'decision_log',
    description: 'Query the factory decision audit trail. Returns structured records of all decisions made by factory agents (health model, architect, planner, executor, verifier, human) with stage, reasoning, and confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        stage: { type: 'string', enum: ['sense', 'prioritize', 'plan', 'execute', 'verify', 'ship'], description: 'Filter by factory stage' },
        actor: { type: 'string', enum: ['health_model', 'architect', 'planner', 'executor', 'verifier', 'human'], description: 'Filter by actor' },
        since: { type: 'string', description: 'ISO date — only decisions after this time' },
        limit: { type: 'integer', description: 'Max results (default: 100)' },
        batch_id: { type: 'string', description: 'Get all decisions for a specific batch' },
      },
      required: ['project'],
    },
  },
  {
    name: 'factory_notifications',
    description: 'List available notification channels and send a test notification for a factory project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        action: { type: 'string', enum: ['list_channels', 'test'], description: 'Action to perform. list_channels returns available channels. test sends a test notification.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'factory_digest',
    description: 'Generate an activity digest for a factory project. Returns accumulated notification events since the last digest flush.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
];

module.exports = tools;
