'use strict';

module.exports = [{
  name: 'review_task_output',
  description: 'Run AI-powered structured code review on a completed task. Submits a review prompt to a provider and returns the review task ID.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID to review' },
      provider: { type: 'string', description: 'Provider for review (defaults to different from original)' },
    },
    required: ['task_id'],
  },
}];
