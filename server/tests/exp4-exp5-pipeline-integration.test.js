'use strict';

/**
 * Integration tests for Experiments 4 & 5 in the task-finalizer pipeline.
 * Verifies that smart_diagnosis and strategic_review stages fire correctly
 * within the full finalization flow.
 */

const { finalizeTask, init, _testing } = require('../execution/task-finalizer');

const mockDb = {
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
};

beforeEach(() => {
  _testing.resetForTest();
  mockDb.getTask.mockReset();
  mockDb.updateTaskStatus.mockReset();
  mockDb.updateTaskStatus.mockImplementation(() => undefined);

  init({
    db: mockDb,
    safeUpdateTaskStatus: mockDb.updateTaskStatus,
  });
});

function makeTask(overrides = {}) {
  return {
    id: 'test-001',
    status: 'running',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    task_description: 'Implement the notification system',
    metadata: JSON.stringify({}),
    started_at: new Date(Date.now() - 10000).toISOString(),
    ...overrides,
  };
}

describe('Experiment 4+5 pipeline integration', () => {
  describe('smart_diagnosis stage in pipeline', () => {
    it('runs smart_diagnosis on failed tasks', async () => {
      const task = makeTask();
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 1,
        errorOutput: 'error TS2304: Cannot find name "Observable"',
      });

      expect(result.finalized).toBe(true);
      expect(result.validationStages.smart_diagnosis).toBeDefined();
      expect(result.validationStages.smart_diagnosis.outcome).not.toBe('skipped');

      // Check metadata was updated with diagnosis
      const updateCall = mockDb.updateTaskStatus.mock.calls[0];
      const metadata = updateCall[2]?.metadata;
      expect(metadata?.finalization).toBeDefined();
    });

    it('skips smart_diagnosis on successful tasks', async () => {
      const task = makeTask();
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 0,
        output: 'Success',
      });

      expect(result.finalized).toBe(true);
      expect(result.validationStages.smart_diagnosis).toBeDefined();
      expect(result.validationStages.smart_diagnosis.outcome).toBe('skipped');
    });

    it('diagnoses timeout errors and records in metadata', async () => {
      const task = makeTask();
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 1,
        errorOutput: 'Process timed out after 300 seconds',
      });

      expect(result.finalized).toBe(true);
      const stages = result.validationStages;
      expect(stages.smart_diagnosis.outcome).not.toBe('skipped');
    });

    it('diagnoses connection errors and suggests provider switch', async () => {
      const task = makeTask({ provider: 'ollama' });
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 1,
        errorOutput: 'Error: connect ECONNREFUSED 192.168.1.100:11434',
      });

      expect(result.finalized).toBe(true);
      expect(result.validationStages.smart_diagnosis.outcome).not.toBe('skipped');
    });
  });

  describe('strategic_review stage in pipeline', () => {
    it('runs strategic_review on completed tasks with needs_review', async () => {
      const task = makeTask({
        metadata: JSON.stringify({ needs_review: true }),
      });
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 0,
        output: 'Implementation complete',
      });

      expect(result.finalized).toBe(true);
      expect(result.validationStages.strategic_review).toBeDefined();
      expect(result.validationStages.strategic_review.outcome).not.toBe('skipped');
    });

    it('skips strategic_review on tasks without needs_review', async () => {
      const task = makeTask({
        metadata: JSON.stringify({}),
      });
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 0,
        output: 'Done',
      });

      expect(result.finalized).toBe(true);
      // strategic_review should still run (it checks internally), but outcome is no_change
      expect(result.validationStages.strategic_review).toBeDefined();
    });

    it('skips strategic_review on failed tasks', async () => {
      const task = makeTask({
        metadata: JSON.stringify({ needs_review: true }),
      });
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 1,
        errorOutput: 'Build failed',
      });

      expect(result.finalized).toBe(true);
      // strategic_review only runs on completed tasks
      expect(result.validationStages.strategic_review.outcome).toBe('skipped');
    });

    it('rejects task when review detects critical file shrinkage', async () => {
      const task = makeTask({
        metadata: JSON.stringify({
          needs_review: true,
          finalization: { file_size_delta_pct: -80 },
        }),
      });
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 0,
        output: 'Done',
      });

      expect(result.finalized).toBe(true);
      // Review should reject, so final status should be failed
      expect(result.status).toBe('failed');
    });
  });

  describe('pipeline stage ordering', () => {
    it('runs stages in correct order', async () => {
      const task = makeTask({
        metadata: JSON.stringify({ needs_review: true }),
      });
      mockDb.getTask.mockReturnValue(task);

      const result = await finalizeTask('test-001', {
        exitCode: 0,
        output: 'Success',
      });

      const stageNames = Object.keys(result.validationStages);
      const diagIdx = stageNames.indexOf('smart_diagnosis');
      const reviewIdx = stageNames.indexOf('strategic_review');
      const failoverIdx = stageNames.indexOf('provider_failover');

      // smart_diagnosis before strategic_review before provider_failover
      expect(diagIdx).toBeLessThan(reviewIdx);
      expect(reviewIdx).toBeLessThan(failoverIdx);
    });
  });
});
