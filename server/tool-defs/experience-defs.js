'use strict';

const tools = [
  {
    name: 'find_related_experiences',
    description: 'Find successful past task experiences related to a new task description.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        task_description: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      },
      required: ['task_description'],
    },
  },
  {
    name: 'record_experience',
    description: 'Record a completed task experience for future prompt memory.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        task_description: { type: 'string' },
        output_summary: { type: 'string' },
        files_modified: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
        success_score: { type: 'number' },
      },
      required: ['task_description'],
    },
  },
];

module.exports = tools;
