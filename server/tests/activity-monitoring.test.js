/**
 * Unit Tests: activity-monitoring stall threshold multipliers
 */

const { TEST_MODELS } = require('./test-helpers');

describe('Activity Monitoring - Stall Threshold Multipliers', () => {
  let activityMonitoring;
  let runningProcesses;
  let getStallThreshold;
  let processActivity;

  beforeEach(() => {
    activityMonitoring = require('../utils/activity-monitoring');
    processActivity = require('../utils/process-activity');
    processActivity.clearActivityCache();
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

  it('rescues codex via cumulative-CPU-delta when instantaneous CPU is 0%', () => {
    // Simulates codex parked on an LLM API call: process alive, low
    // instantaneous CPU, but cumulative CPU advances on response receipt.
    getStallThreshold.mockReturnValue(120);
    const now = Date.now();
    runningProcesses.set('task-codex-wait', {
      process: { pid: process.pid },
      pid: process.pid,
      workingDirectory: null,           // skip git fingerprint check
      model: 'gpt-5.5',
      provider: 'codex',
      metadata: {},
      lastOutputAt: now - 200 * 1000,   // > threshold, would be stalled
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });

    // Force instantaneous CPU rescue to fail (no isActive)
    vi.spyOn(processActivity, 'getProcessTreeCpu').mockReturnValue({
      totalCpu: 0,
      totalCpuPercent: 0,
      processCount: 2,
      isActive: false,
    });
    // Cumulative delta says: yes, CPU advanced since last check
    vi.spyOn(processActivity, 'getProcessTreeCpuDelta').mockReturnValue({
      deltaMs: 1500,
      isAdvancing: true,
      hasBaseline: true,
    });

    const activity = activityMonitoring.getTaskActivity('task-codex-wait');
    expect(activity.isStalled).toBe(false);
    expect(activity.cpuRescued).toBe(true);
  });

  it('still flags stalled for non-agent provider when CPU is 0% even if delta > 0', () => {
    // Cumulative-delta rescue is gated to AGENT_PROVIDERS — ollama/etc.
    // should not benefit, since they are expected to stream stdout when
    // working and silence is a real signal.
    getStallThreshold.mockReturnValue(120);
    const now = Date.now();
    runningProcesses.set('task-ollama', {
      process: { pid: process.pid },
      pid: process.pid,
      workingDirectory: null,
      model: 'qwen3-coder:30b',
      provider: 'ollama',
      metadata: {},
      lastOutputAt: now - 200 * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });
    vi.spyOn(processActivity, 'getProcessTreeCpu').mockReturnValue({
      totalCpu: 0,
      totalCpuPercent: 0,
      processCount: 1,
      isActive: false,
    });
    const deltaSpy = vi.spyOn(processActivity, 'getProcessTreeCpuDelta').mockReturnValue({
      deltaMs: 1500,
      isAdvancing: true,
      hasBaseline: true,
    });

    const activity = activityMonitoring.getTaskActivity('task-ollama');
    expect(activity.isStalled).toBe(true);
    expect(activity.cpuRescued).toBe(false);
    // Delta is not consulted for non-agent providers
    expect(deltaSpy).not.toHaveBeenCalled();
  });
});
