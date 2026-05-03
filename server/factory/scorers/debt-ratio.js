'use strict';

function isDebtRatioSelfReference(file) {
  if (typeof file !== 'string') {
    return false;
  }

  const normalized = file.replace(/\\/g, '/');
  return normalized === 'server/factory/guardrails.js' || normalized.startsWith('server/factory/scorers/');
}

function score(projectPath, scanReport, findingsDir) {
  void projectPath;
  void findingsDir;

  const todos = scanReport?.todos;
  if (!todos) {
    return { score: 50, details: { source: 'no_data' }, findings: [] };
  }

  const scorableItems = Array.isArray(todos.items)
    ? todos.items.filter(item => !isDebtRatioSelfReference(item?.file))
    : null;

  const todoCount = Array.isArray(todos.items) ? scorableItems.length : (todos.count || 0);
  const totalFiles = scanReport?.summary?.totalFiles || 1;
  const density = todoCount / totalFiles;
  const findings = [];

  let s;
  if (density <= 0.02) s = 95;
  else if (density <= 0.05) s = 80;
  else if (density <= 0.1) s = 65;
  else if (density <= 0.2) s = 45;
  else s = 20;

  if (todoCount > 0 && scorableItems) {
    const hacks = scorableItems.filter(t => t.type === 'HACK' || t.type === 'FIXME' || t.type === 'XXX');
    if (hacks.length > 0) {
      s = Math.max(0, s - hacks.length * 5);
      for (const h of hacks.slice(0, 3)) {
        findings.push({ severity: 'medium', title: `${h.type}: ${h.text.substring(0, 60)}`, file: h.file });
      }
    }
  }

  return {
    score: Math.max(0, Math.min(100, s)),
    details: { source: 'scan_project', todoCount, totalFiles, density: Math.round(density * 1000) / 1000 },
    findings,
  };
}

module.exports = { score };
