'use strict';

const mockTaskCore = {
  getTask: vi.fn(),
  createTask: vi.fn((payload) => payload),
};

const mockTaskManager = {
  startTask: vi.fn(() => ({ queued: false })),
};

// Install mock container into require cache before loading the handler
const containerPath = require.resolve('../container');
const handlerPath = require.resolve('../handlers/review-handler');

require.cache[containerPath] = {
  id: containerPath,
  filename: containerPath,
  loaded: true,
  exports: {
    defaultContainer: {
      get(name) {
        if (name === 'taskCore') return mockTaskCore;
        if (name === 'taskManager') return mockTaskManager;
        return null;
      },
      has() { return true; },
    },
  },
};

delete require.cache[handlerPath];
const { handleReviewTaskOutput } = require('../handlers/review-handler');

describe('review-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error for missing task', () => {
    mockTaskCore.getTask.mockReturnValue(null);

    const result = handleReviewTaskOutput({ task_id: 'missing-task' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('returns error for non-completed task', () => {
    mockTaskCore.getTask.mockReturnValue({
      id: 'source-task',
      status: 'running',
      working_directory: '/repo',
    });

    const result = handleReviewTaskOutput({ task_id: 'source-task' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('completed');
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('creates review task with structured prompt', () => {
    mockTaskCore.getTask.mockReturnValue({
      id: 'source-task',
      status: 'completed',
      provider: 'ollama',
      task_description: 'Fix the queue scheduler',
      working_directory: '/repo',
      git_before_sha: 'abc123',
    });

    handleReviewTaskOutput({
      task_id: 'source-task',
      provider: 'deepinfra',
    });

    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    const createdTask = mockTaskCore.createTask.mock.calls[0][0];
    expect(createdTask.task_description).toContain('Review this code change');
  });

  it('selects a different provider from the original when none is specified', () => {
    mockTaskCore.getTask.mockReturnValue({
      id: 'source-task',
      status: 'completed',
      provider: 'codex',
      task_description: 'Fix routing',
      working_directory: '/repo',
    });

    handleReviewTaskOutput({ task_id: 'source-task' });

    const createdTask = mockTaskCore.createTask.mock.calls[0][0];
    expect(createdTask.provider).not.toBe('codex');
  });
});
