'use strict';

const fs = require('fs');
const path = require('path');

const REST_ROUTE_FILES = [
  path.join('server', 'api', 'routes.js'),
  path.join('server', 'api', 'routes-passthrough.js'),
  path.join('server', 'api-server.core.js'),
];

const API_DOC_PATHS = [
  path.join('docs', 'api'),
  'api-docs',
  'swagger.json',
  'openapi.json',
  'openapi.yaml',
];

const REST_TOOL_REGEX = /tool:\s*['"]([a-zA-Z0-9_]+)['"]/g;
const MCP_TOOL_REGEX = /name:\s*['"]([a-zA-Z0-9_]+)['"]/g;

function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

function collectMatches(targetSet, content, regex) {
  regex.lastIndex = 0;
  let match = null;
  while ((match = regex.exec(content)) !== null) {
    targetSet.add(match[1]);
  }
}

function collectRestTools(projectPath) {
  const restTools = new Set();

  for (const relativePath of REST_ROUTE_FILES) {
    const filePath = path.join(projectPath, relativePath);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    collectMatches(restTools, content, REST_TOOL_REGEX);
  }

  return restTools;
}

function collectMcpTools(projectPath) {
  const mcpTools = new Set();
  const toolDefsDir = path.join(projectPath, 'server', 'tool-defs');

  if (!fs.existsSync(toolDefsDir)) {
    return mcpTools;
  }

  const fileNames = fs.readdirSync(toolDefsDir)
    .filter((name) => name.endsWith('.js'))
    .sort();

  for (const fileName of fileNames) {
    const filePath = path.join(toolDefsDir, fileName);
    const content = fs.readFileSync(filePath, 'utf8');
    collectMatches(mcpTools, content, MCP_TOOL_REGEX);
  }

  return mcpTools;
}

function detectApiDocs(projectPath) {
  return API_DOC_PATHS.some((relativePath) => fs.existsSync(path.join(projectPath, relativePath)));
}

function score(projectPath, scanReport, findingsDir) {
  void scanReport;
  void findingsDir;

  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return {
      score: 50,
      details: {
        source: 'rest_mcp_parity',
        reason: 'no_project_path',
        mcpToolCount: 0,
        restToolCount: 0,
        parityPct: 0,
        hasApiDocs: false,
      },
      findings: [{ severity: 'low', title: 'No project path supplied', file: null }],
    };
  }

  try {
    const normalizedProjectPath = projectPath.trim();
    const restTools = collectRestTools(normalizedProjectPath);
    const mcpTools = collectMcpTools(normalizedProjectPath);
    const mcpToolCount = mcpTools.size;
    const restToolCount = restTools.size;

    if (mcpToolCount === 0 && restToolCount === 0) {
      return {
        score: 50,
        details: {
          source: 'rest_mcp_parity',
          reason: 'no_api_surface',
          mcpToolCount: 0,
          restToolCount: 0,
          parityPct: 0,
          hasApiDocs: false,
        },
        findings: [],
      };
    }

    let covered = 0;
    for (const toolName of mcpTools) {
      if (restTools.has(toolName)) {
        covered += 1;
      }
    }

    const parityPct = mcpToolCount > 0 ? covered / mcpToolCount : 0;
    const hasApiDocs = detectApiDocs(normalizedProjectPath);

    let rawScore = 20;
    rawScore += 50 * parityPct;
    rawScore += hasApiDocs ? 15 : 0;
    rawScore += mcpToolCount >= 100 ? 5 : 0;
    rawScore += mcpToolCount >= 300 ? 5 : 0;
    rawScore += restToolCount >= 100 ? 5 : 0;

    const findings = [];
    if (parityPct < 0.5) {
      findings.push({
        severity: 'medium',
        title: `REST/MCP parity is ${Math.round(parityPct * 100)}%`,
        file: null,
      });
    }

    if (!hasApiDocs) {
      findings.push({ severity: 'low', title: 'No API documentation detected', file: null });
    }

    const missingRestTools = Array.from(mcpTools)
      .filter((toolName) => !restTools.has(toolName))
      .sort()
      .slice(0, 3);

    for (const toolName of missingRestTools) {
      findings.push({
        severity: 'low',
        title: `MCP tool \`${toolName}\` has no REST route`,
        file: null,
      });
    }

    return {
      score: clampScore(rawScore),
      details: {
        source: 'rest_mcp_parity',
        mcpToolCount,
        restToolCount,
        parityPct,
        hasApiDocs,
      },
      findings: findings.slice(0, 5),
    };
  } catch (err) {
    return {
      score: 50,
      details: {
        source: 'rest_mcp_parity',
        reason: 'scan_error',
        error: err && err.message ? err.message : String(err),
        mcpToolCount: 0,
        restToolCount: 0,
        parityPct: 0,
        hasApiDocs: false,
      },
      findings: [],
    };
  }
}

module.exports = { score };
