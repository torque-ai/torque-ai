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
const CREW_MODE_ENUM = ['round_robin', 'hierarchical', 'parallel'];
const CREW_ROUTER_MODE_ENUM = ['code', 'llm', 'hybrid', 'round_robin'];

const CREW_ROUTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: CREW_ROUTER_MODE_ENUM },
    code_fn: {
      type: 'string',
      description: 'JS function source body; receives (state, turn). Return a role name in code mode, candidate names in hybrid mode, or null/[] to stop.',
    },
    agent_model: { type: 'string' },
    agent_provider: { type: 'string' },
  },
  allOf: [
    {
      if: {
        properties: { mode: { enum: ['code', 'hybrid'] } },
        required: ['mode'],
      },
      then: {
        required: ['code_fn'],
      },
    },
    {
      if: {
        properties: { mode: { enum: ['llm', 'hybrid'] } },
        required: ['mode'],
      },
      then: {
        required: ['agent_model'],
      },
    },
  ],
};

const CREW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'roles'],
  properties: {
    objective: { type: 'string', minLength: 1 },
    roles: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          provider: { type: 'string', enum: WORKFLOW_PROVIDER_ENUM },
          model: { type: 'string' },
        },
      },
    },
    mode: { type: 'string', enum: CREW_MODE_ENUM, default: 'round_robin' },
    max_rounds: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    output_schema: { type: 'object' },
    router: {
      ...CREW_ROUTER_SCHEMA,
      description: 'Optional router config. mode=code uses code_fn, mode=llm uses agent_model, mode=hybrid uses both.',
    },
  },
};

// JSON Schema for .yaml workflow spec files.
// Keep this schema additive-only across versions; old specs must keep parsing.
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
    model_stylesheet: { type: 'string' },
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
            required: ['kind', 'crew'],
            properties: {
              kind: { const: 'crew' },
            },
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
          kind: { type: 'string', enum: ['crew'] },
          crew: CREW_SCHEMA,
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
