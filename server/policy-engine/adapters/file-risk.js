'use strict';
const { scoreFilesByPath } = require('../../db/file-risk-patterns');

function createFileRiskAdapter({ db, fileRisk, customPatterns = {} }) {
  function scoreAndPersist(filePaths, workingDirectory, taskId) {
    const scored = scoreFilesByPath(filePaths, customPatterns);
    for (const s of scored) {
      fileRisk.upsertScore({
        file_path: s.file_path,
        working_directory: workingDirectory,
        risk_level: s.risk_level,
        risk_reasons: JSON.stringify(s.risk_reasons),
        scored_by: taskId || 'pattern',
      });
    }
    return scored;
  }

  function collectEvidence(context) {
    const files = context.changed_files || [];
    const workDir = context.project_path || '';
    const scored = files.length > 0 ? scoreAndPersist(files, workDir) : [];
    const high = scored.filter(s => s.risk_level === 'high').map(s => s.file_path);
    const medium = scored.filter(s => s.risk_level === 'medium').map(s => s.file_path);
    const low = scored.filter(s => s.risk_level === 'low').map(s => s.file_path);
    return [{ type: 'file_risk_assessed', available: true, satisfied: true, high_risk_files: high, medium_risk_files: medium, low_risk_files: low, total_files: files.length }];
  }

  return { collectEvidence, scoreAndPersist };
}

module.exports = { createFileRiskAdapter };
