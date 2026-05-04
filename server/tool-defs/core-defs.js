/**
 * Tool definitions for core inline handlers
 */

const tools = [
  {
    name: 'ping',
    description: 'Lightweight keepalive ping. Use this to maintain MCP connection during long waits instead of sleeping.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional message to echo back'
        }
      }
    }
  },
  {
    name: 'restart_server',
    description: 'Restart the TORQUE MCP server. Creates a barrier task that blocks the queue scheduler from starting new work, optionally waits for running tasks to drain, then triggers a graceful shutdown. The MCP client will automatically reconnect with fresh code. The barrier task is cancellable — use cancel_task to abort.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for restart (logged and stored in task metadata)'
        },
        drain_timeout_ms: {
          type: 'number',
          description: 'Maximum milliseconds to wait for the pipeline to drain (default: 60000 — 60 s). 0 = immediate restart with no drain (re-adoption catches survivors when subprocess detachment is enabled). 600000 = 10-min graceful drain (today\'s cutover --graceful behavior). Subprocess-detachment design §2.5.3.'
        },
        drain_timeout_minutes: { type: 'number', description: 'Legacy: drain timeout in minutes. Honored only when drain_timeout_ms is unset.' },
        timeout_minutes: { type: 'number', description: 'Legacy alias for drain_timeout_minutes.' },
      }
    }
  },
  {
    name: 'restart_status',
    description: 'Read-only snapshot of an active restart drain. Returns { barrier_active, barrier_id, barrier_status, running_count, queued_held_count, elapsed_seconds } if a restart barrier exists, otherwise { barrier_active: false }. Use to check drain progress without blocking.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'await_restart',
    description: 'Submit a restart barrier task (or attach to an existing one) and block until the pipeline drains and restart triggers. Returns heartbeat progress snapshots at configurable intervals. Equivalent to calling restart_server + await_task on the barrier task.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_minutes: { type: 'number', description: 'Max wait before giving up (default: 30, min: 1, max: 60)' },
        heartbeat_minutes: { type: 'number', description: 'Minutes between scheduled progress heartbeats. Default 5. Set to 0 to disable. Max: 30.', minimum: 0, maximum: 30 },
        reason: { type: 'string', description: 'Restart reason (logged and passed to shutdown event)' },
      },
    },
  },
  {
    name: 'unlock_all_tools',
    description: 'Unlock all TORQUE tools (Tier 3). By default only ~25 core tools are exposed to minimize context usage. Use unlock_tier(2) for extended tools (~78 total) or this tool for all ~488 tools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'unlock_tier',
    description: 'Progressively unlock additional tool tiers. Tier 1 (~25 tools): core task lifecycle. Tier 2 (~78 tools): adds batch orchestration, TS structural tools, SnapScope/Peek, validation. Tier 3 (~488 tools): everything (same as unlock_all_tools).',
    inputSchema: {
      type: 'object',
      properties: {
        tier: {
          type: 'number',
          description: 'Tier level to unlock (1=core, 2=extended, 3=all)',
          enum: [1, 2, 3]
        }
      },
      required: ['tier']
    }
  }
];

module.exports = tools;
