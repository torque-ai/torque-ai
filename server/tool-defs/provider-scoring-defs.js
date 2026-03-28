module.exports = [
  {
    name: 'get_provider_scores',
    description: 'Get multi-dimensional scoring for all providers. Shows cost efficiency, speed, reliability, quality, and composite scores. Only providers with >= 5 samples are trusted.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter to a specific provider' },
        trusted_only: { type: 'boolean', description: 'Only show providers with enough samples (default: false)', default: false },
      },
      required: [],
    },
  },
];
