'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const database = require('../../database');
const matchers = require('../matchers');

const SCANNABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.cts', '.mts']);

function getDbHandle() {
  return typeof database.getDbInstance === 'function' ? database.getDbInstance() : null;
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMatcherPath(value) {
  const normalized = matchers.normalizePath(value);
  return normalized || null;
}

function resolveTaskId(taskData = {}) {
  return normalizeString(
    taskData.id
      || taskData.task_id
      || taskData.taskId
      || taskData.task?.id
      || taskData.task?.task_id
      || taskData.task?.taskId,
  );
}

function resolveProject(taskData = {}, project) {
  return normalizeString(
    project
      || taskData.project
      || taskData.project_id
      || taskData.projectId
      || taskData.task?.project
      || taskData.task?.project_id
      || taskData.task?.projectId,
  );
}

function resolveEvaluationId(taskData = {}) {
  return normalizeString(
    taskData.evaluation_id
      || taskData.evaluationId
      || taskData.policy_evaluation_id
      || taskData.policyEvaluationId
      || taskData.task?.evaluation_id
      || taskData.task?.evaluationId
      || taskData.task?.policy_evaluation_id
      || taskData.task?.policyEvaluationId,
  );
}

function resolveProjectRoot(taskData = {}) {
  const candidate = normalizeString(
    taskData.working_directory
      || taskData.workingDirectory
      || taskData.project_path
      || taskData.projectPath
      || taskData.task?.working_directory
      || taskData.task?.workingDirectory
      || taskData.task?.project_path
      || taskData.task?.projectPath,
  );
  return candidate ? path.resolve(candidate) : null;
}

function resolveChangedFiles(taskData = {}, changedFiles) {
  if (Array.isArray(changedFiles)) {
    return [...new Set(changedFiles.map(normalizeMatcherPath).filter(Boolean))];
  }

  const extracted = matchers.extractChangedFiles(taskData);
  if (Array.isArray(extracted)) {
    return [...new Set(extracted.map(normalizeMatcherPath).filter(Boolean))];
  }

  return [];
}

function normalizePatternArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeMatcherPath(entry))
      .filter(Boolean);
  }

  const text = normalizeString(value);
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => normalizeMatcherPath(entry))
        .filter(Boolean);
    }
  } catch {
    // Fall back to treating the raw string as a single matcher.
  }

  const normalized = normalizeMatcherPath(text);
  return normalized ? [normalized] : [];
}

function normalizeBoundary(boundary = {}) {
  return {
    id: normalizeString(boundary.id),
    project: normalizeString(boundary.project),
    name: normalizeString(boundary.name),
    boundary_type: normalizeString(boundary.boundary_type || boundary.boundaryType),
    source_patterns: normalizePatternArray(boundary.source_patterns || boundary.sourcePatterns),
    allowed_dependencies: normalizePatternArray(
      boundary.allowed_dependencies || boundary.allowedDependencies,
    ),
    forbidden_dependencies: normalizePatternArray(
      boundary.forbidden_dependencies || boundary.forbiddenDependencies,
    ),
    enabled: boundary.enabled === undefined ? true : Boolean(boundary.enabled),
  };
}

function resolveImportTarget(sourceFilePath, importSource) {
  const normalizedSource = normalizeMatcherPath(sourceFilePath);
  const normalizedImport = normalizeMatcherPath(importSource);
  if (!normalizedSource || !normalizedImport) return null;

  if (path.isAbsolute(sourceFilePath)) {
    return normalizeMatcherPath(path.resolve(path.dirname(sourceFilePath), importSource));
  }

  const baseDir = path.posix.dirname(normalizedSource);
  const joined = baseDir === '.'
    ? path.posix.normalize(normalizedImport)
    : path.posix.normalize(path.posix.join(baseDir, normalizedImport));
  return normalizeMatcherPath(joined);
}

function scanImports(filePath, fileContent) {
  const source = normalizeMatcherPath(filePath);
  if (!source || typeof fileContent !== 'string' || fileContent.length === 0) {
    return [];
  }

  const imports = [];
  const seen = new Set();
  const patterns = [
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bimport\s+(?:type\s+)?[\s\w{},*$]+\s+from\s+(['"])([^'"]+)\1/g,
    /\bimport\s+(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];

  function recordImport(specifier) {
    if (!specifier || (!specifier.startsWith('./') && !specifier.startsWith('../'))) {
      return;
    }

    const imported = resolveImportTarget(source, specifier);
    if (!imported) return;

    const key = `${source}=>${imported}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ source, imported });
  }

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(fileContent)) !== null) {
      recordImport(match[2]);
    }
  }

  return imports;
}

function checkBoundaries(imports, boundaries) {
  const normalizedImports = Array.isArray(imports)
    ? imports
        .map((entry) => ({
          source: normalizeMatcherPath(entry?.source),
          imported: normalizeMatcherPath(entry?.imported),
        }))
        .filter((entry) => entry.source && entry.imported)
    : [];
  const normalizedBoundaries = Array.isArray(boundaries)
    ? boundaries.map(normalizeBoundary).filter((boundary) => boundary.id && boundary.enabled)
    : [];

  const violations = [];
  const seen = new Set();

  for (const dependency of normalizedImports) {
    for (const boundary of normalizedBoundaries) {
      if (
        boundary.source_patterns.length === 0
        || !matchers.matchesAnyGlob(dependency.source, boundary.source_patterns)
      ) {
        continue;
      }

      let violationType = null;
      if (
        boundary.forbidden_dependencies.length > 0
        && matchers.matchesAnyGlob(dependency.imported, boundary.forbidden_dependencies)
      ) {
        violationType = 'forbidden_import';
      } else if (
        boundary.allowed_dependencies.length > 0
        && !matchers.matchesAnyGlob(dependency.imported, boundary.allowed_dependencies)
      ) {
        violationType = 'outside_allowed_dependencies';
      }

      if (!violationType) {
        continue;
      }

      const key = `${boundary.id}:${dependency.source}:${dependency.imported}:${violationType}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      violations.push({
        id: randomUUID(),
        boundary_id: boundary.id,
        boundary_name: boundary.name,
        boundary_type: boundary.boundary_type,
        source_file: dependency.source,
        imported_file: dependency.imported,
        violation_type: violationType,
      });
    }
  }

  return violations;
}

function resolveFileForScan(filePath, projectRoot) {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  if (projectRoot) {
    return path.resolve(projectRoot, filePath);
  }
  return path.resolve(filePath);
}

function toBoundaryPath(filePath, projectRoot) {
  if (!filePath) return null;
  const absoluteCandidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : resolveFileForScan(filePath, projectRoot);
  if (projectRoot && absoluteCandidate) {
    const relative = path.relative(projectRoot, absoluteCandidate);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return normalizeMatcherPath(relative);
    }
  }
  return normalizeMatcherPath(filePath);
}

function resolvePersistedEvaluationId(db, taskData = {}) {
  const evaluationId = resolveEvaluationId(taskData);
  if (!evaluationId || !db) return null;

  const row = db.prepare('SELECT id FROM policy_evaluations WHERE id = ?').get(evaluationId);
  return row ? row.id : null;
}

function collectEvidence(taskData = {}, changedFiles, project) {
  const db = getDbHandle();
  const resolvedProject = resolveProject(taskData, project);
  const evidence = {
    violations: [],
    boundaries_checked: 0,
    files_scanned: 0,
  };

  if (!db || !resolvedProject) {
    return evidence;
  }

  const boundaries = db.prepare(`
    SELECT *
    FROM architecture_boundaries
    WHERE project = ?
      AND enabled = 1
    ORDER BY name ASC, id ASC
  `).all(resolvedProject).map(normalizeBoundary);

  evidence.boundaries_checked = boundaries.length;
  if (boundaries.length === 0) {
    return evidence;
  }

  const files = resolveChangedFiles(taskData, changedFiles);
  if (files.length === 0) {
    return evidence;
  }

  const projectRoot = resolveProjectRoot(taskData);
  const collectedImports = [];

  for (const filePath of files) {
    const absolutePath = resolveFileForScan(filePath, projectRoot);
    const extension = path.extname(absolutePath || filePath).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(extension) || !absolutePath || !fs.existsSync(absolutePath)) {
      continue;
    }

    const sourcePath = toBoundaryPath(filePath, projectRoot);
    if (!sourcePath) {
      continue;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
    evidence.files_scanned += 1;
    collectedImports.push(...scanImports(sourcePath, content));
  }

  const violations = checkBoundaries(collectedImports, boundaries);
  evidence.violations = violations;

  if (violations.length === 0) {
    return evidence;
  }

  const taskId = resolveTaskId(taskData);
  const evaluationId = resolvePersistedEvaluationId(db, taskData);
  const insertViolation = db.prepare(`
    INSERT INTO architecture_violations (
      id, evaluation_id, boundary_id, source_file, imported_file, violation_type
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction((rows) => {
    for (const violation of rows) {
      insertViolation.run(
        violation.id,
        evaluationId,
        violation.boundary_id,
        violation.source_file,
        violation.imported_file,
        violation.violation_type,
      );
    }
  })(violations);

  evidence.violations = violations.map((violation) => ({
    ...violation,
    evaluation_id: evaluationId,
    task_id: taskId,
  }));

  return evidence;
}

module.exports = {
  scanImports,
  checkBoundaries,
  collectEvidence,
};
