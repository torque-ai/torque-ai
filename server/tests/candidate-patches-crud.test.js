'use strict';

import { describe, expect, it, beforeEach } from 'vitest';

const { setupTestDbOnly } = require('./vitest-setup');
const { createCandidatePatches } = require('../validation/candidate-patches');

let db;
let svc;

function ensureCandidatePatchesTable(dbHandle) {
  dbHandle.exec([
    'CREATE TABLE IF NOT EXISTS candidate_patches (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  task_id INTEGER NOT NULL,',
    '  attempt INTEGER NOT NULL,',
    '  diff_text TEXT,',
    '  validator_score REAL DEFAULT 0,',
    '  verify_exit_code INTEGER,',
    '  verify_output TEXT,',
    '  selected INTEGER DEFAULT 0,',
    "  created_at TEXT DEFAULT (datetime('now'))",
    ')',
  ].join('\n'));
  dbHandle.exec(
    'CREATE INDEX IF NOT EXISTS idx_candidate_patches_task_score ON candidate_patches(task_id, validator_score DESC)',
  );
}

beforeEach(() => {
  ({ db } = setupTestDbOnly('candidate-patches'));
  const dbHandle = db.getDbInstance();
  ensureCandidatePatchesTable(dbHandle);
  svc = createCandidatePatches({
    db: dbHandle,
    logger: { info() {}, warn() {}, error() {} },
  });
});

describe('candidate-patches CRUD', () => {
  it('recordCandidate inserts a row and returns its id', () => {
    const id = svc.recordCandidate({
      taskId: 1,
      attempt: 1,
      diffText: '--- a/foo.js\n+++ b/foo.js',
      validatorScore: 0.85,
      verifyExitCode: 0,
      verifyOutput: 'All tests passed',
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('listCandidates returns candidates sorted by validator_score DESC', () => {
    svc.recordCandidate({ taskId: 10, attempt: 1, validatorScore: 0.3, verifyExitCode: 1 });
    svc.recordCandidate({ taskId: 10, attempt: 2, validatorScore: 0.9, verifyExitCode: 0 });
    svc.recordCandidate({ taskId: 10, attempt: 3, validatorScore: 0.6, verifyExitCode: 1 });

    const list = svc.listCandidates(10);

    expect(list).toHaveLength(3);
    expect(list[0].validator_score).toBe(0.9);
    expect(list[1].validator_score).toBe(0.6);
    expect(list[2].validator_score).toBe(0.3);
  });

  it('selectBestCandidate marks the highest-scored candidate as selected = 1', () => {
    svc.recordCandidate({ taskId: 20, attempt: 1, validatorScore: 0.5, verifyExitCode: 0 });
    svc.recordCandidate({ taskId: 20, attempt: 2, validatorScore: 0.9, verifyExitCode: 0 });

    const best = svc.selectBestCandidate(20);

    expect(best).not.toBeNull();
    expect(best.selected).toBe(1);
    // Both have exit code 0, so highest validator_score wins
    expect(best.validator_score).toBe(0.9);
    expect(best.attempt).toBe(2);
  });

  it('selectBestCandidate with tied scores uses lowest verify_exit_code as tiebreaker', () => {
    // Same validator_score, different exit codes — lowest exit code wins
    svc.recordCandidate({ taskId: 30, attempt: 1, validatorScore: 0.7, verifyExitCode: 1 });
    svc.recordCandidate({ taskId: 30, attempt: 2, validatorScore: 0.7, verifyExitCode: 0 });

    const best = svc.selectBestCandidate(30);

    expect(best).not.toBeNull();
    expect(best.verify_exit_code).toBe(0);
    expect(best.attempt).toBe(2);
    expect(best.selected).toBe(1);
  });

  it('getCandidateCount returns correct count after multiple inserts', () => {
    expect(svc.getCandidateCount(40)).toBe(0);

    svc.recordCandidate({ taskId: 40, attempt: 1, validatorScore: 0.5 });
    expect(svc.getCandidateCount(40)).toBe(1);

    svc.recordCandidate({ taskId: 40, attempt: 2, validatorScore: 0.6 });
    svc.recordCandidate({ taskId: 40, attempt: 3, validatorScore: 0.7 });
    expect(svc.getCandidateCount(40)).toBe(3);

    // Different taskId should not count
    svc.recordCandidate({ taskId: 99, attempt: 1, validatorScore: 0.1 });
    expect(svc.getCandidateCount(40)).toBe(3);
  });

  it('recordCandidate truncates verifyOutput longer than 8000 chars', () => {
    const longOutput = 'x'.repeat(10000);
    svc.recordCandidate({
      taskId: 50,
      attempt: 1,
      validatorScore: 0.5,
      verifyExitCode: 1,
      verifyOutput: longOutput,
    });

    const list = svc.listCandidates(50);
    expect(list).toHaveLength(1);
    expect(list[0].verify_output).toHaveLength(8000);
    expect(list[0].verify_output).toBe('x'.repeat(8000));
  });
});
