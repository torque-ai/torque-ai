'use strict';

function createTestDeflaker({ db }) {
  const insertStmt = db.prepare(`
    INSERT INTO test_outcomes (project_path, test_name, result, commit_hash, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  /**
   * Record test outcomes in bulk.
   * @param {object} opts
   * @param {string} opts.projectPath
   * @param {string|null} [opts.commitHash]
   * @param {string[]} [opts.passed]  - test names that passed
   * @param {string[]} [opts.failed]  - test names that failed
   */
  function recordOutcomes({ projectPath, commitHash = null, passed = [], failed = [] }) {
    const now = new Date().toISOString();
    const txn = db.transaction(() => {
      for (const name of passed) {
        insertStmt.run(projectPath, name, 'pass', commitHash, now);
      }
      for (const name of failed) {
        insertStmt.run(projectPath, name, 'fail', commitHash, now);
      }
    });
    txn();
  }

  /**
   * Classify test failures as flaky or genuine by inspecting a sliding window
   * of recent outcomes.
   * @param {object} opts
   * @param {string} opts.projectPath
   * @param {string[]} opts.testNames
   * @param {number} [opts.windowSize=5]
   * @returns {{ flaky: string[], genuine: string[] }}
   */
  function classifyFailures({ projectPath, testNames, windowSize = 5 }) {
    const flaky = [];
    const genuine = [];

    const windowStmt = db.prepare(`
      SELECT result FROM test_outcomes
      WHERE project_path = ? AND test_name = ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    for (const name of testNames) {
      const rows = windowStmt.all(projectPath, name, windowSize);
      if (rows.length === 0) {
        // No history — treat as genuine
        genuine.push(name);
        continue;
      }
      const hasPass = rows.some(r => r.result === 'pass');
      const hasFail = rows.some(r => r.result === 'fail');
      if (hasPass && hasFail) {
        flaky.push(name);
      } else {
        genuine.push(name);
      }
    }

    return { flaky, genuine };
  }

  /**
   * Return recent outcome history for a single test.
   * @param {object} opts
   * @param {string} opts.projectPath
   * @param {string} opts.testName
   * @param {number} [opts.limit=20]
   * @returns {object[]}
   */
  function getOutcomeHistory({ projectPath, testName, limit = 20 }) {
    return db.prepare(`
      SELECT * FROM test_outcomes
      WHERE project_path = ? AND test_name = ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(projectPath, testName, limit);
  }

  return { recordOutcomes, classifyFailures, getOutcomeHistory };
}

module.exports = { createTestDeflaker };
