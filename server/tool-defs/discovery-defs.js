const tools = [
  {
    name: 'discover_models',
    description: 'Trigger model discovery on one or all providers. Queries provider APIs for available models, registers them in the model registry, applies capability heuristics, and auto-assigns roles.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Optional: discover models from a specific provider only (e.g., "groq", "deepinfra", "ollama"). Omit to discover from all enabled providers.',
        },
      },
    },
  },
  {
    name: 'list_models',
    description: 'List all models in the model registry, grouped by provider. Shows family, size, role, capabilities, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Optional: filter by provider name (e.g., "ollama", "groq")',
        },
      },
    },
  },
  {
    name: 'assign_model_role',
    description: 'Assign a model to a role (fast/balanced/quality/default/fallback) for a provider. Controls which model is used for each task tier.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name (e.g., "ollama", "groq")' },
        role: { type: 'string', description: 'Role to assign', enum: ['fast', 'balanced', 'quality', 'default', 'fallback'] },
        model_name: { type: 'string', description: 'Model name to assign to the role' },
      },
      required: ['provider', 'role', 'model_name'],
    },
  },
];

module.exports = tools;
