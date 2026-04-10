'use strict';

const { loadLatestFindings } = require('../findings-parser');

function score(projectPath, scanReport, findingsDir) {
  void projectPath;
  void scanReport;

  const data = loadLatestFindings(findingsDir, 'performance');
  if (!data.source) return { score: 50, details: { source: 'no_findings' }, findings: [] };

  const all = data.findings.filter(f => f.status !== 'RESOLVED');
  const critical = all.filter(f => f.severity === 'critical').length;
  const high = all.filter(f => f.severity === 'high').length;

  let s = 100;
  s -= critical * 20;
  s -= high * 10;
  s -= (all.length - critical - high) * 4;
  s = Math.max(0, Math.min(100, s));

  const findings = all.slice(0, 5).map(f => ({ severity: f.severity, title: f.title, file: f.file }));
  return { score: s, details: { source: 'scout_findings', file: data.source, openFindings: all.length }, findings };
}

module.exports = { score };
