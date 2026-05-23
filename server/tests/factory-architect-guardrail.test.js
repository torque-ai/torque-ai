'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
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

  test('detectStuckDimensions uses the bisection loop to find pastScore', () => {
    // Distinct from the "flat history" stuck test above: that test happens to
    // pass via the `pastScore = history[0].score` FALLBACK. Here we force
    // multiple snapshots BEFORE the K-th item's timestamp and one snapshot
    // AFTER it, so the bisection loop body must run and advance pastScore
    // past history[0] before breaking. If the loop body were removed,
    // pastScore would stay at history[0].score=20 and currentScore-pastScore
    // would be 11, NOT < epsilon(3), so the dimension would not be flagged.
    const { detectStuckDimensions } = require('../factory/architect-runner');
    const bisectProject = factoryHealth.registerProject({
      name: 'BisectProj', path: '/tmp/bisect-proj', trust_level: 'supervised',
    });

    const db = rawDb();
    // Baseline snapshot well in the past, score 20. This is history[0] and
    // would be the fallback's pastScore.
    db.prepare(`
      INSERT INTO factory_health_snapshots (project_id, dimension, score, scan_type, scanned_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(bisectProject.id, 'test_coverage', 20, 'incremental', '2026-01-01 00:00:00');
    // Intermediate snapshot, still before the items, score 30. This is the
    // value the bisection loop must converge on.
    db.prepare(`
      INSERT INTO factory_health_snapshots (project_id, dimension, score, scan_type, scanned_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(bisectProject.id, 'test_coverage', 30, 'incremental', '2026-02-01 00:00:00');

    // 9 test-coverage-aligned completed work items. createWorkItem stamps
    // updated_at as new Date().toISOString() (current time, well after the
    // two baseline snapshots above and well before the current snapshot below).
    for (let i = 0; i < 9; i++) {
      factoryIntake.createWorkItem({
        project_id: bisectProject.id, source: 'manual',
        title: `Add unit test coverage bisect ${i}`, status: 'completed',
      });
    }

    // Current snapshot in the far future, score 31. The bisection loop
    // must NOT include this in pastScore; it must break before it.
    db.prepare(`
      INSERT INTO factory_health_snapshots (project_id, dimension, score, scan_type, scanned_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(bisectProject.id, 'test_coverage', 31, 'incremental', '2099-01-01 00:00:00');

    const weak = [{ dimension: 'test_coverage', score: 31 }];
    const stuck = detectStuckDimensions(bisectProject.id, weak, { k: 8, epsilon: 3 });
    // currentScore(31) - pastScore(30 via bisection) = 1, which is < epsilon(3) → stuck.
    // If the loop body were broken, pastScore would stay at 20 and 31-20=11 would
    // NOT be < 3, so this test would fail.
    expect(stuck.has('test_coverage')).toBe(true);
  });

  test('getSortedWeakDimensions sorts stuck dimensions last', () => {
    const { getSortedWeakDimensions } = require('../factory/architect-runner');
    const scores = { test_coverage: 12, build_ci: 32, security: 50 };
    const sorted = getSortedWeakDimensions(scores, new Set(['test_coverage']));
    // test_coverage has the lowest score but is stuck, so it must not be first.
    expect(sorted[0].dimension).toBe('build_ci');
    expect(sorted[sorted.length - 1].dimension).toBe('test_coverage');
  });

  test('prioritizeByHealth ranks stuck-dimension work below non-stuck work', () => {
    const { prioritizeByHealth } = require('../factory/architect-runner');
    const items = [
      { id: '1', title: 'Add unit test coverage', created_at: '2026-01-01T00:00:00Z' },
      { id: '2', title: 'Fix the CI build pipeline', created_at: '2026-01-01T00:00:00Z' },
    ];
    const scores = { test_coverage: 12, build_ci: 32 };
    const backlog = prioritizeByHealth(items, scores, { stuckDimensions: new Set(['test_coverage']) });
    // build_ci item should rank first because test_coverage is demoted.
    expect(backlog[0].work_item_id).toBe('2');
  });

  test('emitStuckDimensionFindings records a high-severity finding', () => {
    const { emitStuckDimensionFindings } = require('../factory/architect-runner');
    const fp = factoryHealth.registerProject({
      name: 'FindingProj', path: '/tmp/finding-proj', trust_level: 'supervised',
    });
    emitStuckDimensionFindings({ id: fp.id, name: 'FindingProj' }, new Set(['test_coverage']), { test_coverage: 12 });

    const history = factoryHealth.getScoreHistory(fp.id, 'test_coverage', 5, { order: 'DESC' });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].scan_type).toBe('architect_guard');
    const findings = factoryHealth.getFindingsForSnapshots([history[0].id]);
    expect(findings[history[0].id][0].severity).toBe('high');
  });
});
