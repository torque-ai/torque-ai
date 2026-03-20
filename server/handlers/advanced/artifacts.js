/**
 * Advanced handlers — Task Artifacts
 *
 * 6 handlers for storing, listing, retrieving, deleting, configuring,
 * and exporting task artifacts with TOCTOU protection and atomic file ops.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../../database');
const { validateArtifactMimeType, isPathTraversalSafe, validateObjectDepth, requireTask, ErrorCodes, makeError } = require('../shared');
const logger = require('../../logger').child({ component: 'advanced-artifacts' });


/**
 * Store an artifact
 * Uses atomic file operations to prevent TOCTOU race conditions
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleStoreArtifact(args) {
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }

  const { task_id, name, file_path, metadata } = args;

  // Security: Validate artifact name (max length 255, safe characters only)
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
      return makeError(ErrorCodes.INVALID_PARAM, 'Artifact name must be 1-255 characters');
    }
    // Only allow alphanumeric, dash, underscore, dot, and space
    if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'Artifact name contains invalid characters (allowed: alphanumeric, dash, underscore, dot, space)');
    }
  }

  // Security: Validate metadata depth to prevent stack overflow
  if (metadata !== undefined) {
    const depthCheck = validateObjectDepth(metadata);
    if (!depthCheck.valid) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid metadata: ${depthCheck.error}`);
    }
  }

  // Security: Validate file_path for path traversal
  if (!file_path || typeof file_path !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required and must be a string');
  }
  if (!isPathTraversalSafe(file_path)) {
    return makeError(ErrorCodes.PATH_TRAVERSAL, 'Invalid file path: path traversal not allowed');
  }

  // Verify task exists
  const { task: _task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  const config = db.getArtifactConfig();
  const maxSizeMb = parseInt(config.max_size_mb || '50', 10);

  // Open file descriptor first to prevent TOCTOU race condition
  // This ensures the file we check is the same file we copy
  let fd;
  let stats;
  try {
    fd = fs.openSync(file_path, 'r');
    stats = fs.fstatSync(fd);

    // Security: Ensure it's a regular file, not a symlink or device
    if (!stats.isFile()) {
      fs.closeSync(fd);
      return makeError(ErrorCodes.INVALID_PARAM, `Not a regular file: ${file_path}`);
    }
  } catch (err) {
    if (fd !== undefined) {
    try { fs.closeSync(fd); } catch (err) {
      logger.debug('[adv-artifacts] failed to close source fd:', err.message || err);
    }
    }
    if (err.code === 'ENOENT') {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${file_path}`);
    }
    return makeError(ErrorCodes.OPERATION_FAILED, `Cannot open file: ${err.message}`);
  }

  // Check size while holding the file descriptor
  if (stats.size > maxSizeMb * 1024 * 1024) {
    fs.closeSync(fd);
    return makeError(ErrorCodes.INVALID_PARAM, `File exceeds maximum size of ${maxSizeMb}MB`);
  }

  // Create artifact storage directory
  const storagePath = config.storage_path || path.join(require('os').homedir(), '.local/share/torque/artifacts');

  // SECURITY: validate task_id to prevent path traversal
  if (!task_id || /[/\\]|\.\./.test(task_id)) {
    fs.closeSync(fd);
    return makeError(ErrorCodes.INVALID_PARAM, 'Invalid task_id: must not contain path separators or ".."');
  }

  // SECURITY: check storage path is not a symlink
  try {
    if (fs.existsSync(storagePath)) {
      const storeStat = fs.lstatSync(storagePath);
      if (storeStat.isSymbolicLink()) {
        fs.closeSync(fd);
        return makeError(ErrorCodes.OPERATION_FAILED, 'Artifact storage path is a symlink — refusing to write');
      }
    }
  } catch { /* path doesn't exist yet, will be created */ }

  const taskDir = path.join(storagePath, task_id);
  try {
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }
    // SECURITY: verify created directory is within storage path (prevent symlink-in-the-middle)
    const resolvedTaskDir = fs.realpathSync(taskDir);
    const resolvedStorePath = fs.realpathSync(storagePath);
    if (!resolvedTaskDir.startsWith(resolvedStorePath)) {
      fs.closeSync(fd);
      return makeError(ErrorCodes.OPERATION_FAILED, 'Artifact directory resolved outside storage path — possible symlink attack');
    }
  } catch (err) {
    fs.closeSync(fd);
    return makeError(ErrorCodes.OPERATION_FAILED, `Cannot create artifact directory: ${err.message}`);
  }

  // Copy file to storage while still holding the file descriptor
  // This prevents the file from being replaced between check and copy
  const artifactId = uuidv4();

  // Security: Extract and validate file extension (prevent path traversal via extension)
  const rawExt = path.extname(file_path);
  // Only allow simple extensions: dot followed by 1-10 alphanumeric chars
  const ext = /^\.[a-zA-Z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const storedPath = path.join(taskDir, `${artifactId}${ext}`);

  // Use try/finally to guarantee file descriptor cleanup
  let copyError = null;
  try {
    // Read from file descriptor and write to destination atomically
    const buffer = Buffer.alloc(stats.size);
    fs.readSync(fd, buffer, 0, stats.size, 0);
    fs.writeFileSync(storedPath, buffer);
  } catch (err) {
    copyError = err;
    // Clean up partial file on error
    try { fs.unlinkSync(storedPath); } catch (err) {
      logger.debug('[adv-artifacts] failed to cleanup stored path after copy error:', err.message || err);
    }
  } finally {
    // Guaranteed fd cleanup regardless of success or failure
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (err) {
        logger.debug('[adv-artifacts] failed to close source fd during cleanup:', err.message || err);
      }
      fd = undefined;
    }
  }

  if (copyError) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Error copying file: ${copyError.message}`);
  }

  // Calculate checksum from the stored file (which we now own)
  const crypto = require('crypto');
  const fileContent = fs.readFileSync(storedPath);
  const checksum = crypto.createHash('sha256').update(fileContent).digest('hex');

  // Detect MIME type
  const mimeTypes = {
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip'
  };
  const mimeType = mimeTypes[ext.toLowerCase()] || 'application/octet-stream';

  // Security: Validate MIME type and file extension
  const mimeValidation = validateArtifactMimeType(file_path, mimeType);
  if (!mimeValidation.valid) {
    // fd already closed in finally block above — just clean up stored file
    try { fs.unlinkSync(storedPath); } catch (err) {
      logger.debug('[adv-artifacts] failed to cleanup stored path for invalid artifact:', err.message || err);
    }
    return makeError(ErrorCodes.INVALID_PARAM, `Artifact rejected: ${mimeValidation.reason}`);
  }

  try {
    const artifact = db.storeArtifact({
      id: artifactId,
      task_id,
      name,
      file_path: storedPath,
      mime_type: mimeType,
      size_bytes: stats.size,
      checksum,
      metadata
    });

    let output = `## Artifact Stored\n\n`;
    output += `**ID:** ${artifact.id}\n`;
    output += `**Name:** ${artifact.name}\n`;
    output += `**Size:** ${(artifact.size_bytes / 1024).toFixed(2)} KB\n`;
    output += `**Type:** ${artifact.mime_type}\n`;
    output += `**Checksum:** ${artifact.checksum.substring(0, 16)}...\n`;
    output += `**Expires:** ${new Date(artifact.expires_at).toLocaleDateString()}\n`;

    return {
      content: [{ type: 'text', text: output }]
    };
  } catch (err) {
    // Clean up stored file if database insert failed
    try {
      if (fs.existsSync(storedPath)) {
        fs.unlinkSync(storedPath);
      }
    } catch (cleanupErr) {
      // Log cleanup error but don't mask the original error
      process.stderr.write(`Failed to cleanup orphaned artifact file: ${cleanupErr.message}\n`);
    }
    return makeError(ErrorCodes.OPERATION_FAILED, `Error storing artifact: ${err.message}`);
  }
}


/**
 * List artifacts for a task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListArtifacts(args) {
  if (!args || !args.task_id || typeof args.task_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const artifacts = db.listArtifacts(args.task_id);

  let output = `## Artifacts for Task ${args.task_id.substring(0, 8)}...\n\n`;

  if (artifacts.length === 0) {
    output += `No artifacts found for this task.\n`;
  } else {
    output += `| Name | Size | Type | Created |\n`;
    output += `|------|------|------|--------|\n`;

    for (const a of artifacts) {
      const size = (a.size_bytes / 1024).toFixed(1) + ' KB';
      const created = new Date(a.created_at).toLocaleDateString();
      output += `| ${a.name} | ${size} | ${a.mime_type} | ${created} |\n`;
    }

    output += `\n**Total:** ${artifacts.length} artifacts`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get an artifact
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetArtifact(args) {
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }

  let artifact;

  if (args.artifact_id) {
    artifact = db.getArtifact(args.artifact_id);
  } else if (args.task_id && args.name) {
    const artifacts = db.listArtifacts(args.task_id);
    artifact = artifacts.find(a => a.name === args.name);
  }

  if (!artifact) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'Artifact not found');
  }

  let output = `## Artifact: ${artifact.name}\n\n`;
  output += `**ID:** ${artifact.id}\n`;
  output += `**Task:** ${artifact.task_id}\n`;
  output += `**Size:** ${(artifact.size_bytes / 1024).toFixed(2)} KB\n`;
  output += `**Type:** ${artifact.mime_type}\n`;
  output += `**Checksum:** ${artifact.checksum}\n`;
  output += `**Path:** ${artifact.file_path}\n`;
  output += `**Created:** ${new Date(artifact.created_at).toLocaleString()}\n`;
  output += `**Expires:** ${new Date(artifact.expires_at).toLocaleString()}\n`;

  if (artifact.metadata) {
    output += `\n### Metadata\n\n`;
    output += '```json\n';
    output += JSON.stringify(artifact.metadata, null, 2);
    output += '\n```\n';
  }

  if (args.include_content && artifact.mime_type && artifact.mime_type.startsWith('text/')) {
    try {
      const content = fs.readFileSync(artifact.file_path, 'utf8');
      output += `\n### Content\n\n`;
      output += '```\n';
      output += content.substring(0, 5000);
      if (content.length > 5000) {
        output += `\n... (truncated, ${content.length} total characters)`;
      }
      output += '\n```\n';
    } catch (err) {
      output += `\n*Could not read content: ${err.message}*`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Delete an artifact
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleDeleteArtifact(args) {
  if (!args || !args.artifact_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'artifact_id is required');
  }

  const artifact = db.getArtifact(args.artifact_id);

  if (!artifact) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Artifact not found: ${args.artifact_id}`);
  }

  // Delete file
  try {
    if (fs.existsSync(artifact.file_path)) {
      fs.unlinkSync(artifact.file_path);
    }
  } catch (err) {
    // Continue even if file deletion fails
    logger.debug('[adv-artifacts] non-critical error deleting artifact file:', err.message || err);
  }

  // Delete database record
  db.deleteArtifact(args.artifact_id);

  return {
    content: [{ type: 'text', text: `Artifact deleted: ${artifact.name}` }]
  };
}


/**
 * Configure artifact storage
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleConfigureArtifactStorage(args) {
  if (!args || typeof args !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'Arguments object is required');
  }

  const updates = [];

  if (args.storage_path !== undefined) {
    db.setArtifactConfig('storage_path', args.storage_path);
    updates.push(`storage_path = ${args.storage_path}`);
  }

  if (args.max_size_mb !== undefined) {
    const val = Number(args.max_size_mb);
    if (!Number.isFinite(val) || val <= 0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'max_size_mb must be a positive number');
    }
    db.setArtifactConfig('max_size_mb', String(val));
    updates.push(`max_size_mb = ${val}`);
  }

  if (args.retention_days !== undefined) {
    const val = Number(args.retention_days);
    if (!Number.isFinite(val) || val < 1) {
      return makeError(ErrorCodes.INVALID_PARAM, 'retention_days must be at least 1');
    }
    db.setArtifactConfig('retention_days', String(val));
    updates.push(`retention_days = ${val}`);
  }

  if (args.max_per_task !== undefined) {
    const val = Number(args.max_per_task);
    if (!Number.isFinite(val) || val < 1) {
      return makeError(ErrorCodes.INVALID_PARAM, 'max_per_task must be at least 1');
    }
    db.setArtifactConfig('max_per_task', String(val));
    updates.push(`max_per_task = ${val}`);
  }

  const config = db.getArtifactConfig();

  let output = `## Artifact Storage Configuration\n\n`;

  if (updates.length > 0) {
    output += `**Updated:**\n`;
    for (const u of updates) {
      output += `- ${u}\n`;
    }
    output += `\n`;
  }

  output += `### Current Settings\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Storage Path | ${config.storage_path} |\n`;
  output += `| Max Size | ${config.max_size_mb} MB |\n`;
  output += `| Retention | ${config.retention_days} days |\n`;
  output += `| Max per Task | ${config.max_per_task} |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Export artifacts as zip
 * Uses proper event listener cleanup to prevent memory leaks
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
async function handleExportArtifacts(args) {
  try {
  
  if (!args || !args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }
  
  if (args.output_path && !isPathTraversalSafe(args.output_path, os.tmpdir())) {
    return makeError(ErrorCodes.INVALID_PARAM, 'output_path contains path traversal');
  }

  const artifacts = db.listArtifacts(args.task_id);

  if (artifacts.length === 0) {
    return {
      ...makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'No artifacts found for this task')
    };
  }

  const archiver = require('archiver');
  const defaultOutputDir = os.tmpdir();
  const outputPath = args.output_path || path.join(
    defaultOutputDir,
    `task-${(args.task_id || '').substring(0, 8)}-artifacts.zip`
  );

  // Security: refuse to write through a symlink
  try {
    const lstat = fs.lstatSync(outputPath);
    if (lstat.isSymbolicLink()) {
      return makeError(ErrorCodes.OPERATION_FAILED, 'Export output path is a symlink — refusing to write');
    }
  } catch { /* path doesn't exist yet, OK */ }

  // Create streams with proper error handling
  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  // Wait for archive to complete with proper cleanup
  try {
    await new Promise((resolve, reject) => {
      let settled = false;

      // Cleanup function to remove all event listeners
      const cleanup = () => {
        output.removeAllListeners('error');
        output.removeAllListeners('close');
        archive.removeAllListeners('error');
        archive.removeAllListeners('warning');
      };

      const safeReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const safeResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      // Handle output stream errors - use .once() for single-trigger events
      output.once('error', (err) => {
        archive.abort();
        safeReject(new Error(`Write stream error: ${err.message}`));
      });

      // Handle archive errors - use .once() for single-trigger events
      archive.once('error', (err) => {
        safeReject(new Error(`Archive error: ${err.message}`));
      });

      // Handle archive warnings (non-fatal) - can happen multiple times
      archive.on('warning', (err) => {
        if (err.code !== 'ENOENT') {
          process.stderr.write(`Archive warning: ${err.message}\n`);
        }
      });

      // Resolve when output stream closes successfully - use .once()
      output.once('close', () => {
        safeResolve();
      });

      // Pipe archive to output
      archive.pipe(output);

      // Add files to archive
      for (const artifact of artifacts) {
        if (fs.existsSync(artifact.file_path)) {
          archive.file(artifact.file_path, { name: artifact.name });
        }
      }

      // Finalize the archive
      archive.finalize();
    });

    let result = `## Artifacts Exported\n\n`;
    result += `**Output:** ${outputPath}\n`;
    result += `**Artifacts:** ${artifacts.length}\n\n`;

    result += `### Contents\n\n`;
    for (const a of artifacts) {
      result += `- ${a.name}\n`;
    }

    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (err) {
    // Clean up partial file on error
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch (cleanupErr) {
      process.stderr.write(`Failed to cleanup partial archive: ${cleanupErr.message}\n`);
    }

    return makeError(ErrorCodes.OPERATION_FAILED, `Error exporting artifacts: ${err.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


module.exports = {
  handleStoreArtifact,
  handleListArtifacts,
  handleGetArtifact,
  handleDeleteArtifact,
  handleConfigureArtifactStorage,
  handleExportArtifacts,
};
