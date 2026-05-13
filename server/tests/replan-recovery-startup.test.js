'use strict';

const factoryIntake = require('../db/factory/intake');
const factoryHealth = require('../db/factory/health');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  cleanupStaleReplanClaims,
  getReplanRecoveryInstanceId,
} = require('../factory/replan-recovery');

describe('cleanupStaleReplanClaims', () => {
  let db, testDir;
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-startup-${Date.now()}`));
    db = rawDb();
  });
  afterEach(() => { teardownTestDb(); });

  it('clears claims from prior instances; preserves current instance claims', () => {
    const project = factoryHealth.registerProject({
      name: 'startup test',
      path: testDir,
      trust_level: 'dark',
      config: { loop: { auto_continue: false } },
    });
    factoryHealth.updateProject(project.id, { status: 'running' });
    const itemA = factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'a', description: 'd' });
    const itemB = factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'b', description: 'd' });
    db.prepare(`UPDATE factory_work_items SET claimed_by_instance_id = 'old-uuid:replan' WHERE id = ?`).run(itemA.id);
    db.prepare(`UPDATE factory_work_items SET claimed_by_instance_id = 'current-uuid:replan' WHERE id = ?`).run(itemB.id);

    const cleared = cleanupStaleReplanClaims(db, 'current-uuid');
    expect(cleared).toBe(1);

    const a = factoryIntake.getWorkItem(itemA.id);
    const b = factoryIntake.getWorkItem(itemB.id);
    expect(a.claimed_by_instance_id).toBeNull();
    expect(b.claimed_by_instance_id).toBe('current-uuid:replan');
  });

  it('clears legacy default claims when the current instance has a real id', () => {
    const project = factoryHealth.registerProject({
      name: 'legacy default claim test',
      path: testDir,
      trust_level: 'dark',
      config: { loop: { auto_continue: false } },
    });
    factoryHealth.updateProject(project.id, { status: 'running' });
    const stale = factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'stale', description: 'd' });
    const current = factoryIntake.createWorkItem({ project_id: project.id, source: 'manual', title: 'current', description: 'd' });
    db.prepare(`UPDATE factory_work_items SET claimed_by_instance_id = 'default:replan' WHERE id = ?`).run(stale.id);
    db.prepare(`UPDATE factory_work_items SET claimed_by_instance_id = 'mcp-current:replan' WHERE id = ?`).run(current.id);

    const cleared = cleanupStaleReplanClaims(db, 'mcp-current');
    expect(cleared).toBe(1);

    expect(factoryIntake.getWorkItem(stale.id).claimed_by_instance_id).toBeNull();
    expect(factoryIntake.getWorkItem(current.id).claimed_by_instance_id).toBe('mcp-current:replan');
  });

  it('uses the MCP instance id instead of a shared default fallback', () => {
    const previous = process.env.TORQUE_INSTANCE_ID;
    delete process.env.TORQUE_INSTANCE_ID;
    try {
      expect(getReplanRecoveryInstanceId({ getMcpInstanceId: () => 'mcp-current' })).toBe('mcp-current');
    } finally {
      if (previous === undefined) {
        delete process.env.TORQUE_INSTANCE_ID;
      } else {
        process.env.TORQUE_INSTANCE_ID = previous;
      }
    }
  });

  it('returns 0 when no stale claims exist', () => {
    expect(cleanupStaleReplanClaims(db, 'fresh-uuid')).toBe(0);
  });
});
