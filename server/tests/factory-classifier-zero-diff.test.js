'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryDecisions = require('../db/factory-decisions');
const verifyReview = require('../factory/verify-review');

function ensureClassifierTables(dbHandle) {
  dbHandle.exec(`
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
    VALUES (?, 'Zero Diff Classifier', ?, 'autonomous', 'running', '{}', datetime('now'), datetime('now'))
  `).run(projectId, `/tmp/${projectId}`);
}

function seedSkippedCleanDecision(projectId, batchId) {
  factoryDecisions.recordDecision({
    project_id: projectId,
    stage: 'execute',
    actor: 'executor',
    action: 'auto_commit_skipped_clean',
    reasoning: 'Auto-commit skipped because the worktree was clean.',
    outcome: { file_count: 0 },
    confidence: 1,
    batch_id: batchId,
  });
}

function buildReviewArgs({ projectId, batchId }) {
  return {
    verifyOutput: { exitCode: 1, stdout: 'FAIL', stderr: '', timedOut: false },
    workingDirectory: '/tmp/project',
    worktreeBranch: 'feat/factory-zero-diff',
    mergeBase: 'main',
    workItem: { id: 1, title: 'test item', description: 'desc' },
    project: { id: projectId, path: '/tmp/project' },
    batch_id: batchId,
  };
}

describe('reviewVerifyFailure zero-diff cascade classifier', () => {
  const projectId = 'proj-zero-diff-classifier';
  let dbHandle;
  let llmSpy;

  beforeEach(() => {
    const setup = setupTestDbOnly('factory-classifier-zero-diff');
    dbHandle = setup.db.getDbInstance();
    ensureClassifierTables(dbHandle);
    dbHandle.prepare('DELETE FROM factory_decisions').run();
    factoryDecisions.setDb(dbHandle);
    seedProject(dbHandle, projectId);

    vi.spyOn(verifyReview, 'parseFailingTests').mockReturnValue(['src/foo.test.js']);
    llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({ verdict: null, critique: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('returns zero_diff_cascade when the batch has a prior auto_commit_skipped_clean decision and no modified files', async () => {
    seedSkippedCleanDecision(projectId, 'B1');
    vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue([]);

    const result = await verifyReview.reviewVerifyFailure(buildReviewArgs({ projectId, batchId: 'B1' }));

    expect(result.classification).toBe('zero_diff_cascade');
    expect(result.confidence).toBe('high');
    expect(result.suggestedRejectReason).toBe('zero_diff_across_retries');
    expect(result.modifiedFiles).toEqual([]);
    expect(result.failingTests).toEqual(['src/foo.test.js']);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('falls back to ambiguous when the batch has no prior skipped-clean decision', async () => {
    seedSkippedCleanDecision(projectId, 'B1');
    vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue([]);

    const result = await verifyReview.reviewVerifyFailure(buildReviewArgs({ projectId, batchId: 'B2' }));

    expect(result.classification).toBe('ambiguous');
    expect(result.suggestedRejectReason).toBeNull();
    expect(llmSpy).toHaveBeenCalledTimes(1);
  });

  it('does not return zero_diff_cascade when modified files are present for a batch with prior skipped-clean', async () => {
    seedSkippedCleanDecision(projectId, 'B1');
    vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['x.js']);

    const result = await verifyReview.reviewVerifyFailure(buildReviewArgs({ projectId, batchId: 'B1' }));

    expect(result.classification).toBe('ambiguous');
    expect(result.classification).not.toBe('zero_diff_cascade');
    expect(result.modifiedFiles).toEqual(['x.js']);
    expect(llmSpy).toHaveBeenCalledTimes(1);
  });
});
