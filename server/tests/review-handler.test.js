'use strict';

const mockTaskCore = {
  getTask: vi.fn(),
  createTask: vi.fn((payload) => payload),
};

const mockTaskManager = {
  startTask: vi.fn(() => ({ queued: false })),
};

vi.mock('../container', () => ({
  defaultContainer: {
    get(name) {
      if (name === 'taskCore') return mockTaskCore;
      if (name === 'taskManager') return mockTaskManager;
      return null;
    },
    has() { return true; },
  },
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => 'diff --git a/server/app.js b/server/app.js\n+new line\n'),
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'review-task-123'),
}));

const childProcess = require('child_process');
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

    const result = handleReviewTaskOutput({
      task_id: 'source-task',
      provider: 'deepinfra',
    });

    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    expect(mockTaskManager.startTask).toHaveBeenCalledTimes(1);

    const createdTask = mockTaskCore.createTask.mock.calls[0][0];
    expect(createdTask.task_description).toContain('Review this code change');
    expect(createdTask.task_description).toContain('Logic/correctness');
    expect(result.review_task_id || result.structuredData?.review_task_id).toBeTruthy();
  });

  it('selects a different provider from the original when none is specified', () => {
    mockTaskCore.getTask.mockReturnValue({
      id: 'source-task',
      status: 'completed',
      provider: 'codex',
      task_description: 'Fix routing',
      working_directory: '/repo',
    });

    const result = handleReviewTaskOutput({ task_id: 'source-task' });

    const createdTask = mockTaskCore.createTask.mock.calls[0][0];
    // Should pick a provider different from 'codex'
    expect(createdTask.provider).not.toBe('codex');
  });
});
