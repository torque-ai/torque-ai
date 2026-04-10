'use strict';

const { loadLatestFindings } = require('../findings-parser');

function score(projectPath, scanReport, findingsDir) {
  void projectPath;
  void scanReport;

  const data = loadLatestFindings(findingsDir, 'security');
  if (!data.source) return { score: 50, details: { source: 'no_findings' }, findings: [] };

  const all = data.findings.filter(f => f.status !== 'RESOLVED');
  const critical = all.filter(f => f.severity === 'critical').length;
  const high = all.filter(f => f.severity === 'high').length;
  const medium = all.filter(f => f.severity === 'medium').length;
  const low = all.filter(f => f.severity === 'low').length;

  let s = 100;
  s -= critical * 25;
  s -= high * 15;
  s -= medium * 5;
  s -= low * 2;
  s = Math.max(0, Math.min(100, s));

  const findings = all.map(f => ({ severity: f.severity, title: f.title, file: f.file }));
  return { score: s, details: { source: 'scout_findings', file: data.source, critical, high, medium, low }, findings };
}

module.exports = { score };
