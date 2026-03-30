module.exports = [
  {
    name: 'get_project_template',
    description: 'Get the detected project template for a working directory. Shows framework/language, agent context, and suggested verify command.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Project directory' },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'list_project_templates',
    description: 'List all available project templates with their detection rules and priorities.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'detect_project_type',
    description: 'Run project type detection on a directory. Returns best-match template with score.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Directory to scan' },
      },
      required: ['working_directory'],
    },
  },
];
