'use strict';

function createVerificationLedger({ db }) {
  function insertCheck(check) {
    const now = check.created_at || new Date().toISOString();
    db.prepare(`
      INSERT INTO verification_checks (task_id, workflow_id, phase, check_name, tool, command, exit_code, output_snippet, passed, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      check.task_id,
      check.workflow_id || null,
      check.phase,
      check.check_name,
      check.tool || null,
      check.command || null,
      check.exit_code ?? null,
      check.output_snippet || null,
      check.passed,
      check.duration_ms || null,
      now,
    );
  }

  function insertChecks(checks) {
    const tx = db.transaction(() => {
      for (const check of checks) {
        insertCheck(check);
      }
    });
    tx();
  }

  function getChecksForTask(taskId, filters = {}) {
    let sql = 'SELECT * FROM verification_checks WHERE task_id = ?';
    const params = [taskId];
    if (filters.phase) {
      sql += ' AND phase = ?';
      params.push(filters.phase);
    }
    if (filters.checkName) {
      sql += ' AND check_name = ?';
      params.push(filters.checkName);
    }
    sql += ' ORDER BY created_at ASC';
    return db.prepare(sql).all(...params);
  }

  function getCheckSummary(workflowId) {
    const rows = db.prepare(`
      SELECT check_name, passed, COUNT(*) as cnt
      FROM verification_checks
      WHERE workflow_id = ?
      GROUP BY check_name, passed
    `).all(workflowId);

    const summary = {};
    for (const row of rows) {
      if (!summary[row.check_name]) {
        summary[row.check_name] = { total: 0, passed: 0, failed: 0 };
      }
      summary[row.check_name].total += row.cnt;
      if (row.passed) {
        summary[row.check_name].passed += row.cnt;
      } else {
        summary[row.check_name].failed += row.cnt;
      }
    }
    return summary;
  }

  function pruneOldChecks(retentionDays = 90) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const result = db.prepare('DELETE FROM verification_checks WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  return { insertCheck, insertChecks, getChecksForTask, getCheckSummary, pruneOldChecks };
}

module.exports = { createVerificationLedger };
