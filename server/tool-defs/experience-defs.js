'use strict';

const EXPERIENCE_TOOLS = [
  {
    name: 'find_related_experiences',
    description: 'Find past task experiences similar to a query description.',
    inputSchema: {
      type: 'object',
      required: ['task_description'],
      properties: {
        task_description: { type: 'string' },
        project: { type: 'string' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        min_similarity: { type: 'number', default: 0.3 },
      },
    },
  },
  {
    name: 'record_experience',
    description: 'Manually record a successful task experience for future retrieval.',
    inputSchema: {
      type: 'object',
      required: ['task_description', 'output_summary'],
      properties: {
        task_description: { type: 'string' },
        output_summary: { type: 'string' },
        project: { type: 'string' },
        files_modified: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
      },
    },
  },
];

module.exports = { EXPERIENCE_TOOLS };
