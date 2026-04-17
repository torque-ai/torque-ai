'use strict';

const WORKFLOW_PROVIDER_ENUM = [
  'codex',
  'claude-cli',
  'ollama',
  'ollama-cloud',
  'anthropic',
  'cerebras',
  'deepinfra',
  'google-ai',
  'groq',
  'hyperbolic',
  'openrouter',
];

const VERSION_INTENT_ENUM = ['feature', 'fix', 'breaking', 'internal'];
const ON_FAIL_ENUM = ['cancel', 'skip', 'continue', 'run_alternate'];

// JSON Schema for authored workflow specs on disk.
const WORKFLOW_SPEC_SCHEMA = {
  type: 'object',
  required: ['version', 'name', 'tasks'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    project: { type: 'string' },
    working_directory: { type: 'string' },
    routing_template: { type: 'string' },
    version_intent: { type: 'string', enum: VERSION_INTENT_ENUM },
    priority: { type: 'number' },
    extends: { type: 'string' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['node_id'],
        additionalProperties: false,
        anyOf: [
          {
            required: ['task'],
          },
          {
            required: ['__remove'],
            properties: {
              __remove: { const: true },
            },
          },
        ],
        properties: {
          node_id: { type: 'string', minLength: 1 },
          task: { type: 'string', minLength: 1 },
          depends_on: { type: 'array', items: { type: 'string' } },
          context_from: { type: 'array', items: { type: 'string' } },
          provider: { type: 'string', enum: WORKFLOW_PROVIDER_ENUM },
          model: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          timeout_minutes: { type: 'integer', minimum: 1, maximum: 480 },
          auto_approve: { type: 'boolean' },
          version_intent: { type: 'string', enum: VERSION_INTENT_ENUM },
          on_fail: { type: 'string', enum: ON_FAIL_ENUM },
          alternate_node_id: { type: 'string' },
          condition: { type: 'string' },
          goal_gate: { type: 'boolean' },
          __remove: { type: 'boolean' },
        },
      },
    },
  },
};

module.exports = {
  WORKFLOW_SPEC_SCHEMA,
  WORKFLOW_PROVIDER_ENUM,
  VERSION_INTENT_ENUM,
  ON_FAIL_ENUM,
};
