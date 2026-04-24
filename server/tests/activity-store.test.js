'use strict';

const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createActivityStore } = require('../db/activity-store');

describe('activity-store', () => {
  let db;
  let store;

  beforeEach(() => {
    setupTestDbOnly('activity-store');
    db = rawDb();
    store = createActivityStore({ db });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('creates and reads back activity payloads', () => {
    const id = store.create({
      workflowId: 'wf-1',
      taskId: 'task-1',
      kind: 'provider',
      name: 'codex.runPrompt',
      input: { prompt: 'hello' },
      options: {
        max_attempts: 3,
        start_to_close_timeout_ms: 5000,
        heartbeat_timeout_ms: 1000,
      },
    });

    expect(id).toMatch(/^act_/);
    expect(store.get(id)).toMatchObject({
      activity_id: id,
      workflow_id: 'wf-1',
      task_id: 'task-1',
      kind: 'provider',
      name: 'codex.runPrompt',
      input: { prompt: 'hello' },
      status: 'pending',
      attempt: 0,
      max_attempts: 3,
      start_to_close_timeout_ms: 5000,
      heartbeat_timeout_ms: 1000,
      result: null,
    });
  });

  it('returns an empty stale list when called without options', () => {
    expect(store.listStale()).toEqual([]);
  });

  it('tracks running, heartbeat, and completion state', () => {
    const id = store.create({
      kind: 'verify',
      name: 'safe_verify',
    });

    store.markRunning(id);
    store.heartbeat(id);
    store.complete(id, { ok: true });

    const activity = store.get(id);
    expect(activity.status).toBe('completed');
    expect(activity.attempt).toBe(1);
    expect(activity.started_at).toBeTruthy();
    expect(activity.last_heartbeat_at).toBeTruthy();
    expect(activity.completed_at).toBeTruthy();
    expect(activity.result).toEqual({ ok: true });
  });

  it('marks failures and finds stale running activities', () => {
    const staleId = store.create({
      kind: 'remote_shell',
      name: 'bitsy.build',
      options: { heartbeat_timeout_ms: 50 },
    });
    const failedId = store.create({
      kind: 'mcp_tool',
      name: 'snapscope.peek_ui',
    });

    store.markRunning(staleId);
    db.prepare(`
      UPDATE activities
      SET started_at = datetime('now', '-5 seconds')
      WHERE activity_id = ?
    `).run(staleId);

    store.markRunning(failedId);
    store.fail(failedId, 'tool crashed', 'timed_out');

    expect(store.listStale({ heartbeatGraceMs: 0 })).toContain(staleId);

    const failed = store.get(failedId);
    expect(failed.status).toBe('timed_out');
    expect(failed.error_text).toBe('tool crashed');
    expect(failed.completed_at).toBeTruthy();
  });
});
