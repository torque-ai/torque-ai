'use strict';

const fs = require('fs');
const path = require('path');

function score(projectPath, scanReport, findingsDir) {
  void scanReport;
  void findingsDir;

  const findings = [];
  let s = 50; // start neutral

  // Check for CI config
  const ciFiles = ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci', 'azure-pipelines.yml'];
  let hasCI = false;
  for (const cf of ciFiles) {
    const p = path.join(projectPath, cf);
    if (fs.existsSync(p)) { hasCI = true; break; }
  }
  if (hasCI) s += 20;
  else findings.push({ severity: 'medium', title: 'No CI configuration detected', file: null });

  // Check for package.json scripts
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      if (scripts.test) s += 10;
      else findings.push({ severity: 'low', title: 'No test script in package.json', file: 'package.json' });
      if (scripts.build) s += 10;
      if (scripts.lint) s += 5;
    } catch { /* ignore parse errors */ }
  }

  // Check for Makefile or build script
  if (fs.existsSync(path.join(projectPath, 'Makefile')) || fs.existsSync(path.join(projectPath, 'build.sh'))) s += 5;

  return { score: Math.max(0, Math.min(100, s)), details: { source: 'heuristic', hasCI }, findings };
}

module.exports = { score };
