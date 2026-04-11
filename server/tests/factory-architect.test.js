'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryArchitect = require('../db/factory-architect');
const { buildArchitectPrompt } = require('../factory/architect-prompt');
const { runArchitectCycle, prioritizeByHealth } = require('../factory/architect-runner');
const handlers = require('../handlers/factory-handlers');

function createFactoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fhs_project_dim
      ON factory_health_snapshots(project_id, dimension, scanned_at);
    CREATE INDEX IF NOT EXISTS idx_fhs_project_time
      ON factory_health_snapshots(project_id, scanned_at);

    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fhf_snapshot
      ON factory_health_findings(snapshot_id);

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
      ON factory_work_items(status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_fwi_source
      ON factory_work_items(source);
    CREATE INDEX IF NOT EXISTS idx_fwi_linked
      ON factory_work_items(linked_item_id);

    CREATE TABLE IF NOT EXISTS factory_architect_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      input_snapshot_json TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      backlog_json TEXT NOT NULL,
      flags_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      trigger TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fac_project_time
      ON factory_architect_cycles(project_id, created_at);
  `);
}

function parseJsonResponse(result) {
  return JSON.parse(result.content[0].text);
}

function requireHandler(name) {
  if (typeof handlers[name] !== 'function') {
    throw new Error(`${name} is not implemented`);
  }
  return handlers[name];
}

describe('factory-architect', () => {
  let db;
  let project;

  function seedHealthScores(scores) {
    for (const score of scores) {
      db.prepare(`
        INSERT INTO factory_health_snapshots (
          project_id,
          dimension,
          score,
          details_json,
          scan_type,
          batch_id,
          scanned_at
        )
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        project.id,
        score.dimension,
        score.score,
        score.details ? JSON.stringify(score.details) : null,
        score.scan_type || 'incremental',
        score.batch_id || null,
      );
    }
  }

  function setCycleCreatedAt(cycleId, createdAt) {
    db.prepare('UPDATE factory_architect_cycles SET created_at = ? WHERE id = ?').run(createdAt, cycleId);
  }

  function createCycleWithCreatedAt(overrides, createdAt) {
    const cycle = factoryArchitect.createCycle({
      project_id: project.id,
      input_snapshot: { scores: { security: 20 } },
      reasoning: 'Architect reasoning',
      backlog: [],
      flags: [],
      trigger: 'manual',
      ...overrides,
    });
    setCycleCreatedAt(cycle.id, createdAt);
    return factoryArchitect.getCycle(cycle.id);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryArchitect.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Architect Test App',
      path: '/projects/factory-architect-test-app',
      brief: 'Test project for architect flows',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('createCycle stores and returns a cycle with parsed JSON fields', () => {
    const cycle = factoryArchitect.createCycle({
      project_id: project.id,
      input_snapshot: {
        healthScores: [{ dimension: 'security', score: 21 }],
        intakeItems: [{ id: 'work-1', title: 'Harden login' }],
      },
      reasoning: 'Security is weakest, so login hardening goes first.',
      backlog: [
        {
          work_item_id: 'work-1',
          title: 'Harden login',
          why: 'Security is weakest',
          expected_impact: { security: 'targeted' },
          scope_budget: 3,
          priority_rank: 1,
        },
      ],
      flags: [{ item: 'Login rate limit', reason: 'Need production traffic data' }],
      trigger: 'manual',
    });

    expect(cycle).toMatchObject({
      id: expect.any(Number),
      project_id: project.id,
      input_snapshot: {
        healthScores: [{ dimension: 'security', score: 21 }],
        intakeItems: [{ id: 'work-1', title: 'Harden login' }],
      },
      backlog: [
        expect.objectContaining({
          work_item_id: 'work-1',
          title: 'Harden login',
          priority_rank: 1,
        }),
      ],
      reasoning: 'Security is weakest, so login hardening goes first.',
      flags: [{ item: 'Login rate limit', reason: 'Need production traffic data' }],
    });
  });

  it('getLatestCycle returns most recent cycle for a project', () => {
    createCycleWithCreatedAt(
      { reasoning: 'First cycle', backlog: [{ title: 'First backlog item' }] },
      '2026-04-10T10:00:00.000Z'
    );
    const latestCycle = createCycleWithCreatedAt(
      { reasoning: 'Second cycle', backlog: [{ title: 'Second backlog item' }] },
      '2026-04-10T10:00:05.000Z'
    );

    const cycle = factoryArchitect.getLatestCycle(project.id);

    expect(cycle.id).toBe(latestCycle.id);
    expect(cycle.reasoning).toBe('Second cycle');
    expect(cycle.backlog).toEqual([{ title: 'Second backlog item' }]);
  });

  it('listCycles returns ordered by created_at DESC', () => {
    createCycleWithCreatedAt(
      { reasoning: 'Oldest cycle', backlog: [{ title: 'Oldest backlog item' }] },
      '2026-04-10T10:00:00.000Z'
    );
    const middle = createCycleWithCreatedAt(
      { reasoning: 'Middle cycle', backlog: [{ title: 'Middle backlog item' }] },
      '2026-04-10T10:00:10.000Z'
    );
    const newest = createCycleWithCreatedAt(
      { reasoning: 'Newest cycle', backlog: [{ title: 'Newest backlog item' }] },
      '2026-04-10T10:00:20.000Z'
    );

    const cycles = factoryArchitect.listCycles(project.id, 2);

    expect(cycles).toHaveLength(2);
    expect(cycles.map((cycle) => cycle.id)).toEqual([newest.id, middle.id]);
    expect(cycles.map((cycle) => cycle.reasoning)).toEqual(['Newest cycle', 'Middle cycle']);
  });

  it('getBacklog returns parsed backlog array from latest cycle', () => {
    createCycleWithCreatedAt(
      {
        reasoning: 'Earlier cycle',
        backlog: [{ title: 'Earlier backlog item', priority_rank: 1 }],
      },
      '2026-04-10T10:00:00.000Z'
    );
    createCycleWithCreatedAt(
      {
        reasoning: 'Latest cycle',
        backlog: [
          { title: 'Fix auth regression', priority_rank: 1 },
          { title: 'Add onboarding smoke test', priority_rank: 2 },
        ],
      },
      '2026-04-10T10:00:10.000Z'
    );

    const backlog = factoryArchitect.getBacklog(project.id);

    expect(backlog).toEqual([
      { title: 'Fix auth regression', priority_rank: 1 },
      { title: 'Add onboarding smoke test', priority_rank: 2 },
    ]);
  });

  it('getReasoningLog returns reasoning text entries', () => {
    createCycleWithCreatedAt(
      { reasoning: 'Initial architect reasoning', backlog: [{ title: 'Initial work' }] },
      '2026-04-10T10:00:00.000Z'
    );
    createCycleWithCreatedAt(
      { reasoning: 'Follow-up architect reasoning', backlog: [{ title: 'Follow-up work' }] },
      '2026-04-10T10:00:10.000Z'
    );

    const entries = factoryArchitect.getReasoningLog(project.id, 5);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(expect.objectContaining({
      reasoning: 'Follow-up architect reasoning',
      created_at: '2026-04-10T10:00:10.000Z',
    }));
    expect(entries[1]).toEqual(expect.objectContaining({
      reasoning: 'Initial architect reasoning',
      created_at: '2026-04-10T10:00:00.000Z',
    }));
  });

  it('buildArchitectPrompt includes health scores and product-sense questions', () => {
    const prompt = buildArchitectPrompt({
      project: {
        id: project.id,
        name: project.name,
        brief: 'A factory dashboard focused on developer workflow quality.',
      },
      healthScores: [
        { dimension: 'security', score: 18 },
        { dimension: 'user_facing', score: 42 },
        { dimension: 'documentation', score: 73 },
      ],
      intakeItems: [
        {
          id: 'item-1',
          title: 'Harden login flow',
          description: 'Protect the first-run authentication path.',
          priority: 100,
          source: 'api',
        },
      ],
      previousBacklog: [{ title: 'Previous backlog item' }],
      previousReasoning: 'Previous reasoning text',
    });

    expect(prompt).toContain('## Health scores');
    expect(prompt).toContain('- security: 18');
    expect(prompt).toContain('- user_facing: 42');
    expect(prompt).toContain('- documentation: 73');
    expect(prompt).toContain('## Intake queue');
    expect(prompt).toContain('[item-1] Harden login flow');
    expect(prompt).toContain('Protect the first-run authentication path.');
    expect(prompt).toContain('## Product-sense questions');
    expect(prompt).toContain('What does a new user encounter first? Is that path solid?');
    expect(prompt).toContain('If this shipped today, what would embarrass you?');
  });

  it('buildArchitectPrompt truncates intake to 20 items', () => {
    const intakeItems = Array.from({ length: 25 }, (_, index) => ({
      id: `item-${index}`,
      title: `Intake item ${index}`,
      description: `Description for item ${index}`,
      priority: index,
      source: 'conversational',
    }));

    const prompt = buildArchitectPrompt({
      project: {
        id: project.id,
        name: project.name,
        brief: project.brief,
      },
      healthScores: [{ dimension: 'security', score: 20 }],
      intakeItems,
      previousBacklog: [],
      previousReasoning: '',
    });

    const renderedIds = prompt.match(/\[item-\d+\]/g) || [];

    expect(prompt).toContain('Truncated intake queue from 25 items to the top 20 by priority.');
    expect(renderedIds).toHaveLength(20);
    expect(prompt).toContain('[item-24]');
    expect(prompt).toContain('[item-5]');
    expect(prompt).not.toContain('[item-4]');
    expect(prompt).not.toContain('[item-0]');
  });

  it('prioritizeByHealth sorts by weakest dimension', () => {
    const backlog = prioritizeByHealth(
      [
        {
          id: 'item-docs',
          title: 'Refresh setup guide',
          description: 'Update documentation for local development.',
          priority: 'default',
          created_at: '2026-04-10T10:00:00.000Z',
        },
        {
          id: 'item-security',
          title: 'Harden authentication flow',
          description: 'Fix login and permission checks.',
          priority: 'default',
          created_at: '2026-04-10T10:00:10.000Z',
        },
      ],
      [
        { dimension: 'security', score: 12 },
        { dimension: 'documentation', score: 65 },
      ]
    );

    expect(backlog.map((item) => item.title)).toEqual([
      'Harden authentication flow',
      'Refresh setup guide',
    ]);
    expect(backlog[0].expected_impact).toEqual({ security: 'targeted' });
  });

  it('prioritizeByHealth puts user_override items first', () => {
    const backlog = prioritizeByHealth(
      [
        {
          id: 'item-docs',
          title: 'Refresh docs',
          description: 'Update the readme.',
          priority: 'user_override',
          created_at: '2026-04-10T10:00:10.000Z',
        },
        {
          id: 'item-security',
          title: 'Fix auth checks',
          description: 'Address a security regression.',
          priority: 'default',
          created_at: '2026-04-10T10:00:00.000Z',
        },
      ],
      [
        { dimension: 'security', score: 5 },
        { dimension: 'documentation', score: 80 },
      ]
    );

    expect(backlog.map((item) => item.title)).toEqual([
      'Refresh docs',
      'Fix auth checks',
    ]);
    expect(backlog[0].why).toContain('User override priority takes precedence.');
  });

  it('runArchitectCycle creates a cycle and updates intake items', async () => {
    seedHealthScores([
      { dimension: 'security', score: 8 },
      { dimension: 'documentation', score: 70 },
      { dimension: 'performance', score: 55 },
    ]);
    const securityItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Fix authentication regression',
      description: 'Security review for login and session paths.',
    });
    const docsItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Refresh onboarding docs',
      description: 'Update setup instructions for new contributors.',
    });

    const cycle = await runArchitectCycle(project.id, 'manual');

    expect(cycle).toMatchObject({
      id: expect.any(Number),
      project_id: project.id,
      reasoning: expect.any(String),
      backlog: expect.any(Array),
      flags: [],
      trigger: 'manual',
    });
    expect(cycle.backlog.map((item) => item.title)).toEqual([
      'Fix authentication regression',
      'Refresh onboarding docs',
    ]);
    expect(factoryArchitect.getLatestCycle(project.id).id).toBe(cycle.id);
    expect(factoryIntake.getWorkItem(securityItem.id).status).toBe('prioritized');
    expect(factoryIntake.getWorkItem(docsItem.id).status).toBe('prioritized');
  });

  it('handleTriggerArchitect returns cycle data', async () => {
    const handleTriggerArchitect = requireHandler('handleTriggerArchitect');

    seedHealthScores([
      { dimension: 'security', score: 11 },
      { dimension: 'user_facing', score: 60 },
    ]);
    factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Fix authentication regression',
      description: 'Security review for login and session paths.',
    });

    const result = await handleTriggerArchitect({ project: project.id });
    const data = parseJsonResponse(result);
    const cycle = data.cycle || data;

    expect(cycle).toMatchObject({
      reasoning: expect.any(String),
      backlog: expect.any(Array),
    });
    expect(cycle.backlog.length).toBeGreaterThan(0);
  });

  it('handleArchitectBacklog returns ordered backlog', async () => {
    const handleArchitectBacklog = requireHandler('handleArchitectBacklog');

    createCycleWithCreatedAt(
      {
        reasoning: 'Backlog reasoning',
        backlog: [
          { title: 'Fix auth regression', priority_rank: 1 },
          { title: 'Refresh onboarding docs', priority_rank: 2 },
        ],
      },
      '2026-04-10T10:00:10.000Z'
    );

    const result = await handleArchitectBacklog({ project: project.id });
    const data = parseJsonResponse(result);
    const backlog = data.backlog || data;

    expect(backlog).toEqual([
      expect.objectContaining({ title: 'Fix auth regression', priority_rank: 1 }),
      expect.objectContaining({ title: 'Refresh onboarding docs', priority_rank: 2 }),
    ]);
  });

  it('handleArchitectLog returns reasoning history', async () => {
    const handleArchitectLog = requireHandler('handleArchitectLog');

    createCycleWithCreatedAt(
      { reasoning: 'First reasoning entry', backlog: [{ title: 'Initial work' }] },
      '2026-04-10T10:00:00.000Z'
    );
    createCycleWithCreatedAt(
      { reasoning: 'Second reasoning entry', backlog: [{ title: 'Follow-up work' }] },
      '2026-04-10T10:00:10.000Z'
    );

    const result = await handleArchitectLog({ project: project.id, limit: 10 });
    const data = parseJsonResponse(result);
    const entries = data.entries || data.log || data;

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(expect.objectContaining({ reasoning: 'Second reasoning entry' }));
    expect(entries[1]).toEqual(expect.objectContaining({ reasoning: 'First reasoning entry' }));
  });
});
