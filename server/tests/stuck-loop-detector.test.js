'use strict';

const { randomUUID } = require('crypto');
const { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } = require('vitest');

const { detectStuckLoops, STALL_THRESHOLD_MS } = require('../factory/stuck-loop-detector');
const { rawDb, resetTables, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;

function insertProject({ name, loopState, lastActionAt }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO factory_projects (
      id,
      name,
      path,
      status,
      loop_state,
      loop_last_action_at
    )
    VALUES (?, ?, ?, 'running', ?, ?)
  `).run(
    id,
    name,
    `C:/projects/${id}`,
    loopState,
    lastActionAt,
  );
  return id;
}

beforeAll(() => {
  setupTestDbOnly('stuck-loop-detector');
  db = rawDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  resetTables('factory_projects');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-18T18:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('detectStuckLoops', () => {
  it('does not return loops below the stall threshold', () => {
    insertProject({
      name: 'Below Threshold',
      loopState: 'PLAN',
      lastActionAt: new Date(Date.now() - (STALL_THRESHOLD_MS - 60 * 1000)).toISOString(),
    });

    expect(detectStuckLoops(db)).toEqual([]);
  });

  it('never returns IDLE loops even when they are old', () => {
    insertProject({
      name: 'Idle Project',
      loopState: 'IDLE',
      lastActionAt: new Date(Date.now() - (2 * STALL_THRESHOLD_MS)).toISOString(),
    });

    expect(detectStuckLoops(db)).toEqual([]);
  });

  it('computes stalled_minutes from loop_last_action_at', () => {
    const lastActionAt = new Date(Date.now() - (47 * 60 * 1000)).toISOString();
    const projectId = insertProject({
      name: 'Stalled Project',
      loopState: 'EXECUTE',
      lastActionAt,
    });

    expect(detectStuckLoops(db)).toEqual([
      {
        project_id: projectId,
        project_name: 'Stalled Project',
        loop_state: 'EXECUTE',
        last_action_at: lastActionAt,
        stalled_minutes: 47,
      },
    ]);
  });

  it('returns an empty result when no projects are stalled', () => {
    insertProject({
      name: 'Paused Project',
      loopState: 'PAUSED',
      lastActionAt: new Date(Date.now() - (3 * STALL_THRESHOLD_MS)).toISOString(),
    });
    insertProject({
      name: 'Missing Timestamp',
      loopState: 'LEARN',
      lastActionAt: null,
    });
    insertProject({
      name: 'Recent Work',
      loopState: 'SENSE',
      lastActionAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    });

    expect(detectStuckLoops(db)).toEqual([]);
  });
});
