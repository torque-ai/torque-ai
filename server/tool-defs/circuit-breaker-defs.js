module.exports = [
  {
    name: 'get_circuit_breaker_status',
    description: 'Get circuit breaker state for all providers. Shows which providers are tripped (OPEN), probing (HALF_OPEN), or healthy (CLOSED). Returns consecutive failure counts, last failure category, and recovery timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Optional: filter to a specific provider' },
      },
      required: [],
    },
  },
];
