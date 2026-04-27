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
  {
    name: 'trip_codex_breaker',
    description: 'Manually trip the Codex circuit breaker. Marks Codex unavailable; the factory then falls back per the configured project codex_fallback_policy. Pair with untrip_codex_breaker when ready to resume.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Operator-supplied reason for the trip.' },
      },
      required: [],
    },
  },
  {
    name: 'untrip_codex_breaker',
    description: 'Manually untrip the Codex circuit breaker. Marks Codex available; emits circuit:recovered, which auto-resumes work items parked under parked_codex_unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Operator-supplied reason for the untrip.' },
      },
      required: [],
    },
  },
  {
    name: 'get_codex_breaker_status',
    description: 'Get the current Codex circuit breaker state — both the in-memory state machine and the persisted DB record.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'configure_codex_policy',
    description: 'Set a project codex_fallback_policy (auto | manual | wait_for_codex). Controls what the factory does when Codex is unavailable: auto = pick a fallback provider, manual = pause for operator decision, wait_for_codex = park work until Codex returns.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Factory project id.' },
        mode: {
          type: 'string',
          enum: ['auto', 'manual', 'wait_for_codex'],
          description: 'Fallback policy.',
        },
      },
      required: ['project_id', 'mode'],
    },
  },
];
