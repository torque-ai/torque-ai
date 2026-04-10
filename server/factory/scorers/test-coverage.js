'use strict';

function score(projectPath, scanReport, findingsDir) {
  void projectPath;
  void findingsDir;

  const mt = scanReport?.missingTests;
  if (!mt || mt.total === undefined) {
    return { score: 50, details: { source: 'no_data' }, findings: [] };
  }

  const covered = mt.covered || 0;
  const missing = mt.missing || 0;
  const total = mt.total || 1;
  const coveragePercent = mt.coveragePercent || Math.round((covered / total) * 100);
  const findings = [];

  if (missing > 0 && Array.isArray(mt.missingFiles)) {
    for (const f of mt.missingFiles.slice(0, 5)) {
      findings.push({
        severity: f.lines > 300 ? 'high' : f.lines > 100 ? 'medium' : 'low',
        title: `Missing test for ${f.file} (${f.lines} lines)`,
        file: f.file,
      });
    }
  }

  return {
    score: Math.max(0, Math.min(100, coveragePercent)),
    details: { source: 'scan_project', covered, missing, total, coveragePercent },
    findings,
  };
}

module.exports = { score };
