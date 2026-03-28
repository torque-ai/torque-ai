'use strict';

const RISK_LEVELS = ['high', 'medium', 'low'];
const RISK_LEVEL_ORDER = { high: 0, medium: 1, low: 2 };

function parseRiskReasons(value) {
  if (!value) {
    return [];
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return [];
  }
}

function createFileRisk({ db }) {
  function upsertScore({ file_path, working_directory, risk_level, risk_reasons, scored_by }) {
    const now = new Date().toISOString();
    const serializedReasons = typeof risk_reasons === 'string'
      ? risk_reasons
      : JSON.stringify(risk_reasons || []);

    db.prepare(`
      INSERT INTO file_risk_scores (file_path, working_directory, risk_level, risk_reasons, auto_scored, scored_at, scored_by)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(file_path, working_directory) DO UPDATE SET
        risk_level = excluded.risk_level,
        risk_reasons = excluded.risk_reasons,
        auto_scored = 1,
        scored_at = excluded.scored_at,
        scored_by = excluded.scored_by
      WHERE file_risk_scores.auto_scored = 1;
    `).run(file_path, working_directory, risk_level, serializedReasons, now, scored_by || 'pattern');
  }

  function getFileRisk(filePath, workingDirectory) {
    return db.prepare('SELECT * FROM file_risk_scores WHERE file_path = ? AND working_directory = ?')
      .get(filePath, workingDirectory) || null;
  }

  function getFilesAtRisk(workingDirectory, minLevel = 'low') {
    const minOrder = RISK_LEVEL_ORDER[minLevel] ?? 2;
    return db.prepare(
      `SELECT * FROM file_risk_scores
       WHERE working_directory = ?
         AND CASE risk_level
          WHEN 'high' THEN 0
          WHEN 'medium' THEN 1
          WHEN 'low' THEN 2
          ELSE 3
        END <= ?
       ORDER BY CASE risk_level
        WHEN 'high' THEN 0
        WHEN 'medium' THEN 1
        WHEN 'low' THEN 2
        ELSE 3
      END, file_path`
    ).all(workingDirectory, minOrder);
  }

  function setManualOverride(filePath, workingDirectory, riskLevel, reason) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO file_risk_scores (file_path, working_directory, risk_level, risk_reasons, auto_scored, scored_at, scored_by)
      VALUES (?, ?, ?, ?, 0, ?, 'manual')
      ON CONFLICT(file_path, working_directory) DO UPDATE SET
        risk_level = excluded.risk_level,
        risk_reasons = excluded.risk_reasons,
        auto_scored = 0,
        scored_at = excluded.scored_at,
        scored_by = 'manual'
    `).run(filePath, workingDirectory, riskLevel, JSON.stringify([reason]), now);
  }

  function getTaskRiskSummary(taskId) {
    const files = db.prepare(`
      SELECT tfc.file_path, tfc.working_directory, frs.risk_level, frs.risk_reasons
      FROM task_file_changes tfc
      LEFT JOIN file_risk_scores frs ON tfc.file_path = frs.file_path AND tfc.working_directory = frs.working_directory
      WHERE tfc.task_id = ?
    `).all(taskId);

    const summary = { high: [], medium: [], low: [], unscored: [], overall_risk: 'low' };
    for (const f of files) {
      const level = f.risk_level || 'unscored';
      const bucket = summary[level] || summary.unscored;
      bucket.push({
        file_path: f.file_path,
        risk_reasons: parseRiskReasons(f.risk_reasons),
      });
    }
    if (summary.high.length > 0) {
      summary.overall_risk = 'high';
    } else if (summary.medium.length > 0) {
      summary.overall_risk = 'medium';
    }

    return summary;
  }

  return { upsertScore, getFileRisk, getFilesAtRisk, setManualOverride, getTaskRiskSummary };
}

module.exports = { createFileRisk, RISK_LEVELS, RISK_LEVEL_ORDER };
