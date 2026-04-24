'use strict';

const { afterEach, describe, it, expect, vi } = require('vitest');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createActivityStore } = require('../db/activity-store');
const { createJournalWriter } = require('../journal/journal-writer');
const { createActivityRunner } = require('../activities/activity-runner');

function setup() {
  setupTestDbOnly('activity-runner');

  const db = rawDb();
  const store = createActivityStore({ db });
  const journal = createJournalWriter({ db });
  const runner = createActivityRunner({ db, store, journal });

  db.prepare(`
    INSERT INTO workflows (id, name, status, created_at)
    VALUES ('wf-1', 't', 'running', ?)
  `).run(new Date().toISOString());

  return { db, store, runner, journal };
}

describe('activityRunner.runActivity', () => {
  afterEach(() => {
    teardownTestDb();
  });

  it('runs a happy-path activity once and marks completed', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(async () => ({ value: 42 }));

    const result = await runner.runActivity({
      workflowId: 'wf-1',
      taskId: 't1',
      kind: 'mcp_tool',
      name: 'noop',
      input: { x: 1 },
      fn,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ value: 42 });
    expect(fn).toHaveBeenCalledTimes(1);

    const stored = store.get(result.activity_id);
    expect(stored.status).toBe('completed');
    expect(stored.attempt).toBe(1);
  });

  it('retries up to max_attempts on retriable failure', async () => {
    const { runner, store } = setup();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error('transient'), { retriable: true });
      }
      return { ok: true };
    });

    const result = await runner.runActivity({
      workflowId: 'wf-1',
      kind: 'provider',
      name: 'codex.runPrompt',
      fn,
      options: { max_attempts: 3, retry_policy: { initial_ms: 1, max_ms: 5 } },
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);

    const stored = store.get(result.activity_id);
    expect(stored.attempt).toBe(3);
  });

  it('fails after exhausting retries', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('always fails'), { retriable: true });
    });

    const result = await runner.runActivity({
      workflowId: 'wf-1',
      kind: 'provider',
      name: 'codex.runPrompt',
      fn,
      options: { max_attempts: 2, retry_policy: { initial_ms: 1 } },
    });

    expect(result.ok).toBe(false);
    expect(result.attempt).toBe(2);

    const stored = store.get(result.activity_id);
    expect(stored.status).toBe('failed');
    expect(stored.error_text).toMatch(/always fails/);
  });

  it('does not retry non-retriable errors', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('validation'), {
        retriable: false,
        name: 'ValidationError',
      });
    });

    const result = await runner.runActivity({
      workflowId: 'wf-1',
      kind: 'verify',
      name: 'tsc',
      fn,
      options: { max_attempts: 5 },
    });

    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);

    const stored = store.get(result.activity_id);
    expect(stored.attempt).toBe(1);
    expect(stored.status).toBe('failed');
  });

  it('honors start_to_close_timeout_ms', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve('late'), 200)));

    const result = await runner.runActivity({
      workflowId: 'wf-1',
      kind: 'mcp_tool',
      name: 'slow',
      fn,
      options: { start_to_close_timeout_ms: 50, max_attempts: 1 },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);

    const stored = store.get(result.activity_id);
    expect(stored.status).toBe('timed_out');
  });

  it('journals begin/complete events with activity_id', async () => {
    const { runner, journal } = setup();
    const fn = async () => 'ok';

    const result = await runner.runActivity({
      workflowId: 'wf-1',
      kind: 'mcp_tool',
      name: 'noop',
      fn,
    });

    const events = journal.readJournal('wf-1');
    expect(events.some((event) => event.event_type === 'activity_started' && event.payload?.activity_id === result.activity_id)).toBe(true);
    expect(events.some((event) => event.event_type === 'activity_completed' && event.payload?.activity_id === result.activity_id)).toBe(true);
  });
});
