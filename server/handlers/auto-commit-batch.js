/**
 * Auto Commit Batch handler — extracted from automation-batch-orchestration.js
 *
 * Contains handleAutoCommitBatch: verify + stage + commit + push in one call.
 */

const path = require('path');
const { TASK_TIMEOUTS } = require('../constants');
const { safeExecChain } = require('../utils/safe-exec');
const { executeValidatedCommand } = require('../execution/command-policy');
const { filterTempFiles } = require('../utils/temp-file-filter');
const { ErrorCodes, makeError } = require('./shared');
const logger = require('../logger').child({ component: 'auto-commit-batch' });

// Lazy-load to avoid circular deps
let _configCore;
function configCore() { return _configCore || (_configCore = require('../db/config-core')); }
let _projectConfigCore;
function projectConfigCore() { return _projectConfigCore || (_projectConfigCore = require('../db/project-config-core')); }

let _resolveTrackedCommitFiles;
let _getFallbackCommitFiles;

function init({ resolveTrackedCommitFiles, getFallbackCommitFiles }) {
  _resolveTrackedCommitFiles = resolveTrackedCommitFiles;
  _getFallbackCommitFiles = getFallbackCommitFiles;
}

async function handleAutoCommitBatch(args) {
  try {

  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }


  const batchName = args.batch_name || 'batch';
  const push = args.auto_push === true || args.push === true;
  const verifyFirst = args.verify !== false;
  const stagePaths = args.stage_paths || ['.'];
  const coAuthor = args.co_author || 'Claude Opus 4.6 <noreply@anthropic.com>';

  // Resolve verify command: explicit arg > project defaults > fallback
  let verifyCmd = args.verify_command;
  if (!verifyCmd) {
    try {
      const defaults = projectConfigCore().getProjectDefaults(workingDir);
      verifyCmd = defaults?.verify_command || null;
    } catch (err) {
      logger.debug('[auto-commit-batch] non-critical error loading project verify defaults:', err.message || err);
    }
  }
  if (!verifyCmd) verifyCmd = 'npx tsc --noEmit && npx vitest run';

  // Resource gate: warn if any host is overloaded before running verify
  try {
    const { checkResourceGate } = require('../utils/resource-gate');
    const { hostActivityCache } = require('../utils/host-monitoring');
    if (hostActivityCache && hostActivityCache.size > 0) {
      for (const [hostId] of hostActivityCache) {
        const gateResult = checkResourceGate(hostActivityCache, hostId, configCore());
        if (gateResult && !gateResult.allowed) {
          logger.info(`[auto-commit-batch] Resource warning: host ${hostId} overloaded — ${gateResult.reason || 'CPU/RAM >= 85%'}`);
          break;
        }
      }
    }
  } catch (gateErr) {
    // Missing module or unexpected error — don't break existing functionality
    logger.debug('[auto-commit-batch] Resource gate check skipped: ' + (gateErr.message || gateErr));
  }

  // Validate shell commands against allowlist policy
  const { validateShellCommand } = require('../utils/shell-policy');
  const verifyCheck = validateShellCommand(verifyCmd);
  if (!verifyCheck.ok) {
    return makeError(ErrorCodes.INVALID_PARAM, `verify_command rejected: ${verifyCheck.reason}`);
  }

  const resolvedWorkingDir = path.resolve(workingDir);
  const workingDirPrefix = process.platform === 'win32'
    ? `${resolvedWorkingDir.toLowerCase()}${path.sep}`
    : `${resolvedWorkingDir}${path.sep}`;

  const validatedStagePaths = [];
  for (const sp of stagePaths) {
    const resolvedStagePath = path.resolve(resolvedWorkingDir, sp);
    const normalizedResolvedStagePath = process.platform === 'win32'
      ? resolvedStagePath.toLowerCase()
      : resolvedStagePath;
    if (!(normalizedResolvedStagePath === (process.platform === 'win32' ? resolvedWorkingDir.toLowerCase() : resolvedWorkingDir)
      || normalizedResolvedStagePath.startsWith(workingDirPrefix))) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid stage path: ${sp}`);
    }
    validatedStagePaths.push(sp);
  }

  let output = `## Auto Commit Batch: ${batchName}\n\n`;

  // Step 1: Verify (tsc + vitest)
  if (verifyFirst) {
    output += '### Step 1: Verify\n\n';
    try {
      const verifyResult = safeExecChain(verifyCmd, {
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.VERIFY_COMMAND,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (verifyResult.exitCode !== 0) {
        const stderr = (verifyResult.stderr || verifyResult.error || '');
        const tsErrors = (stderr.match(/error TS/g) || []).length;
        const testFailMatch = stderr.match(/(\d+)\s+failed/);
        output += `Verification **FAILED**\n`;
        if (tsErrors > 0) output += `- ${tsErrors} TypeScript errors\n`;
        if (testFailMatch) output += `- ${testFailMatch[1]} test failures\n`;
        output += '\nAborting commit. Fix errors first.\n';
        return makeError(ErrorCodes.OPERATION_FAILED, output);
      }

      // Extract test count from vitest output
      const testMatch = verifyResult.output.match(/(\d+)\s+passed/);
      const testCount = testMatch ? testMatch[1] : '?';
      output += `Verification **PASSED** (${testCount} tests)\n\n`;
    } catch (err) {
      const stderr = (err.stderr || err.message || '');
      const tsErrors = (stderr.match(/error TS/g) || []).length;
      const testFailMatch = stderr.match(/(\d+)\s+failed/);
      output += `Verification **FAILED**\n`;
      if (tsErrors > 0) output += `- ${tsErrors} TypeScript errors\n`;
      if (testFailMatch) output += `- ${testFailMatch[1]} test failures\n`;
      output += '\nAborting commit. Fix errors first.\n';
      return makeError(ErrorCodes.OPERATION_FAILED, output);
    }
  }

  // Step 2: Check for changes
  output += '### Step 2: Stage changes\n\n';
  try {
    await executeValidatedCommand('git', ['rev-parse', '--show-toplevel'], {
      profile: 'advanced_shell',
      dangerous: true,
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      encoding: 'utf8',
    });
  } catch (err) {
    output += `Error checking git status: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  const trackedCommitFiles = _resolveTrackedCommitFiles(args, workingDir);
  const rawFiles = trackedCommitFiles.length > 0
    ? trackedCommitFiles
    : _getFallbackCommitFiles(workingDir);
  const { kept: filesToCommit, excluded } = filterTempFiles(rawFiles);
  if (excluded.length > 0) {
    output += `Excluded ${excluded.length} temp file(s): ${excluded.join(', ')}\n`;
  }

  if (filesToCommit.length === 0) {
    output += 'No changes to commit — working tree is clean.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  output += `${filesToCommit.length} file(s) selected for commit\n\n`;

  try {
    await executeValidatedCommand('git', ['add', '--', ...filesToCommit], {
      profile: 'advanced_shell',
      dangerous: true,
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_ADD,
      encoding: 'utf8'
    });
  } catch (err) {
    output += `Error staging files: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  let stagedOutput = '';
  try {
    stagedOutput = (await executeValidatedCommand('git', ['diff', '--cached', '--name-only', '--relative', '--', ...filesToCommit], {
      profile: 'safe_verify',
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      encoding: 'utf8',
    })).stdout.trim();
  } catch (err) {
    output += `Error checking staged files: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  if (!stagedOutput) {
    output += 'No changes to commit — no tracked files were staged.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  // Step 4: Get test count for commit message
  let testCount = '?';
  const testCountCmd = args.test_count_command || verifyCmd;
  const testCmdCheck = validateShellCommand(testCountCmd);
  if (!testCmdCheck.ok) {
    output += `Test count command rejected: ${testCmdCheck.reason}\n`;
    logger.debug('[auto-commit-batch] non-critical error deriving test count:', testCmdCheck.reason);
  } else {
    try {
      const testResult = safeExecChain(testCountCmd, {
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.VERIFY_COMMAND,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Try vitest pattern first, then jest, then generic
      const match = testResult.exitCode === 0 ? testResult.output.match(/(\d+)\s+(?:passed|passing)/) : null;
      if (match) testCount = match[1];
    } catch (err) {
      logger.debug('[auto-commit-batch] non-critical error deriving test count:', err.message || err);
    }
  }

  // Step 5: Commit
  output += '### Step 3: Commit\n\n';
  let commitMessage = args.commit_message || `feat: ${batchName} (${testCount} tests)`;
  if (commitMessage.length > 4096) {
    commitMessage = commitMessage.slice(0, 4096);
    output += 'Warning: commit_message exceeded 4096 characters and was truncated.\n';
  }
  const fullCommitMsg = `${commitMessage}\n\nCo-Authored-By: ${coAuthor}`;

  try {
    await executeValidatedCommand('git', ['commit', '-m', fullCommitMsg, '--', ...filesToCommit], {
      profile: 'advanced_shell',
      dangerous: true,
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.HTTP_REQUEST,
      encoding: 'utf8'
    });
    output += `Committed: "${commitMessage}"\n\n`;
  } catch (err) {
    output += `Commit failed: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  // Step 6: Push
  if (push) {
    output += '### Step 4: Push\n\n';
    try {
      await executeValidatedCommand('git', ['push'], {
        profile: 'advanced_shell',
        dangerous: true,
        source: 'auto_commit_batch',
        caller: 'handleAutoCommitBatch',
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.GIT_PUSH,
        encoding: 'utf8'
      });
      output += `Pushed to remote.\n`;
    } catch (err) {
      output += `Push failed: ${(err.stderr || err.message).trim()}\n`;
    }
  }

  // Summary
  output += `\n### Summary\n\n`;
  output += `- **Tests:** ${testCount} passing\n`;
  output += `- **Files:** ${stagedOutput.split(/\r?\n/).filter(Boolean).length} committed\n`;
  output += `- **Commit:** ${commitMessage}\n`;
  output += `- **Pushed:** ${push ? 'Yes' : 'No'}\n`;

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

module.exports = {
  init,
  handleAutoCommitBatch,
};
