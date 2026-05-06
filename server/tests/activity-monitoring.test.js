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
    vi.restoreAllMocks();
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses activity timeout policy as a stall threshold floor', () => {
    getStallThreshold.mockReturnValue(180);
    const now = Date.now();
    runningProcesses.set('task-plan-generation', {
      process: {},
      model: 'gpt-5.5',
      provider: 'codex',
      metadata: JSON.stringify({
        activity_timeout_policy: {
          kind: 'plan_generation',
          timeout_minutes: 30,
        },
      }),
      lastOutputAt: now - 600 * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });

    const activity = activityMonitoring.getTaskActivity('task-plan-generation');
    expect(activity.stallThreshold).toBe(1800);
    expect(activity.isStalled).toBe(false);
  });

  it('keeps stall detection disabled when provider threshold is null', () => {
    getStallThreshold.mockReturnValue(null);
    const now = Date.now();
    runningProcesses.set('task-provider-disabled', {
      process: {},
      model: 'gpt-5.5',
      provider: 'codex',
      metadata: {
        activity_timeout_policy: {
          kind: 'plan_generation',
          timeout_minutes: 30,
        },
      },
      lastOutputAt: now - 3600 * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });

    const activity = activityMonitoring.getTaskActivity('task-provider-disabled');
    expect(activity.stallThreshold).toBeNull();
    expect(activity.isStalled).toBe(false);
  });

  it('uses a default factory-internal timeout floor for legacy architect tasks', () => {
    getStallThreshold.mockReturnValue(180);
    const now = Date.now();
    runningProcesses.set('task-legacy-architect', {
      process: {},
      model: 'gpt-5.5',
      provider: 'codex',
      project: 'factory-architect',
      metadata: {
        factory_internal: true,
        kind: 'architect_cycle',
      },
      lastOutputAt: now - 600 * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });

    const activity = activityMonitoring.getTaskActivity('task-legacy-architect');
    expect(activity.stallThreshold).toBe(1800);
    expect(activity.isStalled).toBe(false);
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

// Max-task-lifetime cap: defense-in-depth against tasks that ARE making
// activity (so the layered stall rescues keep saving them) but never
// converging — e.g., a codex run that loops endlessly through tool calls.
// Disabled by default (config 0); operator opts in by setting
// `max_task_lifetime_seconds`. Bypasses CPU + filesystem rescues at the
// limit because at that age the task is stuck regardless of activity.
describe('Activity Monitoring - max-task-lifetime cap', () => {
  let activityMonitoring;
  let runningProcesses;
  let getStallThreshold;
  let safeConfigInt;
  let processActivity;

  beforeEach(() => {
    vi.restoreAllMocks();
    activityMonitoring = require('../utils/activity-monitoring');
    processActivity = require('../utils/process-activity');
    processActivity.clearActivityCache();
    runningProcesses = new Map();
    getStallThreshold = vi.fn();
    safeConfigInt = vi.fn();

    activityMonitoring.init({
      runningProcesses,
      getStallThreshold,
      safeConfigInt,
      getSkipGitInCloseHandler: () => false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupCodexProc(taskId, { ageSeconds, lastOutputSecondsAgo = 5 }) {
    const now = Date.now();
    runningProcesses.set(taskId, {
      process: {},
      pid: undefined,
      model: 'gpt-5.5',
      provider: 'codex',
      metadata: {},
      startTime: now - ageSeconds * 1000,
      lastOutputAt: now - lastOutputSecondsAgo * 1000,
      output: '',
      errorOutput: '',
      lastFsFingerprint: null,
    });
  }

  it('does NOT trip when max_task_lifetime_seconds is 0 (disabled, default)', () => {
    getStallThreshold.mockReturnValue(120);
    safeConfigInt.mockImplementation((key, def) => (key === 'max_task_lifetime_seconds' ? 0 : def));
    setupCodexProc('task-no-cap', { ageSeconds: 99999, lastOutputSecondsAgo: 5 });
    const activity = activityMonitoring.getTaskActivity('task-no-cap');
    expect(activity.isStalled).toBe(false);
    expect(activity.stallReason).toBeNull();
  });

  it('does NOT trip when task age is below the cap', () => {
    getStallThreshold.mockReturnValue(120);
    safeConfigInt.mockImplementation((key, def) => (key === 'max_task_lifetime_seconds' ? 14400 : def));
    setupCodexProc('task-young', { ageSeconds: 3600, lastOutputSecondsAgo: 5 });
    const activity = activityMonitoring.getTaskActivity('task-young');
    expect(activity.isStalled).toBe(false);
    expect(activity.stallReason).toBeNull();
  });

  it('trips when task age exceeds the cap, even with fresh activity', () => {
    // The bug class this catches: codex emitting periodic stderr (so
    // lastActivitySeconds is small and would normally not be stalled),
    // but the task has been running for 5+ hours and is clearly stuck
    // in some loop. Without the cap, stall detection would never fire.
    getStallThreshold.mockReturnValue(120);
    safeConfigInt.mockImplementation((key, def) => (key === 'max_task_lifetime_seconds' ? 14400 : def));
    setupCodexProc('task-overrun', { ageSeconds: 18000, lastOutputSecondsAgo: 5 });
    const activity = activityMonitoring.getTaskActivity('task-overrun');
    expect(activity.isStalled).toBe(true);
    expect(activity.stallReason).toBe('max_lifetime_exceeded');
  });

  it('caps at upper limit (86400s = 24h) and trips a 25h-old task', () => {
    getStallThreshold.mockReturnValue(120);
    safeConfigInt.mockImplementation((key, def, _min, _max) => {
      if (key !== 'max_task_lifetime_seconds') return def;
      // Caller asks for 999999, safeConfigInt clamps to max=86400. We
      // simulate the actual signature by returning the clamped value.
      return Math.min(999999, 86400);
    });
    setupCodexProc('task-very-old', { ageSeconds: 90000, lastOutputSecondsAgo: 5 });
    const activity = activityMonitoring.getTaskActivity('task-very-old');
    expect(activity.isStalled).toBe(true);
    expect(activity.stallReason).toBe('max_lifetime_exceeded');
  });
});
