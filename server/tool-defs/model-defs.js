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
        model_name: { type: 'string', description: 'Model name (e.g., qwen2.5-coder:32b)' },
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
  {
    name: 'list_models',
    description: 'List all known models across all providers with their approval status, size, and host info.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'denied', 'removed'], description: 'Filter by status' },
        provider: { type: 'string', description: 'Filter by provider' },
      },
    },
  },
];

module.exports = tools;
