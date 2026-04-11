'use strict';

const fs = require('fs');
const path = require('path');

function score(projectPath, scanReport, findingsDir) {
  void findingsDir;

  const mt = scanReport?.missingTests;

  // If scan_project reports coverage, use it
  if (mt && mt.total > 0 && mt.coveragePercent > 0) {
    const findings = [];
    if (mt.missing > 0 && Array.isArray(mt.missingFiles)) {
      for (const f of mt.missingFiles.slice(0, 5)) {
        findings.push({
          severity: f.lines > 300 ? 'high' : f.lines > 100 ? 'medium' : 'low',
          title: `Missing test for ${f.file} (${f.lines} lines)`,
          file: f.file,
        });
      }
    }
    return {
      score: Math.max(0, Math.min(100, mt.coveragePercent)),
      details: { source: 'scan_project', covered: mt.covered, missing: mt.missing, total: mt.total, coveragePercent: mt.coveragePercent },
      findings,
    };
  }

  // Fallback: count test files directly (handles non-co-located test directories)
  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  let testFileCount = 0;
  let sourceFileCount = mt?.total || scanReport?.fileSizes?.totalCodeFiles || 0;

  for (const testDir of testDirs) {
    const candidates = [
      path.join(projectPath, testDir),
      path.join(projectPath, 'server', testDir),
      path.join(projectPath, 'src', testDir),
    ];
    for (const dir of candidates) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => /\.test\.|\.spec\.|_test\./i.test(f));
        testFileCount += files.length;
      } catch { /* skip */ }
    }
  }

  if (testFileCount === 0 && sourceFileCount === 0) {
    return { score: 50, details: { source: 'no_data' }, findings: [] };
  }

  // Estimate coverage ratio from test file count vs source file count
  const ratio = sourceFileCount > 0 ? Math.min(testFileCount / sourceFileCount, 1.0) : 0;
  const coveragePercent = Math.round(ratio * 100);

  return {
    score: Math.max(0, Math.min(100, coveragePercent)),
    details: {
      source: 'file_count_heuristic',
      test_files: testFileCount,
      source_files: sourceFileCount,
      coveragePercent,
    },
    findings: coveragePercent < 50 ? [{ severity: 'medium', title: `Test file ratio is ${coveragePercent}% (${testFileCount} test files / ${sourceFileCount} source files)`, file: null }] : [],
  };
}

module.exports = { score };
