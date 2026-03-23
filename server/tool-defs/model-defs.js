const tools = [
  {
    name: 'list_pending_models',
    description: 'List all discovered models awaiting approval. Models must be approved before TORQUE will route tasks to them.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'approve_model',
    description: 'Approve a discovered model for task routing. Only approved models are eligible for task execution.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name (e.g., ollama, deepinfra)' },
        model_name: { type: 'string', description: 'Model name (e.g., my-model:14b)' },
        host_id: { type: 'string', description: 'Host ID (optional, for Ollama providers)' },
      },
      required: ['provider', 'model_name'],
    },
  },
  {
    name: 'deny_model',
    description: 'Deny a discovered model. Denied models are never used for task routing.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name' },
        model_name: { type: 'string', description: 'Model name' },
        host_id: { type: 'string', description: 'Host ID (optional)' },
      },
      required: ['provider', 'model_name'],
    },
  },
  {
    name: 'bulk_approve_models',
    description: 'Approve all pending models for a provider at once.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name — approves all pending models for this provider' },
      },
      required: ['provider'],
    },
  },
  // list_models moved to discovery-defs.js (model-agnostic migration)
  {
    name: 'configure_model_roles',
    description: 'Set which model fills a named role (default, fallback, fast, balanced, quality) for a provider. Roles determine which model is used for each tier of task complexity.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name (e.g., ollama, deepinfra, codex)' },
        role: { type: 'string', enum: ['default', 'fallback', 'fast', 'balanced', 'quality'], description: 'Role to assign the model to' },
        model_name: { type: 'string', description: 'Model name to assign to this role (e.g., my-model:14b)' },
      },
      required: ['provider', 'role', 'model_name'],
    },
  },
  {
    name: 'list_model_roles',
    description: 'List current model role assignments. Shows which model is assigned to each role (default, fallback, fast, balanced, quality) per provider.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter by provider (optional — omit to list all providers)' },
      },
    },
  },
];

module.exports = tools;
