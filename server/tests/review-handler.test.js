'use strict';

const mockTaskCore = {
  getTask: vi.fn(),
  createTask: vi.fn((payload) => payload),
};

const mockTaskManager = {
  startTask: vi.fn(() => ({ queued: false })),
};

const mockStudyEngine = {
  buildTaskStudyContextEnvelope: vi.fn(() => null),
};

// Install mock container into require cache before loading the handler
const containerPath = require.resolve('../container');
const handlerPath = require.resolve('../handlers/review-handler');
const studyEnginePath = require.resolve('../integrations/codebase-study-engine');

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
require.cache[studyEnginePath] = {
  id: studyEnginePath,
  filename: studyEnginePath,
  loaded: true,
  exports: mockStudyEngine,
};

// Force re-load of handler with our mock container
delete require.cache[handlerPath];

let handleReviewTaskOutput;

describe('review-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-inject our mock container (may have been overwritten by other test files)
    require.cache[containerPath] = {
      id: containerPath, filename: containerPath, loaded: true,
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
    require.cache[studyEnginePath] = {
      id: studyEnginePath,
      filename: studyEnginePath,
      loaded: true,
      exports: mockStudyEngine,
    };
    delete require.cache[handlerPath];
    ({ handleReviewTaskOutput } = require('../handlers/review-handler'));
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

  it('injects stored study context into the review prompt', () => {
    mockTaskCore.getTask.mockReturnValue({
      id: 'source-task',
      status: 'completed',
      provider: 'ollama',
      task_description: 'Fix the queue scheduler',
      working_directory: '/repo',
      metadata: JSON.stringify({
        study_context_prompt: 'Study context: review task lifecycle and scheduler invariants first.',
      }),
      git_before_sha: 'abc123',
    });

    handleReviewTaskOutput({ task_id: 'source-task' });

    const createdTask = mockTaskCore.createTask.mock.calls[0][0];
    expect(createdTask.task_description).toContain('Study context: review task lifecycle and scheduler invariants first.');
  });

  it('derives study context from JSON-string files_modified when stored prompt is absent', () => {
    mockStudyEngine.buildTaskStudyContextEnvelope.mockReturnValue({
      study_context_prompt: 'Study context: inspect scheduler-related files first.',
    });
    mockTaskCore.getTask.mockReturnValue({
      id: 'source-task',
      status: 'completed',
      provider: 'ollama',
      task_description: 'Fix the queue scheduler',
      working_directory: '/repo',
      files_modified: '["server/maintenance/scheduler.js"]',
      git_before_sha: 'abc123',
    });

    handleReviewTaskOutput({ task_id: 'source-task' });

    expect(mockStudyEngine.buildTaskStudyContextEnvelope).toHaveBeenCalledWith({
      workingDirectory: '/repo',
      taskDescription: 'Fix the queue scheduler',
      files: ['server/maintenance/scheduler.js'],
    });
    const createdTask = mockTaskCore.createTask.mock.calls[0][0];
    expect(createdTask.task_description).toContain('Study context: inspect scheduler-related files first.');
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

describe('review-handler lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/review-handler.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
