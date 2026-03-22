'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { getDbInstance } = require('../../db/backup-core');
const matchers = require('../matchers');

const USER_VISIBLE_SEGMENTS = new Set(['routes', 'api', 'pages', 'views', 'components', 'dashboard']);
const MAX_FILE_BYTES = 1024 * 1024;

function getDbHandle() {
  return typeof getDbInstance === 'function' ? getDbInstance() : null;
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFilePath(filePath) {
  const normalized = matchers.normalizePath(filePath);
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

function resolveWorkingDirectory(taskData = {}) {
  return normalizeString(
    taskData.working_directory
      || taskData.workingDirectory
      || taskData.project_path
      || taskData.projectPath
      || taskData.task?.working_directory
      || taskData.task?.workingDirectory
      || taskData.task?.project_path
      || taskData.task?.projectPath,
  );
}

function resolveChangedFiles(taskData = {}, changedFiles) {
  if (Array.isArray(changedFiles)) {
    return [...new Set(changedFiles.map(normalizeFilePath).filter(Boolean))];
  }

  const extracted = matchers.extractChangedFiles(taskData);
  if (Array.isArray(extracted)) {
    return [...new Set(extracted.map(normalizeFilePath).filter(Boolean))];
  }

  return [];
}

function resolveAbsolutePath(filePath, workingDirectory) {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return filePath;
  if (workingDirectory) return path.join(workingDirectory, filePath);
  return path.resolve(filePath);
}

function readTextFile(filePath, workingDirectory) {
  const absolutePath = resolveAbsolutePath(filePath, workingDirectory);
  if (!absolutePath) return null;

  try {
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      return null;
    }
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function addMatches(findings, filePath, flagType, content, regex, extractor) {
  regex.lastIndex = 0;
  for (const match of content.matchAll(regex)) {
    const flagName = normalizeString(typeof extractor === 'function' ? extractor(match) : match[1] || match[2]);
    findings.push({
      file_path: filePath,
      flag_name: flagName,
      flag_type: flagType,
      match: normalizeString(match[0]) || '',
    });
  }
}

function detectFeatureFlags(filePath, content) {
  if (!content) return [];

  const findings = [];

  addMatches(
    findings,
    filePath,
    'env',
    content,
    /process\.env\.(FEATURE_[A-Z0-9_]+|FF_[A-Z0-9_]+)\b/g,
  );
  addMatches(
    findings,
    filePath,
    'feature_flags',
    content,
    /featureFlags\.isEnabled\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    (match) => match[2],
  );
  addMatches(
    findings,
    filePath,
    'flags_object',
    content,
    /if\s*\([^)]*\bflags\.([A-Za-z0-9_]+)\b[^)]*\)/g,
  );
  addMatches(
    findings,
    filePath,
    'config_feature',
    content,
    /if\s*\([^)]*\bconfig\.(feature_[A-Za-z0-9_]+)\b[^)]*\)/g,
  );
  addMatches(
    findings,
    filePath,
    'launchdarkly',
    content,
    /\b(?:ldClient|launchDarklyClient)\.variation\s*\(\s*(['"`])([^'"`]+)\1/g,
    (match) => match[2],
  );
  addMatches(
    findings,
    filePath,
    'launchdarkly',
    content,
    /\buseFlag\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    (match) => match[2],
  );
  addMatches(
    findings,
    filePath,
    'unleash',
    content,
    /\b(?:unleash|unleashClient)\.(?:isEnabled|getVariant)\s*\(\s*(['"`])([^'"`]+)\1/g,
    (match) => match[2],
  );
  addMatches(
    findings,
    filePath,
    'custom_sdk',
    content,
    /\b(?:featureToggle|featureToggles|flags|toggles)\.(?:isEnabled|getVariant|variation)\s*\(\s*(['"`])([^'"`]+)\1/g,
    (match) => match[2],
  );

  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.file_path}:${finding.flag_type}:${finding.flag_name || finding.match}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectUserVisibleChange(filePath, content) {
  const reasons = [];
  const normalizedPath = normalizeFilePath(filePath);
  if (!normalizedPath) return null;

  const segments = normalizedPath.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => USER_VISIBLE_SEGMENTS.has(segment))) {
    reasons.push('surface_path');
  }

  if (content) {
    if (/\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(content)) {
      reasons.push('http_handler_export');
    }
    if (/\b(?:router|app)\.(?:get|post|put|patch|delete|all|use)\s*\(/i.test(content)) {
      reasons.push('http_handler_registration');
    }
    if (
      /\bexport\s+default\s+function\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(content)
      || /\bexport\s+function\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(content)
      || /\bexport\s+(?:const|let|var)\s+[A-Z][A-Za-z0-9_]*\s*=/.test(content)
      || /\bexport\s+default\s+class\s+[A-Z][A-Za-z0-9_]*\s+extends\s+React\.Component\b/.test(content)
    ) {
      reasons.push('react_component_export');
    }
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    file_path: normalizedPath,
    reasons: uniq(reasons),
  };
}

function persistFeatureFlagEvidence(taskData = {}, findings = []) {
  const db = getDbHandle();
  if (!db) return;

  const taskId = resolveTaskId(taskData);
  if (taskId) {
    db.prepare('DELETE FROM feature_flag_evidence WHERE task_id = ?').run(taskId);
  }

  if (findings.length === 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO feature_flag_evidence (
      id, task_id, file_path, flag_name, flag_type
    ) VALUES (?, ?, ?, ?, ?)
  `);

  for (const finding of findings) {
    insert.run(
      randomUUID(),
      taskId,
      finding.file_path,
      finding.flag_name || null,
      finding.flag_type || 'unknown',
    );
  }
}

function collectEvidence(taskData = {}, changedFiles) {
  const files = resolveChangedFiles(taskData, changedFiles);
  const workingDirectory = resolveWorkingDirectory(taskData);
  const userVisibleChanges = [];
  const featureFlagsFound = [];

  for (const filePath of files) {
    const content = readTextFile(filePath, workingDirectory);
    const userVisibleChange = detectUserVisibleChange(filePath, content);
    if (userVisibleChange) {
      userVisibleChanges.push(userVisibleChange);
    }

    featureFlagsFound.push(...detectFeatureFlags(filePath, content));
  }

  persistFeatureFlagEvidence(taskData, featureFlagsFound);

  return {
    user_visible_changes: userVisibleChanges,
    feature_flags_found: featureFlagsFound,
    has_feature_flag: featureFlagsFound.length > 0,
  };
}

function createFeatureFlagAdapter() {
  return { collectEvidence };
}

module.exports = {
  collectEvidence,
  createFeatureFlagAdapter,
};
