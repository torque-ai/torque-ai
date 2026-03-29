'use strict';

// Mock the container module in Node's require cache before loading the handler
const mockTaskCore = {
  createTask: vi.fn(),
  getTask: vi.fn(),
};

const mockTaskManager = {
  startTask: vi.fn(),
};

const containerPath = require.resolve('../container');
const handlerPath = require.resolve('../handlers/comparison-handler');

// Install mock container into require cache
const mockContainer = {
  defaultContainer: {
    get(name) {
      if (name === 'taskCore') return mockTaskCore;
      if (name === 'taskManager') return mockTaskManager;
      return null;
    },
    has() { return true; },
  },
};

// Save original and replace
const originalContainerModule = require.cache[containerPath];
require.cache[containerPath] = {
  id: containerPath,
  filename: containerPath,
  loaded: true,
  exports: mockContainer,
};

// Initial load
delete require.cache[handlerPath];
let handleCompareProviders = require('../handlers/comparison-handler').handleCompareProviders;

describe('comparison-handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00.000Z'));
    vi.clearAllMocks();
    // Re-inject mock container (may have been overwritten by other test files)
    require.cache[containerPath] = {
      id: containerPath, filename: containerPath, loaded: true,
      exports: mockContainer,
    };
    delete require.cache[handlerPath];
    handleCompareProviders = require('../handlers/comparison-handler').handleCompareProviders;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates tasks for each provider', async () => {
    mockTaskCore.getTask.mockReturnValue({
      status: 'completed', output: 'test output', exit_code: 0,
      started_at: '2026-03-21T00:00:00.000Z', completed_at: '2026-03-21T00:00:01.000Z',
    });

    const result = await handleCompareProviders({
      prompt: 'test prompt',
      providers: ['codex', 'ollama'],
      working_directory: '/project',
    });

    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(2);
    expect(mockTaskManager.startTask).toHaveBeenCalledTimes(2);
    expect(result.content).toBeDefined();
  });

  it('returns comparison results with content', async () => {
    mockTaskCore.getTask.mockReturnValue({
      status: 'completed', output: 'provider output', exit_code: 0,
      started_at: '2026-03-21T00:00:00.000Z', completed_at: '2026-03-21T00:00:02.000Z',
    });

    const result = await handleCompareProviders({
      prompt: 'test prompt',
      providers: ['codex'],
    });

    const text = result.content[0].text;
    expect(text).toBeDefined();
    expect(typeof text).toBe('string');
    // Response contains provider name and result info (may be JSON or markdown)
    expect(text).toContain('codex');
  });

  it('handles provider that times out', async () => {
    mockTaskCore.getTask.mockReturnValue({ status: 'running' });

    const promise = handleCompareProviders({
      prompt: 'test prompt',
      providers: ['codex'],
    });

    for (let i = 0; i < 70; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    const result = await promise;
    const text = result.content[0].text;
    // Timed-out provider should appear in results with failure/timeout indication
    expect(text).toContain('codex');
  });

  it('compares multiple providers', async () => {
    mockTaskCore.getTask.mockReturnValue({
      status: 'completed', output: 'output', exit_code: 0,
      started_at: '2026-03-21T00:00:00.000Z', completed_at: '2026-03-21T00:00:01.000Z',
    });

    const result = await handleCompareProviders({
      prompt: 'test',
      providers: ['fast-provider', 'slow-provider'],
    });

    const text = result.content[0].text;
    expect(text).toContain('fast-provider');
    expect(text).toContain('slow-provider');
  });
});
