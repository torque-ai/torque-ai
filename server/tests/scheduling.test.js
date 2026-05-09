/**
 * Scheduling Tests
 */

const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');
const { uniqueId } = require('./test-helpers');

describe('Scheduling', () => {
  beforeAll(() => { setupTestDb('scheduling'); });
  afterAll(() => { teardownTestDb(); });

  describe('Cron Scheduling', () => {
    it('create_cron_schedule creates schedule', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: uniqueId('cron'),
        task: 'Test cron task',
        cron_expression: '0 * * * *'
      });
      expect(result.isError).toBeFalsy();
    });

    it.each([
      '*/15 * * * *',
      '0 0 * * *',
      '0 9 * * 1-5',
    ])('accepts valid cron expression: %s', async (cron) => {
      const result = await safeTool('create_cron_schedule', {
        name: uniqueId('cron'),
        task: `Task for ${cron}`,
        cron_expression: cron
      });
      expect(result.isError).toBeFalsy();
    });

    it.each([
      'not a cron',
      '60 * * * *',
      '* 25 * * *',
    ])('rejects invalid cron expression: %s', async (cron) => {
      const result = await safeTool('create_cron_schedule', {
        name: uniqueId('bad'),
        task: 'Bad cron',
        cron_expression: cron
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('Schedule Management', () => {
    it('list_schedules returns schedules', async () => {
      const result = await safeTool('list_schedules', {});
      expect(result.isError).toBeFalsy();
    });
  });
});
