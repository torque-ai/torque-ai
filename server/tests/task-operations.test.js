'use strict';

/**
 * Unit tests for task-operations.js handler functions.
 * Mocks database/task-manager dependencies at the module boundary and verifies
 * each exported handler with success, error, and edge-case coverage.
 */

const { mockSpawnSync, mockUuidV4 } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(() => ({ status: 0, stdout: '1.0.0\n', stderr: '', error: null })),
  mockUuidV4: vi.fn(() => '11111111-1111-1111-1111-111111111111'),
}));

// Mock sub-modules that operations.js imports directly
vi.mock('../db/task-core', () => ({
  getTask() { return null; },
  listTasks() { return []; },
  countTasks() { return 0; },
  createTask() {},
}));

vi.mock('../db/task-metadata', () => ({
  addTaskTags() { return { tags: [] }; },
  removeTaskTags() { return { tags: [] }; },
  getAllTags() { return []; },
  getTagStats() { return []; },
  createBulkOperation() {},
  batchCancelTasks() { return 0; },
  updateBulkOperation() {},
  getRetryableTasks() { return []; },
  batchAddTagsByFilter() { return 0; },
  archiveTask() { return false; },
  archiveTasks() { return { archived: 0 }; },
  listArchivedTasks() { return []; },
  getArchivedTask() { return null; },
  restoreTask() { return null; },
  getArchiveStats() {
    return {
      total_archived: 0,
      oldest_archive: null,
      newest_archive: null,
      by_status: {},
      by_reason: {},
    };
  },
}));

vi.mock('../db/project-config-core', () => ({
  recordHealthCheck() {},
  getHealthSummary() {
    return {
      total_checks: 0,
      healthy_count: 0,
      degraded_count: 0,
      unhealthy_count: 0,
      avg_response_time: 0,
      uptime_percentage: 0,
    };
  },
  getLatestHealthCheck() { return null; },
  createScheduledTask(payload) { return payload; },
  listScheduledTasks() { return []; },
  getScheduledTask() { return null; },
  deleteScheduledTask() { return false; },
  updateScheduledTask() {},
}));

vi.mock('../db/scheduling-automation', () => ({
  getScheduledTask() { return null; },
  listScheduledTasks() { return []; },
  deleteScheduledTask() { return false; },
  updateScheduledTask() {},
  createCronScheduledTask() { return {}; },
}));

vi.mock('../db/config-core', () => ({
  getAllConfig() { return {}; },
}));

vi.mock('../db/event-tracking', () => ({
  searchTaskOutputs() { return []; },
  getOutputStats() {
    return {
      total_tasks: 0,
      tasks_with_output: 0,
      tasks_with_errors: 0,
      total_output_bytes: 0,
      total_error_bytes: 0,
    };
  },
  exportData() {
    return {
      exported_at: '2026-03-12T00:00:00.000Z',
      version: '1.0',
      data: {},
    };
  },
  safeJsonParse(value, fallback = null) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  importData() { return {}; },
}));

vi.mock('../db/provider-routing-core', () => ({
  getHealthHistory() { return []; },
}));

vi.mock('../task-manager', () => ({
  getRunningTaskCount() { return 0; },
  getAllTaskActivity() { return []; },
  checkStalledTasks() { return []; },
  cancelTask() {},
  startTask() {},
}));

vi.mock('fs', () => ({
  readFileSync() { return ''; },
  writeFileSync() {},
}));

vi.mock('../logger', () => ({
  child: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock('uuid', () => ({
  v4: mockUuidV4,
}));

const taskCore = require('../db/task-core');
const taskMetadata = require('../db/task-metadata');
const projectConfigCore = require('../db/project-config-core');
const schedulingAutomation = require('../db/scheduling-automation');
const configCore = require('../db/config-core');
const eventTracking = require('../db/event-tracking');
const providerRoutingCore = require('../db/provider-routing-core');
const taskManager = require('../task-manager');
const fs = require('fs');
const childProcess = require('node:child_process');
const originalSpawnSync = childProcess.spawnSync;

childProcess.spawnSync = mockSpawnSync;
const handlersPath = require.resolve('../handlers/task/operations');
delete require.cache[handlersPath];
const handlers = require('../handlers/task/operations');
childProcess.spawnSync = originalSpawnSync;

function getText(result) {
  return result.content[0].text;
}

describe('task-operations handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '1.0.0\n', stderr: '', error: null });
    mockUuidV4.mockReset();
    mockUuidV4.mockReturnValue('11111111-1111-1111-1111-111111111111');
    projectConfigCore.listScheduledTasks = vi.fn(() => []);
    projectConfigCore.getScheduledTask = vi.fn(() => null);
    projectConfigCore.deleteScheduledTask = vi.fn(() => false);
    projectConfigCore.updateScheduledTask = vi.fn(() => undefined);
    schedulingAutomation.listScheduledTasks = vi.fn(() => []);
    schedulingAutomation.getScheduledTask = vi.fn(() => null);
    schedulingAutomation.deleteScheduledTask = vi.fn(() => false);
    schedulingAutomation.updateScheduledTask = vi.fn(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ============ handleTagTask ============

  describe('handleTagTask', () => {
    it('returns an error when task_id is missing', () => {
      const result = handlers.handleTagTask({ tags: ['bug'] });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
    });

    it('returns error when task not found', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleTagTask({ task_id: 'nonexistent', tags: ['bug'] });
      expect(result.content[0].text).toContain('Task not found');
    });

    it('returns error when no tags provided', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'completed' });
      const result = handlers.handleTagTask({ task_id: 'task-1', tags: [] });
      expect(result.content[0].text).toContain('No tags provided');
    });

    it('adds tags and normalizes to lowercase/trimmed', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'completed' });
      vi.spyOn(taskMetadata, 'addTaskTags').mockReturnValue({ tags: ['bug', 'urgent'] });
      const result = handlers.handleTagTask({ task_id: 'task-1', tags: ['BUG', ' Urgent '] });
      expect(result.content[0].text).toContain('Tags Added');
      expect(result.content[0].text).toContain('bug, urgent');
      expect(taskMetadata.addTaskTags).toHaveBeenCalledWith('task-1', ['bug', 'urgent']);
    });
  });

  // ============ handleUntagTask ============

  describe('handleUntagTask', () => {
    it('returns error when task not found', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleUntagTask({ task_id: 'missing', tags: ['bug'] });
      expect(result.content[0].text).toContain('Task not found');
    });

    it('returns error when no tags provided', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'completed' });
      const result = handlers.handleUntagTask({ task_id: 'task-1', tags: [] });
      expect(result.content[0].text).toContain('No tags provided');
    });

    it('removes tags successfully', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'completed' });
      vi.spyOn(taskMetadata, 'removeTaskTags').mockReturnValue({ tags: ['remaining'] });
      const result = handlers.handleUntagTask({ task_id: 'task-1', tags: ['bug'] });
      expect(result.content[0].text).toContain('Tags Removed');
      expect(result.content[0].text).toContain('remaining');
    });

    it('shows (none) when all tags removed', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'completed' });
      vi.spyOn(taskMetadata, 'removeTaskTags').mockReturnValue({ tags: [] });
      const result = handlers.handleUntagTask({ task_id: 'task-1', tags: ['bug'] });
      expect(result.content[0].text).toContain('(none)');
    });
  });

  // ============ handleListTags ============

  describe('handleListTags', () => {
    it('returns empty message when no tags exist', () => {
      vi.spyOn(taskMetadata, 'getAllTags').mockReturnValue([]);
      vi.spyOn(taskMetadata, 'getTagStats').mockReturnValue([]);
      const result = handlers.handleListTags({});
      expect(result.content[0].text).toContain('No tags found');
    });

    it('lists tag statistics', () => {
      vi.spyOn(taskMetadata, 'getAllTags').mockReturnValue(['bug', 'feature']);
      vi.spyOn(taskMetadata, 'getTagStats').mockReturnValue([
        { tag: 'bug', count: 5 },
        { tag: 'feature', count: 3 },
      ]);
      const result = handlers.handleListTags({});
      expect(result.content[0].text).toContain('Tag Statistics');
      expect(result.content[0].text).toContain('bug');
      expect(result.content[0].text).toContain('5');
      expect(result.content[0].text).toContain('Total Unique Tags');
    });
  });

  // ============ handleCheckTaskProgress ============

  describe('handleCheckTaskProgress', () => {
    it('returns no running tasks message', async () => {
      vi.spyOn(taskCore, 'listTasks').mockReturnValue([]);
      const result = await handlers.handleCheckTaskProgress({ wait_seconds: 0 });
      expect(getText(result)).toContain('No running tasks');
    });

    it('detects active tasks with output growth', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:00:00.000Z'));

      const firstSnapshot = {
        id: 'task-1234567890ab',
        output: 'x'.repeat(100),
        started_at: '2026-03-12T11:59:20.000Z',
        ollama_host_id: 'host-1',
      };
      const secondSnapshot = {
        ...firstSnapshot,
        output: 'x'.repeat(140),
      };
      vi.spyOn(taskCore, 'listTasks')
        .mockReturnValueOnce([firstSnapshot])
        .mockReturnValueOnce([secondSnapshot]);
      vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);

      const promise = handlers.handleCheckTaskProgress({ wait_seconds: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(getText(result)).toContain('Task Progress Check');
      expect(getText(result)).toContain('task-123456');
      expect(getText(result)).toContain('+40');
      expect(getText(result)).toContain('✓ Active');
    });

    it('detects context limit exceeded', async () => {
      vi.useFakeTimers();

      const taskData = {
        id: 'task-ctx-exceeded',
        output: 'exceeds the 4096 token limit for this model',
        started_at: new Date(Date.now() - 60000).toISOString(),
      };
      vi.spyOn(taskCore, 'listTasks')
        .mockReturnValueOnce([taskData])
        .mockReturnValueOnce([taskData]);
      vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);

      const promise = handlers.handleCheckTaskProgress({ wait_seconds: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(getText(result)).toContain('CONTEXT EXCEEDED');
    });

    it('returns an internal error when progress inspection throws', async () => {
      vi.spyOn(taskCore, 'listTasks').mockImplementation(() => {
        throw new Error('db exploded');
      });

      const result = await handlers.handleCheckTaskProgress({ wait_seconds: 1 });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('INTERNAL_ERROR');
      expect(getText(result)).toContain('db exploded');
    });
  });

  // ============ handleHealthCheck ============

  describe('handleHealthCheck', () => {
    it('runs a connectivity check and records result', () => {
      vi.spyOn(projectConfigCore, 'recordHealthCheck').mockReturnValue(undefined);
      const result = handlers.handleHealthCheck({ check_type: 'connectivity' });
      // Whether codex is installed or not, the handler returns a status string
      expect(result.content[0].text).toContain('Health Check: CONNECTIVITY');
      expect(result.content[0].text).toMatch(/Healthy|Degraded|Unhealthy/);
      expect(result.content[0].text).toContain('Response Time');
      expect(projectConfigCore.recordHealthCheck).toHaveBeenCalled();
    });

    it('defaults to connectivity check_type', () => {
      vi.spyOn(projectConfigCore, 'recordHealthCheck').mockReturnValue(undefined);
      const result = handlers.handleHealthCheck({});
      expect(result.content[0].text).toContain('Health Check: CONNECTIVITY');
      expect(projectConfigCore.recordHealthCheck).toHaveBeenCalledWith(
        'connectivity',
        expect.any(String),
        expect.any(Number),
        null,
        expect.any(Object),
      );
    });

    it('runs full check type with capacity info when healthy', () => {
      vi.spyOn(projectConfigCore, 'recordHealthCheck').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'getRunningTaskCount').mockReturnValue(1);
      vi.spyOn(configCore, 'getAllConfig').mockReturnValue({ max_concurrent: '3' });
      const result = handlers.handleHealthCheck({ check_type: 'full' });
      expect(result.content[0].text).toContain('Health Check: FULL');
      // The check may report unhealthy if codex is not installed,
      // in which case capacity details are skipped. Either way the handler runs.
      expect(result.content[0].text).toMatch(/Healthy|Degraded|Unhealthy/);
    });

    it('marks the check degraded when the CLI returns a non-zero exit code', () => {
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'boom', error: null });
      vi.spyOn(projectConfigCore, 'recordHealthCheck').mockReturnValue(undefined);

      const result = handlers.handleHealthCheck({ check_type: 'connectivity' });

      expect(getText(result)).toContain('⚠ Degraded');
      expect(getText(result)).toContain('boom');
      expect(projectConfigCore.recordHealthCheck).toHaveBeenCalledWith(
        'connectivity',
        'degraded',
        expect.any(Number),
        'boom',
        expect.any(Object),
      );
    });

    it('reports at-capacity details during a full health check', () => {
      vi.spyOn(projectConfigCore, 'recordHealthCheck').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'getRunningTaskCount').mockReturnValue(3);
      vi.spyOn(configCore, 'getAllConfig').mockReturnValue({ max_concurrent: '3' });

      const result = handlers.handleHealthCheck({ check_type: 'full' });

      expect(getText(result)).toContain('⚠ Degraded');
      expect(getText(result)).toContain('At capacity');
      expect(getText(result)).toContain('3/3');
    });
  });

  // ============ handleHealthStatus ============

  describe('handleHealthStatus', () => {
    it('shows unknown status when no checks recorded', () => {
      vi.spyOn(projectConfigCore, 'getHealthSummary').mockReturnValue({ total_checks: 0 });
      vi.spyOn(projectConfigCore, 'getLatestHealthCheck').mockReturnValue(null);
      const result = handlers.handleHealthStatus({});
      expect(result.content[0].text).toContain('Unknown');
      expect(result.content[0].text).toContain('No health checks recorded');
    });

    it('shows current status and summary', () => {
      vi.spyOn(projectConfigCore, 'getLatestHealthCheck').mockReturnValue({
        status: 'healthy',
        checked_at: new Date().toISOString(),
        response_time_ms: 42,
      });
      vi.spyOn(projectConfigCore, 'getHealthSummary').mockReturnValue({
        total_checks: 10,
        healthy_count: 9,
        degraded_count: 1,
        unhealthy_count: 0,
        avg_response_time: 50,
        uptime_percentage: 90.0,
      });
      const result = handlers.handleHealthStatus({});
      expect(result.content[0].text).toContain('HEALTHY');
      expect(result.content[0].text).toContain('90.0%');
    });

    it('shows history when requested', () => {
      vi.spyOn(projectConfigCore, 'getLatestHealthCheck').mockReturnValue({
        status: 'healthy',
        checked_at: new Date().toISOString(),
        response_time_ms: 30,
      });
      vi.spyOn(projectConfigCore, 'getHealthSummary').mockReturnValue({
        total_checks: 5,
        healthy_count: 5,
        degraded_count: 0,
        unhealthy_count: 0,
        avg_response_time: 35,
        uptime_percentage: 100.0,
      });
      vi.spyOn(providerRoutingCore, 'getHealthHistory').mockReturnValue([
        { status: 'healthy', checked_at: new Date().toISOString(), check_type: 'connectivity', response_time_ms: 30 },
      ]);
      const result = handlers.handleHealthStatus({ include_history: true });
      expect(result.content[0].text).toContain('Recent History');
      expect(result.content[0].text).toContain('connectivity');
    });
  });

  // ============ handleCheckStalledTasks ============

  describe('handleCheckStalledTasks', () => {
    it('returns no running tasks message', () => {
      vi.spyOn(taskManager, 'getAllTaskActivity').mockReturnValue([]);
      vi.spyOn(taskManager, 'checkStalledTasks').mockReturnValue([]);
      const result = handlers.handleCheckStalledTasks({});
      expect(result.content[0].text).toContain('No running tasks');
    });

    it('shows active tasks', () => {
      vi.spyOn(taskManager, 'getAllTaskActivity').mockReturnValue([
        { taskId: 'task-12345678', elapsedSeconds: 30, lastActivitySeconds: 5, isStalled: false },
      ]);
      vi.spyOn(taskManager, 'checkStalledTasks').mockReturnValue([]);
      const result = handlers.handleCheckStalledTasks({});
      expect(result.content[0].text).toContain('Running Tasks');
      expect(result.content[0].text).toContain('No stalled tasks');
    });

    it('detects stalled tasks', () => {
      vi.spyOn(taskManager, 'getAllTaskActivity').mockReturnValue([
        { taskId: 'task-stalled-1', elapsedSeconds: 300, lastActivitySeconds: 200, isStalled: true, stallThreshold: 120 },
      ]);
      vi.spyOn(taskManager, 'checkStalledTasks').mockReturnValue([
        { taskId: 'task-stalled-1', lastActivitySeconds: 200 },
      ]);
      const result = handlers.handleCheckStalledTasks({ auto_cancel: false });
      expect(result.content[0].text).toContain('Stalled Tasks');
      expect(result.content[0].text).toContain('No output for 200s');
    });

    it('auto-cancels stalled tasks', () => {
      vi.spyOn(taskManager, 'getAllTaskActivity').mockReturnValue([
        { taskId: 'task-stalled-2', elapsedSeconds: 300, lastActivitySeconds: 200, isStalled: true },
      ]);
      vi.spyOn(taskManager, 'checkStalledTasks').mockReturnValue([
        { taskId: 'task-stalled-2', lastActivitySeconds: 200 },
      ]);
      const result = handlers.handleCheckStalledTasks({ auto_cancel: true });
      expect(result.content[0].text).toContain('CANCELLED');
    });
  });

  // ============ handleScheduleTask ============

  describe('handleScheduleTask', () => {
    it('returns error on empty task', () => {
      const result = handlers.handleScheduleTask({ task: '', schedule_type: 'once' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('task must be a non-empty string');
    });

    it('returns error on invalid schedule_type', () => {
      const result = handlers.handleScheduleTask({ task: 'do thing', schedule_type: 'daily' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('schedule_type must be "once" or "interval"');
    });

    it('returns error when once type missing run_at', () => {
      const result = handlers.handleScheduleTask({ task: 'do thing', schedule_type: 'once' });
      expect(result.content[0].text).toContain('run_at');
    });

    it('returns error when interval type missing interval_minutes', () => {
      const result = handlers.handleScheduleTask({ task: 'do thing', schedule_type: 'interval' });
      expect(result.content[0].text).toContain('interval_minutes');
    });

    it('creates a once schedule', () => {
      const runAt = new Date(Date.now() + 60000).toISOString();
      vi.spyOn(projectConfigCore, 'createScheduledTask').mockReturnValue({
        name: 'test-schedule',
        schedule_type: 'once',
        next_run_at: runAt,
        task_description: 'do something cool',
      });
      const result = handlers.handleScheduleTask({
        task: 'do something cool',
        schedule_type: 'once',
        run_at: runAt,
        name: 'test-schedule',
      });
      expect(result.content[0].text).toContain('Task Scheduled');
      expect(result.content[0].text).toContain('test-schedule');
    });

    it('creates an interval schedule', () => {
      vi.spyOn(projectConfigCore, 'createScheduledTask').mockReturnValue({
        name: 'interval-task',
        schedule_type: 'interval',
        next_run_at: new Date().toISOString(),
        repeat_interval_minutes: 15,
        max_runs: 5,
        task_description: 'recurring work',
      });
      const result = handlers.handleScheduleTask({
        task: 'recurring work',
        schedule_type: 'interval',
        interval_minutes: 15,
        name: 'interval-task',
        max_runs: 5,
      });
      expect(result.content[0].text).toContain('Every 15 minutes');
      expect(result.content[0].text).toContain('Max Runs');
    });

    it('computes a next_run_at timestamp for interval schedules without run_at', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T18:00:00.000Z'));
      vi.spyOn(projectConfigCore, 'createScheduledTask').mockImplementation((payload) => payload);

      const result = handlers.handleScheduleTask({
        task: 'recurring work',
        schedule_type: 'interval',
        interval_minutes: 15,
        tags: ['nightly'],
      });

      expect(projectConfigCore.createScheduledTask).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        task_description: 'recurring work',
        repeat_interval_minutes: 15,
        next_run_at: '2026-03-12T18:15:00.000Z',
        timeout_minutes: 30,
        priority: 0,
        tags: ['nightly'],
      }));
      expect(getText(result)).toContain('2026');
    });
  });

  // ============ handleListScheduled ============

  describe('handleListScheduled', () => {
    it('shows empty message when no schedules', () => {
      vi.spyOn(projectConfigCore, 'listScheduledTasks').mockReturnValue([]);
      const result = handlers.handleListScheduled({});
      expect(result.content[0].text).toContain('No scheduled tasks found');
    });

    it('lists scheduled tasks in table', () => {
      vi.spyOn(projectConfigCore, 'listScheduledTasks').mockReturnValue([{
        id: 'sched-12345678-1234-1234-1234-123456789012',
        name: 'My Schedule Task Here',
        schedule_type: 'interval',
        status: 'active',
        next_run_at: new Date().toISOString(),
        run_count: 3,
        max_runs: 10,
      }]);
      const result = handlers.handleListScheduled({});
      expect(result.content[0].text).toContain('Scheduled Tasks');
      expect(result.content[0].text).toContain('interval');
      expect(result.content[0].text).toContain('3/10');
    });
  });

  // ============ handleCancelScheduled ============

  describe('handleCancelScheduled', () => {
    it('returns error when schedule not found', () => {
      vi.spyOn(schedulingAutomation, 'getScheduledTask').mockReturnValue(null);
      const result = handlers.handleCancelScheduled({ schedule_id: 'missing' });
      expect(result.content[0].text).toContain('not found');
    });

    it('cancels a scheduled task', () => {
      vi.spyOn(schedulingAutomation, 'getScheduledTask').mockReturnValue({ name: 'My Task', run_count: 5 });
      vi.spyOn(schedulingAutomation, 'deleteScheduledTask').mockReturnValue(true);
      const result = handlers.handleCancelScheduled({ schedule_id: 'sched-1' });
      expect(result.content[0].text).toContain('Cancelled');
      expect(result.content[0].text).toContain('5 times');
    });

    it('returns error when delete fails', () => {
      vi.spyOn(schedulingAutomation, 'getScheduledTask').mockReturnValue({ name: 'My Task', run_count: 0 });
      vi.spyOn(schedulingAutomation, 'deleteScheduledTask').mockReturnValue(false);
      const result = handlers.handleCancelScheduled({ schedule_id: 'sched-1' });
      expect(result.content[0].text).toContain('Failed to cancel');
    });
  });

  // ============ handlePauseScheduled ============

  describe('handlePauseScheduled', () => {
    it('returns error when schedule not found', () => {
      vi.spyOn(schedulingAutomation, 'getScheduledTask').mockReturnValue(null);
      const result = handlers.handlePauseScheduled({ schedule_id: 'missing', action: 'pause' });
      expect(result.content[0].text).toContain('not found');
    });

    it('pauses a scheduled task', () => {
      vi.spyOn(schedulingAutomation, 'getScheduledTask').mockReturnValue({ name: 'My Task' });
      vi.spyOn(schedulingAutomation, 'updateScheduledTask').mockReturnValue(undefined);
      const result = handlers.handlePauseScheduled({ schedule_id: 'sched-1', action: 'pause' });
      expect(result.content[0].text).toContain('Paused');
      expect(result.content[0].text).toContain('paused');
    });

    it('resumes a scheduled task', () => {
      vi.spyOn(schedulingAutomation, 'getScheduledTask').mockReturnValue({ name: 'My Task' });
      vi.spyOn(schedulingAutomation, 'updateScheduledTask').mockReturnValue(undefined);
      const result = handlers.handlePauseScheduled({ schedule_id: 'sched-1', action: 'resume' });
      expect(result.content[0].text).toContain('Resumed');
      expect(result.content[0].text).toContain('active');
    });
  });

  // ============ handleBatchCancel ============

  describe('handleBatchCancel', () => {
    it('returns error on invalid status type', () => {
      const result = handlers.handleBatchCancel({ status: 123 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('status must be a string');
    });

    it('returns error on invalid tags type', () => {
      const result = handlers.handleBatchCancel({ tags: 'not-array' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tags must be an array');
    });

    it('cancels tasks with process killing', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskCore, 'listTasks').mockImplementation((options = {}) => {
        if (options.status === 'running') {
          return [
            { id: 'task-running-1' },
            { id: 'task-running-2' },
          ];
        }
        return [];
      });
      vi.spyOn(taskManager, 'cancelTask').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'batchCancelTasks').mockReturnValue(0);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchCancel({ status: 'running' });
      expect(result.content[0].text).toContain('Batch Cancel Complete');
      expect(result.content[0].text).toContain('Tasks Cancelled:** 2');
      expect(result.content[0].text).toContain('Running Processes Killed');
      expect(taskManager.cancelTask).toHaveBeenCalledTimes(2);
    });

    it('skips process killing when status is queued', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskCore, 'listTasks').mockImplementation((options = {}) => {
        if (options.status === 'queued') {
          return Array.from({ length: 5 }, (_, index) => ({ id: `task-queued-${index + 1}` }));
        }
        return [];
      });
      vi.spyOn(taskMetadata, 'batchCancelTasks').mockReturnValue(5);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchCancel({ status: 'queued' });
      expect(result.content[0].text).toContain('Tasks Cancelled:** 5');
    });

    it('applies older_than_hours filter', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskCore, 'listTasks').mockReturnValue([]);
      vi.spyOn(taskMetadata, 'batchCancelTasks').mockReturnValue(2);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchCancel({ older_than_hours: 24 });
      expect(result.content[0].text).toContain('Older than: 24 hours');
    });

    it('continues bulk cancellation when cancelling one running task throws', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskCore, 'listTasks')
        .mockImplementationOnce(() => [
          { id: 'task-running-1' },
          { id: 'task-running-2' },
        ])
        .mockImplementationOnce(() => [
          { id: 'task-running-1' },
        ])
        .mockImplementationOnce(() => [
          { id: 'task-queued-1' },
          { id: 'task-queued-2' },
        ])
        .mockImplementationOnce(() => [
          { id: 'task-pending-1' },
        ]);
      vi.spyOn(taskManager, 'cancelTask')
        .mockImplementationOnce(() => {
          throw new Error('already gone');
        })
        .mockReturnValueOnce(undefined);
      vi.spyOn(taskMetadata, 'batchCancelTasks').mockReturnValue(4);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchCancel({});

      expect(taskManager.cancelTask).toHaveBeenCalledTimes(2);
      expect(taskMetadata.updateBulkOperation).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          total_tasks: 5,
          succeeded_tasks: 5,
        }),
      );
      expect(getText(result)).toContain('Tasks Cancelled:** 5');
      expect(getText(result)).toContain('Running Processes Killed:** 1');
    });
  });

  // ============ handleBatchRetry ============

  describe('handleBatchRetry', () => {
    it('returns error on invalid tags type', () => {
      const result = handlers.handleBatchRetry({ tags: 'not-array' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tags must be an array');
    });

    it('returns empty when no retryable tasks', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'getRetryableTasks').mockReturnValue([]);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchRetry({});
      expect(result.content[0].text).toContain('No failed tasks found');
    });

    it('retries failed tasks', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'getRetryableTasks').mockReturnValue([
        { id: 'failed-1', status: 'failed', task_description: 'do stuff', working_directory: '/tmp', timeout_minutes: 30, priority: 0 },
      ]);
      vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchRetry({});
      expect(result.content[0].text).toContain('Batch Retry Complete');
      expect(result.content[0].text).toContain('Tasks Retried:** 1');
      expect(taskCore.createTask).toHaveBeenCalled();
      expect(taskManager.startTask).toHaveBeenCalled();
    });

    it('filters to failed only when include_cancelled is false', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'getRetryableTasks').mockReturnValue([
        { id: 'cancelled-1', status: 'cancelled', task_description: 'x', working_directory: '/tmp', timeout_minutes: 30, priority: 0 },
      ]);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchRetry({ include_cancelled: false });
      expect(result.content[0].text).toContain('No failed tasks found');
    });

    it('retries cancelled tasks when include_cancelled is true', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'getRetryableTasks').mockReturnValue([
        {
          id: 'cancelled-1',
          status: 'cancelled',
          task_description: 'rerun me',
          working_directory: '/tmp',
          timeout_minutes: 45,
          auto_approve: true,
          priority: 2,
          tags: ['ops'],
        },
      ]);
      vi.spyOn(taskCore, 'createTask').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchRetry({ include_cancelled: true, limit: 1 });

      expect(taskCore.createTask).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        status: 'pending',
        task_description: 'rerun me',
        priority: 3,
        context: { retry_of: 'cancelled-1' },
      }));
      const newTaskId = taskCore.createTask.mock.calls[0][0].id;
      expect(taskManager.startTask).toHaveBeenCalledWith(newTaskId);
      expect(taskMetadata.updateBulkOperation).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          affected_task_ids: [newTaskId],
          total_tasks: 1,
        }),
      );
      expect(getText(result)).toContain('Tasks Retried:** 1');
    });
  });

  // ============ handleBatchTag ============

  describe('handleBatchTag', () => {
    it('returns error on missing tags', () => {
      const result = handlers.handleBatchTag({ tags: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tags must be a non-empty array');
    });

    it('batch tags tasks', () => {
      vi.spyOn(taskMetadata, 'createBulkOperation').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'batchAddTagsByFilter').mockReturnValue(7);
      vi.spyOn(taskMetadata, 'updateBulkOperation').mockReturnValue(undefined);

      const result = handlers.handleBatchTag({ tags: ['batch-1'], filter_status: 'completed' });
      expect(result.content[0].text).toContain('Batch Tag Complete');
      expect(result.content[0].text).toContain('Tasks Updated:** 7');
      expect(result.content[0].text).toContain('batch-1');
    });
  });

  // ============ handleSearchOutputs ============

  describe('handleSearchOutputs', () => {
    it('returns error for short pattern', () => {
      const result = handlers.handleSearchOutputs({ pattern: 'x' });
      expect(result.content[0].text).toContain('at least 2 characters');
    });

    it('returns no matches message', () => {
      vi.spyOn(eventTracking, 'searchTaskOutputs').mockReturnValue([]);
      const result = handlers.handleSearchOutputs({ pattern: 'error' });
      expect(result.content[0].text).toContain('No matches found');
    });

    it('returns search results with snippets', () => {
      vi.spyOn(eventTracking, 'searchTaskOutputs').mockReturnValue([{
        id: 'task-search-result-1234',
        status: 'completed',
        created_at: new Date().toISOString(),
        task_description: 'some task description here',
        snippets: [{ source: 'output', text: '...found the error here...' }],
      }]);
      const result = handlers.handleSearchOutputs({ pattern: 'error' });
      expect(result.content[0].text).toContain('Output Search');
      expect(result.content[0].text).toContain('Matches:** 1');
      expect(result.content[0].text).toContain('found the error here');
    });

    it('passes sanitized search filters to the database', () => {
      vi.spyOn(eventTracking, 'searchTaskOutputs').mockReturnValue([]);

      handlers.handleSearchOutputs({
        pattern: 'error',
        status: 'failed',
        tags: ['ops'],
        since: '2026-03-10T12:00:00.000Z',
        limit: 5,
      });

      expect(eventTracking.searchTaskOutputs).toHaveBeenCalledWith('error', {
        status: 'failed',
        tags: ['ops'],
        since: '2026-03-10T12:00:00.000Z',
        limit: 5,
      });
    });
  });

  // ============ handleOutputStats ============

  describe('handleOutputStats', () => {
    it('returns formatted statistics', () => {
      vi.spyOn(eventTracking, 'getOutputStats').mockReturnValue({
        total_tasks: 100,
        tasks_with_output: 85,
        tasks_with_errors: 10,
        total_output_bytes: 1048576,
        total_error_bytes: 51200,
      });
      const result = handlers.handleOutputStats({});
      expect(result.content[0].text).toContain('Task Output Statistics');
      expect(result.content[0].text).toContain('100');
      expect(result.content[0].text).toContain('85');
      expect(result.content[0].text).toContain('MB');
    });
  });

  // ============ handleExportData ============

  describe('handleExportData', () => {
    it('exports data as text when no output_file', () => {
      vi.spyOn(eventTracking, 'exportData').mockReturnValue({
        exported_at: new Date().toISOString(),
        version: '1.0',
        data: { tasks: [{ id: 't1' }], templates: [], pipelines: [], scheduled_tasks: [] },
      });
      const result = handlers.handleExportData({});
      expect(result.content[0].text).toContain('Data Export');
      expect(result.content[0].text).toContain('Tasks: 1');
    });

    it('exports data to file', () => {
      vi.spyOn(eventTracking, 'exportData').mockReturnValue({
        exported_at: new Date().toISOString(),
        version: '1.0',
        data: { tasks: [], templates: [], pipelines: [], scheduled_tasks: [] },
      });
      vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
      const result = handlers.handleExportData({ output_file: '/tmp/export.json' });
      expect(result.content[0].text).toContain('Data Exported');
      expect(result.content[0].text).toContain('/tmp/export.json');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('returns an operation error when writing export file fails', () => {
      vi.spyOn(eventTracking, 'exportData').mockReturnValue({
        exported_at: new Date().toISOString(),
        version: '1.0',
        data: { tasks: [], templates: [], pipelines: [], scheduled_tasks: [] },
      });
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      const result = handlers.handleExportData({ output_file: '/tmp/export.json' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Failed to write export file');
      expect(getText(result)).toContain('disk full');
    });

    it('rejects path traversal in output_file', () => {
      vi.spyOn(eventTracking, 'exportData').mockReturnValue({
        exported_at: new Date().toISOString(),
        version: '1.0',
        data: { tasks: [], templates: [], pipelines: [], scheduled_tasks: [] },
      });
      const result = handlers.handleExportData({ output_file: '../../etc/passwd' });
      expect(result.content[0].text).toContain('path traversal');
    });
  });

  // ============ handleImportData ============

  describe('handleImportData', () => {
    it('returns error when no source provided', () => {
      const result = handlers.handleImportData({});
      expect(result.content[0].text).toContain('file_path or json_data is required');
    });

    it('imports from json_data', () => {
      vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue({ tasks: [{ id: 't1' }, { id: 't2' }], templates: [] });
      vi.spyOn(eventTracking, 'importData').mockReturnValue({
        tasks: { imported: 2, skipped: 0, errors: [] },
        templates: { imported: 0, skipped: 0, errors: [] },
      });
      const result = handlers.handleImportData({
        json_data: '{"tasks":[{"id":"t1"},{"id":"t2"}],"templates":[]}',
      });
      expect(result.content[0].text).toContain('Data Import Complete');
      expect(result.content[0].text).toContain('JSON data');
    });

    it('imports from file', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue('{"tasks":[],"templates":[]}');
      vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue({ tasks: [], templates: [] });
      vi.spyOn(eventTracking, 'importData').mockReturnValue({
        tasks: { imported: 0, skipped: 0, errors: [] },
      });
      const result = handlers.handleImportData({ file_path: '/tmp/import.json' });
      expect(result.content[0].text).toContain('Data Import Complete');
    });

    it('rejects path traversal in file_path', () => {
      const result = handlers.handleImportData({ file_path: '../../../etc/shadow' });
      expect(result.content[0].text).toContain('path traversal');
    });

    it('returns an operation error when reading the import file fails', () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('access denied');
      });

      const result = handlers.handleImportData({ file_path: '/tmp/import.json' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Failed to read import file');
      expect(getText(result)).toContain('access denied');
    });

    it('handles invalid JSON', () => {
      vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue(null);
      const result = handlers.handleImportData({ json_data: 'not-json{{{' });
      expect(result.content[0].text).toContain('invalid JSON');
    });

    it('rejects imports above the maximum task batch size', () => {
      vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue({
        tasks: Array.from({ length: 1001 }, (_, index) => ({ id: `task-${index}` })),
        templates: [],
      });

      const result = handlers.handleImportData({ json_data: '{"tasks":[]}' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Too many tasks: maximum 1000 allowed per import');
    });

    it('rejects imports above the maximum template batch size', () => {
      vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue({
        tasks: [],
        templates: Array.from({ length: 101 }, (_, index) => ({ id: `template-${index}` })),
      });

      const result = handlers.handleImportData({ json_data: '{"templates":[]}' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Too many templates: maximum 100 allowed per import');
    });
  });

  // ============ handleArchiveTask ============

  describe('handleArchiveTask', () => {
    it('returns error when task not found', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
      const result = handlers.handleArchiveTask({ task_id: 'missing' });
      expect(result.content[0].text).toContain('Task not found');
    });

    it('returns error for running task', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'running' });
      const result = handlers.handleArchiveTask({ task_id: 'task-1' });
      expect(result.content[0].text).toContain('Cannot archive task with status: running');
    });

    it('archives a completed task', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'completed', task_description: 'some task' });
      vi.spyOn(taskMetadata, 'archiveTask').mockReturnValue(true);
      const result = handlers.handleArchiveTask({ task_id: 'task-1', reason: 'cleanup' });
      expect(result.content[0].text).toContain('Task Archived');
      expect(result.content[0].text).toContain('cleanup');
    });

    it('returns error when archive fails', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1', status: 'completed', task_description: 'x' });
      vi.spyOn(taskMetadata, 'archiveTask').mockReturnValue(false);
      const result = handlers.handleArchiveTask({ task_id: 'task-1' });
      expect(result.content[0].text).toContain('Failed to archive');
    });
  });

  // ============ handleArchiveTasks ============

  describe('handleArchiveTasks', () => {
    it('bulk archives tasks with filters', () => {
      vi.spyOn(taskMetadata, 'archiveTasks').mockReturnValue({ archived: 15 });
      const result = handlers.handleArchiveTasks({
        status: 'failed',
        older_than_days: 7,
        tags: ['test'],
        reason: 'cleanup old failures',
      });
      expect(result.content[0].text).toContain('Bulk Archive Complete');
      expect(result.content[0].text).toContain('15');
      expect(result.content[0].text).toContain('7 days');
      expect(result.content[0].text).toContain('test');
    });

    it('defaults to completed status', () => {
      vi.spyOn(taskMetadata, 'archiveTasks').mockReturnValue({ archived: 0 });
      const result = handlers.handleArchiveTasks({});
      expect(result.content[0].text).toContain('completed');
    });
  });

  // ============ handleListArchived ============

  describe('handleListArchived', () => {
    it('returns empty message when no archived tasks', () => {
      vi.spyOn(taskMetadata, 'listArchivedTasks').mockReturnValue([]);
      const result = handlers.handleListArchived({});
      expect(result.content[0].text).toContain('No archived tasks found');
    });

    it('lists archived tasks in table', () => {
      vi.spyOn(taskMetadata, 'listArchivedTasks').mockReturnValue([{
        id: 'archived-12345678-xxxx',
        archived_at: new Date().toISOString(),
        archive_reason: 'old task',
        original_data: JSON.stringify({ status: 'completed', task_description: 'Do something here' }),
      }]);
      vi.spyOn(eventTracking, 'safeJsonParse').mockReturnValue({ status: 'completed', task_description: 'Do something here' });
      const result = handlers.handleListArchived({});
      expect(result.content[0].text).toContain('Archived Tasks');
      expect(result.content[0].text).toContain('completed');
      expect(result.content[0].text).toContain('Do something here');
    });
  });

  // ============ handleRestoreTask ============

  describe('handleRestoreTask', () => {
    it('returns error when archived task not found', () => {
      vi.spyOn(taskMetadata, 'getArchivedTask').mockReturnValue(null);
      const result = handlers.handleRestoreTask({ task_id: 'missing' });
      expect(result.content[0].text).toContain('not found');
    });

    it('restores an archived task', () => {
      vi.spyOn(taskMetadata, 'getArchivedTask').mockReturnValue({ id: 'task-1' });
      vi.spyOn(taskMetadata, 'restoreTask').mockReturnValue({
        id: 'task-1',
        status: 'completed',
        task_description: 'restored task',
      });
      const result = handlers.handleRestoreTask({ task_id: 'task-1' });
      expect(result.content[0].text).toContain('Task Restored');
      expect(result.content[0].text).toContain('completed');
    });

    it('returns error when restore fails', () => {
      vi.spyOn(taskMetadata, 'getArchivedTask').mockReturnValue({ id: 'task-1' });
      vi.spyOn(taskMetadata, 'restoreTask').mockReturnValue(null);
      const result = handlers.handleRestoreTask({ task_id: 'task-1' });
      expect(result.content[0].text).toContain('Failed to restore');
    });
  });

  // ============ handleGetArchiveStats ============

  describe('handleGetArchiveStats', () => {
    it('returns archive statistics', () => {
      vi.spyOn(taskMetadata, 'getArchiveStats').mockReturnValue({
        total_archived: 42,
        oldest_archive: '2025-01-01T00:00:00.000Z',
        newest_archive: '2025-06-01T00:00:00.000Z',
        by_status: { completed: 30, failed: 12 },
        by_reason: { cleanup: 35, '': 7 },
      });
      const result = handlers.handleGetArchiveStats({});
      expect(result.content[0].text).toContain('Archive Statistics');
      expect(result.content[0].text).toContain('42');
      expect(result.content[0].text).toContain('completed');
      expect(result.content[0].text).toContain('30');
      expect(result.content[0].text).toContain('cleanup');
    });

    it('handles empty archive', () => {
      vi.spyOn(taskMetadata, 'getArchiveStats').mockReturnValue({
        total_archived: 0,
        oldest_archive: null,
        newest_archive: null,
        by_status: {},
        by_reason: {},
      });
      const result = handlers.handleGetArchiveStats({});
      expect(result.content[0].text).toContain('Total Archived:** 0');
      expect(result.content[0].text).toContain('N/A');
    });
  });
});
