'use strict';

/**
 * Candidate-patch recording and selection module.
 *
 * Tracks repair-loop patch attempts for a given task, scores them, and
 * selects the best candidate.  Used by the surgical-repair loop
 * (AutoCodeRover / Fabro #49) to persist each verify-retry diff so the
 * orchestrator can pick the highest-quality patch when multiple attempts
 * are made.
 *
 * Factory shape: createCandidatePatches({ db, logger }) →
 *   { recordCandidate, listCandidates, selectBestCandidate, getCandidateCount }
 */

const VERIFY_OUTPUT_MAX_LENGTH = 8000;

function createCandidatePatches({ db, logger }) {
  const log = logger || { info() {}, warn() {}, error() {} };

  /**
   * Insert a candidate-patch row.
   *
   * @param {object} opts
   * @param {number} opts.taskId        - The original failing task id.
   * @param {number} opts.attempt       - 1-indexed attempt number.
   * @param {string} [opts.diffText]    - Unified diff of the patch.
   * @param {number} [opts.validatorScore] - Quality score 0.0–1.0.
   * @param {number} [opts.verifyExitCode] - Exit code from verify command.
   * @param {string} [opts.verifyOutput]   - Verify-command output (truncated to 8 KB).
   * @returns {number} The inserted row id.
   */
  function recordCandidate({ taskId, attempt, diffText, validatorScore, verifyExitCode, verifyOutput }) {
    const truncatedOutput = verifyOutput != null && verifyOutput.length > VERIFY_OUTPUT_MAX_LENGTH
      ? verifyOutput.slice(0, VERIFY_OUTPUT_MAX_LENGTH)
      : verifyOutput;

    const stmt = db.prepare(
      `INSERT INTO candidate_patches
         (task_id, attempt, diff_text, validator_score, verify_exit_code, verify_output)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const result = stmt.run(
      taskId,
      attempt,
      diffText != null ? diffText : null,
      validatorScore != null ? validatorScore : 0,
      verifyExitCode != null ? verifyExitCode : null,
      truncatedOutput != null ? truncatedOutput : null
    );

    log.info({ taskId, attempt, id: result.lastInsertRowid }, 'candidate patch recorded');
    return Number(result.lastInsertRowid);
  }

  /**
   * List all candidates for a task, ordered by validator_score descending.
   *
   * @param {number} taskId
   * @returns {Array<object>}
   */
  function listCandidates(taskId) {
    const stmt = db.prepare(
      `SELECT id, task_id, attempt, diff_text, validator_score,
              verify_exit_code, verify_output, selected, created_at
       FROM candidate_patches
       WHERE task_id = ?
       ORDER BY validator_score DESC`
    );
    return stmt.all(taskId);
  }

  /**
   * Mark the best candidate as selected.
   *
   * Selection criteria: lowest verify_exit_code first (0 = passed),
   * then highest validator_score as tiebreaker.
   *
   * @param {number} taskId
   * @returns {object|null} The selected candidate row, or null if none exist.
   */
  function selectBestCandidate(taskId) {
    const candidates = db.prepare(
      `SELECT id, task_id, attempt, diff_text, validator_score,
              verify_exit_code, verify_output, selected, created_at
       FROM candidate_patches
       WHERE task_id = ?
       ORDER BY verify_exit_code ASC, validator_score DESC
       LIMIT 1`
    ).all(taskId);

    if (candidates.length === 0) {
      return null;
    }

    const best = candidates[0];

    // Clear any previous selection for this task, then mark the winner.
    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE candidate_patches SET selected = 0 WHERE task_id = ?'
      ).run(taskId);
      db.prepare(
        'UPDATE candidate_patches SET selected = 1 WHERE id = ?'
      ).run(best.id);
    });
    txn();

    log.info({ taskId, selectedId: best.id, attempt: best.attempt }, 'best candidate selected');
    return { ...best, selected: 1 };
  }

  /**
   * Return the number of candidate patches recorded for a task.
   *
   * @param {number} taskId
   * @returns {number}
   */
  function getCandidateCount(taskId) {
    const row = db.prepare(
      'SELECT COUNT(*) AS cnt FROM candidate_patches WHERE task_id = ?'
    ).get(taskId);
    return row.cnt;
  }

  return {
    recordCandidate,
    listCandidates,
    selectBestCandidate,
    getCandidateCount,
  };
}

module.exports = { createCandidatePatches };
