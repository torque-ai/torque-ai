'use strict';

module.exports = [
  {
    name: 'start_fine_tune',
    description: 'Start a fine-tune job for the current project. Builds a dataset from matching source files, trains a LoRA adapter, and registers the resulting model alias for per-project routing.',
    inputSchema: {
      type: 'object',
      required: ['name', 'base_model', 'source_globs'],
      properties: {
        name: { type: 'string' },
        base_model: { type: 'string' },
        backend: { type: 'string', default: 'llama-cpp' },
        source_globs: { type: 'array', items: { type: 'string' } },
        ignore: { type: 'array', items: { type: 'string' } },
        working_dir: { type: 'string' },
        working_directory: { type: 'string' },
      },
    },
  },
  {
    name: 'list_fine_tune_jobs',
    description: 'List fine-tune jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
      },
    },
  },
  {
    name: 'get_fine_tune_job',
    description: 'Get one fine-tune job.',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string' },
      },
    },
  },
];
