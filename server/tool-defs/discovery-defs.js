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
];

module.exports = tools;
