const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer, db, taskCore, handleToolCall, schedulingAutomation;

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function createTask(overrides = {}) {
  const id = randomUUID();
  taskCore.createTask({
    id,
    task_description: overrides.task_description || 'resource usage test task',
    working_directory: overrides.working_directory || process.cwd(),
    status: overrides.status || 'completed',
    timeout_minutes: overrides.timeout_minutes || 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    project: overrides.project ?? null,
  });
  return taskCore.getTask(id);
}

function parseScheduleId(resultText) {
  const match = resultText.match(/\*\*ID:\*\* ([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

beforeAll(() => {
  templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  db = require('../database');
  taskCore = require('../db/task-core');
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  schedulingAutomation = require('../db/scheduling-automation');
  schedulingAutomation.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  handleToolCall = require('../tools').handleToolCall;
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
});

afterAll(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
});

describe('handler-adv-scheduling via handleToolCall', () => {
  describe('create_cron_schedule', () => {
    it('creates a cron schedule with default and optional fields', async () => {
      const result = await handleToolCall('create_cron_schedule', {
        name: 'daily-check',
        cron_expression: '0 7 * * *',
        task: 'Run a daily scan',
        working_directory: '/tmp',
        auto_approve: true,
        timeout_minutes: 20,
      });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Scheduled Task Created');
      expect(text).toContain('daily-check');
      expect(text).toContain('0 7 * * *');
      expect(text).toContain('Enabled');
      expect(text).toContain('Run a daily scan');
    });

    it('creates a disabled schedule when requested', async () => {
      const result = await handleToolCall('create_cron_schedule', {
        name: 'disabled-cron',
        cron_expression: '0 0 * * 1',
        task: 'Weekly run',
        enabled: false,
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Disabled');
    });

    it('returns an error for invalid cron', async () => {
      const result = await handleToolCall('create_cron_schedule', {
        name: 'bad-cron',
        cron_expression: 'nonsense',
        task: 'Broken schedule',
      });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Failed to create scheduled task');
    });
  });

  describe('list_schedules', () => {
    it('returns empty message when no schedules exist', async () => {
      const result = await handleToolCall('list_schedules', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No scheduled tasks found');
    });

    it('lists schedules after creation', async () => {
      await handleToolCall('create_cron_schedule', {
        name: 'listable-cron',
        cron_expression: '15 3 * * *',
        task: 'Nightly report',
      });

      const result = await handleToolCall('list_schedules', {});
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Scheduled Tasks');
      expect(text).toContain('listable-cron');
      expect(text).toContain('**Total:');
    });

    it('supports enabled_only filtering', async () => {
      await handleToolCall('create_cron_schedule', {
        name: 'disabled-in-filter',
        cron_expression: '30 2 * * *',
        task: 'Disabled job',
        enabled: false,
      });

      const result = await handleToolCall('list_schedules', { enabled_only: true });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('No scheduled tasks found');
      expect(text).toContain('(enabled only)');
    });

    it('respects limit parameter', async () => {
      await handleToolCall('create_cron_schedule', {
        name: 'first-limited',
        cron_expression: '0 8 * * *',
        task: 'First',
      });
      await handleToolCall('create_cron_schedule', {
        name: 'second-limited',
        cron_expression: '0 9 * * *',
        task: 'Second',
      });

      const result = await handleToolCall('list_schedules', { limit: 1 });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('**Total:');
      // The order may vary but only one row should be rendered.
      const rowCount = (text.match(/\n\| /g) || []).length;
      expect(rowCount).toBeLessThanOrEqual(2);
    });

  });

  describe('toggle_schedule', () => {
    it('disables an enabled schedule', async () => {
      const createResult = await handleToolCall('create_cron_schedule', {
        name: 'toggle-disable',
        cron_expression: '10 * * * *',
        task: 'Toggle me',
      });
      const createText = getText(createResult);
      const scheduleId = parseScheduleId(createText);

      expect(scheduleId).toBeTruthy();

      const result = await handleToolCall('toggle_schedule', {
        schedule_id: scheduleId,
        enabled: false,
      });

      // toggle_schedule now accepts string schedule_id (UUID)
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('disabled');
    });

    it('enables a disabled schedule', async () => {
      const createResult = await handleToolCall('create_cron_schedule', {
        name: 'toggle-enable',
        cron_expression: '20 * * * *',
        task: 'Enable again',
        enabled: false,
      });
      const createText = getText(createResult);
      const scheduleId = parseScheduleId(createText);

      expect(scheduleId).toBeTruthy();

      const result = await handleToolCall('toggle_schedule', {
        schedule_id: scheduleId,
        enabled: true,
      });

      // toggle_schedule now accepts string schedule_id (UUID)
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('enabled');
    });

    it('returns an error for missing schedule', async () => {
      const result = await handleToolCall('toggle_schedule', {
        schedule_id: 'non-existent-schedule-id',
        enabled: true,
      });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Schedule not found');
    });
  });

  describe('get_resource_usage', () => {
    it('returns an error when no selector is provided', async () => {
      const result = await handleToolCall('get_resource_usage', {});
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Please specify either task_id or project');
    });

    it('returns no data for a task with no usage samples', async () => {
      const task = createTask({ task_description: 'task-without-usage' });
      const result = await handleToolCall('get_resource_usage', { task_id: task.id });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data found for this task');
    });

    it('returns usage rows for a task with samples', async () => {
      const task = createTask({ task_description: 'task-with-usage', status: 'completed' });

      schedulingAutomation.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 45.5,
        memory_mb: 120,
        disk_io_mb: 2.5,
      });
      schedulingAutomation.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 50,
        memory_mb: 180,
        disk_io_mb: 4.3,
      });

      const result = await handleToolCall('get_resource_usage', { task_id: task.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Resource Usage: Task');
      expect(text).toContain('CPU %');
      expect(text).toContain('Memory MB');
      expect(text).toContain('Disk I/O MB');
      expect(text).toContain(task.id.substring(0, 8));
    });

    it('returns project-level aggregate usage', async () => {
      const project = 'adv-scheduling-project';
      const task = createTask({
        task_description: 'projected-task',
        project,
      });

      schedulingAutomation.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 40,
        memory_mb: 256,
        disk_io_mb: 8,
      });

      const result = await handleToolCall('get_resource_usage', { project });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain(`Resource Usage: ${project}`);
      expect(text).toContain('Avg CPU');
      expect(text).toContain('Max CPU');
      expect(text).toContain('Avg Memory');
      expect(text).toContain('Total Disk I/O');
    });

    it('returns no data for unknown project', async () => {
      const result = await handleToolCall('get_resource_usage', { project: 'missing-project' });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data found for this project');
    });
  });

  describe('set_resource_limits', () => {
    it('persists explicit resource limits', async () => {
      const result = await handleToolCall('set_resource_limits', {
        project: 'limits-project',
        max_cpu_percent: 85,
        max_memory_mb: 2048,
        max_concurrent: 10,
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Resource Limits: limits-project');
      expect(text).toContain('85%');
      expect(text).toContain('2048 MB');
      expect(text).toContain('10');
    });

    it('shows unlimited when limits are omitted', async () => {
      const result = await handleToolCall('set_resource_limits', {
        project: 'unlimited-project',
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Resource Limits: unlimited-project');
      expect(text).toMatch(/Unlimited/g);
    });
  });

  describe('resource_report', () => {
    it('returns empty report when no data exists', async () => {
      const result = await handleToolCall('resource_report', {
        project: 'empty-report',
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data found for the specified criteria');
    });

    it('returns grouped report for a project', async () => {
      const project = 'report-project';
      const task = createTask({
        task_description: 'report-task',
        project,
      });

      schedulingAutomation.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 55.2,
        memory_mb: 512,
        disk_io_mb: 12,
        timestamp: '2026-01-15T10:00:00.000Z',
      });
      schedulingAutomation.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 60.8,
        memory_mb: 488,
        disk_io_mb: 14,
        timestamp: '2026-01-15T18:00:00.000Z',
      });

      const result = await handleToolCall('resource_report', {
        project,
        group_by: 'day',
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Resource Report');
      expect(text).toContain('**Project:**');
      expect(text).toContain(project);
      expect(text).toContain('**Grouped by:** day');
      expect(text).toContain('2026-01-15');
      expect(text).toContain('**Total Periods:** 1');
    });

    it('respects time-range filtering returning no data outside window', async () => {
      const project = 'windowed-report';
      const task = createTask({
        task_description: 'window task',
        project,
      });

      schedulingAutomation.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 30,
        memory_mb: 100,
        disk_io_mb: 1,
        timestamp: '2024-01-15T10:00:00.000Z',
      });

      const result = await handleToolCall('resource_report', {
        project,
        start_time: '2025-01-01T00:00:00.000Z',
        end_time: '2025-12-31T23:59:59.000Z',
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data found for the specified criteria');
    });
  });
});
