const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Email Notifications', () => {
  let db;

  beforeAll(() => {
    const setup = setupTestDb('email-notifications');
    db = setup.db;
  });
  afterAll(() => { teardownTestDb(); });

  // ============================================================
  // Database-level: recordEmailNotification
  // ============================================================
  describe('recordEmailNotification', () => {
    it('persists a notification to the database', () => {
      const notification = db.recordEmailNotification({
        id: 'email-001',
        recipient: 'user@example.com',
        subject: 'Test Subject',
        status: 'pending',
        sent_at: new Date().toISOString()
      });
      expect(notification).toBeTruthy();
      expect(notification.id).toBe('email-001');
      expect(notification.recipient).toBe('user@example.com');
      expect(notification.subject).toBe('Test Subject');
      expect(notification.status).toBe('pending');
    });

    it('persists with task_id association', () => {
      const notification = db.recordEmailNotification({
        id: 'email-002',
        task_id: 'task-abc',
        recipient: 'admin@example.com',
        subject: 'Task Complete',
        status: 'sent',
        sent_at: new Date().toISOString()
      });
      expect(notification.task_id).toBe('task-abc');
      expect(notification.status).toBe('sent');
    });

    it('throws when required fields are missing', () => {
      expect(() => db.recordEmailNotification({ id: 'x' })).toThrow();
      expect(() => db.recordEmailNotification({ id: 'x', recipient: 'a@b.com' })).toThrow();
    });
  });

  // ============================================================
  // Database-level: listEmailNotifications
  // ============================================================
  describe('listEmailNotifications', () => {
    it('returns all notifications without filters', () => {
      const list = db.listEmailNotifications();
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by status', () => {
      const pending = db.listEmailNotifications({ status: 'pending' });
      expect(pending.every(n => n.status === 'pending')).toBe(true);

      const sent = db.listEmailNotifications({ status: 'sent' });
      expect(sent.every(n => n.status === 'sent')).toBe(true);
    });

    it('filters by task_id', () => {
      const results = db.listEmailNotifications({ task_id: 'task-abc' });
      expect(results.length).toBe(1);
      expect(results[0].task_id).toBe('task-abc');
    });

    it('respects limit parameter', () => {
      const results = db.listEmailNotifications({ limit: 1 });
      expect(results.length).toBe(1);
    });
  });

  // ============================================================
  // Database-level: getEmailNotification
  // ============================================================
  describe('getEmailNotification', () => {
    it('returns notification by id', () => {
      const n = db.getEmailNotification('email-001');
      expect(n).toBeTruthy();
      expect(n.id).toBe('email-001');
    });

    it('returns null for non-existent id', () => {
      const n = db.getEmailNotification('nonexistent');
      expect(n).toBeNull();
    });

    it('returns null for null/undefined id', () => {
      expect(db.getEmailNotification(null)).toBeNull();
      expect(db.getEmailNotification(undefined)).toBeNull();
    });
  });

  // ============================================================
  // Database-level: updateEmailNotificationStatus
  // ============================================================
  describe('updateEmailNotificationStatus', () => {
    it('updates status successfully', () => {
      const updated = db.updateEmailNotificationStatus('email-001', 'sent');
      expect(updated.status).toBe('sent');
    });

    it('updates status with error message', () => {
      db.recordEmailNotification({
        id: 'email-003',
        recipient: 'fail@example.com',
        subject: 'Will Fail',
        status: 'pending',
        sent_at: new Date().toISOString()
      });
      const updated = db.updateEmailNotificationStatus('email-003', 'failed', 'Connection refused');
      expect(updated.status).toBe('failed');
      expect(updated.error).toBe('Connection refused');
    });

    it('throws when id or status is missing', () => {
      expect(() => db.updateEmailNotificationStatus(null, 'sent')).toThrow();
      expect(() => db.updateEmailNotificationStatus('email-001', null)).toThrow();
    });
  });

  // ============================================================
  // Handler: send_email_notification
  // ============================================================
  describe('send_email_notification handler', () => {
    it('validates email format', async () => {
      const result = await safeTool('send_email_notification', {
        recipient: 'not-an-email',
        subject: 'Test',
        body: 'Test body'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid email');
    });

    it('requires recipient, subject, and body', async () => {
      const r1 = await safeTool('send_email_notification', { subject: 'Test', body: 'Body' });
      expect(r1.isError).toBe(true);

      const r2 = await safeTool('send_email_notification', { recipient: 'a@b.com', body: 'Body' });
      expect(r2.isError).toBe(true);

      const r3 = await safeTool('send_email_notification', { recipient: 'a@b.com', subject: 'Test' });
      expect(r3.isError).toBe(true);
    });

    it('records as pending when SMTP is not configured', async () => {
      // Ensure SMTP env vars are not set
      const origHost = process.env.SMTP_HOST;
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      delete process.env.SMTP_FROM;

      const result = await safeTool('send_email_notification', {
        recipient: 'user@example.com',
        subject: 'No SMTP Test',
        body: 'This should be pending'
      });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('pending');
      expect(text).toContain('SMTP is not configured');

      // Restore
      if (origHost !== undefined) process.env.SMTP_HOST = origHost;
    });

    it('records pending notification with task_id association', async () => {
      delete process.env.SMTP_HOST;

      const result = await safeTool('send_email_notification', {
        recipient: 'dev@example.com',
        subject: 'Task Alert',
        body: 'Task completed',
        task_id: 'task-xyz'
      });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('pending');

      // Verify in DB
      const notifications = db.listEmailNotifications({ task_id: 'task-xyz' });
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      expect(notifications[0].recipient).toBe('dev@example.com');
    });
  });

  // ============================================================
  // Handler: list_email_notifications
  // ============================================================
  describe('list_email_notifications handler', () => {
    it('returns paginated results', async () => {
      const result = await safeTool('list_email_notifications', { limit: 10 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Email Notifications');
    });

    it('filters by status', async () => {
      const result = await safeTool('list_email_notifications', { status: 'pending' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Email Notifications');
    });

    it('returns empty message when no results', async () => {
      const result = await safeTool('list_email_notifications', { status: 'sent', task_id: 'nonexistent-task' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('No email notifications found');
    });
  });

  // ============================================================
  // Handler: get_email_notification
  // ============================================================
  describe('get_email_notification handler', () => {
    it('returns correct notification by id', async () => {
      const result = await safeTool('get_email_notification', { id: 'email-002' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('email-002');
      expect(text).toContain('admin@example.com');
      expect(text).toContain('Task Complete');
    });

    it('returns error for non-existent id', async () => {
      const result = await safeTool('get_email_notification', { id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('requires id parameter', async () => {
      const result = await safeTool('get_email_notification', {});
      expect(result.isError).toBe(true);
    });
  });
});
