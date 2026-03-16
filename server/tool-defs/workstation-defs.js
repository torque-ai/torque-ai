const tools = [
  {
    name: 'list_workstations',
    description: 'List all registered workstations with status, capabilities, and health.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Filter by capability (e.g., "ollama", "ui_capture", "command_exec")' },
        status: { type: 'string', description: 'Filter by status (e.g., "healthy", "down", "degraded")' },
        enabled: { type: 'boolean', description: 'Filter by enabled state' },
      },
    },
  },
  {
    name: 'add_workstation',
    description: 'Register a new workstation with TORQUE.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable name' },
        host: { type: 'string', description: 'Hostname or IP address' },
        agent_port: { type: 'integer', description: 'Agent port (default: 3460)', default: 3460 },
        secret: { type: 'string', description: 'Shared secret for authentication' },
        max_concurrent: { type: 'integer', description: 'Max concurrent tasks (default: 3)', default: 3 },
        priority: { type: 'integer', description: 'Routing priority (default: 10)', default: 10 },
        is_default: { type: 'boolean', description: 'Set as default workstation', default: false },
      },
      required: ['name', 'host', 'secret'],
    },
  },
  {
    name: 'remove_workstation',
    description: 'Remove a registered workstation by name or ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workstation name to remove' },
        id: { type: 'string', description: 'Workstation ID to remove' },
      },
    },
  },
  {
    name: 'probe_workstation',
    description: 'Re-detect capabilities of a workstation by calling its /probe endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workstation name to probe' },
      },
      required: ['name'],
    },
  },
  {
    name: 'check_workstation_health',
    description: 'Check health of one or all workstations.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Specific workstation name (omit for all)' },
      },
    },
  },
];

module.exports = tools;
