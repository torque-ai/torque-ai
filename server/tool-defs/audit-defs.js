'use strict';

module.exports = [
  {
    name: 'audit_codebase',
    description: 'Run an LLM-powered code audit on a project directory. Inventories files, creates review units, and dispatches them as a TORQUE workflow. Returns an audit run ID for tracking. Use dry_run=true to preview without executing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the project root directory to audit',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Category keys to include (e.g. ["security", "performance"]). Defaults to all relevant categories based on file extensions.',
        },
        subcategories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Dotted subcategory keys to include (e.g. ["security.injection.sql"]). Can be combined with categories.',
        },
        provider: {
          type: 'string',
          description: 'Execution provider override (e.g. "codex", "deepinfra"). If omitted, tasks are routed via preferFree.',
        },
        model: {
          type: 'string',
          description: 'Model override (e.g. "Qwen/Qwen2.5-72B-Instruct"). Used with provider.',
        },
        source_dirs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Directories to scan relative to path (default: ["src", "server", "lib"])',
        },
        ignore_dirs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional directories to ignore beyond defaults (node_modules, .git, etc.)',
        },
        ignore_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to ignore (e.g. ["*.test.js", "*.spec.ts"])',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, return inventory and plan without creating workflow tasks',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_audit_runs',
    description: 'List audit runs, optionally filtered by project path or status. Returns run IDs, status, file counts, and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Filter by project path',
        },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
          description: 'Filter by run status',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of runs to return (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_audit_findings',
    description: 'Retrieve audit findings for a specific run, with optional filters by category, severity, confidence, verification status, or file path.',
    inputSchema: {
      type: 'object',
      properties: {
        audit_run_id: {
          type: 'string',
          description: 'Audit run ID to get findings for',
        },
        category: {
          type: 'string',
          description: 'Filter by category (e.g. "security")',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'info'],
          description: 'Filter by severity level',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Filter by confidence level',
        },
        verified: {
          type: 'boolean',
          description: 'Filter by verification status',
        },
        false_positive: {
          type: 'boolean',
          description: 'Filter by false positive status',
        },
        file_path: {
          type: 'string',
          description: 'Filter by file path (partial match)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of findings to return (default: 50)',
        },
        offset: {
          type: 'number',
          description: 'Number of findings to skip for pagination',
        },
      },
      required: ['audit_run_id'],
    },
  },
  {
    name: 'update_audit_finding',
    description: 'Update an audit finding to mark it as verified or as a false positive. False positive markings are used to suppress similar findings in future audits.',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: {
          type: 'string',
          description: 'ID of the finding to update',
        },
        verified: {
          type: 'boolean',
          description: 'Mark finding as verified (true) or unverified (false)',
        },
        false_positive: {
          type: 'boolean',
          description: 'Mark finding as false positive (true). Affects future audit confidence for matching snippets.',
        },
      },
      required: ['finding_id'],
    },
  },
  {
    name: 'get_audit_run_summary',
    description: 'Get an aggregated summary of an audit run including finding counts by severity, category breakdown, and run metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        audit_run_id: {
          type: 'string',
          description: 'Audit run ID to summarize',
        },
      },
      required: ['audit_run_id'],
    },
  },
];
