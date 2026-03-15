const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Integration Handlers', () => {
  beforeAll(() => {
    setupTestDb('integration-handlers');
  });
  afterAll(() => { teardownTestDb(); });

  // ============================================
  // get_cost_summary
  // ============================================
  describe('get_cost_summary', () => {
    it('returns cost data for day period', async () => {
      const result = await safeTool('get_cost_summary', { period: 'day' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('returns cost data for week period', async () => {
      const result = await safeTool('get_cost_summary', { period: 'week' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('returns cost data for month period', async () => {
      const result = await safeTool('get_cost_summary', { period: 'month' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('returns cost data with no period (default)', async () => {
      const result = await safeTool('get_cost_summary', {});
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // get_budget_status
  // ============================================
  describe('get_budget_status', () => {
    it('returns budget info', async () => {
      const result = await safeTool('get_budget_status', {});
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // get_audit_trail
  // ============================================
  describe('get_audit_trail', () => {
    it('returns audit data with task_id', async () => {
      const result = await safeTool('get_audit_trail', { task_id: 'fake-task-id' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('returns audit data with no filters', async () => {
      const result = await safeTool('get_audit_trail', {});
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // export_report_json
  // ============================================
  describe('export_report_json', () => {
    it('exports report with no filters', async () => {
      const result = await safeTool('export_report_json', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('JSON Export');
    });

    it('exports report with status filter', async () => {
      const result = await safeTool('export_report_json', { status: 'completed' });
      expect(result.isError).toBeFalsy();
    });

    it('exports report with project filter', async () => {
      const result = await safeTool('export_report_json', { project: 'test-project' });
      expect(result.isError).toBeFalsy();
    });

    it('exports report with limit', async () => {
      const result = await safeTool('export_report_json', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });

    it('shows row count in output', async () => {
      const result = await safeTool('export_report_json', {});
      const text = getText(result);
      expect(text).toContain('Rows');
      expect(text).toContain('Size');
    });

    it('shows export ID', async () => {
      const result = await safeTool('export_report_json', {});
      const text = getText(result);
      expect(text).toContain('Export ID');
    });

    it('exports report with date range filters', async () => {
      const result = await safeTool('export_report_json', {
        from_date: '2026-01-01',
        to_date: '2026-02-17'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // export_report_csv
  // ============================================
  describe('export_report_csv', () => {
    it('exports CSV with no filters', async () => {
      const result = await safeTool('export_report_csv', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('CSV Export');
    });

    it('exports CSV with status filter', async () => {
      const result = await safeTool('export_report_csv', { status: 'failed' });
      expect(result.isError).toBeFalsy();
    });

    it('exports CSV with project filter', async () => {
      const result = await safeTool('export_report_csv', { project: 'test-proj' });
      expect(result.isError).toBeFalsy();
    });

    it('exports CSV with limit', async () => {
      const result = await safeTool('export_report_csv', { limit: 3 });
      expect(result.isError).toBeFalsy();
    });

    it('shows row count and size in output', async () => {
      const result = await safeTool('export_report_csv', {});
      const text = getText(result);
      expect(text).toContain('Rows');
      expect(text).toContain('bytes');
    });

    it('exports CSV with date range', async () => {
      const result = await safeTool('export_report_csv', {
        from_date: '2026-01-01',
        to_date: '2026-12-31'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // list_report_exports
  // ============================================
  describe('list_report_exports', () => {
    it('returns exports list', async () => {
      const result = await safeTool('list_report_exports', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Report Exports');
    });

    it('accepts limit parameter', async () => {
      const result = await safeTool('list_report_exports', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });

    it('returns exports after creating some', async () => {
      // Create an export via export_report_json
      await safeTool('export_report_json', {});
      const result = await safeTool('list_report_exports', {});
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // success_rates
  // ============================================
  describe('success_rates', () => {
    it('returns rates grouped by project', async () => {
      const result = await safeTool('success_rates', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('accepts group_by parameter', async () => {
      const result = await safeTool('success_rates', { group_by: 'provider' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts group_by template', async () => {
      const result = await safeTool('success_rates', { group_by: 'template' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts from_date and to_date', async () => {
      const result = await safeTool('success_rates', {
        from_date: '2026-01-01',
        to_date: '2026-02-17'
      });
      expect(result.isError).toBeFalsy();
    });
  });

});
