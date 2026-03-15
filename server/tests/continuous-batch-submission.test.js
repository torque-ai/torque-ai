import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleContinuousBatchSubmission } = require('../handlers/automation-batch-orchestration');

let mockPlanNextBatch;
let mockRunBatch;
let mockRecordEvent;
let mockGetConfig;
let mockLogger;

function makeDeps() {
  return {
    db: {
      getConfig: mockGetConfig,
      recordEvent: mockRecordEvent,
    },
    logger: mockLogger,
    handlePlanNextBatch: mockPlanNextBatch,
    handleRunBatch: mockRunBatch,
  };
}

const workflowData = {
  id: 'wf-test-1',
  working_directory: 'C:/test/project',
  status: 'completed',
};

describe('continuous batch submission', () => {
  beforeEach(() => {
    mockPlanNextBatch = vi.fn();
    mockRunBatch = vi.fn();
    mockRecordEvent = vi.fn();
    mockGetConfig = vi.fn();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    vi.clearAllMocks();
  });

  it('returns null when continuous_batch_enabled is not 1', async () => {
    mockGetConfig.mockReturnValue('0');

    const result = await handleContinuousBatchSubmission('wf-1', workflowData, makeDeps());

    expect(result).toBeNull();
    expect(mockPlanNextBatch).not.toHaveBeenCalled();
    expect(mockRunBatch).not.toHaveBeenCalled();
  });

  it('returns null when no working_directory is available', async () => {
    mockGetConfig.mockImplementation((key) => {
      if (key === 'continuous_batch_enabled') return '1';
      return null;
    });

    const result = await handleContinuousBatchSubmission('wf-1', { id: 'wf-1' }, makeDeps());

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[Continuous Batch] Missing working_directory or deluge_path; skipping submission'
    );
  });

  it('returns null when no deluge_path is configured', async () => {
    mockGetConfig.mockImplementation((key) => {
      if (key === 'continuous_batch_enabled') return '1';
      if (key === 'continuous_batch_deluge_path') return null;
      return null;
    });

    const result = await handleContinuousBatchSubmission('wf-1', workflowData, makeDeps());

    expect(result).toBeNull();
    expect(mockPlanNextBatch).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[Continuous Batch] Missing working_directory or deluge_path; skipping submission'
    );
  });

  it('returns null when plan_next_batch finds no recommendations', async () => {
    mockGetConfig.mockImplementation((key) => {
      if (key === 'continuous_batch_enabled') return '1';
      if (key === 'continuous_batch_deluge_path') return 'C:/test/deluge';
      return null;
    });
    mockPlanNextBatch.mockResolvedValue({ _recommendations: [] });

    const result = await handleContinuousBatchSubmission('wf-1', workflowData, makeDeps());

    expect(result).toBeNull();
    expect(mockPlanNextBatch).toHaveBeenCalledWith({
      working_directory: 'C:/test/project',
      deluge_path: 'C:/test/deluge',
      count: 1,
    });
    expect(mockRunBatch).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('No features available for continuous batch');
  });

  it('submits the next batch when enabled and recommendations exist', async () => {
    mockGetConfig.mockImplementation((key) => {
      if (key === 'continuous_batch_enabled') return '1';
      if (key === 'continuous_batch_deluge_path') return 'C:/test/deluge';
      if (key === 'continuous_batch_step_providers') return null;
      return null;
    });
    mockPlanNextBatch.mockResolvedValue({
      _recommendations: [{ featureName: 'TestFeature', score: 85 }],
    });
    mockRunBatch.mockResolvedValue({ _workflow_id: 'wf-next-1' });

    const result = await handleContinuousBatchSubmission('wf-1', workflowData, makeDeps());

    expect(result).toEqual({ workflow_id: 'wf-next-1', feature_name: 'TestFeature' });
    expect(mockRunBatch).toHaveBeenCalledWith({
      working_directory: 'C:/test/project',
      feature_name: 'TestFeature',
      step_providers: undefined,
      batch_name: 'auto-batch-TestFeature',
    });
    expect(mockRecordEvent).toHaveBeenCalledWith(
      'continuous_batch_submitted',
      'wf-1',
      {
        next_workflow_id: 'wf-next-1',
        feature_name: 'TestFeature',
        score: 85,
      }
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[Continuous Batch] Submitted TestFeature as workflow wf-next-1'
    );
  });

  it('parses step_providers from config JSON', async () => {
    mockGetConfig.mockImplementation((key) => {
      if (key === 'continuous_batch_enabled') return '1';
      if (key === 'continuous_batch_deluge_path') return 'C:/test/deluge';
      if (key === 'continuous_batch_step_providers') return '{"types":"ollama","system":"deepinfra"}';
      return null;
    });
    mockPlanNextBatch.mockResolvedValue({
      _recommendations: [{ featureName: 'Feature2', score: 70 }],
    });
    mockRunBatch.mockResolvedValue({ _workflow_id: 'wf-next-2' });

    await handleContinuousBatchSubmission('wf-1', workflowData, makeDeps());

    expect(mockRunBatch).toHaveBeenCalledWith({
      working_directory: 'C:/test/project',
      feature_name: 'Feature2',
      step_providers: { types: 'ollama', system: 'deepinfra' },
      batch_name: 'auto-batch-Feature2',
    });
  });

  it('catches errors and returns null without throwing', async () => {
    mockGetConfig.mockImplementation((key) => {
      if (key === 'continuous_batch_enabled') return '1';
      if (key === 'continuous_batch_deluge_path') return 'C:/test/deluge';
      return null;
    });
    mockPlanNextBatch.mockRejectedValue(new Error('plan failed'));

    const result = await handleContinuousBatchSubmission('wf-1', workflowData, makeDeps());

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[Continuous Batch] Failed to submit next batch:',
      'plan failed'
    );
  });

  it('uses workflow working_directory over configured fallback', async () => {
    mockGetConfig.mockImplementation((key) => {
      if (key === 'continuous_batch_enabled') return '1';
      if (key === 'continuous_batch_deluge_path') return 'C:/test/deluge';
      if (key === 'continuous_batch_working_directory') return 'C:/fallback/dir';
      return null;
    });
    mockPlanNextBatch.mockResolvedValue({
      _recommendations: [{ featureName: 'F3', score: 60 }],
    });
    mockRunBatch.mockResolvedValue({ _workflow_id: 'wf-3' });

    await handleContinuousBatchSubmission('wf-1', workflowData, makeDeps());

    expect(mockPlanNextBatch).toHaveBeenCalledWith({
      working_directory: 'C:/test/project',
      deluge_path: 'C:/test/deluge',
      count: 1,
    });
    expect(mockRunBatch).toHaveBeenCalledWith({
      working_directory: 'C:/test/project',
      feature_name: 'F3',
      step_providers: undefined,
      batch_name: 'auto-batch-F3',
    });
  });
});
