'use strict';

const tools = [
  {
    name: 'score_native_eval',
    description: 'Run deterministic native evaluator scorers against an output string.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string' },
        scorers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['exact', 'regex', 'contains_all', 'length_gte'] },
              expected: {},
              pattern: { type: 'string' },
              min: { type: 'number' },
            },
            required: ['type'],
          },
        },
      },
      required: ['output', 'scorers'],
    },
  },
  {
    name: 'diff_native_eval_runs',
    description: 'Compare baseline and candidate native eval run score rows.',
    inputSchema: {
      type: 'object',
      properties: {
        baseline: { type: 'array', items: { type: 'object' } },
        candidate: { type: 'array', items: { type: 'object' } },
      },
      required: ['baseline', 'candidate'],
    },
  },
];

module.exports = tools;
