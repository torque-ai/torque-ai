'use strict';

const { createHash } = require('crypto');

const { getDbInstance } = require('../../db/backup-core');
const matchers = require('../matchers');

function getDbHandle() {
  return typeof getDbInstance === 'function' ? getDbInstance() : null;
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function normalizeFilePath(filePath) {
  const normalized = matchers.normalizePath(filePath);
  return normalized || null;
}

function resolveProject(taskData = {}) {
  return normalizeString(
    taskData.project
      || taskData.project_id
      || taskData.projectId
      || taskData.task?.project
      || taskData.task?.project_id
      || taskData.task?.projectId,
  );
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

function buildHotspotId(project, filePath) {
  const fingerprint = `${project}:${filePath}`;
  return `refactor-hotspot:${createHash('sha256').update(fingerprint).digest('hex')}`;
}

function toMetricSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    file_path: normalizeFilePath(row.file_path),
    cyclomatic_complexity: normalizeNumber(row.cyclomatic_complexity),
    cognitive_complexity: normalizeNumber(row.cognitive_complexity),
    lines_of_code: normalizeNumber(row.lines_of_code),
    function_count: normalizeNumber(row.function_count),
    max_nesting_depth: normalizeNumber(row.max_nesting_depth),
    maintainability_index: normalizeNumber(row.maintainability_index),
    analyzed_at: row.analyzed_at || null,
  };
}

function resolveTrend(previousMetric, currentMetric) {
  if (!previousMetric || !currentMetric) return 'stable';

  const cyclomaticDelta =
    normalizeNumber(currentMetric.cyclomatic_complexity) - normalizeNumber(previousMetric.cyclomatic_complexity);
  const cognitiveDelta =
    normalizeNumber(currentMetric.cognitive_complexity) - normalizeNumber(previousMetric.cognitive_complexity);

  if (cyclomaticDelta > 0 || cognitiveDelta > 0) {
    return 'worsening';
  }
  if (cyclomaticDelta < 0 || cognitiveDelta < 0) {
    return 'improving';
  }
  return 'stable';
}

function calculateComplexityScore(metric) {
  if (!metric) return 0;
  return normalizeNumber(metric.cyclomatic_complexity) + normalizeNumber(metric.cognitive_complexity);
}

function getMetricPair(statements, taskId, filePath) {
  if (taskId) {
    const current = statements.selectLatestMetricForTask.get(taskId, filePath);
    if (current) {
      return {
        current: toMetricSnapshot(current),
        previous: toMetricSnapshot(statements.selectPreviousMetricForFile.get(filePath, current.id)),
      };
    }
  }

  const history = statements.selectLatestMetricsForFile.all(filePath).map(toMetricSnapshot);
  return {
    current: history[0] || null,
    previous: history[1] || null,
  };
}

function collectEvidence(taskData = {}, changedFiles) {
  const files = resolveChangedFiles(taskData, changedFiles);
  const evidence = {
    hotspots_worsened: [],
    has_backlog_item: false,
    files_checked: files.length,
  };

  if (files.length === 0) {
    return evidence;
  }

  const db = getDbHandle();
  if (!db) {
    return evidence;
  }

  const project = resolveProject(taskData);
  const taskId = resolveTaskId(taskData);
  const statements = {
    selectLatestMetricsForFile: db.prepare(`
      SELECT *
      FROM complexity_metrics
      WHERE REPLACE(file_path, '\\', '/') = ?
      ORDER BY analyzed_at DESC, id DESC
      LIMIT 2
    `),
    selectLatestMetricForTask: db.prepare(`
      SELECT *
      FROM complexity_metrics
      WHERE task_id = ?
        AND REPLACE(file_path, '\\', '/') = ?
      ORDER BY analyzed_at DESC, id DESC
      LIMIT 1
    `),
    selectPreviousMetricForFile: db.prepare(`
      SELECT *
      FROM complexity_metrics
      WHERE REPLACE(file_path, '\\', '/') = ?
        AND id != ?
      ORDER BY analyzed_at DESC, id DESC
      LIMIT 1
    `),
    selectBacklogItem: db.prepare(`
      SELECT id, status
      FROM refactor_backlog_items
      WHERE project = ?
        AND REPLACE(file_path, '\\', '/') = ?
        AND status IN ('open', 'in_progress')
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `),
    upsertHotspot: db.prepare(`
      INSERT INTO refactor_hotspots (
        id, project, file_path, complexity_score, change_frequency,
        last_worsened_at, trend, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 1,
        ?, 'worsening', datetime('now'), datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        project = excluded.project,
        file_path = excluded.file_path,
        complexity_score = excluded.complexity_score,
        change_frequency = refactor_hotspots.change_frequency + 1,
        last_worsened_at = excluded.last_worsened_at,
        trend = excluded.trend,
        updated_at = datetime('now')
    `),
  };

  for (const filePath of files) {
    const { current, previous } = getMetricPair(statements, taskId, filePath);
    if (!current || !previous) {
      continue;
    }

    const trend = resolveTrend(previous, current);
    if (trend !== 'worsening') {
      continue;
    }

    const hotspotId = project ? buildHotspotId(project, filePath) : null;
    if (project && hotspotId) {
      statements.upsertHotspot.run(
        hotspotId,
        project,
        filePath,
        calculateComplexityScore(current),
        current.analyzed_at || new Date().toISOString(),
      );
    }

    const backlogItem = project
      ? statements.selectBacklogItem.get(project, filePath) || null
      : null;

    evidence.hotspots_worsened.push({
      hotspot_id: hotspotId,
      project,
      file_path: filePath,
      trend,
      complexity_score: calculateComplexityScore(current),
      backlog_item_exists: Boolean(backlogItem),
      backlog_item_id: backlogItem ? backlogItem.id : null,
      current,
      previous,
    });
  }

  evidence.has_backlog_item = evidence.hotspots_worsened.length > 0
    && evidence.hotspots_worsened.every((entry) => entry.backlog_item_exists);

  return evidence;
}

function createRefactorDebtAdapter() {
  return { collectEvidence };
}

module.exports = {
  collectEvidence,
  createRefactorDebtAdapter,
};
