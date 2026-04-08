'use strict';

const Database = require('better-sqlite3');

vi.mock('../providers/adapter-registry', () => ({
  getProviderAdapter: vi.fn(),
}));

vi.mock('../tools', () => ({
  handleToolCall: vi.fn(),
}));

const adapterRegistry = require('../providers/adapter-registry');
const tools = require('../tools');
const { createTables } = require('../db/schema-tables');
const { createOpenClawAdvisor } = require('../integrations/openclaw-advisor');

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createDb() {
  const db = new Database(':memory:');
  createTables(db, createLogger());
  return db;
}

function setConfig(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function getTask(db, id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    files_modified: row.files_modified ? JSON.parse(row.files_modified) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  };
}

function insertTask(db, overrides = {}) {
  const id = overrides.id || `task-${Math.random().toString(16).slice(2)}`;
  const createdAt = overrides.created_at || '2026-04-07T12:00:00.000Z';
  const startedAt = overrides.started_at || '2026-04-07T12:01:00.000Z';
  const completedAt = overrides.completed_at || '2026-04-07T12:03:00.000Z';
  db.prepare(`
    INSERT INTO tasks (
      id, status, task_description, working_directory, output, exit_code,
      created_at, started_at, completed_at, files_modified, tags, project,
      provider, model, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.status || 'completed',
    overrides.task_description || 'Finish the requested change',
    overrides.working_directory || 'C:/repo',
    overrides.output || 'Task finished successfully.',
    overrides.exit_code ?? 0,
    createdAt,
    overrides.status === 'completed' ? startedAt : (overrides.started_at || null),
    overrides.status === 'completed' ? completedAt : (overrides.completed_at || null),
    JSON.stringify(overrides.files_modified || ['server/example.js']),
    JSON.stringify(overrides.tags || []),
    overrides.project || 'demo',
    overrides.provider || 'codex',
    overrides.model || 'gpt-5.3-codex',
    JSON.stringify(overrides.metadata || {})
  );
  return getTask(db, id);
}

function insertProposal(db, overrides = {}) {
  const now = overrides.created_at || '2026-04-07T12:10:00.000Z';
  const id = overrides.id || `proposal-${Math.random().toString(16).slice(2)}`;
  db.prepare(`
    INSERT INTO openclaw_proposals (
      id, parent_task_id, project, status, task_description, rationale,
      confidence, suggested_provider, submitted_task_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.parent_task_id,
    overrides.project || 'demo',
    overrides.status || 'pending_approval',
    overrides.task_description || 'Add follow-up validation',
    overrides.rationale || 'Useful next step.',
    overrides.confidence || 'medium',
    overrides.suggested_provider || 'codex',
    overrides.submitted_task_id || null,
    now,
    overrides.updated_at || now
  );
  return db.prepare('SELECT * FROM openclaw_proposals WHERE id = ?').get(id);
}

function createAdvisor(db) {
  return createOpenClawAdvisor({
    db,
    taskCore: {
      getTask: (taskId) => getTask(db, taskId),
    },
    logger: createLogger(),
  });
}

describe('openclaw advisor', () => {
  let db;
  let advisor;
  let submitMock;

  beforeEach(() => {
    db = createDb();
    setConfig(db, 'openclaw_advisor_enabled', '1');
    setConfig(db, 'openclaw_advisor_provider', 'codex');
    setConfig(db, 'openclaw_advisor_max_proposals', '3');
    setConfig(db, 'openclaw_advisor_projects', '');
    advisor = createAdvisor(db);

    submitMock = vi.fn().mockResolvedValue({
      output: JSON.stringify({ proposals: [] }),
    });
    adapterRegistry.getProviderAdapter.mockReset().mockImplementation(() => ({
      submit: submitMock,
    }));
    tools.handleToolCall.mockReset().mockResolvedValue({ task_id: 'follow-up-task-1' });
  });

  afterEach(() => {
    db.close();
  });

  it('handleTaskCompletion creates a proposal request for matching projects', () => {
    setConfig(db, 'openclaw_advisor_projects', 'demo');
    const task = insertTask(db, {
      task_description: 'Implement API parity',
      output: 'Updated 3 routes and matching handlers.',
      files_modified: ['server/api/routes-passthrough.js'],
      project: 'demo',
    });

    const requestId = advisor.handleTaskCompletion(task);
    const row = db.prepare('SELECT * FROM openclaw_proposals WHERE id = ?').get(requestId);

    expect(requestId).toBeTruthy();
    expect(row.status).toBe('pending_generation');
    expect(row.parent_task_id).toBe(task.id);
    expect(row.project).toBe('demo');
    expect(JSON.parse(row.task_description)).toEqual(expect.objectContaining({
      task_id: task.id,
      description: 'Implement API parity',
      output_summary: 'Updated 3 routes and matching handlers.',
      files_modified: ['server/api/routes-passthrough.js'],
      duration_seconds: 120,
    }));
  });

  it('handleTaskCompletion skips tasks tagged openclaw-proposal', () => {
    const task = insertTask(db, {
      tags: ['openclaw-proposal'],
    });

    const requestId = advisor.handleTaskCompletion(task);
    const count = db.prepare('SELECT COUNT(*) AS count FROM openclaw_proposals').get();

    expect(requestId).toBeNull();
    expect(count.count).toBe(0);
  });

  it('handleTaskCompletion skips when advisor is disabled', () => {
    setConfig(db, 'openclaw_advisor_enabled', '0');
    const task = insertTask(db);

    const requestId = advisor.handleTaskCompletion(task);

    expect(requestId).toBeNull();
  });

  it('approveProposal submits to TORQUE with the correct project and tags', async () => {
    const parentTask = insertTask(db, {
      project: 'demo',
      working_directory: 'C:/repo/demo',
    });
    const proposal = insertProposal(db, {
      parent_task_id: parentTask.id,
      task_description: 'Add a regression test for the new advisor route',
      suggested_provider: 'ollama',
    });

    const submittedTaskId = await advisor.approveProposal(proposal.id);
    const updated = db.prepare('SELECT * FROM openclaw_proposals WHERE id = ?').get(proposal.id);

    expect(submittedTaskId).toBe('follow-up-task-1');
    expect(tools.handleToolCall).toHaveBeenCalledWith('smart_submit_task', expect.objectContaining({
      task: 'Add a regression test for the new advisor route',
      project: 'demo',
      working_directory: 'C:/repo/demo',
      tags: ['openclaw-proposal'],
      override_provider: 'ollama',
    }));
    expect(updated.status).toBe('approved');
    expect(updated.submitted_task_id).toBe('follow-up-task-1');
  });

  it('rejectProposal sets status to rejected', () => {
    const parentTask = insertTask(db);
    const proposal = insertProposal(db, {
      parent_task_id: parentTask.id,
    });

    advisor.rejectProposal(proposal.id);
    const updated = db.prepare('SELECT status FROM openclaw_proposals WHERE id = ?').get(proposal.id);

    expect(updated.status).toBe('rejected');
  });

  it('max 3 proposals are enforced', async () => {
    submitMock.mockResolvedValue({
      output: JSON.stringify({
        proposals: [
          { task_description: 'Proposal one', rationale: 'First', confidence: 'high', suggested_provider: 'codex' },
          { task_description: 'Proposal two', rationale: 'Second', confidence: 'medium', suggested_provider: 'codex' },
          { task_description: 'Proposal three', rationale: 'Third', confidence: 'medium', suggested_provider: 'ollama' },
          { task_description: 'Proposal four', rationale: 'Fourth', confidence: 'low', suggested_provider: 'ollama' },
        ],
      }),
    });

    const task = insertTask(db, {
      task_description: 'Finish OpenClaw route wiring',
    });
    const requestId = advisor.handleTaskCompletion(task);

    await advisor.generateProposals(requestId);

    const proposals = db.prepare(`
      SELECT task_description
      FROM openclaw_proposals
      WHERE parent_task_id = ?
        AND confidence IS NOT NULL
      ORDER BY created_at ASC
    `).all(task.id);

    expect(proposals).toHaveLength(3);
    expect(proposals.map((row) => row.task_description)).toEqual([
      'Proposal one',
      'Proposal two',
      'Proposal three',
    ]);
  });

  it('duplicate detection auto-rejects proposals matching recent tasks', async () => {
    const existingTask = insertTask(db, {
      id: 'recent-task',
      task_description: 'Add a regression test for the advisor route',
      created_at: '2026-04-07T11:30:00.000Z',
    });
    expect(existingTask.id).toBe('recent-task');

    submitMock.mockResolvedValue({
      output: JSON.stringify({
        proposals: [
          {
            task_description: 'Add a regression test for the advisor route',
            rationale: 'Close the loop with coverage.',
            confidence: 'high',
            suggested_provider: 'codex',
          },
        ],
      }),
    });

    const parentTask = insertTask(db, {
      id: 'parent-task',
      task_description: 'Wire the OpenClaw advisor',
      created_at: '2026-04-07T12:00:00.000Z',
    });
    const requestId = advisor.handleTaskCompletion(parentTask);

    await advisor.generateProposals(requestId);

    const stored = db.prepare(`
      SELECT status, rationale
      FROM openclaw_proposals
      WHERE parent_task_id = ?
        AND confidence IS NOT NULL
    `).get(parentTask.id);

    expect(stored.status).toBe('rejected');
    expect(stored.rationale).toContain('Auto-rejected as duplicate');
    expect(stored.rationale).toContain('recent-task');
  });
});
