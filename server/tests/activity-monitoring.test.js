/**
 * Unit Tests: activity-monitoring stall threshold multipliers
 */

const { TEST_MODELS } = require('./test-helpers');

describe('Activity Monitoring - Stall Threshold Multipliers', () => {
  let activityMonitoring;
  let runningProcesses;
  let getStallThreshold;

  beforeEach(() => {
    activityMonitoring = require('../utils/activity-monitoring');
    runningProcesses = new Map();
    getStallThreshold = vi.fn();

    activityMonitoring.init({
      runningProcesses,
      getStallThreshold,
      safeConfigInt: vi.fn(),
      getSkipGitInCloseHandler: () => false,
    });
  });

  it('applies large-context and long-running multipliers plus metadata multiplier', () => {
    getStallThreshold.mockReturnValue(100);
    const now = Date.now();
    runningProcesses.set('task-1', {
      process: {},
      model: TEST_MODELS.SMALL,
      provider: 'ollama',
      metadata: JSON.stringify({ stall_grace_multiplier: '2', 'long-running': true, context_tokens: 12000 }),
      lastOutputAt: now - 800 * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });

    const activity = activityMonitoring.getTaskActivity('task-1');
    expect(activity.stallThreshold).toBe(1200);
    expect(activity.isStalled).toBe(false);
  });

  it('adds multiplier for Codex reasoning tasks', () => {
    getStallThreshold.mockReturnValue(600);
    const now = Date.now();
    runningProcesses.set('task-2', {
      process: {},
      model: 'codex-mini',
      provider: 'codex',
      taskType: 'reasoning',
      metadata: {},
      lastOutputAt: now - 700 * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });

    const activity = activityMonitoring.getTaskActivity('task-2');
    expect(activity.stallThreshold).toBe(900);
    expect(activity.isStalled).toBe(false);
  });

  it('falls back to default threshold when no multipliers apply', () => {
    getStallThreshold.mockReturnValue(120);
    const now = Date.now();
    runningProcesses.set('task-3', {
      process: {},
      model: 'llama3',
      provider: 'ollama',
      metadata: {},
      lastOutputAt: now - 200 * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });

    const activity = activityMonitoring.getTaskActivity('task-3');
    expect(activity.stallThreshold).toBe(120);
    expect(activity.isStalled).toBe(true);
  });
});
