'use strict';

module.exports = [
  {
    name: 'register_action_schema',
    description: 'Register a JSON schema + handlers for an action surface. Handlers may be explicit tool mappings or omitted when action names match existing TORQUE tools.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          description: 'Action surface name, for example "workflow" or "task".',
        },
        description: {
          type: 'string',
          description: 'Optional human-readable description for the action surface.',
        },
        schema: {
          type: 'object',
          description: 'JSON schema union for the surface. Each action variant should include an actionName const discriminator.',
        },
        handlers: {
          type: 'object',
          description: 'Optional actionName -> tool mapping. Values may be a TORQUE tool name string or an object with tool, arg_map, fixed_args, include_action, and include_context.',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  tool: { type: 'string' },
                  arg_map: { type: 'object' },
                  fixed_args: { type: 'object' },
                  include_action: { type: 'boolean' },
                  include_context: { type: 'boolean' },
                },
                required: ['tool'],
              },
            ],
          },
        },
      },
      required: ['surface', 'schema'],
    },
  },
  {
    name: 'list_actions',
    description: 'List known action surfaces and their registered actionName values.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          description: 'Optional surface name to inspect.',
        },
      },
      required: [],
    },
  },
  {
    name: 'dispatch_nl',
    description: 'Translate a natural-language utterance into a typed action + execute. Uses construction cache first, LLM translator as fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          description: 'Registered action surface to target.',
        },
        utterance: {
          type: 'string',
          description: 'Natural-language operator request to translate and dispatch.',
        },
        learn_on_success: {
          type: 'boolean',
          description: 'Reserved for future construction learning. Defaults to true.',
          default: true,
        },
      },
      required: ['surface', 'utterance'],
    },
  },
];
