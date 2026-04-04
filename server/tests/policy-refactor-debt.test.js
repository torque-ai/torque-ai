const { createHash } = require('crypto');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const refactorDebtAdapter = require('../policy-engine/adapters/refactor-debt');

describe('policy refactor debt adapter', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('policy-refactor-debt'));
  });

  afterEach(() => {
    teardownTestDb();
  });

  function createTask(id, overrides = {}) {
    db.createTask({
      id,
      task_description: overrides.task_description || `Task ${id}`,
      status: overrides.status || 'completed',
      provider: overrides.provider || 'codex',
      working_directory: overrides.working_directory || testDir,
      project: overrides.project || 'Torque',
      ...overrides,
    });
    return id;
  }

  function seedComplexityMetric({
    taskId,
    filePath,
    cyclomatic,
    cognitive,
    analyzedAt,
    linesOfCode = 100,
    functionCount = 4,
    maxNestingDepth = 3,
    maintainabilityIndex = 70,
  }) {
    rawDb().prepare(`
      INSERT INTO complexity_metrics (
        task_id, file_path, cyclomatic_complexity, cognitive_complexity,
        lines_of_code, function_count, max_nesting_depth, maintainability_index, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      filePath,
      cyclomatic,
      cognitive,
      linesOfCode,
      functionCount,
      maxNestingDepth,
      maintainabilityIndex,
      analyzedAt,
    );
  }

  function seedBacklogItem({
    id,
    project = 'Torque',
    filePath,
    status = 'open',
    hotspotId = null,
    taskId = null,
  }) {
    rawDb().prepare(`
      INSERT INTO refactor_backlog_items (
        id, project, file_path, hotspot_id, description, status, priority, task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      project,
      filePath,
      hotspotId,
      `Refactor ${filePath}`,
      status,
      5,
      taskId,
    );
  }

  function hasViolation(evidence) {
    return evidence.hotspots_worsened.length > 0 && !evidence.has_backlog_item;
  }

  function buildHotspotId(project, filePath) {
    return `refactor-hotspot:${createHash('sha256').update(`${project}:${filePath}`).digest('hex')}`;
  }

  it('returns no violation when complexity improves', () => {
    createTask('task-improve-prev');
    createTask('task-improve-now');
    seedComplexityMetric({
      taskId: 'task-improve-prev',
      filePath: 'server/db/code-analysis.js',
      cyclomatic: 12,
      cognitive: 30,
      analyzedAt: '2026-03-09T10:00:00.000Z',
    });
    seedComplexityMetric({
      taskId: 'task-improve-now',
      filePath: 'server/db/code-analysis.js',
      cyclomatic: 8,
      cognitive: 20,
      analyzedAt: '2026-03-10T10:00:00.000Z',
    });

    const evidence = refactorDebtAdapter.collectEvidence(
      { id: 'task-improve-now', project: 'Torque' },
      ['server/db/code-analysis.js'],
    );

    expect(evidence).toEqual({
      hotspots_worsened: [],
      has_backlog_item: false,
      files_checked: 1,
    });
    expect(hasViolation(evidence)).toBe(false);
    expect(rawDb().prepare('SELECT COUNT(*) AS count FROM refactor_hotspots').get().count).toBe(0);
  });

  it('returns no violation when complexity worsens but backlog item exists', () => {
    createTask('task-backlog-prev');
    createTask('task-backlog-now');
    seedComplexityMetric({
      taskId: 'task-backlog-prev',
      filePath: 'server/policy-engine/engine.js',
      cyclomatic: 10,
      cognitive: 18,
      analyzedAt: '2026-03-09T11:00:00.000Z',
    });
    seedComplexityMetric({
      taskId: 'task-backlog-now',
      filePath: 'server/policy-engine/engine.js',
      cyclomatic: 14,
      cognitive: 25,
      analyzedAt: '2026-03-10T11:00:00.000Z',
    });
    seedBacklogItem({
      id: 'backlog-1',
      filePath: 'server/policy-engine/engine.js',
      status: 'open',
      taskId: 'task-backlog-now',
    });

    const evidence = refactorDebtAdapter.collectEvidence(
      { id: 'task-backlog-now', project: 'Torque' },
      ['server/policy-engine/engine.js'],
    );

    expect(evidence.files_checked).toBe(1);
    expect(evidence.hotspots_worsened).toHaveLength(1);
    expect(evidence.hotspots_worsened[0]).toMatchObject({
      file_path: 'server/policy-engine/engine.js',
      trend: 'worsening',
      backlog_item_exists: true,
    });
    expect(evidence.has_backlog_item).toBe(true);
    expect(hasViolation(evidence)).toBe(false);
  });

  it('returns violation when complexity worsens without backlog item', () => {
    createTask('task-violation-prev');
    createTask('task-violation-now');
    seedComplexityMetric({
      taskId: 'task-violation-prev',
      filePath: 'server/task-manager.js',
      cyclomatic: 20,
      cognitive: 40,
      analyzedAt: '2026-03-09T12:00:00.000Z',
    });
    seedComplexityMetric({
      taskId: 'task-violation-now',
      filePath: 'server/task-manager.js',
      cyclomatic: 24,
      cognitive: 51,
      analyzedAt: '2026-03-10T12:00:00.000Z',
    });

    const evidence = refactorDebtAdapter.collectEvidence(
      { id: 'task-violation-now', project: 'Torque' },
      ['server/task-manager.js'],
    );
    const hotspot = rawDb().prepare(`
      SELECT project, file_path, trend, change_frequency, last_worsened_at, complexity_score
      FROM refactor_hotspots
      WHERE project = ? AND file_path = ?
    `).get('Torque', 'server/task-manager.js');

    expect(evidence.hotspots_worsened).toHaveLength(1);
    expect(evidence.has_backlog_item).toBe(false);
    expect(hasViolation(evidence)).toBe(true);
    expect(hotspot).toMatchObject({
      project: 'Torque',
      file_path: 'server/task-manager.js',
      trend: 'worsening',
      change_frequency: 1,
      last_worsened_at: '2026-03-10T12:00:00.000Z',
      complexity_score: 75,
    });
  });

  it('correctly identifies trend from complexity_metrics history', () => {
    createTask('task-history-1');
    createTask('task-history-2');
    createTask('task-history-3');
    const hotspotId = buildHotspotId('Torque', 'server/db/schema-tables.js');
    rawDb().prepare(`
      INSERT INTO refactor_hotspots (
        id, project, file_path, complexity_score, change_frequency, trend, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      hotspotId,
      'Torque',
      'server/db/schema-tables.js',
      18,
      2,
      'stable',
      '2026-03-08 00:00:00',
      '2026-03-08 00:00:00',
    );
    seedComplexityMetric({
      taskId: 'task-history-1',
      filePath: 'server/db/schema-tables.js',
      cyclomatic: 6,
      cognitive: 12,
      analyzedAt: '2026-03-08T09:00:00.000Z',
    });
    seedComplexityMetric({
      taskId: 'task-history-2',
      filePath: 'server/db/schema-tables.js',
      cyclomatic: 7,
      cognitive: 14,
      analyzedAt: '2026-03-09T09:00:00.000Z',
    });
    seedComplexityMetric({
      taskId: 'task-history-3',
      filePath: 'server/db/schema-tables.js',
      cyclomatic: 10,
      cognitive: 19,
      analyzedAt: '2026-03-10T09:00:00.000Z',
    });

    const evidence = refactorDebtAdapter.collectEvidence(
      { id: 'task-history-3', project: 'Torque' },
      ['server/db/schema-tables.js'],
    );
    const hotspot = rawDb().prepare(`
      SELECT trend, change_frequency, last_worsened_at, complexity_score
      FROM refactor_hotspots
      WHERE project = ? AND file_path = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get('Torque', 'server/db/schema-tables.js');

    expect(evidence.hotspots_worsened).toHaveLength(1);
    expect(evidence.hotspots_worsened[0]).toMatchObject({
      trend: 'worsening',
      previous: {
        task_id: 'task-history-2',
        cyclomatic_complexity: 7,
        cognitive_complexity: 14,
      },
      current: {
        task_id: 'task-history-3',
        cyclomatic_complexity: 10,
        cognitive_complexity: 19,
      },
    });
    expect(hotspot).toMatchObject({
      trend: 'worsening',
      change_frequency: 3,
      last_worsened_at: '2026-03-10T09:00:00.000Z',
      complexity_score: 29,
    });
  });

  it('handles files with no prior complexity data gracefully', () => {
    createTask('task-first-pass');
    seedComplexityMetric({
      taskId: 'task-first-pass',
      filePath: 'server/policy-engine/adapters/refactor-debt.js',
      cyclomatic: 5,
      cognitive: 9,
      analyzedAt: '2026-03-10T13:00:00.000Z',
    });

    const evidence = refactorDebtAdapter.collectEvidence(
      { id: 'task-first-pass', project: 'Torque' },
      ['server/policy-engine/adapters/refactor-debt.js'],
    );

    expect(evidence).toEqual({
      hotspots_worsened: [],
      has_backlog_item: false,
      files_checked: 1,
    });
    expect(hasViolation(evidence)).toBe(false);
    expect(rawDb().prepare('SELECT COUNT(*) AS count FROM refactor_hotspots').get().count).toBe(0);
  });
});
