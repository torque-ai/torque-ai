const tools = [
  {
    name: 'get_concurrency_limits',
    description: 'Get a unified view of all concurrency limits across providers, workstations, hosts, and VRAM budget. Returns current settings and effective values.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_concurrency_limit',
    description: 'Set a concurrency limit by scope. Scope determines what is updated: "provider" updates provider_config.max_concurrent, "workstation" updates workstations.max_concurrent, "host" updates ollama_hosts.max_concurrent, "vram_factor" updates the global VRAM budget factor (0.50-1.00).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['provider', 'workstation', 'host', 'vram_factor'],
          description: 'What type of limit to set',
        },
        target: {
          type: 'string',
          description: 'Identifier: provider name, workstation name, or host ID. Not needed for vram_factor scope.',
        },
        max_concurrent: {
          type: 'integer',
          description: 'Maximum concurrent tasks (1-100, or 0 for unlimited on hosts). Used with provider/workstation/host scopes.',
        },
        vram_factor: {
          type: 'number',
          description: 'VRAM budget factor (0.50-1.00). 0.95 = use 95% of GPU VRAM. Used with vram_factor scope.',
        },
      },
      required: ['scope'],
    },
  },
];

module.exports = tools;
