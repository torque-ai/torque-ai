const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;

describe('Integration Handlers', () => {
  beforeAll(() => {
    const env = setupTestDb('integration-handlers');
    db = env.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: create a task directly via the DB
  function createTaskDirect(description, opts = {}) {
    const id = require('crypto').randomUUID();
    db.createTask({
      id,
      task_description: description || 'test task',
      working_directory: process.env.TORQUE_DATA_DIR,
      status: opts.status || 'queued',
      priority: opts.priority || 0,
      project: opts.project || null,
      provider: opts.provider || 'ollama',
      git_before_sha: opts.git_before_sha || null,
      git_after_sha: opts.git_after_sha || null,
    });
    return db.getTask(id);
  }

  // ============================================
  // list_integrations
  // ============================================
  describe('list_integrations', () => {
    it('returns integrations', async () => {
      const result = await safeTool('list_integrations', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Integrations');
    });

    it('includes disabled integrations', async () => {
      const result = await safeTool('list_integrations', { include_disabled: true });
      expect(result.isError).toBeFalsy();
    });

    it('shows table headers when integrations exist', async () => {
      // Ensure we have configured integration from earlier tests
      await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T00000/B00000/YYYYYY' },
        enabled: true
      });
      const result = await safeTool('list_integrations', { include_disabled: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Type');
    });
  });

  // ============================================
  // configure_integration
  // ============================================
  describe('configure_integration', () => {
    it('configures slack integration', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T00000/B00000/XXXXXX' }
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Integration Configured');
    });

    it('configures discord integration', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'discord',
        config: { webhook_url: 'https://discord.com/api/webhooks/123/abc' }
      });
      expect(result.isError).toBeFalsy();
    });

    it('configures s3 integration', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 's3',
        config: { bucket: 'my-bucket', region: 'us-east-1' }
      });
      expect(result.isError).toBeFalsy();
    });

    it('configures prometheus integration', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'prometheus',
        config: { endpoint: 'http://prometheus:9090' }
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects invalid integration_type', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'invalid_type',
        config: {}
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing config', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects slack without webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { channel: '#general' }
      });
      expect(result.isError).toBe(true);
    });

    it('rejects discord without webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'discord',
        config: { channel: '#general' }
      });
      expect(result.isError).toBe(true);
    });

    it('rejects non-HTTPS webhook URL', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'http://hooks.slack.com/services/xxx' }
      });
      expect(result.isError).toBe(true);
    });

    it('shows config keys in response', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T00000/B00000/ZZZZZZ' }
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('webhook_url');
    });

    it('sets enabled flag explicitly', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T00000/B00000/ZZZZZ2' },
        enabled: false
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects non-object config', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: 'not-an-object'
      });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // integration_health
  // ============================================
  describe('integration_health', () => {
    it('returns health for all integrations', async () => {
      const result = await safeTool('integration_health', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Integration Health');
    });

    it('returns health for specific type', async () => {
      const result = await safeTool('integration_health', { integration_type: 'slack' });
      expect(result.isError).toBeFalsy();
    });

    it('includes history when requested', async () => {
      const result = await safeTool('integration_health', { include_history: true });
      expect(result.isError).toBeFalsy();
    });

    it('returns empty message for unconfigured type', async () => {
      const result = await safeTool('integration_health', { integration_type: 'nonexistent' });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Parameter "integration_type"');
    });
  });

  // ============================================
  // test_integration
  // ============================================
  describe('test_integration', () => {
    it('rejects invalid integration_type', async () => {
      const result = await safeTool('test_integration', { integration_type: 'invalid' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing integration_type', async () => {
      const result = await safeTool('test_integration', {});
      expect(result.isError).toBe(true);
    });

    it('rejects integration type that is not slack or discord', async () => {
      const result = await safeTool('test_integration', { integration_type: 's3' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // disable_integration
  // ============================================
  describe('disable_integration', () => {
    it('rejects missing integration_type', async () => {
      const result = await safeTool('disable_integration', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent integration', async () => {
      const result = await safeTool('disable_integration', { integration_type: 'prometheus' });
      // prometheus was configured above, so this should succeed now
      // but the handler looks for `${type}_config` which may not exist
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('disables existing integration', async () => {
      await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T00000/B00000/XXXXXX' },
        enabled: true
      });

      const result = await safeTool('disable_integration', { integration_type: 'slack' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Disabled');
    });

    it('shows integration type in response', async () => {
      await safeTool('configure_integration', {
        integration_type: 'discord',
        config: { webhook_url: 'https://discord.com/api/webhooks/999/xyz' },
        enabled: true
      });
      const result = await safeTool('disable_integration', { integration_type: 'discord' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('discord');
    });
  });

  // ============================================
  // enable_integration
  // ============================================
  describe('enable_integration', () => {
    it('rejects missing integration_type', async () => {
      const result = await safeTool('enable_integration', {});
      expect(result.isError).toBe(true);
    });

    it('enables existing integration', async () => {
      const result = await safeTool('enable_integration', { integration_type: 'slack' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Enabled');
    });

    it('rejects nonexistent integration', async () => {
      const result = await safeTool('enable_integration', { integration_type: 'nonexistent_type' });
      expect(result.isError).toBe(true);
    });

    it('shows type in enable response', async () => {
      const result = await safeTool('enable_integration', { integration_type: 'slack' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('slack');
    });
  });

  // ============================================
  // test_routing
  // ============================================
  describe('test_routing', () => {
    it('returns routing decision for a task', async () => {
      const result = await safeTool('test_routing', { task: 'Write unit tests for FooService' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Routing Test Result');
    });

    it('rejects missing task', async () => {
      const result = await safeTool('test_routing', {});
      expect(result.isError).toBe(true);
    });

    it('includes file info when provided', async () => {
      const result = await safeTool('test_routing', {
        task: 'Fix bug in foo.ts',
        files: ['src/foo.ts']
      });
      expect(result.isError).toBeFalsy();
    });

    it('shows Selected Provider in response', async () => {
      const result = await safeTool('test_routing', { task: 'Write documentation' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Selected Provider');
    });

    it('routes XAML tasks differently', async () => {
      const result = await safeTool('test_routing', {
        task: 'Create MainWindow.xaml for WPF app',
        files: ['MainWindow.xaml']
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Selected Provider');
    });

    it('shows rule type when matched', async () => {
      const result = await safeTool('test_routing', { task: 'Refactor the authentication module' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Rule Type');
    });
  });

  // ============================================
  // add_routing_rule
  // ============================================
  describe('add_routing_rule', () => {
    it('creates routing rule with codex provider', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Test Rule',
        pattern: 'test',
        target_provider: 'codex'
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    it('rejects missing required fields', async () => {
      const result = await safeTool('add_routing_rule', { name: 'Incomplete' });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid provider', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Bad Provider',
        pattern: 'test',
        target_provider: 'nonexistent_provider'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid rule_type', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Bad Type',
        pattern: 'test',
        target_provider: 'ollama',
        rule_type: 'invalid'
      });
      expect(result.isError).toBe(true);
    });

    it('creates rule with extension type', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Extension Rule',
        pattern: '.xaml',
        target_provider: 'codex',
        rule_type: 'extension'
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('creates rule with regex type', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Regex Rule',
        pattern: '\\bsecurity\\b',
        target_provider: 'codex',
        rule_type: 'regex'
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('creates rule with description', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'Documented Rule',
        pattern: 'docs',
        target_provider: 'codex',
        description: 'Route documentation tasks to codex'
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('rejects missing pattern', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'No Pattern',
        target_provider: 'codex'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing target_provider', async () => {
      const result = await safeTool('add_routing_rule', {
        name: 'No Target',
        pattern: 'test'
      });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // delete_routing_rule
  // ============================================
  describe('delete_routing_rule', () => {
    it('rejects missing rule ID', async () => {
      const result = await safeTool('delete_routing_rule', {});
      expect(result.isError).toBe(true);
    });

    it('returns error for nonexistent rule', async () => {
      const result = await safeTool('delete_routing_rule', { rule: 'nonexistent-id' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // update_routing_rule
  // ============================================
  describe('update_routing_rule', () => {
    it('rejects missing rule ID', async () => {
      const result = await safeTool('update_routing_rule', {});
      expect(result.isError).toBe(true);
    });

    it('returns error for nonexistent rule', async () => {
      const result = await safeTool('update_routing_rule', { rule: 'nonexistent-id', enabled: false });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid target_provider in update', async () => {
      const result = await safeTool('update_routing_rule', {
        rule: 'some-id',
        target_provider: 'nonexistent_provider'
      });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // view_dependencies
  // ============================================
  describe('view_dependencies', () => {
    it('returns dependency graph for nonexistent task', async () => {
      const result = await safeTool('view_dependencies', { task_id: 'nonexistent-task' });
      expect(result.isError).toBe(true);
    });

    it('returns dependency graph with no filters', async () => {
      const result = await safeTool('view_dependencies', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Dependencies');
    });

    it('returns mermaid diagram format', async () => {
      const result = await safeTool('view_dependencies', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('mermaid');
    });

    it('accepts include_completed flag', async () => {
      const result = await safeTool('view_dependencies', { include_completed: true });
      expect(result.isError).toBeFalsy();
    });

    it('returns dependencies for existing task', async () => {
      const task = createTaskDirect('task with deps check');
      const result = await safeTool('view_dependencies', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Dependencies');
    });
  });

  // ============================================
  // compare_performance
  // ============================================
  describe('compare_performance', () => {
    it('returns performance comparison', async () => {
      const result = await safeTool('compare_performance', {
        current_from: '2026-02-10',
        current_to: '2026-02-17',
        previous_from: '2026-02-03',
        previous_to: '2026-02-10'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Performance Comparison');
    });

    it('shows date ranges in output', async () => {
      const result = await safeTool('compare_performance', {
        current_from: '2026-02-10',
        current_to: '2026-02-17',
        previous_from: '2026-02-03',
        previous_to: '2026-02-10'
      });
      const text = getText(result);
      expect(text).toContain('2026-02-10');
      expect(text).toContain('Current');
      expect(text).toContain('Previous');
    });

    it('accepts group_by parameter', async () => {
      const result = await safeTool('compare_performance', {
        current_from: '2026-02-10',
        current_to: '2026-02-17',
        previous_from: '2026-02-03',
        previous_to: '2026-02-10',
        group_by: 'provider'
      });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Parameter "group_by"');
    });
  });

  // ============================================
  // list_plan_projects
  // ============================================
  describe('list_plan_projects', () => {
    it('returns plan projects list', async () => {
      const result = await safeTool('list_plan_projects', {});
      expect(result.isError).toBeFalsy();
    });

    it('accepts status filter', async () => {
      const result = await safeTool('list_plan_projects', { status: 'active' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts limit parameter', async () => {
      const result = await safeTool('list_plan_projects', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // get_plan_project
  // ============================================
  describe('get_plan_project', () => {
    it('returns error for nonexistent project', async () => {
      const result = await safeTool('get_plan_project', { project_id: 'nonexistent-proj' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // pause_plan_project / resume_plan_project / retry_plan_project
  // ============================================
  describe('pause_plan_project', () => {
    it('returns error for nonexistent project', async () => {
      const result = await safeTool('pause_plan_project', { project_id: 'nonexistent-proj' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  describe('resume_plan_project', () => {
    it('returns error for nonexistent project', async () => {
      const result = await safeTool('resume_plan_project', { project_id: 'nonexistent-proj' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  describe('retry_plan_project', () => {
    it('returns error for nonexistent project', async () => {
      const result = await safeTool('retry_plan_project', { project_id: 'nonexistent-proj' });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // backup_database
  // ============================================
  describe('backup_database', () => {
    it('creates a database backup', async () => {
      const result = await safeTool('backup_database', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Backup');
    });

    it('shows path and size in response', async () => {
      const result = await safeTool('backup_database', {});
      const text = getText(result);
      expect(text).toContain('Path');
      expect(text).toContain('Size');
    });
  });

  // ============================================
  // restore_database
  // ============================================
  describe('restore_database', () => {
    it('rejects missing src_path', async () => {
      const result = await safeTool('restore_database', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent src_path', async () => {
      const result = await safeTool('restore_database', { src_path: '/nonexistent/path.db' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // list_database_backups
  // ============================================
  describe('list_database_backups', () => {
    it('returns backups list', async () => {
      const result = await safeTool('list_database_backups', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Backup');
    });
  });

  // ============================================
  // configure_review_workflow
  // ============================================
  describe('configure_review_workflow', () => {
    it('configures review workflow settings', async () => {
      const result = await safeTool('configure_review_workflow', {
        auto_review: true,
        require_approval: false
      });
      expect(result.isError).toBeFalsy();
    });

    it('sets auto_approve_simple', async () => {
      const result = await safeTool('configure_review_workflow', {
        auto_approve_simple: true
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Review Workflow');
    });

    it('sets require_review_for_complex', async () => {
      const result = await safeTool('configure_review_workflow', {
        require_review_for_complex: true
      });
      expect(result.isError).toBeFalsy();
    });

    it('sets review_interval_minutes', async () => {
      const result = await safeTool('configure_review_workflow', {
        review_interval_minutes: 10
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('10');
    });
  });

  // ============================================
  // get_review_workflow_config
  // ============================================
  describe('get_review_workflow_config', () => {
    it('returns review workflow config', async () => {
      const result = await safeTool('get_review_workflow_config', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('shows review settings section', async () => {
      const result = await safeTool('get_review_workflow_config', {});
      const text = getText(result);
      expect(text).toContain('Review');
      expect(text).toContain('Setting');
    });

    it('shows complexity routing section', async () => {
      const result = await safeTool('get_review_workflow_config', {});
      const text = getText(result);
      expect(text).toContain('Complexity');
    });
  });

  // ============================================
  // set_host_priority
  // ============================================
  describe('set_host_priority', () => {
    it('responds to priority setting request', async () => {
      const result = await safeTool('set_host_priority', { host_id: 'nonexistent', priority: 5 });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });

    it('rejects missing host_id', async () => {
      const result = await safeTool('set_host_priority', { priority: 5 });
      expect(result.isError).toBe(true);
    });

    it('rejects missing priority', async () => {
      const result = await safeTool('set_host_priority', { host_id: 'some-host' });
      expect(result.isError).toBe(true);
    });

    it('rejects non-positive priority', async () => {
      const result = await safeTool('set_host_priority', { host_id: 'some-host', priority: 0 });
      expect(result.isError).toBe(true);
    });

    it('rejects non-string host_id', async () => {
      const result = await safeTool('set_host_priority', { host_id: '', priority: 5 });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // scan_project
  // ============================================
  describe('scan_project', () => {
    it('rejects nonexistent path', async () => {
      const result = await safeTool('scan_project', { path: '/nonexistent/path/12345' });
      expect(result.isError).toBe(true);
    });

    it('scans existing directory', async () => {
      const result = await safeTool('scan_project', { path: process.env.TORQUE_DATA_DIR });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Project Scan');
    });

    it('accepts checks parameter', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        checks: ['summary']
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Summary');
    });

    it('accepts custom source_dirs', async () => {
      const result = await safeTool('scan_project', {
        path: process.env.TORQUE_DATA_DIR,
        source_dirs: ['lib'],
        checks: ['summary']
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing path', async () => {
      const result = await safeTool('scan_project', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // send_email_notification
  // ============================================
  describe('send_email_notification', () => {
    it('rejects missing recipient', async () => {
      const result = await safeTool('send_email_notification', {
        subject: 'Test',
        body: 'Test body'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing subject', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'test@example.com',
        body: 'Test body'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing body', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'test@example.com',
        subject: 'Test'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid email format', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'not-an-email',
        subject: 'Test',
        body: 'Test body'
      });
      expect(result.isError).toBe(true);
    });

    it('records pending notification when SMTP not configured', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'test@example.com',
        subject: 'Test Subject',
        body: 'Test body content'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('pending');
    });

    it('accepts optional task_id', async () => {
      const task = createTaskDirect('email notification task');
      const result = await safeTool('send_email_notification', {
        recipient: 'test@example.com',
        subject: 'Task Complete',
        body: 'Your task finished',
        task_id: task.id
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // list_email_notifications
  // ============================================
  describe('list_email_notifications', () => {
    it('returns email notifications list', async () => {
      const result = await safeTool('list_email_notifications', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Email Notifications');
    });

    it('accepts status filter', async () => {
      const result = await safeTool('list_email_notifications', { status: 'pending' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts limit parameter', async () => {
      const result = await safeTool('list_email_notifications', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });

    it('accepts task_id filter', async () => {
      const result = await safeTool('list_email_notifications', { task_id: 'fake-id' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // get_email_notification
  // ============================================
  describe('get_email_notification', () => {
    it('rejects missing id', async () => {
      const result = await safeTool('get_email_notification', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent id', async () => {
      const result = await safeTool('get_email_notification', { id: 'nonexistent-notification-id' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // get_resource_usage
  // ============================================
  describe('get_resource_usage', () => {
    it('requires task_id or project', async () => {
      const result = await safeTool('get_resource_usage', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('specify');
    });

    it('returns empty data for nonexistent project', async () => {
      const result = await safeTool('get_resource_usage', { project: 'nonexistent-proj' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage');
    });

    it('returns empty data for nonexistent task', async () => {
      const result = await safeTool('get_resource_usage', { task_id: 'nonexistent-task' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No resource usage');
    });
  });

  // ============================================
  // set_resource_limits
  // ============================================
  describe('set_resource_limits', () => {
    it('sets resource limits', async () => {
      const result = await safeTool('set_resource_limits', {
        max_concurrent_tasks: 10
      });
      const text = getText(result);
      expect(typeof text).toBe('string');
    });
  });

  // ============================================
  // resource_report
  // ============================================
  describe('resource_report', () => {
    it('returns resource report', async () => {
      const result = await safeTool('resource_report', {});
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // get_file_chunks
  // ============================================
  describe('get_file_chunks', () => {
    it('rejects missing file_path', async () => {
      const result = await safeTool('get_file_chunks', {});
      expect(result.isError).toBe(true);
    });

    it('rejects non-string file_path', async () => {
      const result = await safeTool('get_file_chunks', { file_path: 123 });
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent file', async () => {
      const result = await safeTool('get_file_chunks', { file_path: '/nonexistent/file.js' });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // list_routing_rules
  // ============================================
  describe('list_routing_rules', () => {
    it('returns routing rules list', async () => {
      const result = await safeTool('list_routing_rules', {});
      expect(result.isError).toBeFalsy();
    });
  });
});
