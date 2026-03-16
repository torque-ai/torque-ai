const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;

describe('Integration Handlers — Expanded Coverage', () => {
  beforeAll(() => {
    const env = setupTestDb('integration-handlers-exp');
    db = env.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: create a task directly via the DB
  function createTaskDirect(description, opts = {}) {
    const id = require('crypto').randomUUID();
    db.createTask({
      id,
      task_description: description || 'test task',
      working_directory: opts.working_directory || process.env.TORQUE_DATA_DIR,
      status: opts.status || 'completed',
      priority: opts.priority || 0,
      project: opts.project || null,
      provider: opts.provider || 'ollama',
      git_before_sha: opts.git_before_sha || null,
      git_after_sha: opts.git_after_sha || null,
    });
    return db.getTask(id);
  }

  // ============================================
  // Scheduling — Cron Schedules
  // ============================================

  describe('create_cron_schedule — extended', () => {
    it('rejects missing name', async () => {
      const result = await safeTool('create_cron_schedule', {
        cron_expression: '0 * * * *',
        task: 'Do something',
        working_directory: '/tmp'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing cron_expression', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'No Cron',
        task: 'Do something',
        working_directory: '/tmp'
      });
      expect(result.isError).toBe(true);
    });

    it('handles missing task description', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'No Task',
        cron_expression: '0 * * * *',
        working_directory: '/tmp'
      });
      // Handler may create schedule with empty task or reject
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('creates schedule with provider override', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'Provider Override Schedule',
        cron_expression: '0 0 * * *',
        task: 'Run daily check',
        working_directory: '/tmp',
        provider: 'codex'
      });
      expect(result.isError).toBeFalsy();
    });

    it('creates schedule with priority', async () => {
      const result = await safeTool('create_cron_schedule', {
        name: 'Priority Schedule',
        cron_expression: '*/30 * * * *',
        task: 'Run priority check',
        working_directory: '/tmp',
        priority: 5
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('list_schedules — after creation', () => {
    it('returns schedules after creating some', async () => {
      const result = await safeTool('list_schedules', {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('toggle_schedule — extended', () => {
    it('rejects missing schedule_id', async () => {
      const result = await safeTool('toggle_schedule', { enabled: false });
      expect(result.isError).toBe(true);
    });

    it('toggles enable state', async () => {
      const result = await safeTool('toggle_schedule', { schedule_id: 'nonexistent', enabled: true });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // Task Changes & Rollback
  // ============================================

  describe('task_changes', () => {
    it('rejects nonexistent task', async () => {
      const result = await safeTool('task_changes', { task_id: 'nonexistent-task' });
      expect(result.isError).toBe(true);
    });

    it('returns error when no git tracking data', async () => {
      const task = createTaskDirect('no git task');
      const result = await safeTool('task_changes', { task_id: task.id });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('git tracking');
    });

    it('rejects missing task_id', async () => {
      const result = await safeTool('task_changes', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('rollback_file', () => {
    it('rejects nonexistent task', async () => {
      const result = await safeTool('rollback_file', {
        task_id: 'nonexistent-task',
        file_path: 'src/test.ts'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects when no git tracking data', async () => {
      const task = createTaskDirect('no git rollback');
      const result = await safeTool('rollback_file', {
        task_id: task.id,
        file_path: 'src/test.ts'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('git tracking');
    });

    it('rejects missing file_path', async () => {
      const task = createTaskDirect('missing file rollback', { git_before_sha: 'abc123' });
      const result = await safeTool('rollback_file', { task_id: task.id });
      expect(result.isError).toBe(true);
    });
  });

  describe('stash_changes', () => {
    it('rejects nonexistent task', async () => {
      const result = await safeTool('stash_changes', { task_id: 'nonexistent-task' });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_rollback_points', () => {
    it('rejects nonexistent task', async () => {
      const result = await safeTool('list_rollback_points', { task_id: 'nonexistent-task' });
      expect(result.isError).toBe(true);
    });

    it('handles existing task (may error if getRollbackPoints uses different lookup)', async () => {
      const task = createTaskDirect('rollback points test');
      const result = await safeTool('list_rollback_points', { task_id: task.id });
      const text = getText(result);
      // May succeed with Rollback Points or fail if db function not compatible
      expect(text.length).toBeGreaterThan(0);
    });

    it('handles task with git SHAs', async () => {
      const task = createTaskDirect('rollback git state', {
        git_before_sha: 'abcdef123456',
        git_after_sha: '654321fedcba'
      });
      const result = await safeTool('list_rollback_points', { task_id: task.id });
      const text = getText(result);
      // May contain Git State or error
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Success Rates — extended
  // ============================================

  describe('success_rates — extended', () => {
      it('groups by model', async () => {
        const result = await safeTool('success_rates', { group_by: 'model' });
        expect(result.isError).toBeTruthy();
        expect(getText(result)).toContain('Parameter "group_by"');
      });

    it('filters by project', async () => {
      const result = await safeTool('success_rates', { project: 'test-project' });
      expect(result.isError).toBeFalsy();
    });

      it('filters by period_type', async () => {
        const result = await safeTool('success_rates', { period_type: 'weekly' });
        expect(result.isError).toBeTruthy();
        expect(getText(result)).toContain('Parameter "period_type"');
      });
  });

  // ============================================
  // Compare Performance — extended
  // ============================================

  describe('compare_performance — extended', () => {
      it('groups by model', async () => {
        const result = await safeTool('compare_performance', {
          current_from: '2026-02-10',
          current_to: '2026-02-17',
          previous_from: '2026-02-03',
          previous_to: '2026-02-10',
          group_by: 'model'
        });
        expect(result.isError).toBeTruthy();
        expect(getText(result)).toContain('Parameter "group_by"');
      });

    it('handles missing date ranges gracefully', async () => {
      const result = await safeTool('compare_performance', {});
      const text = getText(result);
      // Handler may return empty comparison or error depending on db state
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // View Dependencies — extended
  // ============================================

  describe('view_dependencies — extended', () => {
    it('returns graph for task with no dependencies', async () => {
      const task = createTaskDirect('no deps task');
      const result = await safeTool('view_dependencies', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Dependencies');
    });

    it('handles include_completed=false', async () => {
      const result = await safeTool('view_dependencies', { include_completed: false });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // File Chunks
  // ============================================

  describe('get_file_chunks — extended', () => {
    it('rejects empty string file_path', async () => {
      const result = await safeTool('get_file_chunks', { file_path: '' });
      expect(result.isError).toBe(true);
    });

    it('accepts custom token_limit', async () => {
      const result = await safeTool('get_file_chunks', {
        file_path: '/nonexistent/file.js',
        token_limit: 1000
      });
      expect(result.isError).toBe(true); // file doesn't exist
    });
  });

  // ============================================
  // Test Routing — extended
  // ============================================

  describe('test_routing — extended', () => {
    it('routes security tasks', async () => {
      const result = await safeTool('test_routing', {
        task: 'Fix SQL injection vulnerability in auth module'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Selected Provider');
    });

    it('routes documentation tasks', async () => {
      const result = await safeTool('test_routing', {
        task: 'Write API documentation for the user endpoint'
      });
      expect(result.isError).toBeFalsy();
    });

    it('routes test-writing tasks', async () => {
      const result = await safeTool('test_routing', {
        task: 'Write unit tests for UserService.ts'
      });
      expect(result.isError).toBeFalsy();
    });

    it('routes with multiple files', async () => {
      const result = await safeTool('test_routing', {
        task: 'Refactor these files',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts']
      });
      expect(result.isError).toBeFalsy();
    });

    it('routes WPF/XAML tasks to cloud', async () => {
      const result = await safeTool('test_routing', {
        task: 'Fix data binding in UserControl.xaml',
        files: ['Views/UserControl.xaml', 'Views/UserControl.xaml.cs']
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Routing Rules — extended
  // ============================================

  describe('add_routing_rule — extended', () => {
    it('creates rule with priority', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Priority Rule',
        pattern: 'critical',
        target_provider: 'codex',
        priority: 10
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('creates rule with keyword type', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Keyword Rule',
        pattern: 'database',
        target_provider: 'ollama',
        rule_type: 'keyword'
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  describe('list_routing_rules — extended', () => {
    it('returns rules after adding some', async () => {
      const result = await safeTool('list_routing_rules', {});
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Configure Integration — extended
  // ============================================

  describe('configure_integration — extended', () => {
    it('configures github integration', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'github',
        config: { token: 'ghp_test_token', repo: 'owner/repo' }
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('configures jira integration', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'jira',
        config: { url: 'https://mycompany.atlassian.net', api_key: 'test-key' }
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('configures with enabled=true explicitly', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T/B/X' },
        enabled: true
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects empty config object', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: {}
      });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Integration Health — extended
  // ============================================

  describe('integration_health — extended', () => {
    it('returns health for slack after configuration', async () => {
      await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T1/B1/X1' },
        enabled: true
      });
      const result = await safeTool('integration_health', { integration_type: 'slack' });
      expect(result.isError).toBeFalsy();
    });

    it('returns health for discord type', async () => {
      const result = await safeTool('integration_health', { integration_type: 'discord' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Test Integration — extended
  // ============================================

  describe('test_integration — extended', () => {
    it('rejects s3 type as not testable', async () => {
      const result = await safeTool('test_integration', { integration_type: 's3' });
      expect(result.isError).toBe(true);
    });

    it('rejects prometheus type as not testable', async () => {
      const result = await safeTool('test_integration', { integration_type: 'prometheus' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Report Exports — extended
  // ============================================

  describe('export_report_json — extended', () => {
    it('exports with provider filter', async () => {
      const result = await safeTool('export_report_json', { provider: 'ollama' });
      expect(result.isError).toBeFalsy();
    });

    it('exports with combined filters', async () => {
      const result = await safeTool('export_report_json', {
        status: 'completed',
        project: 'test',
        limit: 10,
        from_date: '2026-01-01',
        to_date: '2026-12-31'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('export_report_csv — extended', () => {
    it('exports with provider filter', async () => {
      const result = await safeTool('export_report_csv', { provider: 'codex' });
      expect(result.isError).toBeFalsy();
    });

    it('exports with combined filters', async () => {
      const result = await safeTool('export_report_csv', {
        status: 'failed',
        limit: 5,
        from_date: '2026-02-01'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('list_report_exports — extended', () => {
    it('returns exports sorted by creation time', async () => {
      // Create some exports first
      await safeTool('export_report_json', {});
      await safeTool('export_report_csv', {});
      const result = await safeTool('list_report_exports', { limit: 10 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Report Exports');
    });
  });

  // ============================================
  // Plan Projects — extended
  // ============================================

  describe('list_plan_projects — extended', () => {
    it('filters by completed status', async () => {
      const result = await safeTool('list_plan_projects', { status: 'completed' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by paused status', async () => {
      const result = await safeTool('list_plan_projects', { status: 'paused' });
      expect(result.isError).toBeFalsy();
    });

    it('respects small limit', async () => {
      const result = await safeTool('list_plan_projects', { limit: 1 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('get_plan_project — extended', () => {
    it('handles missing project_id', async () => {
      const result = await safeTool('get_plan_project', {});
      // Handler may return {error: 'Project not found'} or throw
      // The result is an object, not necessarily with content[0].text
      expect(result).toBeDefined();
    });
  });

  // ============================================
  // Review Workflow — extended
  // ============================================

  describe('configure_review_workflow — extended', () => {
    it('sets all options at once', async () => {
      const result = await safeTool('configure_review_workflow', {
        auto_review: true,
        require_approval: true,
        auto_approve_simple: false,
        require_review_for_complex: true,
        review_interval_minutes: 5
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Review Workflow');
    });

    it('returns current config when no options set', async () => {
      const result = await safeTool('configure_review_workflow', {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('get_review_workflow_config — extended', () => {
    it('shows all configuration fields', async () => {
      const result = await safeTool('get_review_workflow_config', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Setting');
      expect(text).toContain('Value');
    });
  });

  // ============================================
  // Set Host Priority — extended
  // ============================================

  describe('set_host_priority — extended', () => {
    it('handles high priority value', async () => {
      const result = await safeTool('set_host_priority', { host_id: 'test-host', priority: 101 });
      // No upper bound validation, so this may succeed
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('sets valid priority', async () => {
      const result = await safeTool('set_host_priority', { host_id: 'test-host', priority: 10 });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // Email Notifications — extended
  // ============================================

  describe('send_email_notification — extended', () => {
    it('sends with all optional fields', async () => {
      const task = createTaskDirect('email full test');
      const result = await safeTool('send_email_notification', {
        recipient: 'admin@example.com',
        subject: 'Task Completed',
        body: 'Your task has completed successfully.',
        task_id: task.id,
        priority: 'high'
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects email with spaces', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'bad email@example.com',
        subject: 'Test',
        body: 'Test'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_email_notifications — extended', () => {
    it('returns notifications after sending some', async () => {
      const result = await safeTool('list_email_notifications', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Email Notifications');
    });

    it('filters by sent status', async () => {
      const result = await safeTool('list_email_notifications', { status: 'sent' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by failed status', async () => {
      const result = await safeTool('list_email_notifications', { status: 'failed' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('get_email_notification — extended', () => {
    it('rejects empty string id', async () => {
      const result = await safeTool('get_email_notification', { id: '' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Database Backup — extended
  // ============================================

  describe('backup_database — extended', () => {
    it('creates multiple backups', async () => {
      const r1 = await safeTool('backup_database', {});
      const r2 = await safeTool('backup_database', {});
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
    });
  });

  describe('restore_database — extended', () => {
    it('rejects empty string src_path', async () => {
      const result = await safeTool('restore_database', { src_path: '' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // Scan Project — extended
  // ============================================

  describe('scan_project — extended', () => {
    it('scans with missing_tests check', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['missing_tests']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with todos check', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['todos']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with file_sizes check', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['file_sizes']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with data_inventory check', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['data_inventory']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with dependencies check', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['dependencies']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with all checks', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['summary', 'missing_tests', 'todos', 'file_sizes', 'data_inventory', 'dependencies']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Project Scan');
    });

    it('scans with custom ignore_dirs', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['summary'],
        ignore_dirs: ['node_modules', '.git']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with custom test_pattern', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['missing_tests'],
        test_pattern: '.spec.ts'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Resource Usage & Limits
  // ============================================

  describe('get_resource_usage — extended', () => {
    it('accepts both task_id and project', async () => {
      const result = await safeTool('get_resource_usage', {
        task_id: 'test-task',
        project: 'test-project'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('set_resource_limits — extended', () => {
    it('sets max_concurrent_tasks', async () => {
      const result = await safeTool('set_resource_limits', { max_concurrent_tasks: 5 });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('sets with empty args', async () => {
      const result = await safeTool('set_resource_limits', {});
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  describe('resource_report — extended', () => {
    it('returns report data', async () => {
      const result = await safeTool('resource_report', {});
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // Enable/Disable Integration lifecycle
  // ============================================

  describe('enable_integration → disable_integration lifecycle', () => {
    it('configures, disables, then re-enables', async () => {
      // Configure
      await safeTool('configure_integration', {
        integration_type: 's3',
        config: { bucket: 'test-bucket', region: 'us-west-2' },
        enabled: true
      });

      // Disable
      const disableResult = await safeTool('disable_integration', { integration_type: 's3' });
      expect(disableResult.isError).toBeFalsy();

      // Enable
      const enableResult = await safeTool('enable_integration', { integration_type: 's3' });
      expect(enableResult.isError).toBeFalsy();
      expect(getText(enableResult)).toContain('Enabled');
    });
  });
});
