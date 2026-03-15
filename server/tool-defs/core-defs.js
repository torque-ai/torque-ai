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
        }
      }
    }
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
