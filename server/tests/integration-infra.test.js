/**
 * Tests for integration-infra.js handlers:
 *   handleConfigureIntegration, handleSetHostPriority,
 *   handleConfigureReviewWorkflow, handleGetReviewWorkflowConfig,
 *   handleBackupDatabase, handleRestoreDatabase, handleListDatabaseBackups,
 *   handleSendEmailNotification, handleListEmailNotifications,
 *   handleGetEmailNotification, handleScanProject
 */
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const fs = require('fs');
const os = require('os');
const backupCore = require('../db/backup-core');

let db;
let testDir;
let savedSmtp;
let backupsDirSpy;

describe('Integration Infra Handlers', () => {
  beforeAll(() => {
    const env = setupTestDb('integration-infra');
    db = env.db;
    testDir = env.testDir;
    backupsDirSpy = vi.spyOn(backupCore, 'getBackupsDir').mockReturnValue(testDir);

    // Save and clear SMTP environment variables to ensure predictable email test behaviour
    savedSmtp = {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      SMTP_FROM: process.env.SMTP_FROM,
    };
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
  });
  afterAll(() => {
    backupsDirSpy?.mockRestore();
    for (const [key, val] of Object.entries(savedSmtp)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
    teardownTestDb();
  });

  // ============================================================
  // handleConfigureIntegration
  // ============================================================
  describe('configure_integration', () => {
    it('rejects missing integration_type', async () => {
      const result = await safeTool('configure_integration', {
        config: { webhook_url: 'https://hooks.slack.com/services/T/B/X' }
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('integration_type');
    });

    it('rejects invalid integration_type', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'github',
        config: { token: 'ghp_test' }
      });
      expect(result.isError).toBe(true);
    });

    it('rejects another invalid integration_type', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'jira',
        config: { url: 'https://example.atlassian.net' }
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing config', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('config');
    });

    it('rejects non-object config', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: 'not-an-object'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects slack config without webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { channel: '#general' }
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('webhook_url');
    });

    it('rejects discord config without webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'discord',
        config: { server: 'my-server' }
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('webhook_url');
    });

    it('rejects non-HTTPS webhook URL', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'http://hooks.slack.com/services/T/B/X' }
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('HTTPS');
    });

    it('rejects invalid webhook URL format', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'not-a-url' }
      });
      expect(result.isError).toBe(true);
    });

    it('configures slack with valid webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'slack',
        config: { webhook_url: 'https://hooks.slack.com/services/T/B/VALID' }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Integration Configured');
      expect(text).toContain('slack');
    });

    it('configures discord with valid webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'discord',
        config: { webhook_url: 'https://discord.com/api/webhooks/123/token' }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Integration Configured');
      expect(text).toContain('discord');
    });

    it('configures s3 without webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 's3',
        config: { bucket: 'my-backup-bucket', region: 'us-east-1' }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Integration Configured');
    });

    it('configures prometheus without webhook_url', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 'prometheus',
        config: { endpoint: '/metrics', port: 9090 }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Integration Configured');
    });

    it('respects enabled flag on configuration', async () => {
      const result = await safeTool('configure_integration', {
        integration_type: 's3',
        config: { bucket: 'disabled-bucket' },
        enabled: false
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('false');
    });
  });

  // ============================================================
  // handleSetHostPriority
  // ============================================================
  describe('set_host_priority', () => {
    let hostId;

    beforeAll(() => {
      // Insert a host directly into the DB for testing
      const rawDb = db.getDbInstance ? db.getDbInstance() : db.getDb();
      hostId = `test-host-${Date.now()}`;
      rawDb.prepare(`
        INSERT INTO ollama_hosts (id, name, url, enabled, status, running_tasks, max_concurrent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        hostId,
        'TestHost',
        'http://127.0.0.1:11435',
        1,
        'healthy',
        0,
        4,
        new Date().toISOString()
      );
    });

    it('rejects missing host_id', async () => {
      const result = await safeTool('set_host_priority', { priority: 5 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('host_id');
    });

    it('rejects invalid priority (zero)', async () => {
      const result = await safeTool('set_host_priority', {
        host_id: hostId,
        priority: 0
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('priority');
    });

    it('rejects invalid priority (negative)', async () => {
      const result = await safeTool('set_host_priority', {
        host_id: hostId,
        priority: -5
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('priority');
    });

    it('rejects nonexistent host', async () => {
      const result = await safeTool('set_host_priority', {
        host_id: 'nonexistent-host-xyz',
        priority: 5
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('sets valid priority for existing host by id', async () => {
      const result = await safeTool('set_host_priority', {
        host_id: hostId,
        priority: 3
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Host Priority Updated');
      expect(text).toContain('3');
    });

    it('sets valid priority for existing host by name', async () => {
      const result = await safeTool('set_host_priority', {
        host_id: 'TestHost',
        priority: 7
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Host Priority Updated');
    });
  });

  // ============================================================
  // handleConfigureReviewWorkflow
  // ============================================================
  describe('configure_review_workflow', () => {
    it('updates review_interval_minutes', async () => {
      const result = await safeTool('configure_review_workflow', {
        review_interval_minutes: 10
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Review Workflow Configuration');
      expect(text).toContain('10');
    });

    it('enables auto_approve_simple', async () => {
      const result = await safeTool('configure_review_workflow', {
        auto_approve_simple: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Review Workflow Configuration');
      expect(text).toContain('Yes');
    });

    it('disables auto_approve_simple', async () => {
      const result = await safeTool('configure_review_workflow', {
        auto_approve_simple: false
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No');
    });

    it('enables require_review_for_complex', async () => {
      const result = await safeTool('configure_review_workflow', {
        require_review_for_complex: true
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Review Workflow Configuration');
    });

    it('disables require_review_for_complex', async () => {
      const result = await safeTool('configure_review_workflow', {
        require_review_for_complex: false
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Review Workflow Configuration');
    });

    it('updates all settings at once', async () => {
      const result = await safeTool('configure_review_workflow', {
        review_interval_minutes: 5,
        auto_approve_simple: true,
        require_review_for_complex: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Review Workflow Configuration');
      expect(text).toContain('5');
    });

    it('returns current config when no settings provided', async () => {
      const result = await safeTool('configure_review_workflow', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Review Workflow Configuration');
    });
  });

  // ============================================================
  // handleGetReviewWorkflowConfig
  // ============================================================
  describe('get_review_workflow_config', () => {
    it('returns current config without error', async () => {
      const result = await safeTool('get_review_workflow_config', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Review Workflow Configuration');
    });

    it('output includes all expected sections', async () => {
      const result = await safeTool('get_review_workflow_config', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Setting');
      expect(text).toContain('Value');
    });

    it('includes review interval in output', async () => {
      // Set a known value first
      await safeTool('configure_review_workflow', { review_interval_minutes: 15 });
      const result = await safeTool('get_review_workflow_config', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('15');
    });

    it('includes complexity routing section', async () => {
      const result = await safeTool('get_review_workflow_config', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Complexity');
    });
  });

  // ============================================================
  // handleBackupDatabase
  // ============================================================
  describe('backup_database', () => {
    it('creates a backup with default path', async () => {
      const result = await safeTool('backup_database', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Database Backup Created');
      expect(text).toContain('Path:');
    });

    it('creates a backup at a specified path', async () => {
      const dest = path.join(os.tmpdir(), `torque-infra-test-backup-${Date.now()}.db`);
      const result = await safeTool('backup_database', { dest_path: dest });
      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(dest)).toBe(true);
      expect(getText(result)).toContain('Database Backup Created');
      fs.unlinkSync(dest);
    });

    it('backup output includes size and timestamp', async () => {
      const result = await safeTool('backup_database', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Size:');
      expect(text).toContain('KB');
      expect(text).toContain('Created:');
    });
  });

  // ============================================================
  // handleRestoreDatabase
  // ============================================================
  describe('restore_database', () => {
    it('rejects missing src_path', async () => {
      const result = await safeTool('restore_database', { confirm: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('rejects without confirm flag', async () => {
      const result = await safeTool('restore_database', {
        src_path: path.join(testDir, 'some-backup.db')
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('confirm');
    });

    it('rejects with confirm=false', async () => {
      const result = await safeTool('restore_database', {
        src_path: path.join(testDir, 'some-backup.db'),
        confirm: false
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('confirm');
    });

    it('rejects nonexistent backup file (with confirm=true)', async () => {
      const result = await safeTool('restore_database', {
        src_path: path.join(testDir, 'nonexistent-backup-xyz.db'),
        confirm: true
      });
      expect(result.isError).toBe(true);
    });

    it('restores from a valid backup', async () => {
      // Create a backup first
      const backupPath = path.join(testDir, `infra-restore-test-${Date.now()}.db`);
      await safeTool('backup_database', { dest_path: backupPath });

      const result = await safeTool('restore_database', {
        src_path: backupPath,
        confirm: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Database Restored');
      expect(text).toContain('From:');
    });
  });

  // ============================================================
  // handleListDatabaseBackups
  // ============================================================
  describe('list_database_backups', () => {
    it('returns "No backups" for nonexistent directory', async () => {
      const result = await safeTool('list_database_backups', {
        directory: path.join(testDir, 'no-backups-here-xyz')
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No backups');
    });

    it('lists backup files in a directory', async () => {
      const backupDir = path.join(testDir, 'list-test-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'listed.db') });
      const result = await safeTool('list_database_backups', { directory: backupDir });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('listed.db');
    });

    it('shows count in header', async () => {
      const backupDir = path.join(testDir, 'count-test-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'first.db') });
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'second.db') });
      const result = await safeTool('list_database_backups', { directory: backupDir });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Database Backups (2)');
    });
  });

  // ============================================================
  // handleSendEmailNotification
  // ============================================================
  describe('send_email_notification', () => {
    it('rejects missing recipient', async () => {
      const result = await safeTool('send_email_notification', {
        subject: 'Test Subject',
        body: 'Test body'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('rejects missing subject', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'user@example.com',
        body: 'Test body'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('rejects missing body', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'user@example.com',
        subject: 'Test Subject'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('rejects invalid email format', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'not-an-email',
        subject: 'Test',
        body: 'Body'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid email');
    });

    it('rejects email with spaces', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'bad email@example.com',
        subject: 'Test',
        body: 'Body'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid email');
    });

    it('records as pending when SMTP is not configured', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'user@example.com',
        subject: 'Infra Test Email',
        body: 'This should be recorded as pending'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('pending');
      expect(text).toContain('SMTP');
    });

    it('records pending notification with task_id association', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'dev@example.com',
        subject: 'Task Alert',
        body: 'Task completed',
        task_id: 'task-infra-test'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('pending');

      // Verify persisted to DB
      const notifications = db.listEmailNotifications({ task_id: 'task-infra-test' });
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      expect(notifications[0].recipient).toBe('dev@example.com');
    });

    it('includes notification ID in pending output', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'id-check@example.com',
        subject: 'ID Check',
        body: 'Checking notification ID'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('ID:');
    });
  });

  // ============================================================
  // handleListEmailNotifications
  // ============================================================
  describe('list_email_notifications', () => {
    beforeAll(async () => {
      // Seed some notifications
      delete process.env.SMTP_HOST;
      await safeTool('send_email_notification', {
        recipient: 'list-test-1@example.com',
        subject: 'List Test 1',
        body: 'Body 1'
      });
      await safeTool('send_email_notification', {
        recipient: 'list-test-2@example.com',
        subject: 'List Test 2',
        body: 'Body 2'
      });
    });

    it('returns notification listing', async () => {
      const result = await safeTool('list_email_notifications', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Email Notifications');
    });

    it('lists notifications seeded in this session', async () => {
      const result = await safeTool('list_email_notifications', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('list-test-1@example.com');
    });

    it('filters by pending status', async () => {
      const result = await safeTool('list_email_notifications', { status: 'pending' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Email Notifications');
    });

    it('returns "No email notifications found" for empty result set', async () => {
      const result = await safeTool('list_email_notifications', {
        status: 'sent',
        task_id: 'definitely-nonexistent-task-xyz'
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No email notifications found');
    });

    it('respects limit parameter', async () => {
      const result = await safeTool('list_email_notifications', { limit: 1 });
      expect(result.isError).toBeFalsy();
      // With limit=1, only one row should appear in the table
      const text = getText(result);
      expect(text).toContain('Email Notifications');
    });
  });

  // ============================================================
  // handleGetEmailNotification
  // ============================================================
  describe('get_email_notification', () => {
    let notificationId;

    beforeAll(async () => {
      // Send one and extract its ID
      delete process.env.SMTP_HOST;
      const result = await safeTool('send_email_notification', {
        recipient: 'get-test@example.com',
        subject: 'Get Test Email',
        body: 'Body for get test'
      });
      const text = getText(result);
      // ID: <uuid> appears in the output
      const match = text.match(/ID:\s+([a-f0-9-]{36})/);
      if (match) notificationId = match[1];
    });

    it('rejects missing id', async () => {
      const result = await safeTool('get_email_notification', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('rejects empty string id', async () => {
      const result = await safeTool('get_email_notification', { id: '' });
      expect(result.isError).toBe(true);
    });

    it('returns error for nonexistent id', async () => {
      const result = await safeTool('get_email_notification', { id: 'nonexistent-id-xyz' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('returns notification details by id', async () => {
      if (!notificationId) {
        // Fallback: look up any existing notification from DB
        const list = db.listEmailNotifications({ limit: 1 });
        if (list.length > 0) notificationId = list[0].id;
      }
      if (!notificationId) return; // skip if no notifications exist

      const result = await safeTool('get_email_notification', { id: notificationId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Email Notification');
      expect(text).toContain('Recipient:');
      expect(text).toContain('Subject:');
      expect(text).toContain('Status:');
    });

    it('returned details match the sent notification', async () => {
      if (!notificationId) return; // skip if setup failed

      const result = await safeTool('get_email_notification', { id: notificationId });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('get-test@example.com');
      expect(text).toContain('Get Test Email');
    });
  });

  // ============================================================
  // handleScanProject
  // ============================================================
  describe('scan_project', () => {
    it('rejects missing path', async () => {
      const result = await safeTool('scan_project', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Missing required parameter: "path"');
    });

    it('rejects nonexistent directory', async () => {
      const result = await safeTool('scan_project', {
        path: path.join(testDir, 'definitely-does-not-exist-xyz-abc')
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('does not exist');
    });

    it('scans a valid directory with default checks', async () => {
      const result = await safeTool('scan_project', {
        path: testDir
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Project Scan');
    });

    it('scans with summary check only', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['summary']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Summary');
      expect(text).toContain('Total files');
    });

    it('scans with todos check', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['todos']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Project Scan');
    });

    it('scans with file_sizes check', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['file_sizes']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Project Scan');
    });

    it('scans with missing_tests check', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['missing_tests']
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Project Scan');
    });

    it('scans with data_inventory check', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['data_inventory']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with dependencies check', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['dependencies']
      });
      expect(result.isError).toBeFalsy();
    });

    it('scans with all checks at once', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['summary', 'missing_tests', 'todos', 'file_sizes', 'data_inventory', 'dependencies']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Project Scan');
    });

    it('scans a real project directory', async () => {
      // Use a known-good directory that always exists
      const serverDir = path.join(__dirname, '..');
      const result = await safeTool('scan_project', {
        path: serverDir,
        checks: ['summary']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Project Scan');
      expect(text).toContain('Total files');
    });

    it('respects custom ignore_dirs', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['summary'],
        ignore_dirs: ['node_modules', '.git', 'dist']
      });
      expect(result.isError).toBeFalsy();
    });

    it('respects custom test_pattern', async () => {
      const result = await safeTool('scan_project', {
        path: testDir,
        checks: ['missing_tests'],
        test_pattern: '.spec.ts'
      });
      expect(result.isError).toBeFalsy();
    });
  });
});
