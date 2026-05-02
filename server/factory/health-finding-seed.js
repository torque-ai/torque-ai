'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 3;
const RECENT_DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL_DUPLICATE_STATUSES = Object.freeze([
  'completed',
  'rejected',
  'shipped',
  'shipped_stale',
  'unactionable',
  'needs_review',
  'superseded',
  'escalation_exhausted',
]);

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeRepoPath(projectPath, filePath) {
  if (!projectPath || !filePath) {
    return null;
  }

  const root = path.resolve(projectPath);
  const raw = String(filePath).trim();
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(root, raw);
  const relative = path.relative(root, resolved);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return toPosixPath(relative);
}

function existingFile(projectPath, repoPath) {
  if (!projectPath || !repoPath) {
    return false;
  }
  const resolved = path.resolve(projectPath, repoPath);
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function siblingTestPath(repoPath) {
  const parsed = path.posix.parse(toPosixPath(repoPath));
  if (!parsed.ext) {
    return null;
  }
  if (/\.test\.[cm]?[jt]sx?$/i.test(parsed.base)) {
    return null;
  }
  return path.posix.join(parsed.dir, `${parsed.name}.test${parsed.ext}`);
}

function verificationForPath(repoPath) {
  const normalized = toPosixPath(repoPath);
  if (normalized.startsWith('dashboard/')) {
    return 'npm --prefix dashboard test -- --run';
  }
  if (normalized.startsWith('server/')) {
    return 'npm --prefix server test --';
  }
  return 'npm test';
}

function severityPriority(severity) {
  const normalized = String(severity || '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'high') {
    return 'high';
  }
  if (normalized === 'medium') {
    return 'medium';
  }
  return 'default';
}

function variantForDimension(dimension) {
  switch (String(dimension || '').trim()) {
    case 'user_facing':
      return 'visual';
    case 'dependency_health':
      return 'dependency';
    case 'documentation':
      return 'documentation';
    case 'test_coverage':
      return 'test-coverage';
    case 'performance':
      return 'performance';
    case 'security':
      return 'security';
    default:
      return 'quality';
  }
}

function buildCandidateFromHealthFinding(finding, project) {
  const repoPath = normalizeRepoPath(project?.path, finding?.file_path);
  if (!repoPath || !existingFile(project.path, repoPath)) {
    return null;
  }

  const message = String(finding?.message || '').trim();
  if (!message) {
    return null;
  }

  const allowedFiles = [repoPath];
  const testPath = siblingTestPath(repoPath);
  if (testPath && existingFile(project.path, testPath)) {
    allowedFiles.push(testPath);
  }

  const basename = path.posix.basename(repoPath);
  const lowerMessage = message.toLowerCase();
  let title = null;
  let work = null;

  if (lowerMessage.includes('has no empty-state handling')) {
    title = `Add empty-state handling to ${basename}`;
    work = `Update ${repoPath} so empty API/list states render an accessible, testable empty state instead of blank content.`;
  }

  if (!title || !work) {
    return null;
  }

  const verification = verificationForPath(repoPath);
  const severity = String(finding.severity || 'medium').trim().toLowerCase() || 'medium';
  const dimension = String(finding.dimension || 'user_facing').trim() || 'user_facing';

  return {
    title,
    description: [
      `Factory health finding (${dimension}/${severity}): ${message}`,
      work,
      `Keep the implementation scoped to ${allowedFiles.map((file) => `\`${file}\``).join(', ')}.`,
      `Acceptance criteria: the view must show a meaningful empty state and the relevant dashboard tests should pass.`,
      `Verification: ${verification}`,
    ].join('\n\n'),
    priority: severityPriority(severity),
    requestor: 'starvation-health-seed',
    origin: {
      type: 'starvation_health_finding',
      finding_id: finding.id || null,
      snapshot_id: finding.snapshot_id || null,
      dimension,
      severity,
      variant: variantForDimension(dimension),
      file: repoPath,
      allowed_files: allowedFiles,
      message,
    },
    constraints: {
      allowed_files: allowedFiles,
      verification,
      max_files: allowedFiles.length,
    },
  };
}

function hasDuplicate(factoryIntake, projectId, title) {
  if (!factoryIntake || !projectId || !title) {
    return false;
  }

  if (typeof factoryIntake.findDuplicates === 'function') {
    const openDuplicates = factoryIntake.findDuplicates(projectId, title) || [];
    if (openDuplicates.length > 0) {
      return true;
    }
  }

  if (typeof factoryIntake.findRecentDuplicateWorkItems === 'function') {
    const recent = factoryIntake.findRecentDuplicateWorkItems(projectId, title, {
      source: 'scout',
      statuses: TERMINAL_DUPLICATE_STATUSES,
      windowMs: RECENT_DUPLICATE_WINDOW_MS,
      limit: 200,
    }) || [];
    if (recent.length > 0) {
      return true;
    }
  }

  return false;
}

function listLatestHealthFindings(db, projectId) {
  if (!db || !projectId) {
    return [];
  }

  return db.prepare(`
    WITH latest AS (
      SELECT dimension, MAX(scanned_at) AS scanned_at
      FROM factory_health_snapshots
      WHERE project_id = ?
      GROUP BY dimension
    )
    SELECT
      f.id,
      f.snapshot_id,
      f.severity,
      f.message,
      f.file_path,
      f.details_json,
      s.dimension,
      s.scanned_at
    FROM factory_health_findings f
    JOIN factory_health_snapshots s ON s.id = f.snapshot_id
    JOIN latest l ON l.dimension = s.dimension AND l.scanned_at = s.scanned_at
    WHERE s.project_id = ?
    ORDER BY
      CASE s.dimension
        WHEN 'user_facing' THEN 0
        WHEN 'build_ci' THEN 1
        WHEN 'api_completeness' THEN 2
        WHEN 'debt_ratio' THEN 3
        WHEN 'structural' THEN 4
        ELSE 5
      END,
      CASE lower(f.severity)
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        ELSE 3
      END,
      f.id ASC
  `).all(projectId, projectId);
}

function createHealthFindingSeed({
  db,
  factoryIntake,
  logger = console,
  limit = DEFAULT_LIMIT,
} = {}) {
  if (!db) {
    throw new Error('db is required');
  }
  if (!factoryIntake || typeof factoryIntake.createWorkItem !== 'function') {
    throw new Error('factoryIntake with createWorkItem is required');
  }

  function seed(project, context = {}) {
    const created = [];
    const skipped = [];
    const max = Number.isInteger(context.limit) && context.limit > 0
      ? context.limit
      : limit;
    const findings = listLatestHealthFindings(db, project?.id);

    for (const finding of findings) {
      if (created.length >= max) {
        break;
      }

      const candidate = buildCandidateFromHealthFinding(finding, project);
      if (!candidate) {
        skipped.push({
          finding_id: finding.id,
          reason: 'not_seedable',
          dimension: finding.dimension,
          file_path: finding.file_path || null,
        });
        continue;
      }

      try {
        if (hasDuplicate(factoryIntake, project.id, candidate.title)) {
          skipped.push({
            finding_id: finding.id,
            reason: 'duplicate',
            title: candidate.title,
          });
          continue;
        }

        const item = factoryIntake.createWorkItem({
          project_id: project.id,
          source: 'scout',
          title: candidate.title,
          description: candidate.description,
          priority: candidate.priority,
          requestor: candidate.requestor,
          origin: {
            ...candidate.origin,
            recovery_reason: context.reason || null,
            active_scout_task_id: context.active_scout_task_id || null,
          },
          constraints: candidate.constraints,
        });
        created.push(item);
      } catch (err) {
        skipped.push({
          finding_id: finding.id,
          reason: 'create_failed',
          title: candidate.title,
          error: err.message,
        });
        logger.warn?.('Health finding starvation seed failed to create work item', {
          project_id: project?.id,
          finding_id: finding.id,
          title: candidate.title,
          err: err.message,
        });
      }
    }

    return {
      created,
      skipped,
      scanned: findings.length,
    };
  }

  return { seed };
}

module.exports = {
  DEFAULT_LIMIT,
  RECENT_DUPLICATE_WINDOW_MS,
  TERMINAL_DUPLICATE_STATUSES,
  buildCandidateFromHealthFinding,
  createHealthFindingSeed,
  listLatestHealthFindings,
  normalizeRepoPath,
  verificationForPath,
};
