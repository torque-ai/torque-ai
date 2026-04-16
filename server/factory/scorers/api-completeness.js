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
  'swagger.yaml',
  'swagger.yml',
  'openapi.json',
  'openapi.yaml',
];

const REST_TOOL_REGEX = /tool:\s*['"]([a-zA-Z0-9_]+)['"]/g;
const MCP_TOOL_REGEX = /name:\s*['"]([a-zA-Z0-9_]+)['"]/g;
const API_CONTROLLER_RE = /\[ApiController\]/;
const CONTROLLER_CLASS_RE = /\bclass\s+\w+Controller\b/;
const ROUTE_ATTR_RE = /\[Route\(\s*"([^"]+)"\s*\)\]/g;
const HTTP_ATTR_RE = /\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|HttpHead|HttpOptions)(?:\(\s*"([^"]*)"\s*\))?\]/g;
const MINIMAL_API_RE = /app\.(MapGet|MapPost|MapPut|MapDelete|MapPatch|MapHead|MapOptions)\s*\(\s*"([^"]+)"/g;
const MAP_CONTROLLERS_RE = /\bMapControllers\s*\(/g;
const API_ROUTE_RE = /\/?api\/v\d+/i;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'bin', 'obj']);

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

function normalizeRouteFragment(route) {
  return String(route || '')
    .trim()
    .replace(/^~/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function combineRoute(baseRoute, childRoute) {
  const normalizedBase = normalizeRouteFragment(baseRoute);
  const normalizedChild = normalizeRouteFragment(childRoute);

  if (!normalizedBase && !normalizedChild) return null;
  if (!normalizedBase) return `/${normalizedChild}`;
  if (!normalizedChild) return `/${normalizedBase}`;
  if (API_ROUTE_RE.test(normalizedChild)) return `/${normalizedChild}`;
  return `/${normalizedBase}/${normalizedChild}`.replace(/\/+/g, '/');
}

function walkDotNetApiFiles(projectPath, currentDir = projectPath, files = []) {
  if (!fs.existsSync(currentDir)) {
    return files;
  }

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      walkDotNetApiFiles(projectPath, path.join(currentDir, entry.name), files);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.cs')) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(projectPath, fullPath).split(path.sep).join('/');
    if (
      /(^|\/)Controllers\/.*\.cs$/i.test(relativePath) ||
      /(^|\/)[^/]+\.Api\/.*\.cs$/i.test(relativePath) ||
      /(^|\/)(Program|Startup)\.cs$/i.test(relativePath)
    ) {
      files.push({ fullPath, relativePath });
    }
  }

  return files;
}

function collectAspNetApiSurface(projectPath) {
  const restTools = new Set();
  let controllerCount = 0;
  let attributeEndpointCount = 0;
  let minimalEndpointCount = 0;
  let usesMapControllers = false;
  let surfaceFilesScanned = 0;

  for (const file of walkDotNetApiFiles(projectPath)) {
    surfaceFilesScanned += 1;
    const content = fs.readFileSync(file.fullPath, 'utf8');
    const routeMatches = Array.from(content.matchAll(ROUTE_ATTR_RE)).map(match => match[1]);
    const preferredBaseRoute = routeMatches.find(route => API_ROUTE_RE.test(route)) || routeMatches[0] || '';
    const hasController = API_CONTROLLER_RE.test(content) || CONTROLLER_CLASS_RE.test(content);
    const httpMatches = Array.from(content.matchAll(HTTP_ATTR_RE));
    const minimalMatches = Array.from(content.matchAll(MINIMAL_API_RE));

    if (hasController) {
      controllerCount += 1;
    }

    for (const match of httpMatches) {
      const method = match[1].replace(/^Http/, '').toUpperCase();
      const endpointRoute = combineRoute(preferredBaseRoute, match[2]);
      attributeEndpointCount += 1;
      restTools.add(endpointRoute ? `${method} ${endpointRoute}` : `${method} ${file.relativePath}`);
    }

    if (hasController && preferredBaseRoute && httpMatches.length === 0) {
      restTools.add(`CONTROLLER ${combineRoute(preferredBaseRoute, '')}`);
    }

    for (const match of minimalMatches) {
      const method = match[1].replace(/^Map/, '').toUpperCase();
      minimalEndpointCount += 1;
      restTools.add(`${method} ${combineRoute('', match[2])}`);
    }

    if (MAP_CONTROLLERS_RE.test(content)) {
      usesMapControllers = true;
      restTools.add('MAP_CONTROLLERS');
    }
  }

  return {
    restTools,
    controllerCount,
    attributeEndpointCount,
    minimalEndpointCount,
    usesMapControllers,
    surfaceFilesScanned,
  };
}

function collectRestSurface(projectPath) {
  const restTools = new Set();

  for (const relativePath of REST_ROUTE_FILES) {
    const filePath = path.join(projectPath, relativePath);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    collectMatches(restTools, content, REST_TOOL_REGEX);
  }

  const aspNetSurface = collectAspNetApiSurface(projectPath);
  for (const toolName of aspNetSurface.restTools) {
    restTools.add(toolName);
  }

  return {
    restTools,
    ...aspNetSurface,
  };
}

function collectRestTools(projectPath) {
  return collectRestSurface(projectPath).restTools;
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
    const {
      restTools,
      controllerCount,
      attributeEndpointCount,
      minimalEndpointCount,
      usesMapControllers,
      surfaceFilesScanned,
    } = collectRestSurface(normalizedProjectPath);
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

    const restOnlySurface = mcpToolCount === 0 && restToolCount > 0;
    let covered = 0;
    for (const toolName of mcpTools) {
      if (restTools.has(toolName)) {
        covered += 1;
      }
    }

    const parityPct = restOnlySurface ? 1 : mcpToolCount > 0 ? covered / mcpToolCount : 0;
    const hasApiDocs = detectApiDocs(normalizedProjectPath);

    let rawScore = 20;
    if (restOnlySurface) {
      rawScore += 30;
      rawScore += Math.min(15, restToolCount * 5);
    } else {
      rawScore += 50 * parityPct;
    }
    rawScore += hasApiDocs ? 15 : 0;
    rawScore += controllerCount > 0 ? 5 : 0;
    rawScore += minimalEndpointCount > 0 ? 5 : 0;
    rawScore += mcpToolCount >= 100 ? 5 : 0;
    rawScore += mcpToolCount >= 300 ? 5 : 0;
    rawScore += restToolCount >= 100 ? 5 : 0;

    const findings = [];
    if (!restOnlySurface && parityPct < 0.5) {
      findings.push({
        severity: 'medium',
        title: `REST/MCP parity is ${Math.round(parityPct * 100)}%`,
        file: null,
      });
    }

    if (!hasApiDocs) {
      findings.push({ severity: 'low', title: 'No API documentation detected', file: null });
    }

    if (!restOnlySurface) {
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
    }

    return {
      score: clampScore(rawScore),
      details: {
        source: 'rest_mcp_parity',
        mcpToolCount,
        restToolCount,
        parityPct,
        hasApiDocs,
        controllerCount,
        attributeEndpointCount,
        minimalEndpointCount,
        usesMapControllers,
        surfaceFilesScanned,
        surfaceMode: restOnlySurface ? 'rest_only' : 'rest_mcp_parity',
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

module.exports = {
  clampScore,
  collectMatches,
  collectRestTools,
  collectMcpTools,
  detectApiDocs,
  score,
};
