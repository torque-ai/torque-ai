'use strict';

const { loadLatestFindings } = require('../findings-parser');

function score(projectPath, scanReport, findingsDir) {
  void projectPath;
  void scanReport;

  const data = loadLatestFindings(findingsDir, 'documentation');
  if (!data.source) return { score: 50, details: { source: 'no_findings' }, findings: [] };

  const all = data.findings.filter(f => f.status !== 'RESOLVED');
  const total = all.length;

  let s = 100;
  s -= total * 8;
  s = Math.max(0, Math.min(100, s));

  const findings = all.slice(0, 5).map(f => ({ severity: f.severity, title: f.title, file: f.file }));
  return { score: s, details: { source: 'scout_findings', file: data.source, openFindings: total }, findings };
}

module.exports = { score };
