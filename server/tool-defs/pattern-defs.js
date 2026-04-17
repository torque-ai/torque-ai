'use strict';

module.exports = [
  {
    name: 'list_patterns',
    description: 'List all patterns from .torque/patterns/.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'describe_pattern',
    description: 'Show the system prompt + template + metadata for a pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pattern name to describe.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_pattern',
    description: 'Run a named pattern with input + optional variables.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pattern name to execute.',
        },
        input: {
          type: 'string',
          description: 'Input text passed to the pattern.',
        },
        vars: {
          type: 'object',
          description: 'Optional template variables used during rendering.',
        },
        provider: {
          type: 'string',
          description: 'Optional provider override. Defaults to codex.',
        },
      },
      required: ['name', 'input'],
    },
  },
];
