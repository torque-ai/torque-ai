'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const RUN_SUBDIRECTORIES = ['outputs', 'inputs', 'scratch', 'screenshots'];

const MIME_TYPES = new Map([
  ['.csv', 'text/csv'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
]);

function createRunDirManager({ db, rootDir, promotedDir = null }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createRunDirManager requires a sqlite database handle');
  }

  const rootPath = requireDirectoryRoot(rootDir, 'rootDir');
  const promotedRoot = path.resolve(promotedDir || path.join(rootPath, '..', 'promoted'));
  fs.mkdirSync(rootPath, { recursive: true });

  function runDirFor(taskId) {
    return path.join(rootPath, normalizeTaskId(taskId));
  }

  function openRunDir(taskId) {
    const dir = runDirFor(taskId);
    for (const subdirectory of RUN_SUBDIRECTORIES) {
      fs.mkdirSync(path.join(dir, subdirectory), { recursive: true });
    }
    return dir;
  }

  function indexFiles(taskId, { workflowId = null } = {}) {
    const normalizedTaskId = normalizeTaskId(taskId);
    const dir = runDirFor(normalizedTaskId);
    if (!fs.existsSync(dir)) {
      return { count: 0 };
    }

    const files = [];
    walkRunDir(dir, dir, files);

    const selectExisting = db.prepare(`
      SELECT artifact_id
      FROM run_artifacts
      WHERE task_id = ? AND relative_path = ?
    `);
    const insertArtifact = db.prepare(`
      INSERT INTO run_artifacts (
        artifact_id, task_id, workflow_id, relative_path, absolute_path, size_bytes, mime_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateArtifact = db.prepare(`
      UPDATE run_artifacts
      SET workflow_id = ?, absolute_path = ?, size_bytes = ?, mime_type = ?
      WHERE artifact_id = ?
    `);

    const persistFiles = db.transaction((records) => {
      for (const record of records) {
        const existing = selectExisting.get(normalizedTaskId, record.relativePath);
        if (existing) {
          updateArtifact.run(
            workflowId,
            record.absolutePath,
            record.sizeBytes,
            record.mimeType,
            existing.artifact_id,
          );
          continue;
        }

        insertArtifact.run(
          `art_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          normalizedTaskId,
          workflowId,
          record.relativePath,
          record.absolutePath,
          record.sizeBytes,
          record.mimeType,
        );
      }
    });

    persistFiles(files);
    return { count: files.length };
  }

  function listArtifacts(taskId) {
    const normalizedTaskId = normalizeTaskId(taskId);
    return db.prepare(`
      SELECT artifact_id, task_id, workflow_id, relative_path, absolute_path, size_bytes, mime_type, promoted
      FROM run_artifacts
      WHERE task_id = ?
      ORDER BY relative_path COLLATE NOCASE ASC
    `).all(normalizedTaskId).map(normalizeArtifactRow);
  }

  function getArtifact(artifactId) {
    const normalizedArtifactId = normalizeRequiredString(artifactId, 'artifactId');
    const row = db.prepare(`
      SELECT artifact_id, task_id, workflow_id, relative_path, absolute_path, size_bytes, mime_type, promoted
      FROM run_artifacts
      WHERE artifact_id = ?
    `).get(normalizedArtifactId);
    return normalizeArtifactRow(row);
  }

  function promoteArtifact(artifactId, { destPath } = {}) {
    const normalizedArtifactId = normalizeRequiredString(artifactId, 'artifactId');
    const relativeDestination = normalizeRelativePath(destPath, 'destPath');
    const row = getArtifact(normalizedArtifactId);
    if (!row) {
      throw new Error(`artifact not found: ${normalizedArtifactId}`);
    }

    if (row.promoted && typeof row.absolute_path === 'string' && row.absolute_path.trim()) {
      return row.absolute_path;
    }

    const sourcePath = path.resolve(String(row.absolute_path || ''));
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`artifact file missing: ${row.absolute_path}`);
    }

    fs.mkdirSync(promotedRoot, { recursive: true });
    const destinationPath = resolveWithinRoot(promotedRoot, relativeDestination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    moveFile(sourcePath, destinationPath);

    db.prepare(`
      UPDATE run_artifacts
      SET promoted = 1, absolute_path = ?
      WHERE artifact_id = ?
    `).run(destinationPath, normalizedArtifactId);

    return destinationPath;
  }

  function sweepRunDir(taskId) {
    const normalizedTaskId = normalizeTaskId(taskId);
    const dir = runDirFor(normalizedTaskId);
    if (!fs.existsSync(dir)) {
      return { deleted: 0 };
    }

    const rows = db.prepare(`
      SELECT relative_path, promoted
      FROM run_artifacts
      WHERE task_id = ?
    `).all(normalizedTaskId);

    let deleted = 0;
    for (const row of rows) {
      if (row.promoted) {
        continue;
      }

      let targetPath;
      try {
        targetPath = resolveWithinRoot(dir, row.relative_path);
      } catch {
        continue;
      }

      if (!fs.existsSync(targetPath)) {
        continue;
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) {
        continue;
      }

      fs.unlinkSync(targetPath);
      deleted += 1;
    }

    removeEmptyDirectories(dir);
    return { deleted };
  }

  function reindexAllRunDirs() {
    if (!fs.existsSync(rootPath)) {
      return { tasksScanned: 0, artifactsIndexed: 0 };
    }

    let tasksScanned = 0;
    let artifactsIndexed = 0;
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        normalizeTaskId(entry.name);
      } catch {
        continue;
      }
      try {
        const result = indexFiles(entry.name);
        tasksScanned += 1;
        artifactsIndexed += result.count || 0;
      } catch {
        // Skip failures and keep sweeping; one bad dir must not abort the rest.
      }
    }

    return { tasksScanned, artifactsIndexed };
  }

  return { openRunDir, indexFiles, listArtifacts, getArtifact, promoteArtifact, sweepRunDir, runDirFor, reindexAllRunDirs };
}

function normalizeArtifactRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  return {
    ...row,
    promoted: Boolean(row.promoted),
  };
}

function walkRunDir(rootDir, currentDir, out) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkRunDir(rootDir, absolutePath, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    out.push({
      relativePath: path.relative(rootDir, absolutePath).split(path.sep).join('/'),
      absolutePath,
      sizeBytes: fs.statSync(absolutePath).size,
      mimeType: inferMimeType(absolutePath),
    });
  }
}

function inferMimeType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function requireDirectoryRoot(input, label) {
  const value = normalizeRequiredString(input, label);
  return path.resolve(value);
}

function normalizeTaskId(taskId) {
  const value = normalizeRequiredString(taskId, 'taskId');
  if (path.isAbsolute(value) || /[/\\]/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid taskId: ${taskId}`);
  }
  return value;
}

function normalizeRelativePath(input, label) {
  const value = normalizeRequiredString(input, label);
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be a relative path`);
  }

  const normalized = path.normalize(value);
  if (!normalized || normalized === '.' || normalized === path.sep) {
    throw new Error(`${label} must not be empty`);
  }
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} contains path traversal`);
  }

  return normalized;
}

function normalizeRequiredString(input, label) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  if (input.includes('\0')) {
    throw new Error(`${label} contains null bytes`);
  }
  return input.trim();
}

function resolveWithinRoot(rootDir, relativePath) {
  const rootPath = path.resolve(rootDir);
  const targetPath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, targetPath);
  if (relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot))) {
    return targetPath;
  }
  throw new Error(`Path escapes root: ${relativePath}`);
}

function moveFile(sourcePath, destinationPath) {
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    return;
  }

  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (error && error.code !== 'EXDEV') {
      throw error;
    }
    fs.copyFileSync(sourcePath, destinationPath);
    fs.unlinkSync(sourcePath);
  }
}

function removeEmptyDirectories(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    removeEmptyDirectories(path.join(dir, entry.name));
  }

  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

module.exports = { createRunDirManager };
