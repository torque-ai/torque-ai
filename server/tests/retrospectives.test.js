const Database = require('better-sqlite3');

describe('retrospectives', () => {
  let db;
  let crud;

  beforeEach(() => {
    db = new Database(':memory:');
    const { createRetrospectivesCrud } = require('../db/retrospectives');
    crud = createRetrospectivesCrud({ db });
    crud.ensureTable();
  });

  it('ensureTable creates the table idempotently', () => {
    // Table already exists from beforeEach — calling again must not throw
    expect(() => crud.ensureTable()).not.toThrow();
  });

  it('insertRetrospective stores a full retro and returns an id', () => {
    const id = crud.insertRetrospective({
      workflow_id: 'wf-1',
      project_id: 'proj-a',
      created_at: '2026-05-18T10:00:00.000Z',
      duration_seconds: 320,
      total_cost: 0.42,
      files_changed: 7,
      retry_count: 1,
      verify_pass_count: 5,
      verify_fail_count: 2,
      flaky_count: 1,
      smoothness_rating: 'bumpy',
      narrative: 'The workflow hit two verify failures before converging.',
      learnings: ['Pin flaky test X', 'Codex handles large files better'],
      friction_points: ['Stall on task 3', 'Remote workstation timeout'],
      open_items: ['Investigate flaky test X root cause'],
      raw_stats: { task_count: 5, providers_used: ['codex', 'deepinfra'] },
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('getByWorkflowId retrieves a stored retro with all fields intact including JSON round-trip', () => {
    const learnings = ['Pin flaky test X', 'Codex handles large files better'];
    const frictionPoints = ['Stall on task 3'];
    const openItems = ['Investigate root cause'];

    crud.insertRetrospective({
      workflow_id: 'wf-2',
      project_id: 'proj-b',
      created_at: '2026-05-18T11:00:00.000Z',
      duration_seconds: 600,
      total_cost: 1.23,
      files_changed: 12,
      retry_count: 0,
      verify_pass_count: 10,
      verify_fail_count: 0,
      flaky_count: 0,
      smoothness_rating: 'smooth',
      narrative: 'Clean run.',
      learnings,
      friction_points: frictionPoints,
      open_items: openItems,
      raw_stats: { task_count: 3 },
    });

    const row = crud.getByWorkflowId('wf-2');
    expect(row).toBeTruthy();
    expect(row.workflow_id).toBe('wf-2');
    expect(row.project_id).toBe('proj-b');
    expect(row.created_at).toBe('2026-05-18T11:00:00.000Z');
    expect(row.duration_seconds).toBe(600);
    expect(row.total_cost).toBeCloseTo(1.23);
    expect(row.files_changed).toBe(12);
    expect(row.retry_count).toBe(0);
    expect(row.verify_pass_count).toBe(10);
    expect(row.verify_fail_count).toBe(0);
    expect(row.flaky_count).toBe(0);
    expect(row.smoothness_rating).toBe('smooth');
    expect(row.narrative).toBe('Clean run.');

    // JSON round-trip: stored as string, parse back and compare
    expect(JSON.parse(row.learnings)).toEqual(learnings);
    expect(JSON.parse(row.friction_points)).toEqual(frictionPoints);
    expect(JSON.parse(row.open_items)).toEqual(openItems);
    expect(JSON.parse(row.raw_stats)).toEqual({ task_count: 3 });
  });

  it('listByProject filters by project, respects limit/offset, orders by created_at DESC', () => {
    crud.insertRetrospective({ workflow_id: 'wf-a1', project_id: 'proj-a', created_at: '2026-05-18T01:00:00Z', smoothness_rating: 'smooth', learnings: '[]', friction_points: '[]', open_items: '[]', raw_stats: '{}' });
    crud.insertRetrospective({ workflow_id: 'wf-a2', project_id: 'proj-a', created_at: '2026-05-18T02:00:00Z', smoothness_rating: 'bumpy', learnings: '[]', friction_points: '[]', open_items: '[]', raw_stats: '{}' });
    crud.insertRetrospective({ workflow_id: 'wf-a3', project_id: 'proj-a', created_at: '2026-05-18T03:00:00Z', smoothness_rating: 'rough', learnings: '[]', friction_points: '[]', open_items: '[]', raw_stats: '{}' });
    crud.insertRetrospective({ workflow_id: 'wf-b1', project_id: 'proj-b', created_at: '2026-05-18T04:00:00Z', smoothness_rating: 'smooth', learnings: '[]', friction_points: '[]', open_items: '[]', raw_stats: '{}' });

    // Filter: only proj-a rows
    const all = crud.listByProject('proj-a');
    expect(all).toHaveLength(3);

    // Newest first
    expect(all[0].workflow_id).toBe('wf-a3');
    expect(all[1].workflow_id).toBe('wf-a2');
    expect(all[2].workflow_id).toBe('wf-a1');

    // Limit
    const limited = crud.listByProject('proj-a', { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].workflow_id).toBe('wf-a3');

    // Offset
    const paged = crud.listByProject('proj-a', { limit: 2, offset: 1 });
    expect(paged).toHaveLength(2);
    expect(paged[0].workflow_id).toBe('wf-a2');
    expect(paged[1].workflow_id).toBe('wf-a1');
  });

  it('getByWorkflowId returns null for a non-existent workflow id', () => {
    expect(crud.getByWorkflowId('no-such-wf')).toBeNull();
  });

  it('deleteByWorkflowId removes the row and subsequent get returns null', () => {
    crud.insertRetrospective({ workflow_id: 'wf-del', project_id: 'proj-x', learnings: '[]', friction_points: '[]', open_items: '[]', raw_stats: '{}' });
    expect(crud.getByWorkflowId('wf-del')).toBeTruthy();

    const result = crud.deleteByWorkflowId('wf-del');
    expect(result.changes).toBe(1);
    expect(crud.getByWorkflowId('wf-del')).toBeNull();
  });
});
