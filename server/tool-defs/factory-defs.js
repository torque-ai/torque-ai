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
];

module.exports = tools;
