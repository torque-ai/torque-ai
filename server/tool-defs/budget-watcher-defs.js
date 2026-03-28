module.exports = [
  {
    name: 'get_budget_status',
    description: 'Get current budget status for all providers. Shows spend vs budget, threshold proximity, and whether auto-downgrade is active.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Optional: filter to a specific provider' },
      },
      required: [],
    },
  },
];
