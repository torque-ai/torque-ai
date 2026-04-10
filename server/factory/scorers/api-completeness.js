'use strict';

const fs = require('fs');
const path = require('path');

function score(projectPath, scanReport, findingsDir) {
  void findingsDir;

  const findings = [];
  let s = 50;

  // Check for API docs
  const apiDocPaths = ['docs/api', 'api-docs', 'swagger.json', 'openapi.json', 'openapi.yaml'];
  let hasApiDocs = false;
  for (const dp of apiDocPaths) {
    if (fs.existsSync(path.join(projectPath, dp))) { hasApiDocs = true; break; }
  }
  if (hasApiDocs) s += 20;
  else findings.push({ severity: 'low', title: 'No API documentation detected', file: null });

  // Check test coverage ratio from scan_project
  const mt = scanReport?.missingTests;
  if (mt && mt.total > 0) {
    const ratio = (mt.covered || 0) / mt.total;
    if (ratio > 0.7) s += 15;
    else if (ratio > 0.4) s += 10;
    else if (ratio > 0.2) s += 5;
  }

  // Check for README
  if (fs.existsSync(path.join(projectPath, 'README.md'))) s += 10;

  return {
    score: Math.max(0, Math.min(100, s)),
    details: { source: 'heuristic', hasApiDocs },
    findings,
  };
}

module.exports = { score };
