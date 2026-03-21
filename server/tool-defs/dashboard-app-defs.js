module.exports = [
  {
    name: 'show_dashboard',
    description: 'Show interactive TORQUE dashboard inline in chat. Displays real-time task status, provider health, workflow progress, and cost tracking in a tabbed interface.',
    _meta: {
      ui: { resourceUri: 'ui://torque/dashboard' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: ['tasks', 'providers', 'workflow', 'cost'],
          description: 'Initial tab to show (default: tasks)',
        },
      },
    },
  },
];
