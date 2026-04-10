'use strict';

const fs = require('fs');
const path = require('path');

function parseFindingsMarkdown(content) {
  const findings = [];
  const lines = String(content || '').split(/\r?\n/);
  let current = null;

  function pushCurrent() {
    if (!current || !current.title) {
      return;
    }
    findings.push({
      severity: current.severity || 'medium',
      title: current.title,
      file: current.file || null,
      description: current.description || '',
      status: current.status || 'NEW',
    });
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^###\s*\[([A-Za-z]+)\]\s*(.+)$/);
    if (headingMatch) {
      pushCurrent();
      current = {
        severity: headingMatch[1].toLowerCase(),
        title: headingMatch[2].trim(),
        file: null,
        description: '',
        status: 'NEW',
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const fileMatch = trimmed.match(/^-\s*File:\s*(.+)$/i);
    if (fileMatch) {
      current.file = fileMatch[1].trim();
      continue;
    }

    const descriptionMatch = trimmed.match(/^-\s*Description:\s*(.+)$/i);
    if (descriptionMatch) {
      current.description = descriptionMatch[1].trim();
      continue;
    }

    const statusMatch = trimmed.match(/^-\s*Status:\s*(.+)$/i);
    if (statusMatch) {
      current.status = statusMatch[1].trim().toUpperCase();
    }
  }

  pushCurrent();
  return findings;
}

function loadLatestFindings(findingsDir, category) {
  if (!findingsDir || !fs.existsSync(findingsDir)) {
    return { source: null, findings: [] };
  }

  let stats;
  try {
    stats = fs.statSync(findingsDir);
  } catch {
    return { source: null, findings: [] };
  }

  if (!stats.isDirectory()) {
    return { source: null, findings: [] };
  }

  const needle = String(category || '').toLowerCase().replace(/_/g, '-');
  const candidates = fs.readdirSync(findingsDir)
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.endsWith('.md') && lower.includes(needle);
    })
    .map((name) => {
      const fullPath = path.join(findingsDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { name, fullPath, mtimeMs };
    })
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return b.name.localeCompare(a.name);
    });

  if (candidates.length === 0) {
    return { source: null, findings: [] };
  }

  const latest = candidates[0];
  const content = fs.readFileSync(latest.fullPath, 'utf-8');
  return {
    source: latest.fullPath,
    findings: parseFindingsMarkdown(content),
  };
}

module.exports = {
  loadLatestFindings,
  parseFindingsMarkdown,
};
