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
    description: 'Bulk import findings (from scouts, security scans, etc.) into the intake queue. Deduplicates by title. Maps severity to priority automatically.',
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
          description: 'Array of finding objects to import',
        },
        source: { type: 'string', description: 'Override source (default: scout)' },
      },
      required: ['project', 'findings'],
    },
  },
];

module.exports = tools;
