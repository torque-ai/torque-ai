const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const crypto = require('crypto');

let db;

describe('Adv Scheduling Handlers', () => {
  beforeAll(() => {
    const setup = setupTestDb('adv-scheduling');
    db = setup.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: create a task directly in the DB (needed for resource_usage FK)
  function createTaskDirect(overrides = {}) {
    const id = overrides.id || crypto.randomUUID();
    db.createTask({
      id,
      task_description: overrides.description || 'resource test task',
      working_directory: overrides.working_directory || process.env.TORQUE_DATA_DIR,
      status: overrides.status || 'completed',
      priority: 0,
      project: overrides.project || null
    });
    return db.getTask(id);
  }

  // ── create_cron_schedule ──────────────────────────────────

  describe('create_cron_schedule', () => {
    it('creates a cron schedule with all fields', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'hourly-check',
        cron_expression: '0 * * * *',
        task: 'Run hourly check',
        working_directory: '/tmp/test',
        auto_approve: true,
        timeout_minutes: 15
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Scheduled Task Created');
      expect(text).toContain('hourly-check');
      expect(text).toContain('0 * * * *');
      expect(text).toContain('Enabled');
      expect(text).toContain('/tmp/test');
    });

    it('creates a disabled schedule when enabled=false', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'disabled-schedule',
        cron_expression: '30 2 * * *',
        task: 'Nightly maintenance',
        enabled: false
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Disabled');
    });

    it('returns error for invalid cron expression', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'bad-cron',
        cron_expression: 'not-a-cron',
        task: 'Will fail'
      });
      // The handler wraps db errors — should be an error response
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Failed to create');
    });
  });

  // ── list_schedules ────────────────────────────────────────

  describe('list_schedules', () => {
    it('lists existing schedules', async () => {
      // Create a schedule first
      await safeTool('create_cron_schedule', {
        name: 'list-test-schedule',
        cron_expression: '0 6 * * *',
        task: 'Morning task'
      });

      const result = await safeTool('list_schedules', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Scheduled Tasks');
      expect(text).toContain('list-test-schedule');
      expect(text).toContain('Total:');
    });

    it('returns empty message when no enabled schedules match filter', async () => {
      // Disable all created schedules, then query enabled_only
      const listResult = await safeTool('list_schedules', {});
      const listText = getText(listResult);
      // Extract IDs from the table (they appear at the start of rows)
      const idMatches = listText.match(/\| ([a-f0-9-]+) \|/g);
      if (idMatches) {
        for (const match of idMatches) {
          const id = match.replace(/\| /g, '').replace(/ \|/g, '');
          await safeTool('toggle_schedule', { schedule_id: id, enabled: false });
        }
      }

      const result = await safeTool('list_schedules', { enabled_only: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No scheduled tasks found');
      expect(text).toContain('enabled only');
    });

    it('respects limit parameter', async () => {
      const result = await safeTool('list_schedules', { limit: 1 });
      expect(result.isError).toBeFalsy();
    });
  });

  // ── toggle_schedule ───────────────────────────────────────

  describe('toggle_schedule', () => {
    it('disables an enabled schedule', async () => {
      const createResult = await safeTool('create_cron_schedule', {
        name: 'toggle-test',
        cron_expression: '0 12 * * *',
        task: 'Noon task',
        enabled: true
      });
      const createText = getText(createResult);
      const idMatch = createText.match(/\*\*ID:\*\* ([a-f0-9-]+)/);
      expect(idMatch).toBeTruthy();
      const scheduleId = idMatch[1];

      const result = await safeTool('toggle_schedule', {
        schedule_id: scheduleId,
        enabled: false
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('disabled');
    });

    it('enables a disabled schedule', async () => {
      const createResult = await safeTool('create_cron_schedule', {
        name: 'toggle-enable-test',
        cron_expression: '0 18 * * *',
        task: 'Evening task',
        enabled: false
      });
      const createText = getText(createResult);
      const idMatch = createText.match(/\*\*ID:\*\* ([a-f0-9-]+)/);
      const scheduleId = idMatch[1];

      const result = await safeTool('toggle_schedule', {
        schedule_id: scheduleId,
        enabled: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Enabled');
    });

    it('returns error for non-existent schedule', async () => {
      const result = await safeTool('toggle_schedule', {
        schedule_id: 'non-existent-id-12345',
        enabled: true
      });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('not found');
    });
  });

  // ── get_resource_usage ────────────────────────────────────

  describe('get_resource_usage', () => {
    it('returns error when neither task_id nor project provided', async () => {
      const result = await safeTool('get_resource_usage', {});
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('specify either task_id or project');
    });

    it('returns empty for task with no usage data', async () => {
      const task = createTaskDirect({ description: 'no-usage-task' });
      const result = await safeTool('get_resource_usage', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data');
    });

    it('returns usage data for a task with recorded metrics', async () => {
      const task = createTaskDirect({ description: 'usage-task' });
      // Insert resource usage directly
      db.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 45.5,
        memory_mb: 128,
        disk_io_mb: 2.5
      });
      db.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 80.2,
        memory_mb: 256,
        disk_io_mb: 5.0
      });

      const result = await safeTool('get_resource_usage', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Resource Usage');
      expect(text).toContain('CPU');
      expect(text).toContain('Memory');
    });

    it('returns project-level aggregated usage', async () => {
      const projectName = 'resource-test-project';
      const task = createTaskDirect({ description: 'proj-usage', project: projectName });
      db.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 60,
        memory_mb: 512,
        disk_io_mb: 10
      });

      const result = await safeTool('get_resource_usage', { project: projectName });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain(projectName);
      expect(text).toContain('Avg CPU');
    });

    it('returns no-data message for project with no usage', async () => {
      const result = await safeTool('get_resource_usage', { project: 'nonexistent-project' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data');
    });
  });

  // ── set_resource_limits ───────────────────────────────────

  describe('set_resource_limits', () => {
    it('sets resource limits for a project', async () => {
      const result = await safeTool('set_resource_limits', {
        project: 'limits-project',
        max_cpu_percent: 80,
        max_memory_mb: 1024,
        max_concurrent: 4
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Resource Limits');
      expect(text).toContain('limits-project');
      expect(text).toContain('80%');
      expect(text).toContain('1024 MB');
      expect(text).toContain('4');
    });

    it('shows Unlimited for unset limits', async () => {
      const result = await safeTool('set_resource_limits', {
        project: 'partial-limits'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Unlimited');
    });
  });

  // ── resource_report ───────────────────────────────────────

  describe('resource_report', () => {
    it('returns empty report when no data exists', async () => {
      const result = await safeTool('resource_report', {
        project: 'empty-report-project'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data');
    });

    it('returns report grouped by day', async () => {
      const projectName = 'report-project';
      const task = createTaskDirect({ description: 'report-task', project: projectName });
      db.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 50,
        memory_mb: 256,
        disk_io_mb: 3,
        timestamp: '2026-01-15T10:00:00.000Z'
      });
      db.recordResourceUsage({
        task_id: task.id,
        cpu_percent: 70,
        memory_mb: 384,
        disk_io_mb: 5,
        timestamp: '2026-01-15T14:00:00.000Z'
      });

      const result = await safeTool('resource_report', {
        project: projectName,
        group_by: 'day'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Resource Report');
      expect(text).toContain(projectName);
      expect(text).toContain('Grouped by');
      expect(text).toContain('2026-01-15');
    });

    it('returns report without project filter', async () => {
      // There should be usage data from previous tests
      const result = await safeTool('resource_report', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should either have data or show no-data message
      expect(text).toContain('Resource Report');
    });

    it('respects time range filtering', async () => {
      const result = await safeTool('resource_report', {
        start_time: '2099-01-01T00:00:00.000Z',
        end_time: '2099-12-31T23:59:59.000Z'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage data');
    });
  });
});
