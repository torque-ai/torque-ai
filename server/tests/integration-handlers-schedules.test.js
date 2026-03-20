const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Integration Handlers', () => {
  beforeAll(() => {
    setupTestDb('integration-handlers');
  });
  afterAll(() => { teardownTestDb(); });

  // ============================================
  // list_schedules (cron schedules)
  // ============================================
  describe('list_schedules', () => {
    it('returns cron schedules (empty initially)', async () => {
      const result = await safeTool('list_schedules', {});
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // create_cron_schedule
  // ============================================
  describe('create_cron_schedule', () => {
    it('creates a valid cron schedule', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'Nightly Cleanup',
        cron_expression: '0 0 * * *',
        task: 'Run nightly cleanup',
        working_directory: '/tmp'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('creates schedule with auto_approve and timeout', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'Hourly Check',
        cron_expression: '0 * * * *',
        task: 'Run hourly check',
        working_directory: '/tmp',
        auto_approve: true,
        timeout_minutes: 10
      });
      expect(result.isError).toBeFalsy();
    });

    it('creates schedule with every-5-minute expression', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'Frequent Check',
        cron_expression: '*/5 * * * *',
        task: 'Run frequent check',
        working_directory: '/tmp'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // toggle_schedule
  // ============================================
  describe('toggle_schedule', () => {
    it('returns error for nonexistent schedule', async () => {
      const result = await safeTool('toggle_schedule', { schedule_id: 'nonexistent', enabled: false });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // get_rate_limits
  // ============================================
  describe('get_rate_limits', () => {
    it('returns rate limit config', async () => {
      const result = await safeTool('get_rate_limits', {});
      expect(result.isError).toBeFalsy();
    });
  });

});
