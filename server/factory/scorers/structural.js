'use strict';

function score(projectPath, scanReport, findingsDir) {
  void projectPath;
  void findingsDir;

  const fileSizes = scanReport?.fileSizes;
  if (!fileSizes || !fileSizes.totalCodeFiles) {
    return { score: 50, details: { source: 'no_data' }, findings: [] };
  }

  const total = fileSizes.totalCodeFiles;
  const largest = fileSizes.largest || [];
  const avgLines = fileSizes.totalLines / total;

  const over500 = largest.filter(f => f.lines > 500).length;
  const over1000 = largest.filter(f => f.lines > 1000).length;

  // Scale penalties by codebase size — large codebases naturally have some big files
  const scaleFactor = total > 500 ? 0.3 : total > 200 ? 0.5 : 1.0;
  let s = 100;
  s -= Math.round(over1000 * 5 * scaleFactor);
  s -= Math.round(over500 * 2 * scaleFactor);
  if (avgLines > 500) s -= 15;
  else if (avgLines > 300) s -= 10;
  else if (avgLines > 200) s -= 5;

  const findings = largest.filter(f => f.lines > 500).map(f => ({
    severity: f.lines > 1000 ? 'high' : 'medium',
    title: `${f.file} has ${f.lines} lines`,
    file: f.file,
  }));

  return {
    score: Math.max(0, Math.min(100, Math.round(s))),
    details: {
      source: 'scan_project',
      totalCodeFiles: total,
      totalLines: fileSizes.totalLines,
      avgLines: Math.round(avgLines),
      largeFileCount: over500,
      veryLargeFileCount: over1000,
    },
    findings,
  };
}

module.exports = { score };
