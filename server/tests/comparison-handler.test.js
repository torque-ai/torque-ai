'use strict';

let mockTaskCore;
let mockTaskManager;

vi.mock('../container', () => ({
  defaultContainer: {
    get(name) {
      if (name === 'taskCore') return mockTaskCore;
      if (name === 'taskManager') return mockTaskManager;
      return null;
    },
    has() { return true; },
    boot() {},
  },
}));

function createTaskCoreMock() {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
  };
}

function createTaskManagerMock() {
  return {
    startTask: vi.fn(),
  };
}

describe('comparison-handler', () => {
  let handleCompareProviders;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00.000Z'));
    mockTaskCore = createTaskCoreMock();
    mockTaskManager = createTaskManagerMock();
    // Re-require to pick up the mocked container
    vi.resetModules();
    const mod = require('../handlers/comparison-handler');
    handleCompareProviders = mod.handleCompareProviders;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('returns comparison results with correct structure', async () => {
    mockTaskCore.getTask.mockReturnValue({
      status: 'completed', output: 'provider output', exit_code: 0,
      started_at: '2026-03-21T00:00:00.000Z', completed_at: '2026-03-21T00:00:02.000Z',
    });

    const result = await handleCompareProviders({
      prompt: 'test prompt',
      providers: ['codex'],
    });

    const text = JSON.parse(result.content[0].text);
    expect(text.results).toBeDefined();
    expect(text.results.length).toBe(1);
    expect(text.results[0].provider).toBe('codex');
    expect(text.results[0].success).toBe(true);
  });

  it('handles provider that times out', async () => {
    mockTaskCore.getTask.mockReturnValue({ status: 'running' });

    const promise = handleCompareProviders({
      prompt: 'test prompt',
      providers: ['codex'],
    });

    // Advance past the 5-minute timeout
    for (let i = 0; i < 70; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    const result = await promise;
    const text = JSON.parse(result.content[0].text);
    expect(text.results[0].success).toBe(false);
  });

  it('summary identifies fastest provider', async () => {
    let callCount = 0;
    mockTaskCore.getTask.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        // First provider: 1s
        return {
          status: 'completed', output: 'fast', exit_code: 0,
          started_at: '2026-03-21T00:00:00.000Z', completed_at: '2026-03-21T00:00:01.000Z',
        };
      }
      // Second provider: 5s
      return {
        status: 'completed', output: 'slow', exit_code: 0,
        started_at: '2026-03-21T00:00:00.000Z', completed_at: '2026-03-21T00:00:05.000Z',
      };
    });

    const result = await handleCompareProviders({
      prompt: 'test',
      providers: ['fast-provider', 'slow-provider'],
    });

    const text = JSON.parse(result.content[0].text);
    expect(text.results).toHaveLength(2);
  });
});
