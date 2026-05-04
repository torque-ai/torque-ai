'use strict';

const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const handlers = require('../handlers/recovery-inbox-handlers');

const noopLogger = { warn() {}, error() {}, info() {} };

function createInboxItem(db, projectId, {
  attempts = 3,
  history = [{ attempt: 1, strategy: 'rewrite-description', outcome: 'failed', timestamp: '2026-04-29T00:00:00Z' }],
  rejectReason = 'plan_quality_gate_rejected_after_2_attempts',
} = {}) {
  const item = factoryIntake.createWorkItem({
    project_id: projectId,
    source: 'manual',
    title: `Inbox item ${Math.random().toString(16).slice(2)}`,
    description: 'desc',
    status: 'needs_review',
  });
  db.prepare(`
    UPDATE factory_work_items
    SET reject_reason = ?, recovery_attempts = ?, recovery_history_json = ?, last_recovery_at = ?
    WHERE id = ?
  `).run(rejectReason, attempts, JSON.stringify(history), new Date().toISOString(), item.id);
  return factoryIntake.getWorkItem(item.id);
}

function createDarkProject(testDir) {
  const suffix = Math.random().toString(16).slice(2);
  const project = factoryHealth.registerProject({
    name: `Inbox ${suffix}`,
    path: `${testDir}/${suffix}`,
    trust_level: 'dark',
    config: { loop: { auto_continue: false } },
  });
  return factoryHealth.updateProject(project.id, { status: 'running' });
}

describe('recovery-inbox handlers', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`recovery-inbox-${Date.now()}`));
    db = rawDb();
    handlers.setDbForTests(db);
  });
  afterEach(() => {
    handlers.setDbForTests(null);
    teardownTestDb();
  });

  describe('list_recovery_inbox', () => {
    it('returns items with status needs_review only', async () => {
      const project = createDarkProject(testDir);
      createInboxItem(db, project.id);
      factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'open', description: 'd' });
      const result = await handlers.listRecoveryInbox({ logger: noopLogger });
      expect(result.items.length).toBe(1);
      expect(result.items[0].status).toBe('needs_review');
      expect(result.items[0].why_we_gave_up).toMatch(/rewrite-description/i);
    });

    it('filters by project_id', async () => {
      const projA = createDarkProject(testDir);
      const projB = createDarkProject(testDir);
      createInboxItem(db, projA.id);
      createInboxItem(db, projB.id);
      const result = await handlers.listRecoveryInbox({ project_id: projA.id, logger: noopLogger });
      expect(result.items.length).toBe(1);
      expect(result.items[0].project_id).toBe(projA.id);
    });
  });

  describe('inspect_recovery_item', () => {
    it('returns full detail with parsed history', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      const result = await handlers.inspectRecoveryItem({ id: item.id, logger: noopLogger });
      expect(result.item.id).toBe(item.id);
      expect(Array.isArray(result.history)).toBe(true);
      expect(result.history[0].strategy).toBe('rewrite-description');
    });

    it('throws when id not found', async () => {
      await expect(handlers.inspectRecoveryItem({ id: 999999, logger: noopLogger })).rejects.toThrow();
    });
  });

  describe('revive_recovery_item', () => {
    it('mode=retry resets attempts and sets status to pending', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.reviveRecoveryItem({ id: item.id, mode: 'retry', logger: noopLogger });
      const updated = factoryIntake.getWorkItem(item.id);
      expect(updated.status).toBe('pending');
      expect(updated.recovery_attempts).toBe(0);
      expect(updated.reject_reason).toBeNull();
    });

    it('mode=edit applies updates and resets attempts', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.reviveRecoveryItem({
        id: item.id,
        mode: 'edit',
        updates: { title: 'New title', description: 'New description '.repeat(20) },
        logger: noopLogger,
      });
      const updated = factoryIntake.getWorkItem(item.id);
      expect(updated.status).toBe('pending');
      expect(updated.title).toBe('New title');
      expect(updated.description).toMatch(/New description/);
      expect(updated.recovery_attempts).toBe(0);
    });

    it('mode=split creates children and marks parent superseded', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.reviveRecoveryItem({
        id: item.id,
        mode: 'split',
        children: [
          { title: 'Child A', description: 'a'.repeat(150) },
          { title: 'Child B', description: 'b'.repeat(150) },
        ],
        logger: noopLogger,
      });
      const parent = factoryIntake.getWorkItem(item.id);
      expect(parent.status).toBe('superseded');
      const children = db.prepare('SELECT * FROM factory_work_items WHERE linked_item_id = ?').all(item.id);
      expect(children.length).toBe(2);
    });

    it('throws on unknown mode', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await expect(handlers.reviveRecoveryItem({ id: item.id, mode: 'bogus', logger: noopLogger })).rejects.toThrow();
    });
  });

  describe('dismiss_recovery_item', () => {
    it('flips status to unactionable with dismissed_from_inbox reject_reason', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.dismissRecoveryItem({ id: item.id, reason: 'no longer needed', logger: noopLogger });
      const updated = factoryIntake.getWorkItem(item.id);
      expect(updated.status).toBe('unactionable');
      expect(updated.reject_reason).toMatch(/^dismissed_from_inbox: no longer needed$/);
    });

    it('writes a decision-log entry', async () => {
      const project = createDarkProject(testDir);
      const item = createInboxItem(db, project.id);
      await handlers.dismissRecoveryItem({ id: item.id, reason: 'duplicate', logger: noopLogger });
      const decision = db.prepare(`
        SELECT * FROM factory_decisions WHERE action = 'recovery_inbox_dismissed' ORDER BY id DESC LIMIT 1
      `).get();
      expect(decision).toBeDefined();
    });
  });
});
