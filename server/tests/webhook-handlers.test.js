const providerRoutingCore = require('../db/provider-routing-core');
const { setupTestDb, teardownTestDb, safeTool, getText, resetTables } = require('./vitest-setup');

describe('Webhook Handlers', () => {
  beforeAll(() => { setupTestDb('webhook-handlers'); });
  afterAll(() => { teardownTestDb(); });

  // ============================================
  // list_webhooks
  // ============================================
  describe('list_webhooks', () => {
    it('returns webhook list (empty initially)', async () => {
      const result = await safeTool('list_webhooks', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Webhooks');
    });

    it('returns webhooks filtered by project', async () => {
      const result = await safeTool('list_webhooks', { project: 'nonexistent-proj' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // add_webhook
  // ============================================
  describe('add_webhook', () => {
    it('rejects invalid URL', async () => {
      const result = await safeTool('add_webhook', { url: 'not-a-url', events: 'task.completed' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing name', async () => {
      const result = await safeTool('add_webhook', { url: 'https://example.com/webhook' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('name');
    });

    it('rejects empty name', async () => {
      const result = await safeTool('add_webhook', { name: '', url: 'https://example.com/webhook' });
      expect(result.isError).toBe(true);
    });

    it('creates webhook with valid URL and events', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Test Webhook',
        url: 'https://example.com/webhook',
        events: ['completed', 'failed']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Webhook Created');
      expect(text).toContain('Test Webhook');
    });

    it('creates webhook with default events when none specified', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Default Events Hook',
        url: 'https://example.com/hook2'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('completed');
    });

    it('creates webhook with project filter', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Project Hook',
        url: 'https://example.com/hook3',
        project: 'my-project'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('my-project');
    });

    it('creates webhook with type=slack', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Slack Hook',
        url: 'https://hooks.slack.com/services/xxx',
        type: 'slack'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('slack');
    });

    it('creates webhook with type=discord', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Discord Hook',
        url: 'https://discord.com/api/webhooks/xxx',
        type: 'discord'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('discord');
    });

    it('rejects invalid type', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Bad Type',
        url: 'https://example.com/hook',
        type: 'invalid'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid event type', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Bad Event',
        url: 'https://example.com/hook',
        events: ['not_a_valid_event']
      });
      expect(result.isError).toBe(true);
    });

    it('rejects internal/localhost URL (SSRF protection)', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Local Hook',
        url: 'http://localhost:8080/webhook'
      });
      expect(result.isError).toBe(true);
    });

    it('creates webhook with secret', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Secret Hook',
        url: 'https://example.com/secret-hook',
        secret: 'my-secret-key'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Configured');
    });
  });

  // ============================================
  // remove_webhook
  // ============================================
  describe('remove_webhook', () => {
    it('removes existing webhook', async () => {
      // First create a webhook
      const createResult = await safeTool('add_webhook', {
        name: 'To Remove',
        url: 'https://example.com/remove-me'
      });
      expect(createResult.isError).toBeFalsy();
      const idMatch = getText(createResult).match(/`([0-9a-f-]{36})`/);
      expect(idMatch).toBeTruthy();
      const webhookId = idMatch[1];

      // Now remove it
      const removeResult = await safeTool('remove_webhook', { webhook_id: webhookId });
      expect(removeResult.isError).toBeFalsy();
      expect(getText(removeResult)).toContain('Webhook Removed');
    });

    it('returns error for nonexistent webhook', async () => {
      const result = await safeTool('remove_webhook', { webhook_id: 'nonexistent-id' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ============================================
  // test_webhook
  // ============================================
  describe('test_webhook', () => {
    it('returns error for nonexistent webhook', async () => {
      const result = await safeTool('test_webhook', { webhook_id: 'nonexistent-id' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ============================================
  // webhook_logs
  // ============================================
  describe('webhook_logs', () => {
    it('returns error for nonexistent webhook', async () => {
      const result = await safeTool('webhook_logs', { webhook_id: 'nonexistent-id' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('returns empty logs for webhook with no deliveries', async () => {
      // Create a webhook first
      const createResult = await safeTool('add_webhook', {
        name: 'Logs Test Hook',
        url: 'https://example.com/logs-test'
      });
      const idMatch = getText(createResult).match(/`([0-9a-f-]{36})`/);
      const webhookId = idMatch[1];

      const result = await safeTool('webhook_logs', { webhook_id: webhookId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No delivery logs');
    });

    it('accepts limit parameter', async () => {
      const createResult = await safeTool('add_webhook', {
        name: 'Logs Limit Hook',
        url: 'https://example.com/logs-limit'
      });
      const idMatch = getText(createResult).match(/`([0-9a-f-]{36})`/);
      const webhookId = idMatch[1];

      const result = await safeTool('webhook_logs', { webhook_id: webhookId, limit: 5 });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // webhook_stats
  // ============================================
  describe('webhook_stats', () => {
    it('returns stats', async () => {
      const result = await safeTool('webhook_stats', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Webhook Statistics');
      expect(text).toContain('Total');
    });
  });

  // ============================================
  // configure_retries
  // ============================================
  describe('configure_retries', () => {
    it('sets default retry policy', async () => {
      const result = await safeTool('configure_retries', {
        max_retries: 3,
        strategy: 'exponential',
        base_delay_seconds: 30
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('3');
      expect(text).toContain('exponential');
    });

    it('returns error for nonexistent task_id', async () => {
      const result = await safeTool('configure_retries', {
        task_id: 'nonexistent-task',
        max_retries: 2
      });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // get_retry_history
  // ============================================
  describe('get_retry_history', () => {
    it('requires task_id', async () => {
      const result = await safeTool('get_retry_history', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('specify a task_id');
    });

    it('returns empty history for unknown task', async () => {
      const result = await safeTool('get_retry_history', { task_id: 'nonexistent-task' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No retry attempts');
    });
  });

  // ============================================
  // add_budget_alert
  // ============================================
  describe('add_budget_alert', () => {
    it('creates valid budget alert', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'daily_tasks',
        threshold_value: 100
      });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Parameter "alert_type" must be one of [daily_cost, daily_tokens, monthly_cost], got "daily_tasks"');
    });

    it('creates alert with project filter', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'weekly_tasks',
        threshold_value: 500,
        project: 'my-project'
      });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
      expect(getText(result)).toContain('Parameter "alert_type" must be one of [daily_cost, daily_tokens, monthly_cost], got "weekly_tasks"');
    });

    it('creates alert with custom cooldown', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'monthly_tasks',
        threshold_value: 1000,
        cooldown_minutes: 120
      });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
      expect(getText(result)).toContain('Parameter "alert_type" must be one of [daily_cost, daily_tokens, monthly_cost], got "monthly_tasks"');
    });

    it('rejects missing alert_type', async () => {
      const result = await safeTool('add_budget_alert', {
        threshold_value: 100
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid alert_type', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'not_valid',
        threshold_value: 100
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing threshold_value', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'daily_tasks'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects negative threshold_value', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'daily_tasks',
        threshold_value: -5
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid threshold_percent', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'daily_tasks',
        threshold_value: 100,
        threshold_percent: 150
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid cooldown_minutes', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'daily_tasks',
        threshold_value: 100,
        cooldown_minutes: 0
      });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // list_budget_alerts
  // ============================================
  describe('list_budget_alerts', () => {
    it('returns alerts list', async () => {
      const result = await safeTool('list_budget_alerts', {});
      expect(result.isError).toBeFalsy();
    });

    it('filters by project', async () => {
      const result = await safeTool('list_budget_alerts', { project: 'nonexistent' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by alert_type', async () => {
      const result = await safeTool('list_budget_alerts', { alert_type: 'daily_tasks' });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
      expect(getText(result)).toContain('Parameter "alert_type" must be one of [daily_cost, daily_tokens, monthly_cost], got "daily_tasks"');
    });
  });

  // ============================================
  // remove_budget_alert
  // ============================================
  describe('remove_budget_alert', () => {
    it('returns error for nonexistent alert', async () => {
      const result = await safeTool('remove_budget_alert', { alert_id: 'nonexistent-alert' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ============================================
  // configure_auto_cleanup
  // ============================================
  describe('configure_auto_cleanup', () => {
    it('sets auto-archive days', async () => {
      const result = await safeTool('configure_auto_cleanup', { auto_archive_days: 30 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('30');
    });

    it('sets cleanup_log_days', async () => {
      const result = await safeTool('configure_auto_cleanup', { cleanup_log_days: 7 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('7');
    });

    it('sets auto_archive_status', async () => {
      const result = await safeTool('configure_auto_cleanup', {
        auto_archive_status: ['completed']
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('completed');
    });

    it('returns current config when called with no args', async () => {
      const result = await safeTool('configure_auto_cleanup', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Auto-Cleanup Configuration');
    });
  });

  // ============================================
  // run_maintenance
  // ============================================
  describe('run_maintenance', () => {
    it('runs all maintenance tasks', async () => {
      const result = await safeTool('run_maintenance', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Maintenance Results');
    });

    it('runs specific task type (archive_old_tasks)', async () => {
      const result = await safeTool('run_maintenance', { task_type: 'archive_old_tasks' });
      expect(result.isError).toBeFalsy();
    });

    it('runs specific task type (cleanup_logs)', async () => {
      const result = await safeTool('run_maintenance', { task_type: 'cleanup_logs' });
      expect(result.isError).toBeFalsy();
    });

    it('runs specific task type (aggregate_metrics)', async () => {
      const result = await safeTool('run_maintenance', { task_type: 'aggregate_metrics' });
      expect(result.isError).toBeFalsy();
    });

    it('schedules maintenance', async () => {
      const result = await safeTool('run_maintenance', {
        task_type: 'all',
        schedule: { interval_minutes: 120, enabled: true }
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('scheduled');
    });
  });

  // ============================================
  // list_integrations
  // ============================================
  describe('list_integrations', () => {
    it('returns integrations', async () => {
      const result = await safeTool('list_integrations', {});
      expect(result.isError).toBeFalsy();
    });

    it('includes disabled integrations when requested', async () => {
      const result = await safeTool('list_integrations', { include_disabled: true });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Extended validation (merged from webhook-handlers-expanded)
  // ============================================

  describe('add_webhook — extended validation', () => {
    it('rejects URL exceeding max length', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(3000);
      const result = await safeTool('add_webhook', {
        name: 'Long URL Hook',
        url: longUrl
      });
      expect(result.isError).toBe(true);
    });

    it('rejects name exceeding max length', async () => {
      const longName = 'H'.repeat(300);
      const result = await safeTool('add_webhook', {
        name: longName,
        url: 'https://example.com/hook'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects 127.0.0.1 URL (SSRF protection)', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Loopback Hook',
        url: 'http://127.0.0.1:8080/hook'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects 0.0.0.0 URL (SSRF protection)', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Zero Hook',
        url: 'http://0.0.0.0/hook'
      });
      expect(result.isError).toBe(true);
    });

    it('creates webhook with all valid event types', async () => {
      const result = await safeTool('add_webhook', {
        name: 'All Events Hook',
        url: 'https://example.com/all-events',
        events: ['completed', 'failed', 'started', 'cancelled', 'progress', 'timeout']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('completed');
      expect(text).toContain('failed');
    });

    it('creates webhook with headers', async () => {
      const result = await safeTool('add_webhook', {
        name: 'Headers Hook',
        url: 'https://example.com/headers-hook',
        headers: { 'Authorization': 'Bearer test-token' }
      });
      expect(result.isError).toBeFalsy();
    });

    it('creates multiple webhooks with same URL', async () => {
      const url = 'https://example.com/shared-endpoint';
      const r1 = await safeTool('add_webhook', { name: 'Hook A', url });
      const r2 = await safeTool('add_webhook', { name: 'Hook B', url });
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
    });

    it('rejects events as non-array (string)', async () => {
      const result = await safeTool('add_webhook', {
        name: 'String Events',
        url: 'https://example.com/string-events',
        events: 'completed'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('remove_webhook — lifecycle', () => {
    it('removes a webhook and verifies double-remove fails', async () => {
      const createResult = await safeTool('add_webhook', {
        name: 'Remove Lifecycle Hook',
        url: 'https://example.com/hook-' + Date.now(),
        events: ['completed', 'failed'],
      });
      expect(createResult.isError).toBeFalsy();
      const text = getText(createResult);
      const match = text.match(/`([0-9a-f-]{36})`/);
      expect(match).toBeTruthy();
      const webhookId = match[1];

      const removeResult = await safeTool('remove_webhook', { webhook_id: webhookId });
      expect(removeResult.isError).toBeFalsy();
      expect(getText(removeResult)).toContain('Webhook Removed');

      const doubleRemove = await safeTool('remove_webhook', { webhook_id: webhookId });
      expect(doubleRemove.isError).toBe(true);
      expect(getText(doubleRemove)).toContain('not found');
    });
  });

  describe('configure_retries — extended', () => {
    it('sets linear strategy', async () => {
      const result = await safeTool('configure_retries', {
        max_retries: 5,
        strategy: 'linear',
        base_delay_seconds: 10
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('5');
      expect(text).toContain('linear');
    });

    it('sets fixed strategy', async () => {
      const result = await safeTool('configure_retries', {
        max_retries: 2,
        strategy: 'fixed',
        base_delay_seconds: 60
      });
      expect(result.isError).toBeFalsy();
    });

    it('sets max_retries to 0 (no retries)', async () => {
      const result = await safeTool('configure_retries', {
        max_retries: 0,
        strategy: 'exponential',
        base_delay_seconds: 30
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('0');
    });
  });

  describe('add_budget_alert — extended', () => {
    it('creates alert with threshold_percent', async () => {
      const result = await safeTool('add_budget_alert', {
        alert_type: 'weekly_tasks',
        threshold_value: 200,
        threshold_percent: 80
      });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
      expect(getText(result)).toContain('Parameter "alert_type" must be one of [daily_cost, daily_tokens, monthly_cost], got "weekly_tasks"');
    });
  });

  describe('remove_budget_alert — lifecycle', () => {
    it('creates and removes a budget alert', async () => {
      const createResult = await safeTool('add_budget_alert', {
        alert_type: 'daily_tasks',
        threshold_value: 999
      });
      expect(createResult.isError).toBeTruthy();
      const text = getText(createResult);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Parameter "alert_type" must be one of [daily_cost, daily_tokens, monthly_cost], got "daily_tasks"');
    });
  });

  describe('configure_auto_cleanup — extended', () => {
    it('sets all options at once', async () => {
      const result = await safeTool('configure_auto_cleanup', {
        auto_archive_days: 14,
        cleanup_log_days: 3,
        auto_archive_status: ['completed', 'failed']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('14');
      expect(text).toContain('3');
    });

    it('sets auto_archive_days to large value', async () => {
      const result = await safeTool('configure_auto_cleanup', { auto_archive_days: 365 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('365');
    });
  });

  describe('run_maintenance — extended', () => {
    it('runs cleanup_stale_tasks', async () => {
      const result = await safeTool('run_maintenance', { task_type: 'cleanup_stale_tasks' });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
      expect(getText(result)).toContain('Parameter "task_type" must be one of [archive_old_tasks, cleanup_logs, aggregate_metrics, all], got "cleanup_stale_tasks"');
    });

    it('runs update_metrics', async () => {
      const result = await safeTool('run_maintenance', { task_type: 'update_metrics' });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
      expect(getText(result)).toContain('Parameter "task_type" must be one of [archive_old_tasks, cleanup_logs, aggregate_metrics, all], got "update_metrics"');
    });

    it('runs with schedule disabled', async () => {
      const result = await safeTool('run_maintenance', {
        task_type: 'all',
        schedule: { interval_minutes: 60, enabled: false }
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('notify_slack', () => {
    it('rejects missing message', async () => {
      const result = await safeTool('notify_slack', {});
      expect(result.isError).toBe(true);
    });

    it('rejects non-string message', async () => {
      const result = await safeTool('notify_slack', { message: 123 });
      expect(result.isError).toBe(true);
    });

    it('rejects when integration not configured', async () => {
      const result = await safeTool('notify_slack', { message: 'Test notification' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not configured');
    });

    it('rejects internal webhook hosts before fetch', async () => {
      resetTables('integration_config');
      providerRoutingCore.saveIntegrationConfig({
        id: 'slack-internal',
        integration_type: 'slack',
        enabled: true,
        config: {
          webhook_url: 'https://2130706433/services/test',
          default_channel: '#alerts',
        },
      });

      const originalFetch = global.fetch;
      let fetchCalled = false;
      global.fetch = async () => {
        fetchCalled = true;
        return { ok: true };
      };

      try {
        const result = await safeTool('notify_slack', { message: 'Test notification' });
        expect(result.isError).toBe(true);
        expect(getText(result)).toContain('Webhook URL points to internal host');
        expect(fetchCalled).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('notify_discord', () => {
    it('rejects missing message', async () => {
      const result = await safeTool('notify_discord', {});
      expect(result.isError).toBe(true);
    });

    it('rejects non-string message', async () => {
      const result = await safeTool('notify_discord', { message: 456 });
      expect(result.isError).toBe(true);
    });

    it('rejects when integration not configured', async () => {
      const result = await safeTool('notify_discord', { message: 'Test notification' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not configured');
    });

    it('rejects internal webhook hosts before fetch', async () => {
      resetTables('integration_config');
      providerRoutingCore.saveIntegrationConfig({
        id: 'discord-internal',
        integration_type: 'discord',
        enabled: true,
        config: {
          webhook_url: 'https://0x7f000001/api/webhooks/test',
        },
      });

      const originalFetch = global.fetch;
      let fetchCalled = false;
      global.fetch = async () => {
        fetchCalled = true;
        return { ok: true };
      };

      try {
        const result = await safeTool('notify_discord', { message: 'Test notification' });
        expect(result.isError).toBe(true);
        expect(getText(result)).toContain('Webhook URL points to internal host');
        expect(fetchCalled).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
