'use strict';

/**
 * Tests for Experiment 6: A/B Provider Comparison Tool
 */

// rawDb mock with transaction support (returns a function that calls the callback)
const mockRawDb = {
  transaction: vi.fn((fn) => fn),
};

const mockDb = {
  createTask: vi.fn(),
  getTask: vi.fn(),
  getDbInstance: vi.fn(() => mockRawDb),
};

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/experiment-handlers')];
  installMock('../database', mockDb);
  installMock('../handlers/error-codes', require('../handlers/error-codes'));
  return require('../handlers/experiment-handlers');
}

describe('experiment-handlers (Experiment 6)', () => {
  let handlers;

  beforeEach(() => {
    mockDb.createTask.mockReset();
    mockDb.createTask.mockImplementation(() => undefined);
    mockDb.getTask.mockReset();
    mockDb.getTask.mockReturnValue(null);
    mockDb.getDbInstance.mockReset();
    mockDb.getDbInstance.mockReturnValue(mockRawDb);
    mockRawDb.transaction.mockReset();
    // transaction() receives a callback and returns a function; calling that function runs the callback
    mockRawDb.transaction.mockImplementation((fn) => fn);
    handlers = loadHandlers();
  });

  describe('handleSubmitAbTest', () => {
    it('returns error when task_description is missing', () => {
      const result = handlers.handleSubmitAbTest({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when provider_a is missing', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_b: 'ollama',
        working_directory: '/tmp',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when provider_b is missing', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_a: 'codex',
        working_directory: '/tmp',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when providers are the same', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_a: 'codex',
        provider_b: 'codex',
        working_directory: '/tmp',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
    });

    it('returns error when working_directory is missing', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Fix the bug',
        provider_a: 'codex',
        provider_b: 'ollama',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('creates two tasks with different providers', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Write unit tests for auth module',
        provider_a: 'codex',
        provider_b: 'hashline-ollama',
        working_directory: '/tmp/project',
      });

      expect(result.isError).toBeFalsy();
      expect(mockDb.createTask).toHaveBeenCalledTimes(2);

      const callA = mockDb.createTask.mock.calls[0][0];
      const callB = mockDb.createTask.mock.calls[1][0];

      expect(callA.provider).toBe('codex');
      expect(callB.provider).toBe('hashline-ollama');
      expect(callA.task_description).toBe(callB.task_description);
      expect(callA.working_directory).toBe('/tmp/project');
      expect(callB.working_directory).toBe('/tmp/project');
      expect(callA.status).toBe('queued');
      expect(callB.status).toBe('queued');

      const metaA = JSON.parse(callA.metadata);
      const metaB = JSON.parse(callB.metadata);
      expect(metaA.ab_test_id).toBe(metaB.ab_test_id);
      expect(metaA.ab_variant).toBe('A');
      expect(metaB.ab_variant).toBe('B');
      expect(metaA.ab_peer_task_id).toBe(callB.id);
      expect(metaB.ab_peer_task_id).toBe(callA.id);
    });

    it('includes model overrides when provided', () => {
      handlers.handleSubmitAbTest({
        task_description: 'Test task',
        provider_a: 'codex',
        provider_b: 'ollama',
        working_directory: '/tmp',
        model_a: 'gpt-5.3-codex-spark',
        model_b: 'qwen2.5-coder:32b',
      });

      const callA = mockDb.createTask.mock.calls[0][0];
      const callB = mockDb.createTask.mock.calls[1][0];
      expect(callA.model).toBe('gpt-5.3-codex-spark');
      expect(callB.model).toBe('qwen2.5-coder:32b');
    });

    it('returns formatted response with task IDs', () => {
      const result = handlers.handleSubmitAbTest({
        task_description: 'Test task',
        provider_a: 'codex',
        provider_b: 'ollama',
        working_directory: '/tmp',
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('A/B Provider Test Created');
      expect(result.content[0].text).toContain('codex');
      expect(result.content[0].text).toContain('ollama');
    });

    it('handles db.createTask failure gracefully', () => {
      mockDb.createTask.mockImplementation(() => { throw new Error('DB write failed'); });

      const result = handlers.handleSubmitAbTest({
        task_description: 'Test task',
        provider_a: 'codex',
        provider_b: 'ollama',
        working_directory: '/tmp',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
    });
  });

  describe('handleCompareAbTest', () => {
    it('returns error when task_id_a is missing', () => {
      const result = handlers.handleCompareAbTest({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when task A not found', () => {
      mockDb.getTask.mockReturnValue(null);
      const result = handlers.handleCompareAbTest({
        task_id_a: 'a-123',
        task_id_b: 'b-456',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('compares two completed tasks', () => {
      const abTestId = 'test-ab-123';
      mockDb.getTask
        .mockReturnValueOnce({
          id: 'a-123',
          provider: 'codex',
          status: 'completed',
          exit_code: 0,
          output: 'Codex output here',
          started_at: '2026-03-08T10:00:00Z',
          completed_at: '2026-03-08T10:00:30Z',
          metadata: JSON.stringify({ ab_test_id: abTestId, ab_variant: 'A' }),
        })
        .mockReturnValueOnce({
          id: 'b-456',
          provider: 'hashline-ollama',
          status: 'completed',
          exit_code: 0,
          output: 'Ollama output that is longer than codex',
          started_at: '2026-03-08T10:00:00Z',
          completed_at: '2026-03-08T10:01:00Z',
          metadata: JSON.stringify({ ab_test_id: abTestId, ab_variant: 'B' }),
        });

      const result = handlers.handleCompareAbTest({
        task_id_a: 'a-123',
        task_id_b: 'b-456',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('A/B Test Comparison');
      expect(result.content[0].text).toContain('codex');
      expect(result.content[0].text).toContain('hashline-ollama');
      expect(result.content[0].text).toContain('30s');
      expect(result.content[0].text).toContain('60s');
      // Codex was faster, so A should win duration
      expect(result.content[0].text).toContain('codex (A) wins');
    });

    it('handles one failed and one completed task', () => {
      mockDb.getTask
        .mockReturnValueOnce({
          id: 'a-123',
          provider: 'ollama',
          status: 'failed',
          exit_code: 1,
          output: '',
          metadata: '{}',
        })
        .mockReturnValueOnce({
          id: 'b-456',
          provider: 'codex',
          status: 'completed',
          exit_code: 0,
          output: 'Success',
          metadata: '{}',
        });

      const result = handlers.handleCompareAbTest({
        task_id_a: 'a-123',
        task_id_b: 'b-456',
      });

      expect(result.content[0].text).toContain('codex (B) wins');
    });
  });
});
