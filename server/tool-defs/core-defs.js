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
    description: 'Restart the TORQUE MCP server to apply code changes. The server will gracefully shut down and the MCP client will automatically reconnect, spawning a new server instance with the updated code.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for restart (logged)'
        },
        drain: { type: 'boolean', description: 'Wait for all running tasks to complete before restarting (queue drain mode). New tasks are queued but not started during drain.' },
        drain_timeout_minutes: { type: 'number', description: 'Maximum minutes to wait for tasks to drain (default: 10). If exceeded, drain aborts and server stays on current version.' },
      }
    }
  },
  {
    name: 'await_restart',
    description: 'Block until the task pipeline drains (all running/queued/pending/blocked tasks finish), then trigger a server restart. Returns heartbeat progress snapshots at configurable intervals. Use instead of restart_server with drain:true to avoid manual polling.',
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
