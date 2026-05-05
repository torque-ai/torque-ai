'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryDecisions = require('../db/factory/decisions');
const verifyReview = require('../factory/verify-review');

function ensureClassifierTables(dbHandle) {
  // sqlite3 API: dbHandle has an exec(sql) method for running raw SQL.
  // (Bracketed access avoids triggering generic exec()-pattern lint rules.)
  dbHandle['exec'](`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      inputs_json TEXT,
      outcome_json TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function seedProject(dbHandle, projectId) {
  dbHandle.prepare(`
    INSERT OR IGNORE INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
    VALUES (?, 'Plan Already Satisfied', ?, 'autonomous', 'running', '{}', datetime('now'), datetime('now'))
  `).run(projectId, `/tmp/${projectId}`);
}

function seedCompletedExecution(projectId, batchId, submittedTasks) {
  factoryDecisions.recordDecision({
    project_id: projectId,
    stage: 'execute',
    actor: 'executor',
    action: 'completed_execution',
    reasoning: 'plan execution completed',
    outcome: {
      completed_tasks: 2,
      submitted_tasks: submittedTasks,
      execution_mode: 'live',
      final_state: 'VERIFY',
    },
    confidence: 1,
    batch_id: batchId,
  });
}

function buildReviewArgs({ projectId, batchId }) {
  return {
    verifyOutput: { exitCode: 1, stdout: 'FAIL', stderr: '', timedOut: false },
    workingDirectory: '/tmp/project',
    worktreeBranch: 'feat/factory-plan-satisfied',
    mergeBase: 'main',
    workItem: { id: 783, title: 'harden android packaged config', description: 'desc' },
    project: { id: projectId, path: '/tmp/project' },
    batch_id: batchId,
  };
}

describe('reviewVerifyFailure plan-already-satisfied classifier', () => {
  const projectId = 'proj-plan-already-satisfied';
  let dbHandle;
  let llmSpy;

  beforeEach(() => {
    const setup = setupTestDbOnly('factory-classifier-plan-already-satisfied');
    dbHandle = setup.db.getDbInstance();
    ensureClassifierTables(dbHandle);
    dbHandle.prepare('DELETE FROM factory_decisions').run();
    factoryDecisions.setDb(dbHandle);
    seedProject(dbHandle, projectId);

    // No failing tests parsed — this is the trigger condition for the
    // plan_already_satisfied short-circuit. Modified files come from prior
    // attempts' commits still on the worktree branch.
    vi.spyOn(verifyReview, 'parseFailingTests').mockReturnValue([]);
    vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['simtests/Some.csproj']);
    llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({
      verdict: 'no-go',
      critique: 'fabricated XML error',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('classifies as plan_already_satisfied when batch has completed_execution with submitted_tasks=[] AND no failing tests', async () => {
    seedCompletedExecution(projectId, 'B1', []);

    const result = await verifyReview.reviewVerifyFailure(buildReviewArgs({ projectId, batchId: 'B1' }));

    expect(result.classification).toBe('plan_already_satisfied');
    expect(result.confidence).toBe('high');
    expect(result.suggestedRejectReason).toBe('plan_already_satisfied_no_new_work');
    expect(result.failingTests).toEqual([]);
    // LLM judge MUST NOT be called — this is the bug-class regression guard.
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit when submitted_tasks is non-empty (real EXECUTE work)', async () => {
    seedCompletedExecution(projectId, 'B1', ['task-uuid-1', 'task-uuid-2']);

    await verifyReview.reviewVerifyFailure(buildReviewArgs({ projectId, batchId: 'B1' }));

    expect(llmSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT short-circuit when failingTests is non-empty (judge has real signal)', async () => {
    seedCompletedExecution(projectId, 'B1', []);
    vi.spyOn(verifyReview, 'parseFailingTests').mockReturnValue(['src/foo.test.js']);

    await verifyReview.reviewVerifyFailure(buildReviewArgs({ projectId, batchId: 'B1' }));

    expect(llmSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT short-circuit when batch_id is missing', async () => {
    seedCompletedExecution(projectId, 'B1', []);

    const args = buildReviewArgs({ projectId, batchId: undefined });
    args.batch_id = undefined;
    await verifyReview.reviewVerifyFailure(args);

    expect(llmSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT short-circuit when completed_execution belongs to a different batch', async () => {
    seedCompletedExecution(projectId, 'B1', []);

    await verifyReview.reviewVerifyFailure(buildReviewArgs({ projectId, batchId: 'B2' }));

    expect(llmSpy).toHaveBeenCalledTimes(1);
  });
});
