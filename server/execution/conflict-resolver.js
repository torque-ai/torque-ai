'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeGitExec } = require('../utils/git');
const db = require('../database');
const logger = require('../logger').child({ component: 'conflict-resolver' });

function isAbsolutePath(filePath) {
  if (!filePath) return false;
  if (path.isAbsolute(filePath)) return true;
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
}

function getWorkflowTasksById(workflowId) {
  return new Map((db.getWorkflowTasks(workflowId) || []).map((task) => [task.id, task]));
}

function getGitRoot(workingDirectory) {
  if (!workingDirectory) return null;
  try {
    return safeGitExec(['rev-parse', '--show-toplevel'], {
      cwd: workingDirectory,
    }).trim();
  } catch {
    return null;
  }
}

function resolveAbsoluteFilePath(workingDirectory, filePath) {
  if (isAbsolutePath(filePath)) {
    return path.normalize(filePath);
  }
  return path.resolve(workingDirectory, filePath);
}

function getGitRelativePath(gitRoot, workingDirectory, filePath) {
  if (!gitRoot) return null;
  const absolutePath = resolveAbsoluteFilePath(workingDirectory, filePath);
  const relativePath = path.relative(gitRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.replace(/\\/g, '/');
}

function readGitFile(workingDirectory, ref, gitRelativePath) {
  if (!workingDirectory || !ref || !gitRelativePath) {
    return null;
  }

  try {
    return safeGitExec(['show', `${ref}:${gitRelativePath}`], {
      cwd: workingDirectory, timeout: 10000,
    });
  } catch {
    return null;
  }
}

function pickBaseRef(taskRecords) {
  for (const task of taskRecords) {
    if (task?.git_before_sha) {
      return task.git_before_sha;
    }
  }
  return 'HEAD';
}

function readBaseContent(workingDirectory, filePath, taskRecords) {
  if (!workingDirectory) {
    return '';
  }

  const gitRoot = getGitRoot(workingDirectory);
  const gitRelativePath = getGitRelativePath(gitRoot, workingDirectory, filePath);
  const baseRef = pickBaseRef(taskRecords);

  if (gitRelativePath) {
    const gitContent = readGitFile(workingDirectory, baseRef, gitRelativePath);
    if (gitContent !== null) {
      return gitContent;
    }

    const headContent = readGitFile(workingDirectory, 'HEAD', gitRelativePath);
    if (headContent !== null) {
      return headContent;
    }
  }

  return '';
}

function writeTempFile(dir, name, content) {
  const filePath = path.join(dir, name);
  // SECURITY (M8): Restrict temp file permissions to owner-only
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

function simpleMerge(ours, base, theirs) {
  if (ours === theirs) return { content: ours, clean: true, strategy: 'simple' };
  if (ours === base) return { content: theirs, clean: true, strategy: 'simple' };
  if (theirs === base) return { content: ours, clean: true, strategy: 'simple' };

  const conflict = [
    '<<<<<<< merged',
    ours,
    '=======',
    theirs,
    '>>>>>>> incoming'
  ].join('\n');
  return { content: conflict, clean: false, strategy: 'simple' };
}

function mergeContents(ours, base, theirs) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-merge-'));

  try {
    const oursPath = writeTempFile(tempDir, 'ours.txt', ours);
    const basePath = writeTempFile(tempDir, 'base.txt', base);
    const theirsPath = writeTempFile(tempDir, 'theirs.txt', theirs);

    try {
      const merged = safeGitExec(['merge-file', '-p', oursPath, basePath, theirsPath], {
        timeout: 10000,
      });
      return { content: merged, clean: true, strategy: 'git-merge-file' };
    } catch (err) {
      if (err && err.status === 1) {
        return {
          content: String(err.stdout || ''),
          clean: false,
          strategy: 'git-merge-file'
        };
      }
      return simpleMerge(ours, base, theirs);
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function writeMergedContent(workingDirectory, filePath, content, contributors) {
  const absolutePath = resolveAbsoluteFilePath(workingDirectory, filePath);
  const relativeToWorkdir = path.relative(workingDirectory, absolutePath);

  if (relativeToWorkdir.startsWith('..') || path.isAbsolute(relativeToWorkdir)) {
    return {
      ok: false,
      reason: 'file is outside the workflow working directory'
    };
  }

  const shouldDelete = content.length === 0 && contributors.every((entry) => entry.snapshot?.exists === false);
  if (shouldDelete) {
    fs.rmSync(absolutePath, { force: true });
    return { ok: true, absolutePath, action: 'deleted' };
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  // Atomic write: write to a temp file then rename to prevent a partial write from
  // leaving the target file in a corrupt state if the process is interrupted mid-write.
  const dir = path.dirname(absolutePath);
  const basename = path.basename(absolutePath);
  const tempPath = path.join(dir, `.torque-merge-tmp-${basename}-${process.pid}`);
  try {
    // SECURITY (M8): Restrict resolved file permissions to owner-only
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, absolutePath);
  } catch (writeErr) {
    // Clean up temp file on failure (best effort)
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw writeErr;
  }

  return { ok: true, absolutePath, action: 'written' };
}

function resolveWorkflowConflicts(workflowId) {
  if (!workflowId || typeof workflowId !== 'string') {
    throw new Error('workflowId must be a non-empty string');
  }

  const workflow = db.getWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  const conflictedFiles = db.getConflictedFiles(workflowId);
  if (!conflictedFiles.length) {
    return { merged: [], conflicts: [] };
  }

  const tasksById = getWorkflowTasksById(workflowId);
  const merged = [];
  const conflicts = [];

  for (const conflict of conflictedFiles) {
    const writeRecords = db.getWorkflowFileWrites(workflowId, conflict.file_path);
    const taskRecords = writeRecords
      .map((record) => tasksById.get(record.task_id))
      .filter(Boolean);
    const workingDirectory = workflow.working_directory || taskRecords[0]?.working_directory || null;

    if (!workingDirectory) {
      conflicts.push({
        file_path: conflict.file_path,
        task_ids: conflict.task_ids,
        reason: 'workflow has no working directory'
      });
      continue;
    }

    const contributors = writeRecords.map((record) => ({
      ...record,
      task: tasksById.get(record.task_id) || null,
      snapshot: db.getTaskFileSnapshot(record.content_hash)
    }));

    if (contributors.some((entry) => !entry.snapshot)) {
      conflicts.push({
        file_path: conflict.file_path,
        task_ids: conflict.task_ids,
        reason: 'missing snapshot content for one or more task versions'
      });
      continue;
    }

    const baseContent = readBaseContent(workingDirectory, conflict.file_path, taskRecords);
    let mergedContent = baseContent;
    let mergeStrategy = 'git-merge-file';
    let conflictFound = false;

    // Iterative merge: `baseContent` stays fixed (the original pre-workflow state),
    // while `mergedContent` accumulates each contributor's changes on top of the previous
    // merge result. This is intentional — treating the base as the common ancestor for
    // every contributor ensures that edits from different tasks are all anchored to the
    // same reference point rather than treating earlier merges as a new baseline.
    for (const contributor of contributors) {
      const theirContent = contributor.snapshot.exists ? contributor.snapshot.content : '';
      const mergeResult = mergeContents(mergedContent, baseContent, theirContent);
      mergedContent = mergeResult.content;
      mergeStrategy = mergeResult.strategy;

      if (!mergeResult.clean) {
        conflictFound = true;
        conflicts.push({
          file_path: conflict.file_path,
          task_ids: conflict.task_ids,
          reason: 'overlapping edits require manual resolution',
          strategy: mergeResult.strategy
        });
        break;
      }
    }

    if (conflictFound) {
      continue;
    }

    const writeResult = writeMergedContent(workingDirectory, conflict.file_path, mergedContent, contributors);
    if (!writeResult.ok) {
      conflicts.push({
        file_path: conflict.file_path,
        task_ids: conflict.task_ids,
        reason: writeResult.reason
      });
      continue;
    }

    merged.push({
      file_path: conflict.file_path,
      task_ids: conflict.task_ids,
      strategy: mergeStrategy,
      output_path: writeResult.absolutePath,
      action: writeResult.action
    });
  }

  if (merged.length || conflicts.length) {
    logger.info(`[Conflict Resolver] Workflow ${workflowId}: merged=${merged.length}, conflicts=${conflicts.length}`);
  }

  return { merged, conflicts };
}

module.exports = {
  resolveWorkflowConflicts
};
