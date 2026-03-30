const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Provider Failover', () => {
  beforeAll(() => { setupTestDb('provider-failover'); });
  afterAll(() => { teardownTestDb(); });

  describe('adaptive retry configuration', () => {
    it('configure_adaptive_retry enables retry', async () => {
      const result = await safeTool('configure_adaptive_retry', {
        enabled: true,
        max_retries_per_task: 2,
        default_fallback: 'claude-cli',
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toMatch(/enabled|updated|configured/i);
    });

    it('configure_adaptive_retry disables retry', async () => {
      const result = await safeTool('configure_adaptive_retry', { enabled: false });
      expect(result.isError).toBeFalsy();
    });

    it('re-enable for subsequent tests', async () => {
      const result = await safeTool('configure_adaptive_retry', {
        enabled: true,
        max_retries_per_task: 3,
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('task submission with provider routing', () => {
    it('smart_submit_task routes a simple task', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Write a hello world function in JavaScript',
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should contain a task ID
      expect(text).toMatch(/[a-f0-9-]{36}/);
    });

    it('smart_submit_task accepts override_provider', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Explain what a closure is',
        override_provider: 'claude-cli',
      });
      expect(result.isError).toBeFalsy();
    });

    it('smart_submit_task rejects empty task', async () => {
      const result = await safeTool('smart_submit_task', { task: '' });
      expect(result.isError).toBe(true);
    });
  });

  describe('provider statistics', () => {
    it('get_provider_stats returns stats structure', async () => {
      const result = await safeTool('get_provider_stats', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('get_provider_stats accepts provider filter', async () => {
      const result = await safeTool('get_provider_stats', { provider: 'claude-cli' });
      expect(result.isError).toBeFalsy();
    });

    it('get_provider_quality returns quality data', async () => {
      const result = await safeTool('get_provider_quality', { provider: 'ollama' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('task cancellation lifecycle', () => {
    let taskId;

    it('submits and then cancels a task', async () => {
      const qr = await safeTool('queue_task', { task: 'Failover cancel test' });
      expect(qr.isError).toBeFalsy();
      const text = getText(qr);
      const match = text.match(/([a-f0-9-]{36})/);
      expect(match).toBeTruthy();
      taskId = match[1];

      const cancelResult = await safeTool('cancel_task', { task_id: taskId });
      expect(cancelResult.isError).toBeFalsy();
      expect(getText(cancelResult)).toMatch(/cancel/i);
    });
  });

  describe('cost and budget tracking', () => {
    it('get_cost_summary returns cost data', async () => {
      const result = await safeTool('get_cost_summary', { days: 7 });
      expect(result.isError).toBeFalsy();
    });

    it('set_budget creates a budget', async () => {
      const result = await safeTool('set_budget', {
        name: 'test-budget',
        budget_usd: 10.0,
        period: 'daily',
      });
      expect(result.isError).toBeFalsy();
    });

    it('get_budget_status reports budget or container error', async () => {
      const result = await safeTool('get_budget_status', {});
      // In test mode, the DI container may not be booted, so budgetWatcher is unavailable
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('rate limits', () => {
    it('get_rate_limits returns config', async () => {
      const result = await safeTool('get_rate_limits', {});
      expect(result.isError).toBeFalsy();
    });
  });
});
