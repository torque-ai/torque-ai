'use strict';

/**
 * Sandbox Revert Detection — Post-completion git guard.
 *
 * Codex tasks run in a sandbox that may start from a stale repo state.
 * When they write files back, they sometimes overwrite (revert) changes
 * that were committed AFTER the sandbox was created.
 *
 * This module detects such reverts by comparing the working tree against
 * HEAD after a Codex task completes. If a file was modified by the task
 * but the diff shows net removal of lines that exist in HEAD, it flags
 * the file as a potential sandbox revert.
 *
 * Wired into the task-finalizer pipeline between no_file_change_detection
 * and auto_validation.
 */

const { execFileSync } = require('child_process');
const logger = require('../logger').child({ component: 'sandbox-revert-detection' });
const { TASK_TIMEOUTS } = require('../constants');

/**
 * Check if a provider string indicates a Codex provider.
 * @param {string} provider
 * @returns {boolean}
 */
function isCodexProvider(provider) {
  if (!provider || typeof provider !== 'string') return false;
  return provider.toLowerCase().includes('codex');
}

/**
 * Parse a unified diff to extract line addition/removal counts.
 * Returns { added, removed } counts.
 * @param {string} diffOutput - Raw `git diff` output for a single file
 * @returns {{ added: number, removed: number }}
 */
function parseDiffStats(diffOutput) {
  let added = 0;
  let removed = 0;
  if (!diffOutput || typeof diffOutput !== 'string') return { added, removed };

  for (const line of diffOutput.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }
  return { added, removed };
}

/**
 * Check if a file's current state looks like it was reverted from HEAD.
 * A revert is detected when:
 * - The file has changes relative to HEAD
 * - The changes show significant net removal of committed code
 *   (removed lines > added lines, and removed > threshold)
 *
 * @param {string} filePath - Relative file path within the repo
 * @param {string} workingDir - Git repo working directory
 * @returns {{ reverted: boolean, added: number, removed: number, diff: string } | null}
 */
function checkFileForRevert(filePath, workingDir) {
  try {
    // Get diff between HEAD and working tree for this specific file
    const diff = execFileSync('git', ['diff', 'HEAD', '--', filePath], {
      cwd: workingDir,
      encoding: 'utf8',
      timeout: TASK_TIMEOUTS.GIT_DIFF,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });

    if (!diff || !diff.trim()) {
      // No diff means file matches HEAD — no revert
      return null;
    }

    const stats = parseDiffStats(diff);

    // A revert typically removes more lines than it adds.
    // We require: removed > added AND removed >= 5 lines to avoid
    // flagging trivial reformatting.
    const isRevert = stats.removed > stats.added && stats.removed >= 5;

    return {
      reverted: isRevert,
      added: stats.added,
      removed: stats.removed,
      diff: diff.length > 2048 ? diff.slice(0, 2048) + '\n...(truncated)' : diff,
    };
  } catch (err) {
    logger.info(`[SandboxRevertDetection] Failed to diff ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Pipeline stage: detect sandbox reverts after a Codex task completes.
 *
 * Checks each file in ctx.filesModified against HEAD. If any file shows
 * signs of being reverted (net line removals from committed code), it:
 * - Sets ctx.sandboxReverts with the list of reverted files
 * - Appends a warning to ctx.errorOutput
 * - Logs a warning
 *
 * Does NOT block task completion or change ctx.status — this is advisory.
 *
 * @param {object} ctx - Finalization context
 */
function detectSandboxReverts(ctx) {
  // Only applies to Codex providers
  const provider = ctx.proc?.provider || ctx.task?.provider;
  if (!isCodexProvider(provider)) return;

  // Only check completed tasks — failed tasks don't write files
  if (ctx.status !== 'completed') return;

  // Need files to check
  const files = ctx.filesModified;
  if (!Array.isArray(files) || files.length === 0) return;

  const workingDir = ctx.task?.working_directory || process.cwd();
  const reverted = [];

  for (const filePath of files) {
    if (!filePath || typeof filePath !== 'string') continue;

    const result = checkFileForRevert(filePath, workingDir);
    if (result && result.reverted) {
      reverted.push({
        file: filePath,
        added: result.added,
        removed: result.removed,
      });
    }
  }

  if (reverted.length === 0) return;

  // Record findings on context
  ctx.sandboxReverts = reverted;

  const fileList = reverted
    .map((r) => `  - ${r.file} (+${r.added}/-${r.removed})`)
    .join('\n');

  logger.info(
    `[SandboxRevertDetection] Task ${ctx.taskId}: detected ${reverted.length} potential revert(s): ${reverted.map((r) => r.file).join(', ')}`
  );

  // Auto-restore reverted files from HEAD — safe because HEAD has the correct
  // state including all previously committed changes, and the codex task's new
  // changes to non-reverted files are preserved.
  const restored = [];
  for (const r of reverted) {
    try {
      execFileSync('git', ['checkout', 'HEAD', '--', r.file], {
        cwd: workingDir,
        encoding: 'utf8',
        timeout: TASK_TIMEOUTS.GIT_DIFF,
        windowsHide: true,
      });
      restored.push(r.file);
      logger.info(`[SandboxRevertDetection] Auto-restored ${r.file} from HEAD`);
    } catch (restoreErr) {
      logger.info(`[SandboxRevertDetection] Failed to restore ${r.file}: ${restoreErr.message}`);
    }
  }

  // Remove restored files from filesModified — they're back to HEAD state
  if (restored.length > 0 && Array.isArray(ctx.filesModified)) {
    const restoredSet = new Set(restored);
    ctx.filesModified = ctx.filesModified.filter(f => !restoredSet.has(f));
  }

  const restoredNote = restored.length > 0
    ? `\n${restored.length} file(s) auto-restored from HEAD.`
    : '\nAuto-restore failed — manual restore needed: git checkout HEAD -- <files>';

  const warning = `\n\n[SANDBOX REVERT] ${reverted.length} file(s) were reverted by Codex sandbox:\n${fileList}${restoredNote}`;

  ctx.errorOutput = (ctx.errorOutput || '') + warning;
}

module.exports = {
  detectSandboxReverts,
  // Exported for testing
  _testing: {
    isCodexProvider,
    parseDiffStats,
    checkFileForRevert,
  },
};
