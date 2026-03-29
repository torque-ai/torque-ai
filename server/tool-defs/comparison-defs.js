'use strict';

module.exports = [{
  name: 'compare_providers',
  description: 'Run the same prompt on multiple providers and compare results side-by-side. Shows output, duration, exit code, and success for each.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Task prompt to send to all providers' },
      providers: { type: 'array', items: { type: 'string' }, description: 'Providers to compare (e.g., ["codex", "ollama"])' },
      working_directory: { type: 'string', description: 'Project directory' },
    },
    required: ['prompt', 'providers'],
  },
}];
