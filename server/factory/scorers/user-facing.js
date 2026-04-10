'use strict';

function score(projectPath, scanReport, findingsDir) {
  void projectPath;
  void findingsDir;

  const findings = [];
  let s = 50;

  const totalFiles = scanReport?.summary?.totalFiles || 0;

  // Check for UX-related TODOs
  if (scanReport?.todos?.items) {
    const uxTodos = scanReport.todos.items.filter(t =>
      /\b(ux|ui|error.?handl|user.?fac|loading|spinner)/i.test(t.text)
    );
    if (uxTodos.length > 0) {
      s -= uxTodos.length * 5;
      for (const t of uxTodos.slice(0, 3)) {
        findings.push({ severity: 'low', title: `UX TODO: ${t.text.substring(0, 60)}`, file: t.file });
      }
    }
  }

  // Reasonable file count bonus
  if (totalFiles > 0 && totalFiles < 300) s += 10;

  return {
    score: Math.max(0, Math.min(100, s)),
    details: { source: 'heuristic' },
    findings,
  };
}

module.exports = { score };
