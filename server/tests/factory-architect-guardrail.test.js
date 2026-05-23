'use strict';

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');

let projectId;

describe('architect stuck-dimension guardrail', () => {
  beforeAll(() => {
    setupTestDb('architect-guardrail');
    const project = factoryHealth.registerProject({
      name: 'GuardrailTarget',
      path: '/tmp/guardrail-target',
      trust_level: 'supervised',
    });
    projectId = project.id;
  });

  afterAll(() => {
    teardownTestDb();
  });

  test('listResolvedWorkItems returns completed and shipped items only', () => {
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'done item', status: 'completed' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'shipped item', status: 'shipped' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'stale shipped item', status: 'shipped_stale' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'pending item', status: 'pending' });
    factoryIntake.createWorkItem({ project_id: projectId, source: 'manual', title: 'rejected item', status: 'rejected' });

    const resolved = factoryIntake.listResolvedWorkItems({ project_id: projectId });
    const titles = resolved.map(i => i.title);
    expect(titles).toContain('done item');
    expect(titles).toContain('shipped item');
    expect(titles).toContain('stale shipped item');
    expect(titles).not.toContain('pending item');
    expect(titles).not.toContain('rejected item');
  });

  test('matchItemToDimension maps an item to its dominant dimension', () => {
    const { matchItemToDimension } = require('../factory/architect-runner');
    expect(matchItemToDimension({ title: 'Add unit test for coverage', description: '' })).toBe('test_coverage');
    expect(matchItemToDimension({ title: 'Fix the CI build pipeline', description: '' })).toBe('build_ci');
    expect(matchItemToDimension({ title: 'wibble wobble', description: '' })).toBe(null);
  });

  test('getStuckThresholds returns defaults', () => {
    const { getStuckThresholds } = require('../factory/architect-runner');
    expect(getStuckThresholds()).toEqual({ k: 8, epsilon: 3 });
  });

  test('detectStuckDimensions flags a dimension whose score has not moved', () => {
    const { detectStuckDimensions } = require('../factory/architect-runner');

    const stuckProject = factoryHealth.registerProject({
      name: 'StuckProj', path: '/tmp/stuck-proj', trust_level: 'supervised',
    });

    // 9 completed, test-coverage-aligned work items.
    for (let i = 0; i < 9; i++) {
      factoryIntake.createWorkItem({
        project_id: stuckProject.id, source: 'manual',
        title: `Add unit test coverage ${i}`, status: 'completed',
      });
    }
    // Flat score history for test_coverage: 12 -> 13 (gain 1, below epsilon 3).
    factoryHealth.recordSnapshot({ project_id: stuckProject.id, dimension: 'test_coverage', score: 12, scan_type: 'incremental' });
    factoryHealth.recordSnapshot({ project_id: stuckProject.id, dimension: 'test_coverage', score: 13, scan_type: 'incremental' });

    const weak = [{ dimension: 'test_coverage', score: 13 }];
    const stuck = detectStuckDimensions(stuckProject.id, weak, { k: 8, epsilon: 3 });
    expect(stuck.has('test_coverage')).toBe(true);
  });

  test('detectStuckDimensions does not flag a dimension with too few items', () => {
    const { detectStuckDimensions } = require('../factory/architect-runner');
    const thinProject = factoryHealth.registerProject({
      name: 'ThinProj', path: '/tmp/thin-proj', trust_level: 'supervised',
    });
    factoryIntake.createWorkItem({
      project_id: thinProject.id, source: 'manual',
      title: 'Add unit test coverage', status: 'completed',
    });
    factoryHealth.recordSnapshot({ project_id: thinProject.id, dimension: 'test_coverage', score: 12, scan_type: 'incremental' });

    const weak = [{ dimension: 'test_coverage', score: 12 }];
    const stuck = detectStuckDimensions(thinProject.id, weak, { k: 8, epsilon: 3 });
    expect(stuck.has('test_coverage')).toBe(false);
  });
});
