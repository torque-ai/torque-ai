'use strict';

const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('replan-recovery migration (v51)', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-recovery-migration-${Date.now()}`));
    db = rawDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('adds recovery_attempts, last_recovery_at, recovery_history_json, depth columns', () => {
    const cols = db.prepare(`PRAGMA table_info(factory_work_items)`).all();
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('recovery_attempts')).toBe(true);
    expect(colNames.has('last_recovery_at')).toBe(true);
    expect(colNames.has('recovery_history_json')).toBe(true);
    expect(colNames.has('depth')).toBe(true);
  });

  it('default values: recovery_attempts=0, depth=0, others null', () => {
    const project = factoryHealth.registerProject({
      name: `Migration Test ${Math.random().toString(16).slice(2)}`,
      path: `${testDir}/migration-test`,
      trust_level: 'dark',
    });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'migration default test',
      description: 'check defaults',
    });
    const row = db.prepare(`SELECT recovery_attempts, last_recovery_at, recovery_history_json, depth FROM factory_work_items WHERE id = ?`).get(item.id);
    expect(row.recovery_attempts).toBe(0);
    expect(row.last_recovery_at).toBeNull();
    expect(row.recovery_history_json).toBeNull();
    expect(row.depth).toBe(0);
  });

  it('accepts needs_review and superseded as valid statuses', () => {
    const project = factoryHealth.registerProject({
      name: `Status Test ${Math.random().toString(16).slice(2)}`,
      path: `${testDir}/status-test`,
      trust_level: 'dark',
    });
    expect(() => factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'status needs_review',
      description: 'x',
      status: 'needs_review',
    })).not.toThrow();
    expect(() => factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'status superseded',
      description: 'x',
      status: 'superseded',
    })).not.toThrow();
  });

  it('accepts recovery_split as a valid source', () => {
    const project = factoryHealth.registerProject({
      name: `Source Test ${Math.random().toString(16).slice(2)}`,
      path: `${testDir}/source-test`,
      trust_level: 'dark',
    });
    expect(() => factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'recovery_split',
      title: 'split child',
      description: 'x',
    })).not.toThrow();
  });
});
