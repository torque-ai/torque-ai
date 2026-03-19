'use strict';

// require.cache manipulation is intentionally used here rather than vi.mock().
// The database module (database.js) re-exports functions defined in sub-modules
// that hold a reference to the internal SQLite connection, not to the exported
// object. vi.mock('../database') replaces the require() return value but cannot
// intercept those internal references, so the real sub-module functions still run
// against the uninitialized SQLite connection (db = null) and throw.
// installMock() directly patches require.cache so the handler picks up mockDb when
// it first loads. The handler cache entry is evicted on every beforeEach so it
// reloads and re-binds to the fresh mock.
// Named function references are kept for individual mock assertions that test
// which function was called and how many times.

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const createCronSchedule = vi.fn();
const listSchedules = vi.fn();
const toggleSchedule = vi.fn();
const getResourceUsage = vi.fn();
const getResourceUsageByProject = vi.fn();
const setResourceLimits = vi.fn();
const getResourceReport = vi.fn();

const mockDb = {
  createCronSchedule,
  listSchedules,
  toggleSchedule,
  getResourceUsage,
  setResourceLimits,
  getResourceReport,
  createCronScheduledTask: createCronSchedule,
  listScheduledTasks: listSchedules,
  toggleScheduledTask: toggleSchedule,
  getResourceUsageByProject,
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/advanced/scheduling')];
  installMock('../database', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/advanced/scheduling');
}

function resetMockDefaults() {
  createCronSchedule.mockReset();
  listSchedules.mockReset();
  toggleSchedule.mockReset();
  getResourceUsage.mockReset();
  getResourceUsageByProject.mockReset();
  setResourceLimits.mockReset();
  getResourceReport.mockReset();

  createCronSchedule.mockReturnValue({
    id: 'schedule-default',
    name: 'default schedule',
    enabled: true,
    next_run_at: '2026-01-02T03:04:05.000Z',
  });
  listSchedules.mockReturnValue([]);
  toggleSchedule.mockReturnValue(null);
  getResourceUsage.mockReturnValue([]);
  getResourceUsageByProject.mockReturnValue(null);
  setResourceLimits.mockImplementation((project, limits) => ({
    project,
    ...limits,
  }));
  getResourceReport.mockReturnValue([]);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('advanced/scheduling handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleCreateCronSchedule', () => {
    it('wraps invalid or missing create params when the database rejects them', () => {
      createCronSchedule.mockImplementation(() => {
        throw new Error('name, cron_expression, and task are required');
      });

      const result = handlers.handleCreateCronSchedule({
        name: '',
        cron_expression: 'bad cron',
      });

      expect(createCronSchedule).toHaveBeenCalledWith({
        name: '',
        cron_expression: 'bad cron',
        task_config: {
          task: undefined,
          working_directory: undefined,
          auto_approve: false,
          timeout_minutes: 30,
        },
        enabled: true,
        timezone: null,
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Failed to create scheduled task: name, cron_expression, and task are required');
    });

    it('creates a schedule and renders the configured task details', () => {
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Jan 2, 2026, 3:04 AM');
      createCronSchedule.mockReturnValue({
        id: 'schedule-1',
        name: 'daily sync',
        enabled: true,
        next_run_at: '2026-01-02T03:04:05.000Z',
      });

      const result = handlers.handleCreateCronSchedule({
        name: 'daily sync',
        cron_expression: '0 3 * * *',
        task: 'sync --daily',
        working_directory: '/repo',
        auto_approve: true,
        timeout_minutes: 45,
      });

      expect(createCronSchedule).toHaveBeenCalledWith({
        name: 'daily sync',
        cron_expression: '0 3 * * *',
        task_config: {
          task: 'sync --daily',
          working_directory: '/repo',
          auto_approve: true,
          timeout_minutes: 45,
        },
        enabled: true,
        timezone: null,
      });

      const text = getText(result);
      expect(text).toContain('## Scheduled Task Created');
      expect(text).toContain('**Name:** daily sync');
      expect(text).toContain('**ID:** schedule-1');
      expect(text).toContain('**Cron:** `0 3 * * *`');
      expect(text).toContain('**Status:** Enabled');
      expect(text).toContain('**Next Run:** Jan 2, 2026, 3:04 AM');
      expect(text).toContain('**Task:** sync --daily');
      expect(text).toContain('**Working Directory:** /repo');
    });

    it('renders disabled schedules with a not scheduled fallback', () => {
      createCronSchedule.mockReturnValue({
        id: 'schedule-2',
        name: 'nightly cleanup',
        enabled: false,
        next_run_at: null,
      });

      const result = handlers.handleCreateCronSchedule({
        name: 'nightly cleanup',
        cron_expression: '0 0 * * *',
        task: 'cleanup',
        enabled: false,
      });

      const text = getText(result);
      expect(text).toContain('**Status:** Disabled');
      expect(text).toContain('**Next Run:** Not scheduled');
      expect(text).not.toContain('**Working Directory:**');
    });
  });

  describe('handleListSchedules', () => {
    it('returns the empty-state message with default list options', () => {
      const result = handlers.handleListSchedules({});

      expect(listSchedules).toHaveBeenCalledWith({
        enabled_only: false,
        limit: 50,
      });
      expect(getText(result)).toContain('No scheduled tasks found.');
    });

    it('renders a schedule table and forwards enabled_only and limit', () => {
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Jan 3, 2026, 6:00 AM');
      listSchedules.mockReturnValue([
        {
          id: 'schedule-1',
          name: 'enabled schedule',
          cron_expression: '0 6 * * *',
          enabled: true,
          next_run_at: '2026-01-03T06:00:00.000Z',
          run_count: 4,
        },
        {
          id: 'schedule-2',
          name: 'disabled schedule',
          cron_expression: '0 8 * * *',
          enabled: false,
          next_run_at: null,
          run_count: 0,
        },
      ]);

      const result = handlers.handleListSchedules({
        enabled_only: true,
        limit: 5,
      });

      expect(listSchedules).toHaveBeenCalledWith({
        enabled_only: true,
        limit: 5,
      });

      const text = getText(result);
      expect(text).toContain('| ID | Name | Cron | Status | Next Run | Run Count |');
      expect(text).toContain('| schedule-1 | enabled schedule | `0 6 * * *` | ✅ Enabled | Jan 3, 2026, 6:00 AM | 4 |');
      expect(text).toContain('| schedule-2 | disabled schedule | `0 8 * * *` | ❌ Disabled | - | 0 |');
      expect(text).toContain('**Total:** 2 schedule(s)');
    });
  });

  describe('handleToggleSchedule', () => {
    it('returns RESOURCE_NOT_FOUND when the schedule does not exist', () => {
      const result = handlers.handleToggleSchedule({
        schedule_id: 'missing-schedule',
        enabled: true,
      });

      expect(toggleSchedule).toHaveBeenCalledWith('missing-schedule', true);
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('Schedule not found: missing-schedule');
    });

    it('renders a disable confirmation without a next run', () => {
      toggleSchedule.mockReturnValue({
        id: 'schedule-1',
        name: 'report job',
        enabled: false,
        next_run_at: '2026-01-04T00:00:00.000Z',
      });

      const result = handlers.handleToggleSchedule({
        schedule_id: 'schedule-1',
        enabled: false,
      });

      const text = getText(result);
      expect(toggleSchedule).toHaveBeenCalledWith('schedule-1', false);
      expect(text).toContain('## Schedule Disabled');
      expect(text).toContain('**report job** is now disabled.');
      expect(text).not.toContain('**Next Run:**');
    });

    it('renders an enable confirmation and includes the next run', () => {
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Jan 4, 2026, 7:30 PM');
      toggleSchedule.mockReturnValue({
        id: 'schedule-2',
        name: 'nightly report',
        enabled: true,
        next_run_at: '2026-01-04T19:30:00.000Z',
      });

      const result = handlers.handleToggleSchedule({
        schedule_id: 'schedule-2',
        enabled: true,
      });

      const text = getText(result);
      expect(toggleSchedule).toHaveBeenCalledWith('schedule-2', true);
      expect(text).toContain('## Schedule Enabled');
      expect(text).toContain('**nightly report** is now enabled.');
      expect(text).toContain('**Next Run:** Jan 4, 2026, 7:30 PM');
    });
  });

  describe('handleGetResourceUsage', () => {
    it('returns MISSING_REQUIRED_PARAM when neither task_id nor project is provided', () => {
      const result = handlers.handleGetResourceUsage({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('Please specify either task_id or project to get resource usage.');
      expect(getResourceUsage).not.toHaveBeenCalled();
      expect(getResourceUsageByProject).not.toHaveBeenCalled();
    });

    it('returns the project empty state when aggregate data is unavailable', () => {
      getResourceUsageByProject.mockReturnValue({ sample_count: 0 });

      const result = handlers.handleGetResourceUsage({
        project: 'alpha',
      });

      expect(getResourceUsageByProject).toHaveBeenCalledWith('alpha', {
        start_time: undefined,
        end_time: undefined,
      });
      expect(getText(result)).toContain('No resource usage data found for this project.');
    });

    it('renders project-level aggregate usage with formatting and N/A fallbacks', () => {
      getResourceUsageByProject.mockReturnValue({
        task_count: 3,
        sample_count: 8,
        avg_cpu: 12.345,
        max_cpu: 88,
        avg_memory: 512.123,
        max_memory: null,
        total_disk_io: 8.5,
      });

      const result = handlers.handleGetResourceUsage({
        project: 'alpha',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-31T23:59:59.000Z',
      });

      expect(getResourceUsageByProject).toHaveBeenCalledWith('alpha', {
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-31T23:59:59.000Z',
      });

      const text = getText(result);
      expect(text).toContain('## Resource Usage: alpha');
      expect(text).toContain('| Tasks | 3 |');
      expect(text).toContain('| Samples | 8 |');
      expect(text).toContain('| Avg CPU | 12.35% |');
      expect(text).toContain('| Max CPU | 88.00% |');
      expect(text).toContain('| Avg Memory | 512.12 MB |');
      expect(text).toContain('| Max Memory | N/A |');
      expect(text).toContain('| Total Disk I/O | 8.50 MB |');
    });

    it('returns the task empty state when no samples exist', () => {
      const result = handlers.handleGetResourceUsage({
        task_id: '1234567890abcdef',
      });

      expect(getResourceUsage).toHaveBeenCalledWith('1234567890abcdef', {
        limit: 100,
        start_time: undefined,
        end_time: undefined,
      });
      expect(getText(result)).toContain('## Resource Usage: Task 12345678...');
      expect(getText(result)).toContain('No resource usage data found for this task.');
    });

    it('renders task-level usage rows and truncates after twenty samples', () => {
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Jan 5, 2026, 8:00 AM');
      getResourceUsage.mockReturnValue(
        Array.from({ length: 21 }, (_, index) => ({
          timestamp: `2026-01-${String((index % 9) + 1).padStart(2, '0')}T08:00:00.000Z`,
          cpu_percent: index + 1,
          memory_mb: 256 + index,
          disk_io_mb: 5 + index,
        }))
      );

      const result = handlers.handleGetResourceUsage({
        task_id: 'abcdef1234567890',
        limit: 25,
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-31T23:59:59.000Z',
      });

      expect(getResourceUsage).toHaveBeenCalledWith('abcdef1234567890', {
        limit: 25,
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-31T23:59:59.000Z',
      });

      const text = getText(result);
      expect(text).toContain('## Resource Usage: Task abcdef12...');
      expect(text).toContain('| Timestamp | CPU % | Memory MB | Disk I/O MB |');
      expect(text).toContain('| Jan 5, 2026, 8:00 AM | 1 | 256 | 5 |');
      expect(text).toContain('*Showing 20 of 21 samples*');
    });
  });

  describe('handleSetResourceLimits', () => {
    it('passes explicit limits to the database and renders them', () => {
      setResourceLimits.mockReturnValue({
        max_cpu_percent: 80,
        max_memory_mb: 1024,
        max_concurrent: 4,
      });

      const result = handlers.handleSetResourceLimits({
        project: 'alpha',
        max_cpu_percent: 80,
        max_memory_mb: 1024,
        max_concurrent: 4,
      });

      expect(setResourceLimits).toHaveBeenCalledWith('alpha', {
        max_cpu_percent: 80,
        max_memory_mb: 1024,
        max_concurrent: 4,
      });

      const text = getText(result);
      expect(text).toContain('## Resource Limits: alpha');
      expect(text).toContain('| Max CPU | 80% |');
      expect(text).toContain('| Max Memory | 1024 MB |');
      expect(text).toContain('| Max Concurrent | 4 |');
    });

    it('renders Unlimited when returned limits are unset or zero', () => {
      setResourceLimits.mockReturnValue({
        max_cpu_percent: 0,
        max_memory_mb: null,
        max_concurrent: 0,
      });

      const result = handlers.handleSetResourceLimits({
        project: 'beta',
      });

      expect(setResourceLimits).toHaveBeenCalledWith('beta', {
        max_cpu_percent: undefined,
        max_memory_mb: undefined,
        max_concurrent: undefined,
      });
      expect(getText(result).match(/Unlimited/g)).toHaveLength(3);
    });
  });

  describe('handleResourceReport', () => {
    it('returns the empty-state message and defaults group_by to day', () => {
      const result = handlers.handleResourceReport({
        project: 'alpha',
      });

      expect(getResourceReport).toHaveBeenCalledWith({
        project: 'alpha',
        start_time: undefined,
        end_time: undefined,
        group_by: 'day',
      });
      expect(getText(result)).toContain('No resource usage data found for the specified criteria.');
    });

    it('renders a grouped resource report with project and period metadata', () => {
      getResourceReport.mockReturnValue([
        {
          period: '2026-W01',
          task_count: 2,
          sample_count: 10,
          avg_cpu: 32.5,
          max_cpu: 81.2,
          avg_memory: 640,
          max_memory: 1024,
        },
        {
          period: '2026-W02',
          task_count: 1,
          sample_count: 4,
          avg_cpu: 21.4,
          max_cpu: 44.1,
          avg_memory: 512,
          max_memory: 700,
        },
      ]);

      const result = handlers.handleResourceReport({
        project: 'alpha',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-31T23:59:59.000Z',
        group_by: 'week',
      });

      expect(getResourceReport).toHaveBeenCalledWith({
        project: 'alpha',
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-31T23:59:59.000Z',
        group_by: 'week',
      });

      const text = getText(result);
      expect(text).toContain('## Resource Report');
      expect(text).toContain('**Project:** alpha');
      expect(text).toContain('**Period:** 2026-01-01T00:00:00.000Z to 2026-01-31T23:59:59.000Z');
      expect(text).toContain('**Grouped by:** week');
      expect(text).toContain('| 2026-W01 | 2 | 10 | 32.5% | 81.2% | 640 MB | 1024 MB |');
      expect(text).toContain('| 2026-W02 | 1 | 4 | 21.4% | 44.1% | 512 MB | 700 MB |');
      expect(text).toContain('**Total Periods:** 2');
    });
  });
});
