'use strict';

const tools = [
  {
    name: 'list_routing_templates',
    description: 'List all routing templates (built-in presets and user-created).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_routing_template',
    description: 'Get a routing template by ID or name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Template ID' },
        name: { type: 'string', description: 'Template name (alternative to ID)' },
      },
    },
  },
  {
    name: 'set_routing_template',
    description: 'Create or update a user routing template (upsert by name). Cannot modify presets.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template name' },
        description: { type: 'string', description: 'Template description' },
        rules: {
          type: 'object',
          description: 'Category-to-provider mapping. Keys: security, xaml_wpf, architectural, reasoning, large_code_gen, documentation, simple_generation, targeted_file_edit, default',
        },
        complexity_overrides: {
          type: 'object',
          description: 'Optional per-category complexity overrides. Keys are category names, values are {simple, normal, complex} to provider mappings.',
        },
      },
      required: ['name', 'rules'],
    },
  },
  {
    name: 'delete_routing_template',
    description: 'Delete a user routing template. Cannot delete presets.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Template ID' },
        name: { type: 'string', description: 'Template name (alternative to ID)' },
      },
    },
  },
  {
    name: 'activate_routing_template',
    description: 'Set the active routing template by ID or name. Pass null to revert to System Default.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Template ID (or null to clear)' },
        name: { type: 'string', description: 'Template name (alternative to ID)' },
      },
    },
  },
  {
    name: 'get_active_routing',
    description: 'Get the currently active routing template with resolved category-to-provider mappings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_routing_categories',
    description: 'List available task categories with display names, descriptions, and example keywords.',
    inputSchema: { type: 'object', properties: {} },
  },
];

module.exports = tools;
