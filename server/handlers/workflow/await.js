/* eslint-disable torque/no-sync-fs-on-hot-paths -- workflow/await sync calls are in verify-command execution and working-dir detection; Phase 2 async conversion tracked separately. */
/**
 * Workflow await / polling handlers (non-blocking yield-on-completion)
 */

const path = require('path');
const taskCore = require('../../db/task-core');
const fileTracking = require('../../db/file/tracking');
const taskMetadata = require('../../db/task-metadata');
const workflowEngine = require('../../db/workflow-engine');
const {
  buildPeekArtifactReferencesFromTaskArtifacts,
  formatPeekArtifactReferenceSection,
} = require('../../contracts/peek');
const { requireTask, requireWorkflow, ErrorCodes, makeError } = require('../shared');
const { TASK_TIMEOUTS } = require('../../constants');
const { safeExecChain } = require('../../utils/safe-exec');
const { executeValidatedCommandSync } = require('../../execution/command-policy');
const { checkResourceGate } = require('../../utils/resource-gate');
const { mutex: commitMutex } = require('../../utils/commit-mutex');
const { filterTempFiles } = require('../../utils/temp-file-filter');
const hostMonitoring = require('../../utils/host-monitoring');
const activityMonitoring = require('../../utils/activity-monitoring');
let _commitMutex = null, _cmLoaded = false;
function getCommitMutex() {
  if (!_cmLoaded) { _cmLoaded = true; try { _commitMutex = require('../../utils/commit-mutex'); } catch { _commitMutex = null; } }
  return _commitMutex;
}
const { handlePeekUi } = require('../../plugins/snapscope/handlers/capture');
const logger = require('../../logger').child({ component: 'workflow-await' });
const { safeJsonParse } = require('../../utils/json');
const { buildResumeContext, prependResumeContextToPrompt } = require('../../utils/resume-context');
const {
  appendRollbackReport,
  rollbackAgenticTaskChanges,
} = require('../../execution/agentic-orphan-rollback');

function buildRestartResumeContext(task, errorOutputOverride = null) {
  if (task?.resume_context) return task.resume_context;

  return buildResumeContext(
    task?.partial_output || task?.output || '',
    errorOutputOverride || task?.error_output || '',
    {
      task_description: task?.task_description,
      provider: task?.provider,
      duration_ms: task?.started_at && task?.completed_at
        ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
        : 0,
    },
  );
}

function appendAgenticOrphanRollback(task, message) {
  return appendRollbackReport(message, rollbackAgenticTaskChanges(task, { logger }));
}

/**
 * Determine whether verify commands should route through torque-remote.
 * Returns false when the project explicitly sets prefer_remote_tests: false,
 * or when torque-remote isn't on PATH. On Windows, torque-remote is a bash
 * script that Node can't exec directly — resolve the bash path so callers
 * can spawn via `bash <script-path>` instead of direct execution.
 */
function shouldUseTorqueRemote(cwd) {
  // Check project preference first — explicit false means skip wrapping.
  try {
    const { getProjectDefaults } = require('../../db/project-config-core');
    const defaults = getProjectDefaults(cwd);
    if (defaults && defaults.prefer_remote_tests === false) {
      return { use: false, reason: 'prefer_remote_tests=false' };
    }
  } catch { /* project-config-core not available — fall through to PATH check */ }

  // Detect torque-remote on PATH
  try {
    const whichResult = require('child_process').execFileSync('which', ['torque-remote'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (!whichResult) {
      return { use: false, reason: 'not_on_path' };
    }
    // On Windows, Node can't exec bash scripts directly. Resolve a bash
    // path so callers can spawn via `bash <script-path>`.
    let bashPath = null;
    if (process.platform === 'win32') {
      const fs = require('fs');
      for (const candidate of [
        process.env.GIT_BASH,
        'C:/Program Files/Git/bin/bash.exe',
        'C:/Program Files (x86)/Git/bin/bash.exe',
      ].filter(Boolean)) {
        try { if (fs.existsSync(candidate)) { bashPath = candidate; break; } } catch {}
      }
      if (!bashPath) {
        return { use: false, reason: 'bash_not_found_on_windows' };
      }
    }
    return { use: true, scriptPath: whichResult, bashPath };
  } catch {
    return { use: false, reason: 'not_on_path' };
  }
}

function normalizePreCommitReviewConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled !== true) {
    return null;
  }

  const onBlock = ['fail_workflow', 'require_approval', 'warn_only'].includes(value.on_block)
    ? value.on_block
    : 'warn_only';
  const reviewerProvider = typeof value.reviewer_provider === 'string' && value.reviewer_provider.trim()
    ? value.reviewer_provider.trim()
    : null;

  return {
    enabled: true,
    on_block: onBlock,
    reviewer_provider: reviewerProvider,
  };
}

function getWorkflowContext(workflow) {
  return workflow && typeof workflow.context === 'object' && workflow.context && !Array.isArray(workflow.context)
    ? workflow.context
    : {};
}

function getPreCommitReviewConfig(workflow) {
  return normalizePreCommitReviewConfig(getWorkflowContext(workflow).pre_commit_review);
}

function normalizeReviewIssues(issues) {
  return Array.isArray(issues)
    ? issues
      .filter(issue => issue && typeof issue === 'object' && !Array.isArray(issue))
      .slice(0, 20)
      .map(issue => ({
        severity: typeof issue.severity === 'string' ? issue.severity : 'low',
        file: typeof issue.file === 'string' ? issue.file : undefined,
        line: Number.isInteger(issue.line) ? issue.line : undefined,
        note: typeof issue.note === 'string' ? issue.note.slice(0, 500) : String(issue.note || '').slice(0, 500),
      }))
    : [];
}

function summarizeReviewIssues(issues) {
  const normalized = normalizeReviewIssues(issues);
  if (normalized.length === 0) {
    return 'no issues';
  }
  return normalized
    .map(issue => {
      const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : null;
      return `${issue.severity}${location ? ` ${location}` : ''}: ${issue.note}`;
    })
    .join('; ');
}

function buildPreCommitReviewRecord(result, reviewConfig, stagedPaths) {
  const issues = normalizeReviewIssues(result?.issues);
  return {
    verdict: ['pass', 'warn', 'block'].includes(result?.verdict) ? result.verdict : 'warn',
    issues,
    suggestions: Array.isArray(result?.suggestions) ? result.suggestions.slice(0, 20) : [],
    reviewed_at: new Date().toISOString(),
    on_block: reviewConfig.on_block,
    reviewer_provider: reviewConfig.reviewer_provider || null,
    staged_paths: Array.isArray(stagedPaths) ? stagedPaths.slice(0, 100) : [],
    issue_count: issues.length,
  };
}

function persistPreCommitReviewResult(workflow, reviewRecord, updates = {}) {
  try {
    const freshWorkflow = workflowEngine.getWorkflow(workflow.id) || workflow;
    const currentContext = getWorkflowContext(freshWorkflow);
    workflowEngine.updateWorkflow(workflow.id, {
      ...updates,
      context: {
        ...currentContext,
        pre_commit_review_result: reviewRecord,
      },
    });
  } catch (err) {
    logger.debug('[workflow-await] non-critical error persisting pre-commit review result: ' + (err.message || err));
  }
}

function appendPreCommitReviewTrailer(commitMsg, reviewRecord) {
  if (!reviewRecord || !reviewRecord.verdict) {
    return commitMsg;
  }

  const trailerLines = [
    `Pre-Commit-Review: ${reviewRecord.verdict}`,
  ];
  if (reviewRecord.issue_count > 0) {
    trailerLines.push(`Pre-Commit-Review-Issues: ${reviewRecord.issue_count}`);
  }
  return `${commitMsg}\n\n${trailerLines.join('\n')}`;
}

function buildTaskPeekArtifactSection(taskId, options = {}) {
  if (!taskId || typeof taskMetadata.listArtifacts !== 'function') {
    return '';
  }

  try {
    const refs = buildPeekArtifactReferencesFromTaskArtifacts(taskMetadata.listArtifacts(taskId), options);
    return formatPeekArtifactReferenceSection(refs);
  } catch (err) {
    logger.debug('[workflow-await] non-critical error reading task artifacts: ' + (err.message || err));
    return '';
  }
}

function buildWorkflowPeekArtifactSection(tasks) {
  const refs = [];

  for (const task of tasks || []) {
    if (!task?.id) {
      continue;
    }
    const taskLabel = task.workflow_node_id || task.id.substring(0, 8);
    try {
      refs.push(
        ...buildPeekArtifactReferencesFromTaskArtifacts(taskMetadata.listArtifacts(task.id), {
          task_id: task.id,
          workflow_id: task.workflow_id || null,
          task_label: taskLabel,
        })
      );
    } catch (err) {
      logger.debug('[workflow-await] non-critical error aggregating workflow artifacts: ' + (err.message || err));
    }
  }

  return formatPeekArtifactReferenceSection(refs);
}

function syncWorkflowBlockers(workflowId) {
  if (!workflowId) return;
  try {
    const workflowRuntime = require('../../execution/workflow-runtime');
    if (typeof workflowRuntime.refreshWorkflowBlockerSnapshots === 'function') {
      workflowRuntime.refreshWorkflowBlockerSnapshots(workflowId);
    }
  } catch (err) {
    logger.debug('[workflow-await] non-critical blocker refresh error: ' + (err.message || err));
  }
}

function getTaskBlockerSnapshot(task) {
  if (task?.blocker_snapshot && typeof task.blocker_snapshot === 'object' && !Array.isArray(task.blocker_snapshot)) {
    return task.blocker_snapshot;
  }
  const blocker = task?.context
    && typeof task.context === 'object'
    && !Array.isArray(task.context)
    ? task.context.workflow_blocker
    : null;
  return blocker && typeof blocker === 'object' && !Array.isArray(blocker) ? blocker : null;
}

function formatBlockedDependencyDetails(unmetDependencies, limit = 3) {
  const items = Array.isArray(unmetDependencies) ? unmetDependencies : [];
  if (items.length === 0) return '';

  const detail = items.slice(0, limit).map((dependency) => {
    const nodeLabel = dependency?.node_id || dependency?.task_id || 'unknown';
    const status = dependency?.status || 'unknown';
    const onFail = dependency?.on_fail || 'skip';
    const unmetReason = dependency?.unmet_reason === 'dependency_not_terminal'
      ? 'waiting for terminal state'
      : dependency?.unmet_reason === 'condition_failed'
        ? 'condition failed'
        : dependency?.unmet_reason === 'dependency_failed'
          ? 'dependency failed'
          : dependency?.unmet_reason === 'missing_dependency'
            ? 'dependency missing'
            : 'blocked';
    const alternate = dependency?.alternate_task_id ? `, alternate=${dependency.alternate_task_id}` : '';
    return `${nodeLabel} (${status}, ${unmetReason}, on_fail=${onFail}${alternate})`;
  }).join(', ');

  return items.length > limit
    ? `${detail}, +${items.length - limit} more`
    : detail;
}

function formatBlockedFailureActions(failureActions, limit = 3) {
  const items = (Array.isArray(failureActions) ? failureActions : [])
    .filter((action) => action && action.blocking !== false);
  if (items.length === 0) return '';

  const detail = items.slice(0, limit).map((action) => {
    const nodeLabel = action?.node_id || action?.task_id || 'unknown';
    const alternate = action?.alternate_task_id ? ` (alternate ${action.alternate_task_id})` : '';
    return `${nodeLabel}=>${action?.on_fail || 'skip'}${alternate}`;
  }).join(', ');

  return items.length > limit
    ? `${detail}, +${items.length - limit} more`
    : detail;
}

function formatWorkflowBlockerSection(workflowTasks) {
  const blockedTasks = (workflowTasks || []).filter((task) => ['blocked', 'waiting'].includes(task.status));
  if (blockedTasks.length === 0) return '';

  let output = `\n### Blocked Tasks\n\n`;
  for (const task of blockedTasks.slice(0, 5)) {
    const blocker = getTaskBlockerSnapshot(task);
    const nodeLabel = task.workflow_node_id || task.node_id || task.id.substring(0, 8);
    if (!blocker) {
      output += `- **${nodeLabel}**: Blocked with no persisted blocker snapshot.\n`;
      continue;
    }

    const dependencyDetails = formatBlockedDependencyDetails(blocker.unmet_dependencies);
    const failureActions = formatBlockedFailureActions(blocker.failure_actions);
    output += `- **${nodeLabel}** (${task.status}): ${blocker.reason || 'Blocked.'}`;
    if (dependencyDetails) {
      output += ` Waiting on: ${dependencyDetails}.`;
    }
    if (failureActions) {
      output += ` Failure actions: ${failureActions}.`;
    }
    output += `\n`;
  }

  if (blockedTasks.length > 5) {
    output += `- ... and ${blockedTasks.length - 5} more blocked tasks\n`;
  }

  return output;
}

async function evaluatePreVerifyGovernance(target, verifyCommand, context = {}) {
  if (!verifyCommand) {
    return null;
  }

  try {
    const { defaultContainer } = require('../../container');
    if (!defaultContainer || typeof defaultContainer.has !== 'function' || typeof defaultContainer.get !== 'function') {
      return null;
    }
    if (!defaultContainer.has('governanceHooks')) {
      return null;
    }

    const governance = defaultContainer.get('governanceHooks');
    if (!governance || typeof governance.evaluate !== 'function') {
      return null;
    }

    return await governance.evaluate('pre-verify', target, {
      ...context,
      verify_command: verifyCommand,
    });
  } catch (err) {
    logger.debug('[workflow-await] non-critical governance pre-verify error: ' + (err.message || err));
    return null;
  }
}

function formatPreVerifyGovernance(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }

  let text = `**Governance ${label}:**\n`;
  for (const entry of entries) {
    text += `- ${entry?.message || 'Governance rule triggered'}\n`;
  }
  return text;
}

function normalizeCommitPath(filePath, workingDir) {
  if (!workingDir || typeof filePath !== 'string') return null;

  const trimmed = filePath.trim().replace(/^"+|"+$/g, '');
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed)) {
    // Use shared path resolution — handles standard relative paths AND sandbox suffix matching
    const { resolveRelativePath } = require('../../utils/path-resolution');
    return resolveRelativePath(trimmed, workingDir);
  }

  const normalizedRelative = path.normalize(trimmed);
  if (!normalizedRelative || normalizedRelative === '.' || normalizedRelative === path.sep) {
    return null;
  }
  if (normalizedRelative === '..' || normalizedRelative.startsWith(`..${path.sep}`)) {
    return null;
  }

  return normalizedRelative.replace(/\\/g, '/');
}

function addTrackedPath(target, filePath, workingDir) {
  const normalized = normalizeCommitPath(filePath, workingDir);
  if (normalized) {
    target.add(normalized);
  }
}

function collectTaskCommitPaths(taskId, workingDir) {
  const files = new Set();
  if (!taskId || !workingDir) return files;

  try {
    const taskChanges = fileTracking.getTaskFileChanges(taskId) || [];
    for (const change of taskChanges) {
      if (!change || change.is_outside_workdir) continue;
      addTrackedPath(files, change.relative_path || change.file_path, workingDir);
    }
  } catch (err) {
    logger.debug('[workflow-await] non-critical error reading task_file_changes: ' + (err.message || err));
  }

  if (files.size > 0) {
    return files;
  }

  try {
    const fullTask = taskCore.getTask(taskId);
    const modifiedFiles = Array.isArray(fullTask?.files_modified) ? fullTask.files_modified : [];
    for (const file of modifiedFiles) {
      const candidate = typeof file === 'string'
        ? file
        : file?.path || file?.file_path || '';
      addTrackedPath(files, candidate, workingDir);
    }
  } catch (err) {
    logger.debug('[workflow-await] non-critical error reading files_modified fallback: ' + (err.message || err));
  }

  return files;
}

function collectWorkflowCommitPaths(tasks, workingDir) {
  const files = new Set();
  for (const task of tasks || []) {
    for (const file of collectTaskCommitPaths(task.id, workingDir)) {
      files.add(file);
    }
  }
  return [...files];
}

function getFallbackCommitPaths(workingDir) {
  try {
    const diffOutput = executeValidatedCommandSync('git', ['diff', '--name-only', '--relative', 'HEAD', '--', '.'], {
      profile: 'safe_verify',
      source: 'await_workflow',
      caller: 'getFallbackCommitPaths',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (!diffOutput) {
      return [];
    }

    return [...new Set(
      diffOutput
        .split(/\r?\n/)
        .map(file => normalizeCommitPath(file, workingDir))
        .filter(Boolean)
    )];
  } catch (err) {
    logger.debug('[workflow-await] non-critical error reading git diff fallback: ' + (err.message || err));
    return [];
  }
}

/**
 * Format a millisecond duration as a human-readable string.
 * e.g. 272000 → "4m 32s", 45000 → "45s"
 *
 * NOTE: Takes MILLISECONDS. dag.js has a homonymous function that takes
 * SECONDS — intentionally different units matching each module's data source.
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Detect repeated error lines in partial output.
 * Returns array of { line, count } for errors appearing 3+ times.
 */
function detectRepeatedErrors(text) {
  if (!text || text.length === 0) return [];
  const tail = text.slice(-3000);
  const errorPattern = /(?:Error:|FAIL|error\[|ERR!|FATAL|panic:|Exception:)/i;
  const lineCounts = new Map();
  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && errorPattern.test(trimmed)) {
      // Normalize whitespace for dedup
      const key = trimmed.replace(/\s+/g, ' ').slice(0, 200);
      lineCounts.set(key, (lineCounts.get(key) || 0) + 1);
    }
  }
  const repeated = [];
  for (const [line, count] of lineCounts) {
    if (count >= 3) repeated.push({ line, count });
  }
  return repeated.sort((a, b) => b.count - a.count);
}

/**
 * Generate a recommended action string from decision signals.
 */
function recommendAction(signals) {
  const { outputDelta, lastActivitySeconds, stallThreshold, isStalled, repeatedErrors } = signals;
  if (isStalled) {
    return 'Consider cancelling — task appears stalled (no output or filesystem activity).';
  }
  if (repeatedErrors && repeatedErrors.length > 0) {
    return `Task may be looping on errors (${repeatedErrors[0].line.slice(0, 80)}... seen ${repeatedErrors[0].count}x) — review output and consider cancelling.`;
  }
  if (outputDelta !== null && outputDelta === 0 && lastActivitySeconds > (stallThreshold || 180) * 0.5) {
    return 'Output unchanged since last heartbeat — monitor closely.';
  }
  if (signals.filesModifiedCount > 0 || (outputDelta !== null && outputDelta > 0)) {
    return 'Continue waiting — task is making progress.';
  }
  return 'Re-invoke to continue waiting, or take action (cancel, resubmit, etc.)';
}

/**
 * Format a heartbeat response for await_task / await_workflow.
 * Pure formatter — no side effects, no DB access.
 * Returns a markdown string suitable for returning as an MCP text content block.
 */
function formatHeartbeat(opts) {
  const {
    taskId, reason, elapsedMs, runningTasks = [], taskCounts = {},
    partialOutput, alerts = [], nextUpTasks,
    // Decision signal fields (optional — absent in older callers)
    decisionSignals,
    workflowTasks
  } = opts;

  const elapsed = formatDuration(elapsedMs);
  const context = opts.isWorkflow ? 'Await Workflow' : 'Await Task';
  const ds = decisionSignals || {};

  // Determine if anything actionable happened since last heartbeat.
  // When nothing changed, return a compact one-liner to conserve context tokens.
  const hasAlerts = alerts.length > 0;
  const hasNewOutput = partialOutput && partialOutput.length > 0 && (ds.outputDelta == null || ds.outputDelta > 0);
  const hasErrors = ds.repeatedErrors && ds.repeatedErrors.length > 0;
  const isStalled = ds.isStalled;
  const hasFilesModified = (ds.filesModified && ds.filesModified.length > 0) || (ds.filesModifiedCount > 0);
  const isActionable = hasAlerts || hasErrors || isStalled;

  // --- Compact heartbeat: nothing actionable ---
  if (!isActionable && !hasNewOutput && decisionSignals) {
    const counts = `${taskCounts.completed || 0} completed, ${taskCounts.failed || 0} failed, ${taskCounts.running || 0} running, ${taskCounts.pending || 0} pending, ${taskCounts.blocked || 0} blocked`;
    const filesNote = hasFilesModified ? ` | ${ds.filesModifiedCount || ds.filesModified.length} files modified` : '';
    return `## Heartbeat — ${context} ${taskId}\n\n**${elapsed}** | ${counts}${filesNote} | ${reason}\n\nRe-invoke to continue waiting.`;
  }

  // --- Full heartbeat: something needs attention ---
  const lines = [];

  lines.push(`## Heartbeat — ${context} ${taskId}`);
  lines.push('');
  lines.push(`**Reason:** ${reason}`);
  lines.push(`**Elapsed:** ${elapsed}`);
  lines.push(`**Tasks:** ${taskCounts.completed || 0} completed, ${taskCounts.failed || 0} failed, ${taskCounts.running || 0} running, ${taskCounts.pending || 0} pending, ${taskCounts.blocked || 0} blocked`);
  lines.push('');

  if (runningTasks.length > 0) {
    lines.push('### Running Tasks');
    lines.push('| Task | Provider | Host | Elapsed | Description |');
    lines.push('|------|----------|------|---------|-------------|');
    for (const t of runningTasks) {
      const desc = (t.description || '').slice(0, 80);
      lines.push(`| ${t.id} | ${t.provider || '-'} | ${t.host || '-'} | ${formatDuration(t.elapsedMs)} | ${desc} |`);
    }
    lines.push('');
  }

  // Decision signals — only include sections with meaningful data
  if (decisionSignals) {
    const formatBytes = (b) => b > 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} bytes`;
    const signalLines = [];

    if (ds.outputBytes > 0) {
      const rate = ds.elapsedSeconds > 0 ? Math.round(ds.outputBytes / ds.elapsedSeconds) : 0;
      signalLines.push(`- **Output:** ${formatBytes(ds.outputBytes)} (${rate} B/s)`);
    }
    if (ds.outputDelta > 0) {
      signalLines.push(`- **Output delta:** +${formatBytes(ds.outputDelta)} since last heartbeat`);
    }
    if (hasFilesModified) {
      const fileList = ds.filesModified ? ds.filesModified.slice(0, 8).join(', ') : '';
      const more = ds.filesModified && ds.filesModified.length > 8 ? ` (+${ds.filesModified.length - 8} more)` : '';
      signalLines.push(`- **Files modified:** ${ds.filesModifiedCount || ds.filesModified.length}${fileList ? ` (${fileList}${more})` : ''}`);
    }
    if (isStalled) {
      signalLines.push(`- **STALLED** — no output or filesystem activity`);
    }
    if (hasErrors) {
      for (const err of ds.repeatedErrors.slice(0, 3)) {
        signalLines.push(`- **Repeated error (${err.count}x):** ${err.line.slice(0, 120)}`);
      }
    }

    if (signalLines.length > 0) {
      lines.push('### Signals');
      lines.push(...signalLines);
      lines.push('');
    }

    // Recommended action — only when there's a non-default recommendation
    const action = recommendAction(ds);
    if (isStalled || hasErrors || (ds.outputDelta === 0 && ds.lastActivitySeconds > (ds.stallThreshold || 180) * 0.5)) {
      lines.push(`### Recommended Action`);
      lines.push(action);
      lines.push('');
    }
  }

  // Partial output — only when there's actual content
  if (partialOutput && partialOutput.length > 0) {
    lines.push('### Partial Output');
    const truncated = partialOutput.length > 1500
      ? '...(truncated)\n' + partialOutput.slice(-1500)
      : partialOutput;
    lines.push('```');
    lines.push(truncated);
    lines.push('```');
    lines.push('');
  }

  if (hasAlerts) {
    lines.push('### Alerts');
    for (const alert of alerts) {
      lines.push(`- ${alert}`);
    }
    lines.push('');
  }

  // Next up / blocker sections
  if (nextUpTasks && nextUpTasks.length > 0) {
    lines.push('### Next Up');
    for (const t of nextUpTasks.slice(0, 5)) {
      lines.push(`- ${t.id}: ${(t.description || '').slice(0, 60)}`);
    }
    lines.push('');
  }

  if (isActionable && Array.isArray(workflowTasks)) {
    const blockerSection = formatWorkflowBlockerSection(workflowTasks).trim();
    if (blockerSection) {
      lines.push(blockerSection);
      lines.push('');
    }
  }

  lines.push('Re-invoke to continue waiting, or take action (cancel, resubmit, etc.)');

  return lines.join('\n');
}

/**
 * Format a single completed task as a yield response.
 * Shows task details + workflow progress so the caller can review incrementally.
 */
function formatTaskYield(task, workflowTasks, workflowName) {
  const nodeLabel = task.workflow_node_id || task.id.substring(0, 8);
  let out = `## Task Completed: ${nodeLabel}\n\n`;
  out += `**Task ID:** ${task.id}\n`;
  out += `**Status:** ${task.status}\n`;
  if (task.provider) out += `**Provider:** ${task.provider}\n`;
  if (task.model) out += `**Model:** ${task.model}\n`;

  // Duration
  if (task.started_at && task.completed_at) {
    const dur = Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000);
    out += `**Duration:** ${dur}s\n`;
  }

  // Output (capped to avoid flooding context)
  if (task.output) {
    const trimmed = task.output.substring(task.output.length - 3000);
    out += `\n### Output\n\`\`\`\n${trimmed}\n\`\`\`\n`;
  }

  // Error output for failed tasks — use tail (same convention as stdout) so the
  // most recent/relevant error message is always visible rather than the earliest.
  if (task.status === 'failed' && task.error_output) {
    const errTrimmed = task.error_output.substring(task.error_output.length - 2000);
    out += `\n### Error\n\`\`\`\n${errTrimmed}\n\`\`\`\n`;
  }

  // Files modified
  if (task.files_modified && task.files_modified.length > 0) {
    const files = Array.isArray(task.files_modified) ? task.files_modified : [];
    if (files.length > 0) {
      out += `\n### Files Modified\n`;
      for (const f of files.slice(0, 20)) {
        out += `- ${f}\n`;
      }
      if (files.length > 20) out += `- ... and ${files.length - 20} more\n`;
    }
  }

  out += buildTaskPeekArtifactSection(task.id, {
    task_id: task.id,
    workflow_id: task.workflow_id || null,
    task_label: nodeLabel,
  });

  // Workflow progress table
  const completed = workflowTasks.filter(t => t.status === 'completed').length;
  const failed = workflowTasks.filter(t => t.status === 'failed').length;
  const running = workflowTasks.filter(t => t.status === 'running').length;
  const blocked = workflowTasks.filter(t => t.status === 'blocked').length;
  const pending = workflowTasks.filter(t => t.status === 'pending' || t.status === 'queued').length;
  const total = workflowTasks.length;

  out += `\n### Workflow Progress: ${workflowName}\n\n`;
  out += `| Status | Count |\n|--------|-------|\n`;
  out += `| Completed | ${completed} |\n`;
  out += `| Failed | ${failed} |\n`;
  out += `| Running | ${running} |\n`;
  out += `| Pending/Blocked | ${pending + blocked} |\n`;
  out += `| **Total** | **${total}** |\n`;

  // Show what's running or just unblocked
  const activeOrNext = workflowTasks.filter(t => ['running', 'queued', 'pending'].includes(t.status));
  if (activeOrNext.length > 0) {
    out += `\n**Up next:** `;
    out += activeOrNext.map(t => `${t.workflow_node_id || t.id.substring(0, 8)} (${t.status})`).join(', ');
    out += `\n`;
  }

  out += formatWorkflowBlockerSection(workflowTasks);

  return out;
}

/**
 * Block until a task completes, then yield it for review.
 * Uses workflow.context.acknowledged_tasks to track which tasks have already
 * been yielded. Each call returns the next completed task, or the final summary
 * when all tasks are done and acknowledged.
 * Optionally runs a verify command and auto-commits on the final return.
 */
async function handleAwaitWorkflow(args) {
  try {

  const pollMs = Math.min(Math.max(args.poll_interval_ms || 5000, 1000), 30000);
  const timeoutMs = Math.min(Math.max(args.timeout_minutes || 60, 0.01) * 60000, 3600000);
  const startTime = Date.now();
  const shutdownSignal = args.__shutdownSignal;

  // Heartbeat configuration: default 5 min, min 0 (disabled), max 30
  const rawHeartbeat = args.heartbeat_minutes != null ? args.heartbeat_minutes : 5;
  const heartbeatMinutes = Math.min(Math.max(rawHeartbeat, 0), 30);
  const heartbeatEnabled = heartbeatMinutes > 0;
  const heartbeatMs = heartbeatMinutes * 60 * 1000;

  // Per-session heartbeat state for computing deltas between heartbeats
  const heartbeatState = { prevOutputBytes: 0, heartbeatCount: 0 };
  const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
  const serverConfig = require('../../config');
  const currentEpoch = serverConfig.getEpoch();
  const autoResubmit = args.auto_resubmit_on_restart === true;

  // Reason name mapping for notable events
  const REASON_MAP = {
    started: 'task_started',
    stall_warning: 'stall_warning',
    retry: 'task_retried',
    fallback: 'provider_fallback'
  };

  const { workflow, error: wfErr } = requireWorkflow(args.workflow_id);
  if (wfErr) return wfErr;

  // Build set of workflow task IDs for filtering notable events
  const initialTasks = workflowEngine.getWorkflowTasks(args.workflow_id) || [];
  const workflowTaskIds = new Set(initialTasks.map(t => t.id));

  // Load acknowledged set from workflow context
  const ctx = workflow.context || {};
  const acknowledged = new Set(ctx.acknowledged_tasks || []);
  const terminalStates = ['completed', 'failed', 'cancelled', 'skipped'];

  // Poll until we find an unacknowledged terminal task, or all are done
  while (true) {
    syncWorkflowBlockers(args.workflow_id);
    const tasks = workflowEngine.getWorkflowTasks(args.workflow_id);
    if (!tasks) break;

    // Epoch check: requeue or cancel running tasks from a previous epoch
    for (const task of tasks) {
      if (task.status === 'running' && task.server_epoch && task.server_epoch < currentEpoch) {
        const retryCount = task.retry_count || 0;
        const maxRetries = task.max_retries != null ? task.max_retries : 2;

        if (retryCount < maxRetries) {
          const orphanErrorOutput = appendAgenticOrphanRollback(
            task,
            `Task orphaned — server epoch ${task.server_epoch} < current ${currentEpoch}. Requeued.`
          );
          const resumeContext = buildRestartResumeContext(task, orphanErrorOutput);
          taskCore.updateTaskStatus(task.id, 'queued', {
            error_output: orphanErrorOutput,
            retry_count: retryCount + 1,
            mcp_instance_id: null,
            provider: null,
            ollama_host_id: null,
            resume_context: resumeContext,
            task_description: prependResumeContextToPrompt(task.task_description, resumeContext),
          });
          task.status = 'queued';
        } else {
          const orphanErrorOutput = appendAgenticOrphanRollback(
            task,
            `Task orphaned — epoch ${task.server_epoch} < current ${currentEpoch} (max retries exhausted)`
          );
          taskCore.updateTaskStatus(task.id, 'cancelled', {
            error_output: orphanErrorOutput,
            cancel_reason: 'orphan_cleanup',
            completed_at: new Date().toISOString(),
          });
          task.status = 'cancelled';
          task.cancel_reason = 'orphan_cleanup';
        }
      }
    }

    // Restart recovery: find restart-cancelled tasks not yet acknowledged
    const restartCancelled = tasks.filter(t =>
      t.status === 'cancelled' && RESTART_CANCEL_REASONS.has(t.cancel_reason) && !acknowledged.has(t.id)
    );

    if (restartCancelled.length > 0 && autoResubmit) {
      for (const task of restartCancelled) {
        const taskId = task.id;
        const parsedMeta = typeof task.metadata === 'string'
          ? safeJsonParse(task.metadata, {})
          : (task.metadata || {});
        const meta = parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)
          ? parsedMeta
          : {};
        if (meta.resubmitted_as) {
          continue;
        }

        const restartCount = Number(meta.restart_resubmit_count || 0);
        if (restartCount >= 3) {
          continue;
        }

        const newTaskId = require('crypto').randomUUID();
        const newMeta = {
          ...meta,
          restart_resubmit_count: restartCount + 1,
          resubmitted_from: taskId,
        };
        const resumeContext = buildRestartResumeContext(task);

        taskCore.createTask({
          id: newTaskId,
          status: 'pending',
          task_description: prependResumeContextToPrompt(task.task_description, resumeContext),
          provider: task.provider,
          model: task.model,
          working_directory: task.working_directory,
          timeout_minutes: task.timeout_minutes,
          tags: task.tags,
          workflow_id: task.workflow_id,
          workflow_node_id: task.workflow_node_id,
          original_provider: task.original_provider,
          resume_context: resumeContext,
          metadata: newMeta,
        });

        const originalMeta = {
          ...meta,
          resubmitted_as: newTaskId,
        };

        try {
          if (typeof taskMetadata.updateMetadata === 'function') {
            taskMetadata.updateMetadata(taskId, originalMeta);
          } else if (typeof taskCore.patchTaskMetadata === 'function') {
            taskCore.patchTaskMetadata(taskId, originalMeta);
          } else {
            taskCore.updateTask(taskId, { metadata: originalMeta });
          }
        } catch (err) {
          logger.warn('[workflow-await] failed to persist restart recovery pointer for ' + taskId + ': ' + (err.message || err));
        }

        workflowTaskIds.add(newTaskId);
        acknowledged.add(taskId);
        logger.info(`[workflow-await] Restart recovery: resubmitted ${taskId} as ${newTaskId} at epoch ${currentEpoch}`);
      }

      const updatedCtx = { ...ctx, acknowledged_tasks: Array.from(acknowledged) };
      workflowEngine.updateWorkflow(args.workflow_id, { context: updatedCtx });
      continue;
    }

    // Manual recovery: yield restart-cancelled tasks one at a time for review
    if (restartCancelled.length > 0 && !autoResubmit) {
      const task = restartCancelled[0];
      acknowledged.add(task.id);

      const updatedCtx = { ...ctx, acknowledged_tasks: Array.from(acknowledged) };
      workflowEngine.updateWorkflow(args.workflow_id, { context: updatedCtx });

      const completed = tasks.filter(t => t.status === 'completed').length;
      const cancelled = tasks.filter(t => t.status === 'cancelled').length;
      const running = tasks.filter(t => t.status === 'running').length;
      const pending = tasks.filter(t => ['pending', 'queued'].includes(t.status)).length;
      const failed = tasks.filter(t => t.status === 'failed').length;
      const partialSource = (task.partial_output || task.output || '').toString();
      const partialTail = partialSource.length > 1000
        ? '...(truncated)\n' + partialSource.slice(-1000)
        : partialSource;

      let output = `## Workflow Task Cancelled by Server Restart\n\n`;
      output += `**Task ID:** ${task.id}\n`;
      output += `**Node:** ${task.workflow_node_id || task.id.substring(0, 8)}\n`;
      output += `**Cancel Reason:** ${task.cancel_reason}\n`;
      output += `**Description:** ${(task.task_description || '').slice(0, 300)}\n`;

      if (partialTail) {
        output += `\n### Partial Output\n\`\`\`\n${partialTail}\n\`\`\`\n`;
      }

      output += `\n### Workflow Progress\n`;
      output += `| Status | Count |\n`;
      output += `| --- | ---: |\n`;
      output += `| Completed | ${completed} |\n`;
      output += `| Cancelled | ${cancelled} |\n`;
      output += `| Running | ${running} |\n`;
      output += `| Pending | ${pending} |\n`;
      output += `| Failed | ${failed} |\n`;

      output += `\n### Recovery Options\n`;
      output += `- Resubmit this task manually with \`submit_task\`\n`;
      output += `- Use \`auto_resubmit_on_restart: true\` for automatic recovery\n`;
      output += `- Call \`await_workflow\` again to review the next cancelled task\n`;

      return { content: [{ type: 'text', text: output }] };
    }

    // Find terminal tasks not yet acknowledged
    const unacked = tasks.filter(t => terminalStates.includes(t.status) && !acknowledged.has(t.id));

    if (unacked.length > 0) {
      // Yield the first unacknowledged terminal task
      const task = unacked[0];
      acknowledged.add(task.id);

      // Persist acknowledged set to workflow context
      const updatedCtx = { ...ctx, acknowledged_tasks: Array.from(acknowledged) };
      workflowEngine.updateWorkflow(args.workflow_id, { context: updatedCtx });

      // Visual verification if task metadata has visual_verify config
      let visualContent = [];
      if (task.status === 'completed' && task.metadata) {
        try {
          const meta = typeof task.metadata === 'string' ? safeJsonParse(task.metadata, {}) : task.metadata;
          if (meta && meta.visual_verify) {
            const vv = meta.visual_verify;
            const vResult = await handlePeekUi({
              process: vv.process,
              title: vv.title,
              host: vv.host,
              auto_diff: vv.auto_diff !== false,
              diff_baseline: vv.diff_baseline
            });
            if (vResult && vResult.content) {
              visualContent = vResult.content;
            }
          }
        } catch (err) {
          logger.debug('[workflow-await] visual_verify failed: ' + (err.message || err));
        }
      }

      // Check if this was the last one (all terminal + all acknowledged)
      const allTerminal = tasks.every(t => terminalStates.includes(t.status));
      const allAcknowledged = tasks.every(t => acknowledged.has(t.id));

      if (allTerminal && allAcknowledged) {
        // This is the final yield — include task details + final summary
        return { content: [{ type: 'text', text: await formatFinalSummary(args, workflow, tasks, task, startTime) }] };
      }

      // Intermediate yield — just the task details + progress
      const yieldOutput = formatTaskYield(task, tasks, workflow.name);
      if (visualContent.length > 0) {
        return { content: [{ type: 'text', text: yieldOutput }, ...visualContent] };
      }
      return { content: [{ type: 'text', text: yieldOutput }] };
    }

    // Check if all tasks are terminal and all acknowledged already (re-entrant final call)
    const allTerminal = tasks.every(t => terminalStates.includes(t.status));
    const allAcknowledged = tasks.every(t => acknowledged.has(t.id));
    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: `## Workflow Complete: ${workflow.name}\n\n**ID:** ${args.workflow_id}\n**Status:** completed\n**Tasks:** 0 (empty workflow)\n` }] };
    }
    if (allTerminal && allAcknowledged) {
      return { content: [{ type: 'text', text: await formatFinalSummary(args, workflow, tasks, null, startTime) }] };
    }

    // Shutdown check — return early so the response reaches the client before SSE closes
    if (shutdownSignal && shutdownSignal.aborted) {
      let output = `## Server Shutting Down\n\n`;
      output += `**Workflow:** ${workflow.name}\n`;
      output += `**ID:** ${args.workflow_id}\n`;
      output += `**Waited:** ${Math.round((Date.now() - startTime) / 1000)}s\n`;
      output += `**Acknowledged:** ${acknowledged.size} / ${tasks.length} tasks\n\n`;
      output += formatWorkflowBlockerSection(tasks);
      output += `The TORQUE server is restarting. Tasks may still be running on their providers.\n`;
      output += `Call \`await_workflow\` again after the server comes back.\n`;
      return { content: [{ type: 'text', text: output }] };
    }

    // Timeout check
    if (Date.now() - startTime > timeoutMs) {
      let output = `## Workflow Timed Out: ${workflow.name}\n\n`;
      output += `**ID:** ${args.workflow_id}\n`;
      output += `**Waited:** ${Math.round((Date.now() - startTime) / 1000)}s\n`;
      output += `**Acknowledged:** ${acknowledged.size} / ${tasks.length} tasks\n\n`;
      output += formatWorkflowBlockerSection(tasks);
      output += `Workflow is still running. Call \`await_workflow\` again to continue receiving results.\n`;
      return { content: [{ type: 'text', text: output }] };
    }

    // Wait for event-bus wakeup, heartbeat timer, notable event, or poll interval
    let signalType = 'poll';
    let notablePayload = null;

    // Refresh the workflow task ID set in case tasks were added dynamically
    const currentWfTasks = workflowEngine.getWorkflowTasks(args.workflow_id) || [];
    for (const t of currentWfTasks) {
      workflowTaskIds.add(t.id);
    }

    await new Promise(r => {
      let resolved = false;
      let taskEventsRef = null;
      let terminalHandlerRef = null;
      let shutdownRef = null;
      const notableHandlers = new Map();

      const cleanup = () => {
        if (taskEventsRef && terminalHandlerRef) {
          for (const ev of terminalStates) {
            taskEventsRef.removeListener(`task:${ev}`, terminalHandlerRef);
          }
        }
        // Clean up notable event listeners
        if (taskEventsRef) {
          for (const [ev, handler] of notableHandlers) {
            taskEventsRef.removeListener('task:' + ev, handler);
          }
        }
        notableHandlers.clear();
        if (shutdownSignal && shutdownRef) {
          shutdownSignal.removeEventListener('abort', shutdownRef);
          shutdownRef = null;
        }
      };

      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          r();
        }
      };

      // When heartbeats are enabled and fit within remaining time,
      // use the heartbeat interval as the timer delay (replaces the poll timer).
      // When heartbeats don't fit (remaining <= heartbeatMs), use the poll timer
      // so the timeout check at the top of the loop can handle expiry.
      let timerDelay = pollMs;
      let timerSignal = 'poll';
      if (heartbeatEnabled) {
        const remaining = timeoutMs - (Date.now() - startTime);
        if (remaining > heartbeatMs) {
          timerDelay = heartbeatMs;
          timerSignal = 'heartbeat';
        }
      }

      const timer = setTimeout(() => {
        signalType = timerSignal;
        done();
      }, timerDelay);

      // Wake immediately on server shutdown
      if (shutdownSignal) {
        if (shutdownSignal.aborted) { signalType = 'shutdown'; done(); return; }
        shutdownRef = () => { signalType = 'shutdown'; done(); };
        shutdownSignal.addEventListener('abort', shutdownRef, { once: true });
      }

      try {
        const { taskEvents, NOTABLE_EVENTS } = require('../../hooks/event-dispatch');
        taskEventsRef = taskEvents;

        // Terminal event handler — filter by workflow task membership
        terminalHandlerRef = (payload) => {
          const eid = payload?.id || payload?.taskId;
          if (eid && !workflowTaskIds.has(eid)) return;
          signalType = 'terminal';
          done();
        };
        for (const ev of terminalStates) {
          taskEvents.on(`task:${ev}`, terminalHandlerRef);
        }

        // Notable event handlers (only when heartbeats are enabled)
        if (heartbeatEnabled && NOTABLE_EVENTS) {
          for (const ev of NOTABLE_EVENTS) {
            const handler = (payload) => {
              const eid = payload?.id || payload?.taskId;
              if (eid && !workflowTaskIds.has(eid)) return;
              if (signalType !== null && signalType !== 'poll') return; // first signal wins
              signalType = 'notable:' + ev;
              notablePayload = payload;
              done();
            };
            notableHandlers.set(ev, handler);
            taskEvents.on('task:' + ev, handler);
          }
        }
      } catch (err) {
        // event-dispatch not available — fall back to pure timer
        logger.debug('[workflow-handlers] non-critical error wiring fallback timer path:', err.message || err);
      }
    });

    // --- Heartbeat response branch ---
    // Only return heartbeat if:
    // 1. Signal was heartbeat or notable (not terminal/poll)
    // 2. No unacknowledged terminal tasks (task yields take priority)
    // 3. We haven't timed out
    if ((signalType === 'heartbeat' || signalType.startsWith('notable:'))
        && (Date.now() - startTime) < timeoutMs) {
      // Re-check for unacked terminal tasks — task yields always take priority
      syncWorkflowBlockers(args.workflow_id);
      const freshTasks = workflowEngine.getWorkflowTasks(args.workflow_id) || [];
      const freshUnacked = freshTasks.filter(t => terminalStates.includes(t.status) && !acknowledged.has(t.id));
      if (freshUnacked.length === 0) {
        // No new completions — build and return heartbeat
        const workflowTasks = freshTasks;
        const runningTasks = workflowTasks
          .filter(t => t.status === 'running')
          .map(t => ({
            id: t.id,
            provider: t.provider,
            host: t.ollama_host_id || '-',
            elapsedMs: t.started_at ? Date.now() - new Date(t.started_at).getTime() : 0,
            description: t.task_description
          }));

        const counts = {
          completed: workflowTasks.filter(t => t.status === 'completed').length,
          failed: workflowTasks.filter(t => t.status === 'failed').length,
          running: workflowTasks.filter(t => t.status === 'running').length,
          pending: workflowTasks.filter(t => ['pending', 'queued'].includes(t.status)).length,
          blocked: workflowTasks.filter(t => ['blocked', 'waiting'].includes(t.status)).length
        };

        const nextUpTasks = workflowTasks
          .filter(t => ['pending', 'queued'].includes(t.status))
          .slice(0, 5)
          .map(t => ({ id: t.id, description: t.task_description }));

        // Use longest-running task's partial output
        const primaryRunning = [...runningTasks].sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
        const primaryTask = primaryRunning ? taskCore.getTask(primaryRunning.id) : null;

        const reason = signalType === 'heartbeat'
          ? 'scheduled'
          : REASON_MAP[signalType.replace('notable:', '')] || signalType;

        const alerts = [];
        if (signalType === 'notable:stall_warning' && notablePayload) {
          alerts.push(`Approaching stall threshold (${notablePayload.elapsed || '?'}s / ${notablePayload.threshold || '?'}s) — consider cancelling if no progress`);
        }

        // Gather decision signals from the primary running task
        const partialOutput = primaryTask?.partial_output || null;
        let decisionSignals = null;
        if (primaryRunning) {
          const activity = activityMonitoring.getTaskActivity(primaryRunning.id, { skipGitCheck: true });
          const outputBytes = activity?.outputBytes || 0;
          const outputDelta = heartbeatState.heartbeatCount > 0
            ? outputBytes - heartbeatState.prevOutputBytes
            : null;
          const elapsedSeconds = activity?.elapsedSeconds || Math.floor((Date.now() - startTime) / 1000);
          const repeatedErrors = detectRepeatedErrors(partialOutput);
          // Extract files from primary task's current output
          const filesModified = primaryTask?.files_modified
            ? (Array.isArray(primaryTask.files_modified) ? primaryTask.files_modified : [])
            : [];

          decisionSignals = {
            outputBytes,
            outputDelta,
            elapsedSeconds,
            lastActivitySeconds: activity?.lastActivitySeconds ?? null,
            isStalled: activity?.isStalled ?? false,
            stallThreshold: activity?.stallThreshold ?? null,
            repeatedErrors,
            filesModified,
            filesModifiedCount: filesModified.length
          };
          heartbeatState.prevOutputBytes = outputBytes;
        }
        heartbeatState.heartbeatCount++;

        return { content: [{ type: 'text', text: formatHeartbeat({
          taskId: args.workflow_id,
          isWorkflow: true,
          reason,
          elapsedMs: Date.now() - startTime,
          runningTasks,
          taskCounts: counts,
          partialOutput,
          alerts,
          nextUpTasks,
          decisionSignals,
          workflowTasks
        }) }] };
      }
      // If there are unacked terminal tasks, fall through to the top of the loop
      // which will yield them (task yields take priority)
    }
  }

  return makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow disappeared: ${args.workflow_id}`);
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Build the final summary output (verify + commit), shown when all tasks are acknowledged.
 */
async function formatFinalSummary(args, workflow, tasks, lastTask, startTime) {
  // If there's a last task to yield, include it first
  let output = '';
  if (lastTask) {
    output += formatTaskYield(lastTask, tasks, workflow.name);
    output += `\n---\n\n`;
  }

  const completed = tasks.filter(t => t.status === 'completed').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const cancelled = tasks.filter(t => t.status === 'cancelled').length;
  const skipped = tasks.filter(t => t.status === 'skipped').length;
  const wfStatus = failed > 0 ? 'failed' : cancelled > 0 ? 'cancelled' : 'completed';

  output += `## Workflow Completed: ${workflow.name}\n\n`;
  output += `**ID:** ${workflow.id}\n`;
  output += `**Status:** ${wfStatus}\n`;
  output += `**Elapsed:** ${Math.round((Date.now() - startTime) / 1000)}s\n`;
  output += `**Tasks:** ${completed} completed, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped / ${tasks.length} total\n`;

  // Show failed tasks
  const failedTasks = tasks.filter(t => t.status === 'failed');
  if (failedTasks.length > 0) {
    output += `\n### Failed Tasks\n\n`;
    for (const t of failedTasks) {
      output += `- **${t.workflow_node_id || t.id.substring(0, 8)}**: ${(t.error_output || 'unknown error').substring(0, 200)}\n`;
    }
  }

  output += formatWorkflowBlockerSection(tasks);

  output += buildWorkflowPeekArtifactSection(tasks);

  // Surface unresolved file conflicts if any were recorded during auto-merge
  try {
    const freshWorkflow = workflowEngine.getWorkflow(workflow.id);
    const wfCtx = (freshWorkflow && typeof freshWorkflow.context === 'object' && freshWorkflow.context) ? freshWorkflow.context : {};
    const unresolvedConflicts = Array.isArray(wfCtx.unresolved_conflicts) ? wfCtx.unresolved_conflicts : [];
    const autoMerged = Array.isArray(wfCtx.auto_merged) ? wfCtx.auto_merged : [];
    if (autoMerged.length > 0) {
      output += `\n### Auto-Merged Files (${autoMerged.length})\n\n`;
      for (const m of autoMerged) {
        output += `- \`${m.file_path}\` — strategy: ${m.strategy || 'git-merge-file'}\n`;
      }
    }
    if (unresolvedConflicts.length > 0) {
      output += `\n### Unresolved File Conflicts (${unresolvedConflicts.length})\n\n`;
      output += `The following files were modified by multiple tasks and could not be auto-merged. **Manual resolution required before committing.**\n\n`;
      for (const c of unresolvedConflicts) {
        output += `- \`${c.file_path}\`: ${c.reason || 'overlapping edits'}\n`;
      }
    }
  } catch (conflictDisplayErr) {
    logger.debug('[workflow-await] non-critical error reading conflict info: ' + (conflictDisplayErr.message || conflictDisplayErr));
  }

  // Post-workflow verify + commit (serialized via commit mutex)
  if ((args.verify_command || args.auto_commit) && wfStatus === 'completed') {
    const release = await commitMutex.acquire(30000);
    try {
      // Post-workflow verify command (only if all succeeded)
      if (args.verify_command && wfStatus === 'completed') {
        const targetHostId = args.host_id || null;
        const gateResult = checkResourceGate(hostMonitoring.hostActivityCache, targetHostId);
        const { validateShellCommand } = require('../../utils/shell-policy');
        output += `\n### Verification\n\n`;
        if (!gateResult.allowed) {
          output += `Verify skipped: ${gateResult.reason}\n`;
          return output;
        }

        const shellCheck = validateShellCommand(args.verify_command);
        if (!shellCheck.ok) {
          output += `**Rejected:** ${shellCheck.reason}\n`;
          return output;
        }
        try {
          const cwd = args.working_directory || workflow.working_directory || process.cwd();
          const governanceResult = await evaluatePreVerifyGovernance(
            {
              id: workflow.id,
              workflow_id: workflow.id,
              working_directory: cwd,
            },
            args.verify_command,
            { workflow_id: workflow.id }
          );
          if (governanceResult?.blocked?.length) {
            output += formatPreVerifyGovernance(governanceResult.blocked, 'blocks');
            output += 'Verification skipped.\n';
            return output;
          }
          const governanceWarnings = formatPreVerifyGovernance(governanceResult?.warned, 'warnings');
          if (governanceWarnings) {
            output += governanceWarnings;
          }
          const remoteCheck = shouldUseTorqueRemote(cwd);
          const effectiveCommand = remoteCheck.use
            ? `torque-remote ${args.verify_command}`
            : args.verify_command;
          const verifyResult = safeExecChain(effectiveCommand, {
            cwd,
            timeout: TASK_TIMEOUTS.VERIFY_COMMAND,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          });
          if (verifyResult.exitCode === 0) {
            const trimmed = (verifyResult.output || '').trim().substring(0, 2000);
            output += `**Verify command:** \`${args.verify_command}\`\n`;
            output += `**Result:** PASSED\n`;
            if (trimmed) output += `\`\`\`\n${trimmed}\n\`\`\`\n`;
          } else {
            const stderr = `${verifyResult.output || ''}\n${verifyResult.error || ''}`.trim().substring(0, 1000);
            output += `**Verify command:** \`${args.verify_command}\`\n`;
            output += `**Result:** FAILED\n`;
            output += `\`\`\`\n${stderr}\n\`\`\`\n`;
            return output;  // Don't auto-commit if verify failed
          }
        } catch (verifyErr) {
          output += `**Verify command:** \`${args.verify_command}\`\n`;
          output += `**Result:** FAILED\n`;
          output += `\`\`\`\n${(verifyErr.message || '').toString().substring(0, 1000)}\n\`\`\`\n`;
          return output;  // Don't auto-commit if verify failed
        }
      }

      // Auto-commit on success
      if (args.auto_commit && wfStatus === 'completed') {
        output += `\n### Auto-Commit\n\n`;
        try {
          const cwd = args.working_directory || workflow.working_directory || process.cwd();
          const filesToCommit = collectWorkflowCommitPaths(tasks, cwd);
          const commitPaths = filesToCommit.length > 0 ? filesToCommit : getFallbackCommitPaths(cwd);
          if (commitPaths.length === 0) {
            output += `No changes to commit.\n`;
            return output;
          }

          const commitMsg = args.commit_message || `feat: ${workflow.name}`;
          const { kept: filteredPaths, excluded: wfTempExcluded } = filterTempFiles(commitPaths);
          if (wfTempExcluded.length > 0) {
            output += `Excluded ${wfTempExcluded.length} temp file(s): ${wfTempExcluded.join(', ')}\n`;
          }
          const finalCommitPaths = filteredPaths;
          if (finalCommitPaths.length === 0) {
            output += 'No files to commit after temp filter.\n';
            return output;
          }

          // Wrap git add separately so failures are clearly attributed.
          try {
            executeValidatedCommandSync('git', ['add', '--', ...finalCommitPaths], {
              profile: 'advanced_shell',
              dangerous: true,
              source: 'await_workflow',
              caller: 'formatFinalSummary',
              cwd,
              timeout: TASK_TIMEOUTS.GIT_ADD,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe']
            });
          } catch (addErr) {
            output += `**Auto-Commit failed (git add):** ${(addErr.message || '').substring(0, 500)}\n`;
            return output;
          }

          let stagedPaths;
          try {
            stagedPaths = executeValidatedCommandSync('git', ['diff', '--cached', '--name-only', '--relative', '--', ...finalCommitPaths], {
              profile: 'safe_verify',
              source: 'await_workflow',
              caller: 'formatFinalSummary',
              cwd,
              timeout: TASK_TIMEOUTS.GIT_STATUS,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
          } catch (diffErr) {
            output += `**Auto-Commit failed (git diff --cached):** ${(diffErr.message || '').substring(0, 500)}\n`;
            return output;
          }

          if (!stagedPaths) {
            output += `No changes to commit.\n`;
            return output;
          }

          let preCommitReviewRecord = null;
          const preCommitReview = getPreCommitReviewConfig(workflow);
          if (preCommitReview) {
            let stagedDiff;
            try {
              stagedDiff = executeValidatedCommandSync('git', ['diff', '--cached', '--', ...finalCommitPaths], {
                profile: 'safe_verify',
                source: 'await_workflow',
                caller: 'formatFinalSummary',
                cwd,
                timeout: TASK_TIMEOUTS.GIT_STATUS,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
              });
            } catch (diffErr) {
              output += `**Auto-Commit failed (pre-commit review diff):** ${(diffErr.message || '').substring(0, 500)}\n`;
              return output;
            }

            const { reviewDiff } = require('../../review/pre-commit-reviewer');
            const reviewResult = await reviewDiff({
              diff: stagedDiff,
              reviewerProvider: preCommitReview.reviewer_provider,
            });
            const stagedPathList = stagedPaths.split(/\r?\n/).filter(Boolean);
            preCommitReviewRecord = buildPreCommitReviewRecord(reviewResult, preCommitReview, stagedPathList);
            persistPreCommitReviewResult(workflow, preCommitReviewRecord);

            output += `**Pre-Commit Review:** ${preCommitReviewRecord.verdict}`;
            if (preCommitReviewRecord.issue_count > 0) {
              output += ` (${preCommitReviewRecord.issue_count} issue${preCommitReviewRecord.issue_count === 1 ? '' : 's'})`;
            }
            output += `\n`;

            if (preCommitReviewRecord.verdict === 'block') {
              const issueSummary = summarizeReviewIssues(preCommitReviewRecord.issues);
              if (preCommitReview.on_block === 'fail_workflow') {
                persistPreCommitReviewResult(workflow, preCommitReviewRecord, { status: 'failed' });
                output += `**Auto-Commit blocked:** pre-commit review blocked the workflow: ${issueSummary}\n`;
                return output;
              }

              if (preCommitReview.on_block === 'require_approval') {
                persistPreCommitReviewResult(workflow, preCommitReviewRecord, { status: 'pending_approval' });
                output += `**Auto-Commit held for approval:** pre-commit review requires approval: ${issueSummary}\n`;
                return output;
              }

              logger.info(`[pre-commit-review] BLOCK verdict ignored (on_block=warn_only): ${JSON.stringify(preCommitReviewRecord.issues)}`);
              output += `**Warning:** BLOCK verdict ignored because pre_commit_review.on_block=warn_only: ${issueSummary}\n`;
            }
          }

          // Wrap git commit separately.
          const finalCommitMsg = appendPreCommitReviewTrailer(commitMsg, preCommitReviewRecord);
          try {
            executeValidatedCommandSync('git', ['commit', '-m', finalCommitMsg, '--', ...finalCommitPaths], {
              profile: 'advanced_shell',
              dangerous: true,
              source: 'await_workflow',
              caller: 'formatFinalSummary',
              cwd,
              timeout: TASK_TIMEOUTS.GIT_COMMIT,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe']
            });
          } catch (commitErr) {
            output += `**Auto-Commit failed (git commit):** ${(commitErr.message || '').substring(0, 500)}\n`;
            return output;
          }

          const sha = executeValidatedCommandSync('git', ['rev-parse', '--short', 'HEAD'], {
            profile: 'advanced_shell',
            dangerous: true,
            source: 'await_workflow',
            caller: 'formatFinalSummary',
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
          output += `**Committed:** ${sha} — ${commitMsg}\n`;

          if (args.auto_push === true) {
            try {
              executeValidatedCommandSync('git', ['push'], {
                profile: 'advanced_shell',
                dangerous: true,
                source: 'await_workflow',
                caller: 'formatFinalSummary',
                cwd,
                timeout: TASK_TIMEOUTS.GIT_PUSH,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
              });
              output += `**Pushed to remote.**\n`;
            } catch (pushErr) {
              output += `**Auto-Push failed (git push):** ${(pushErr.message || '').substring(0, 500)}\n`;
            }
          }
        } catch (_commitErr) {
          output += `**Auto-Commit failed:** ${(_commitErr.message || '').substring(0, 500)}\n`;
        }
      }
    } finally {
      release();
    }
  }

  return output;
}

/**
 * Format a single standalone task result (not part of a workflow).
 */
function formatStandaloneTaskResult(task, startTime) {
  let out = `## Task ${task.status === 'completed' ? 'Completed' : task.status === 'failed' ? 'Failed' : 'Finished'}: ${task.id.substring(0, 8)}\n\n`;
  out += `**Task ID:** ${task.id}\n`;
  out += `**Status:** ${task.status}\n`;
  out += `**Exit Code:** ${task.exit_code ?? '?'}\n`;
  if (task.provider) out += `**Provider:** ${task.provider}\n`;
  if (task.model) out += `**Model:** ${task.model}\n`;

  if (task.started_at && task.completed_at) {
    const dur = Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000);
    out += `**Duration:** ${dur}s\n`;
  }

  out += `**Waited:** ${Math.round((Date.now() - startTime) / 1000)}s\n`;

  if (task.task_description) {
    const desc = task.task_description.length > 200
      ? task.task_description.substring(0, 200) + '...'
      : task.task_description;
    out += `\n### Description\n${desc}\n`;
  }

  if (task.output) {
    const trimmed = task.output.substring(task.output.length - 3000);
    out += `\n### Output\n\`\`\`\n${trimmed}\n\`\`\`\n`;
  }

  if (task.status === 'failed' && task.error_output) {
    const errTrimmed = task.error_output.substring(task.error_output.length - 2000);
    out += `\n### Error\n\`\`\`\n${errTrimmed}\n\`\`\`\n`;
  }

  if (task.files_modified) {
    let files = [];
    if (Array.isArray(task.files_modified)) {
      files = task.files_modified;
    } else if (typeof task.files_modified === 'string') {
      try {
        files = JSON.parse(task.files_modified || '[]');
      } catch {
        files = [];
      }
    }
    if (files.length > 0) {
      out += `\n### Files Modified\n`;
      for (const f of files.slice(0, 20)) {
        out += `- ${f}\n`;
      }
      if (files.length > 20) out += `- ... and ${files.length - 20} more\n`;
    }
  }

  out += buildTaskPeekArtifactSection(task.id, {
    task_id: task.id,
    workflow_id: task.workflow_id || null,
    task_label: task.workflow_node_id || task.id.substring(0, 8),
  });

  return out;
}

/**
 * Handle a task that was cancelled by server restart or detected as an orphan.
 * Either returns a structured recovery response or auto-resubmits and continues awaiting.
 */
async function handleRestartRecovery(task, args, awaitStartTime, currentEpoch) {
  const taskId = task.id;
  const autoResubmit = args.auto_resubmit_on_restart === true;
  const parsedMeta = typeof task.metadata === 'string'
    ? safeJsonParse(task.metadata, {})
    : (task.metadata || {});
  const meta = parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)
    ? parsedMeta
    : {};

  if (meta.resubmitted_as && meta.resubmitted_as !== taskId) {
    const replacementTask = taskCore.getTask(meta.resubmitted_as);
    if (replacementTask) {
      return handleAwaitTask({ ...args, task_id: meta.resubmitted_as });
    }

    let output = `## Task Already Resubmitted\n\n`;
    output += `**Original Task ID:** ${taskId}\n`;
    output += `**Replacement Task ID:** ${meta.resubmitted_as}\n`;
    output += `**Cancel Reason:** ${task.cancel_reason || 'unknown'}\n`;
    output += `The replacement task could not be loaded. Re-run \`await_task\` with the replacement ID.\n`;
    return { content: [{ type: 'text', text: output }] };
  }

  const restartResubmitCount = Number(meta.restart_resubmit_count || 0);

  if (autoResubmit && restartResubmitCount < 3) {
    const newTaskId = require('crypto').randomUUID();
    const newMeta = {
      ...meta,
      restart_resubmit_count: restartResubmitCount + 1,
      resubmitted_from: taskId,
    };
    const resumeContext = buildRestartResumeContext(task);

    taskCore.createTask({
      id: newTaskId,
      status: 'queued',
      task_description: prependResumeContextToPrompt(task.task_description, resumeContext),
      provider: task.provider,
      model: task.model,
      working_directory: task.working_directory,
      timeout_minutes: task.timeout_minutes,
      tags: task.tags,
      workflow_id: task.workflow_id,
      workflow_node_id: task.workflow_node_id,
      original_provider: task.original_provider,
      resume_context: resumeContext,
      metadata: newMeta,
    });

    const originalMeta = {
      ...meta,
      resubmitted_as: newTaskId,
    };

    try {
      if (typeof taskMetadata.updateMetadata === 'function') {
        taskMetadata.updateMetadata(taskId, originalMeta);
      } else if (typeof taskCore.patchTaskMetadata === 'function') {
        taskCore.patchTaskMetadata(taskId, originalMeta);
      } else {
        taskCore.updateTask(taskId, { metadata: originalMeta });
      }
    } catch (err) {
      logger.warn('[await-task] failed to persist restart recovery pointer for ' + taskId + ': ' + (err.message || err));
    }

    logger.info(`[await-task] Restart recovery: resubmitted ${taskId} as ${newTaskId} at epoch ${currentEpoch}`);
    return handleAwaitTask({ ...args, task_id: newTaskId });
  }

  const startedAtMs = task.started_at ? new Date(task.started_at).getTime() : null;
  const completedAtMs = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
  const durationMs = Number.isFinite(startedAtMs)
    ? Math.max(0, completedAtMs - startedAtMs)
    : Math.max(0, Date.now() - awaitStartTime);
  const partialOutput = (task.partial_output || task.output || '').toString();
  const partialTail = partialOutput.length > 1500
    ? '...(truncated)\n' + partialOutput.slice(-1500)
    : partialOutput;
  const modifiedFiles = [...collectTaskCommitPaths(taskId, task.working_directory)];

  let output = `## Task Cancelled by Server Restart\n\n`;
  output += `**Task ID:** ${taskId}\n`;
  output += `**Cancel Reason:** ${task.cancel_reason || 'unknown'}\n`;
  output += `**Original Description:** ${(task.task_description || '').slice(0, 500)}\n`;
  output += `**Provider:** ${task.provider || 'unknown'}\n`;
  output += `**Model:** ${task.model || 'default'}\n`;
  output += `**Running Time Before Cancel:** ${formatDuration(durationMs)}\n`;
  if (task.cancel_reason === 'orphan_cleanup' && task.server_epoch != null) {
    output += `**Server Epoch:** ${task.server_epoch} -> ${currentEpoch}\n`;
  }

  if (restartResubmitCount >= 3) {
    output += `\n**Warning:** Auto-resubmit stopped after ${restartResubmitCount} restart recoveries.\n`;
  }

  if (partialTail) {
    output += `\n### Partial Output\n\`\`\`\n${partialTail}\n\`\`\`\n`;
  }

  if (modifiedFiles.length > 0) {
    output += `\n### Files Modified\n`;
    for (const file of modifiedFiles.slice(0, 20)) {
      output += `- ${file}\n`;
    }
    if (modifiedFiles.length > 20) {
      output += `- ... and ${modifiedFiles.length - 20} more\n`;
    }
  }

  output += `\n### Recovery Options\n`;
  output += `- Resubmit with \`submit_task\` using the same description\n`;
  output += `- Check the partial output and modified files before resubmitting\n`;
  output += `- Use \`auto_resubmit_on_restart: true\` in future await calls for automatic recovery\n`;

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Block until a standalone task completes or fails, then return its result.
 * Uses the same event-bus wakeup as await_workflow for instant notification.
 * Optionally runs verify_command and auto-commits on success.
 */
async function handleAwaitTask(args) {
  try {
    const pollMs = Math.min(Math.max(args.poll_interval_ms || 5000, 1000), 30000);
    const timeoutMinutes = Math.min(Math.max(args.timeout_minutes || 60, 0.01), 60);
    const timeoutMs = timeoutMinutes * 60000;
    const awaitStartTime = Date.now();
    const terminalStates = ['completed', 'failed', 'cancelled', 'skipped'];
    const shutdownSignal = args.__shutdownSignal;
    const taskId = args.task_id;
    const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
    const serverConfig = require('../../config');
    const currentEpoch = serverConfig.getEpoch();

    // Heartbeat configuration: default 5 min, min 0 (disabled), max 30
    const rawHeartbeat = args.heartbeat_minutes != null ? args.heartbeat_minutes : 5;
    const heartbeatMinutes = Math.min(Math.max(rawHeartbeat, 0), 30);
    const heartbeatEnabled = heartbeatMinutes > 0;
    const heartbeatMs = heartbeatMinutes * 60 * 1000;

    // Per-session heartbeat state for computing deltas between heartbeats
    const heartbeatState = { prevOutputBytes: 0, heartbeatCount: 0 };

    // Reason name mapping for notable events
    const REASON_MAP = {
      started: 'task_started',
      stall_warning: 'stall_warning',
      retry: 'task_retried',
      fallback: 'provider_fallback'
    };

    const { task: initialTask, error: taskErr } = requireTask(taskId);
    if (taskErr) return taskErr;

    if (initialTask.status === 'running' && initialTask.server_epoch && initialTask.server_epoch < currentEpoch) {
      const retryCount = initialTask.retry_count || 0;
      const maxRetries = initialTask.max_retries != null ? initialTask.max_retries : 2;

      if (retryCount < maxRetries) {
        const orphanErrorOutput = appendAgenticOrphanRollback(
          initialTask,
          `Task orphaned — server epoch ${initialTask.server_epoch} < current ${currentEpoch}. Requeued (attempt ${retryCount + 1}/${maxRetries}).`
        );
        const resumeContext = buildRestartResumeContext(initialTask, orphanErrorOutput);
        taskCore.updateTaskStatus(taskId, 'queued', {
          error_output: orphanErrorOutput,
          retry_count: retryCount + 1,
          mcp_instance_id: null,
          provider: null,
          ollama_host_id: null,
          resume_context: resumeContext,
          task_description: prependResumeContextToPrompt(initialTask.task_description, resumeContext),
        });
        // Continue polling — the requeued task will transition to running then completed
      } else {
        const orphanErrorOutput = appendAgenticOrphanRollback(
          initialTask,
          `Task orphaned — server epoch ${initialTask.server_epoch} < current ${currentEpoch} (max retries exhausted)`
        );
        taskCore.updateTaskStatus(taskId, 'cancelled', {
          error_output: orphanErrorOutput,
          cancel_reason: 'orphan_cleanup',
          completed_at: new Date().toISOString(),
        });
        const cancelledTask = taskCore.getTask(taskId);
        return handleRestartRecovery(cancelledTask, args, awaitStartTime, currentEpoch);
      }
    }

    // If already terminal, return immediately
    if (terminalStates.includes(initialTask.status)) {
      if (initialTask.status === 'cancelled' && RESTART_CANCEL_REASONS.has(initialTask.cancel_reason)) {
        return handleRestartRecovery(initialTask, args, awaitStartTime, currentEpoch);
      }
      const output = formatStandaloneTaskResult(initialTask, awaitStartTime);
      return { content: [{ type: 'text', text: output }] };
    }

    // Poll until terminal or heartbeat
    while (true) {
      const task = taskCore.getTask(taskId);
      if (!task) {
        return makeError(ErrorCodes.TASK_NOT_FOUND, `Task disappeared: ${taskId}`);
      }

      if (task.status === 'running' && task.server_epoch && task.server_epoch < currentEpoch) {
        const retryCount = task.retry_count || 0;
        const maxRetries = task.max_retries != null ? task.max_retries : 2;

        if (retryCount < maxRetries) {
          const orphanErrorOutput = appendAgenticOrphanRollback(
            task,
            `Task orphaned — server epoch ${task.server_epoch} < current ${currentEpoch}. Requeued (attempt ${retryCount + 1}/${maxRetries}).`
          );
          const resumeContext = buildRestartResumeContext(task, orphanErrorOutput);
          taskCore.updateTaskStatus(taskId, 'queued', {
            error_output: orphanErrorOutput,
            retry_count: retryCount + 1,
            mcp_instance_id: null,
            provider: null,
            ollama_host_id: null,
            resume_context: resumeContext,
            task_description: prependResumeContextToPrompt(task.task_description, resumeContext),
          });
          // Continue polling — the requeued task will transition to running then completed
        } else {
          const orphanErrorOutput = appendAgenticOrphanRollback(
            task,
            `Task orphaned — server epoch ${task.server_epoch} < current ${currentEpoch} (max retries exhausted)`
          );
          taskCore.updateTaskStatus(taskId, 'cancelled', {
            error_output: orphanErrorOutput,
            cancel_reason: 'orphan_cleanup',
            completed_at: new Date().toISOString(),
          });
          const cancelledTask = taskCore.getTask(taskId);
          return handleRestartRecovery(cancelledTask, args, awaitStartTime, currentEpoch);
        }
      }

      if (terminalStates.includes(task.status)) {
        if (task.status === 'cancelled' && RESTART_CANCEL_REASONS.has(task.cancel_reason)) {
          return handleRestartRecovery(task, args, awaitStartTime, currentEpoch);
        }
        let output = formatStandaloneTaskResult(task, awaitStartTime);

        // Verify + commit (serialized via commit mutex)
        if ((args.verify_command || args.auto_commit) && task.status === 'completed') {
          const release = await commitMutex.acquire(30000);
          try {

        // Verify command (on success only)
        if (task.status === 'completed' && args.verify_command) {
          const targetHostId = args.host_id || null;
          const gateResult = checkResourceGate(hostMonitoring.hostActivityCache, targetHostId);
          if (!gateResult.allowed) {
            output += `\n### Verify Command\nVerify skipped: ${gateResult.reason}\n`;
            return { content: [{ type: 'text', text: output }] };
          }

          const cwd = args.working_directory || task.working_directory;
          if (cwd) {
            let governanceWarnings = '';
            try {
              const governanceResult = await evaluatePreVerifyGovernance(
                task,
                args.verify_command,
                { task_id: task.id, workflow_id: task.workflow_id || null }
              );
              if (governanceResult?.blocked?.length) {
                output += `\n### Verify Command\n${formatPreVerifyGovernance(governanceResult.blocked, 'blocks')}Verification skipped.\n`;
                return { content: [{ type: 'text', text: output }] };
              }
              governanceWarnings = formatPreVerifyGovernance(governanceResult?.warned, 'warnings');
              const remoteCheck = shouldUseTorqueRemote(cwd);

              let verifyResult;
              if (remoteCheck.use) {
                // On Windows, torque-remote is a bash script — Node can't
                // exec it directly (ENOENT). Spawn via resolved bash path.
                const execName = remoteCheck.bashPath || 'torque-remote';
                const execArgs = remoteCheck.bashPath
                  ? [remoteCheck.scriptPath, args.verify_command]
                  : [args.verify_command];
                verifyResult = executeValidatedCommandSync(
                  execName,
                  execArgs,
                  {
                    profile: 'safe_verify',
                    source: 'await_task',
                    caller: 'handleAwaitTask',
                    cwd,
                    timeout: TASK_TIMEOUTS.BUILD_VERIFY || 60000,
                    encoding: 'utf8',
                  }
                );
              } else {
                // Direct execution (no torque-remote or prefer_remote_tests=false)
                verifyResult = executeValidatedCommandSync(
                  process.platform === 'win32' ? 'cmd' : 'sh',
                  process.platform === 'win32' ? ['/c', args.verify_command] : ['-c', args.verify_command],
                  {
                    profile: 'safe_verify',
                    source: 'await_task',
                    caller: 'handleAwaitTask',
                    cwd,
                    timeout: TASK_TIMEOUTS.BUILD_VERIFY || 60000,
                    encoding: 'utf8',
                  }
                );
              }
              output += `\n### Verify Command\n${governanceWarnings}✅ Passed\n\`\`\`\n${(verifyResult || '').toString().trim().substring(0, 1000)}\n\`\`\`\n`;
            } catch (err) {
              const errMsg = (err.stderr || err.stdout || err.message || '').toString().substring(0, 1500);
              output += `\n### Verify Command\n${governanceWarnings}❌ Failed\n\`\`\`\n${errMsg}\n\`\`\`\n`;
            }
          }
        }

        // Auto-commit (on success only)
        if (task.status === 'completed' && args.auto_commit) {
          const cwd = args.working_directory || task.working_directory;
          if (cwd) {
            try {
              const commitMsg = args.commit_message || `task ${task.id.substring(0, 8)}: ${(task.task_description || '').substring(0, 72)}`;
              const taskPaths = [...collectTaskCommitPaths(task.id, cwd)];
              const rawPaths = taskPaths.length > 0 ? taskPaths : getFallbackCommitPaths(cwd);
              const { kept: commitPaths, excluded: tempExcluded } = filterTempFiles(rawPaths);
              if (tempExcluded.length > 0) {
                logger.info(`[await_task] Excluded ${tempExcluded.length} temp file(s) from commit: ${tempExcluded.join(', ')}`);
              }
              if (commitPaths.length > 0) {
                executeValidatedCommandSync('git', ['add', '--', ...commitPaths], {
                  profile: 'advanced_shell',
                  dangerous: true,
                  source: 'await_task',
                  caller: 'handleAwaitTask',
                  cwd,
                  timeout: TASK_TIMEOUTS.GIT_ADD,
                });
                executeValidatedCommandSync('git', ['commit', '-m', commitMsg, '--', ...commitPaths], {
                  profile: 'advanced_shell',
                  dangerous: true,
                  source: 'await_task',
                  caller: 'handleAwaitTask',
                  cwd,
                  timeout: TASK_TIMEOUTS.GIT_COMMIT,
                });
                const sha = executeValidatedCommandSync('git', ['rev-parse', '--short', 'HEAD'], {
                  profile: 'advanced_shell',
                  dangerous: true,
                  source: 'await_task',
                  caller: 'handleAwaitTask',
                  cwd,
                  timeout: TASK_TIMEOUTS.GIT_STATUS,
                  encoding: 'utf8',
                }).trim();
                output += `\n### Auto-Commit\n✅ Committed: ${sha}\n`;

                if (args.auto_push === true) {
                  executeValidatedCommandSync('git', ['push'], {
                    profile: 'advanced_shell',
                    dangerous: true,
                    source: 'await_task',
                    caller: 'handleAwaitTask',
                    cwd,
                    timeout: TASK_TIMEOUTS.GIT_PUSH,
                  });
                  output += `✅ Pushed\n`;
                }
              } else {
                output += `\n### Auto-Commit\nNo changed files to commit.\n`;
              }
            } catch (err) {
              output += `\n### Auto-Commit\n❌ Failed: ${err.message}\n`;
            }
          }
        }

        } finally {
          release();
        }
        }

        return { content: [{ type: 'text', text: output }] };
      }

      // Shutdown check — return early so the response reaches the client before SSE closes
      if (shutdownSignal && shutdownSignal.aborted) {
        let output = `## Server Shutting Down\n\n`;
        output += `**Task ID:** ${taskId}\n`;
        output += `**Status:** ${task.status}\n`;
        output += `**Waited:** ${Math.round((Date.now() - awaitStartTime) / 1000)}s\n\n`;
        output += `The TORQUE server is restarting. The task is still running on the provider.\n`;
        output += `Call \`check_status\` or \`get_result\` with this task ID after the server comes back.\n`;
        return { content: [{ type: 'text', text: output }] };
      }

      // Timeout check
      if (Date.now() - awaitStartTime > timeoutMs) {
        let output = `## Task Timed Out\n\n`;
        output += `**Task ID:** ${taskId}\n`;
        output += `**Status:** ${task.status}\n`;
        output += `**Waited:** ${Math.round((Date.now() - awaitStartTime) / 1000)}s\n\n`;
        output += `Task is still running. Call \`await_task\` again to continue waiting.\n`;
        return { content: [{ type: 'text', text: output }] };
      }

      // Wait for event-bus wakeup, heartbeat timer, notable event, or poll interval
      let signalType = 'poll';
      let notablePayload = null;

      await new Promise(r => {
        let resolved = false;
        let taskEventsRef = null;
        let terminalHandlerRef = null;
        let shutdownRef = null;
        const notableHandlers = new Map();

        const cleanup = () => {
          if (taskEventsRef && terminalHandlerRef) {
            for (const ev of terminalStates) {
              taskEventsRef.removeListener(`task:${ev}`, terminalHandlerRef);
            }
          }
          // Clean up notable event listeners
          if (taskEventsRef) {
            for (const [ev, handler] of notableHandlers) {
              taskEventsRef.removeListener('task:' + ev, handler);
            }
          }
          notableHandlers.clear();
          if (shutdownSignal && shutdownRef) {
            shutdownSignal.removeEventListener('abort', shutdownRef);
            shutdownRef = null;
          }
        };

        const done = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            cleanup();
            r();
          }
        };

        // When heartbeats are enabled and fit within remaining time,
        // use the heartbeat interval as the timer delay (replaces the poll timer).
        // The heartbeat timer wakes the loop and returns a heartbeat response.
        // When heartbeats don't fit (remaining <= heartbeatMs), use the poll timer
        // so the timeout check at the top of the loop can handle expiry.
        let timerDelay = pollMs;
        let timerSignal = 'poll';
        if (heartbeatEnabled) {
          const remaining = timeoutMs - (Date.now() - awaitStartTime);
          if (remaining > heartbeatMs) {
            timerDelay = heartbeatMs;
            timerSignal = 'heartbeat';
          }
        }

        const timer = setTimeout(() => {
          signalType = timerSignal;
          done();
        }, timerDelay);

        // Wake immediately on server shutdown
        if (shutdownSignal) {
          if (shutdownSignal.aborted) { signalType = 'shutdown'; done(); return; }
          shutdownRef = () => { signalType = 'shutdown'; done(); };
          shutdownSignal.addEventListener('abort', shutdownRef, { once: true });
        }

        try {
          const { taskEvents, NOTABLE_EVENTS } = require('../../hooks/event-dispatch');
          taskEventsRef = taskEvents;

          // Terminal event handler — filter by task ID
          terminalHandlerRef = (payload) => {
            const eid = payload?.id || payload?.taskId;
            if (eid && eid !== taskId) return;
            signalType = 'terminal';
            done();
          };
          for (const ev of terminalStates) {
            taskEvents.on(`task:${ev}`, terminalHandlerRef);
          }

          // Notable event handlers (only when heartbeats are enabled)
          if (heartbeatEnabled && NOTABLE_EVENTS) {
            for (const ev of NOTABLE_EVENTS) {
              const handler = (payload) => {
                const eid = payload?.id || payload?.taskId;
                if (eid && eid !== taskId) return;
                signalType = 'notable:' + ev;
                notablePayload = payload;
                done();
              };
              notableHandlers.set(ev, handler);
              taskEvents.on('task:' + ev, handler);
            }
          }
        } catch (err) {
          logger.debug('[await_task] non-critical error wiring event bus: ' + (err.message || err));
        }
      });

      // --- Heartbeat response branch ---
      // Only return heartbeat if we haven't timed out — let the loop's timeout check handle expiry
      if ((signalType === 'heartbeat' || signalType.startsWith('notable:'))
          && (Date.now() - awaitStartTime) < timeoutMs) {
        // Read current task state from DB for heartbeat response
        const currentTask = taskCore.getTask(taskId);
        const reason = signalType === 'heartbeat'
          ? 'scheduled'
          : REASON_MAP[signalType.replace('notable:', '')] || signalType;

        const runningTasks = [];
        if (currentTask && currentTask.status === 'running') {
          runningTasks.push({
            id: currentTask.id,
            provider: currentTask.provider,
            host: currentTask.ollama_host_id || '-',
            elapsedMs: currentTask.started_at
              ? Date.now() - new Date(currentTask.started_at).getTime()
              : 0,
            description: currentTask.task_description
          });
        }

        const alerts = [];
        if (signalType === 'notable:stall_warning' && notablePayload) {
          alerts.push(`Approaching stall threshold (${notablePayload.elapsed || '?'}s / ${notablePayload.threshold || '?'}s) — consider cancelling if no progress`);
        }

        const partialOutput = currentTask?.partial_output || null;

        // Gather decision signals for this task
        let decisionSignals = null;
        if (currentTask && currentTask.status === 'running') {
          const activity = activityMonitoring.getTaskActivity(taskId, { skipGitCheck: true });
          const outputBytes = activity?.outputBytes || 0;
          const outputDelta = heartbeatState.heartbeatCount > 0
            ? outputBytes - heartbeatState.prevOutputBytes
            : null;
          const elapsedSeconds = activity?.elapsedSeconds || Math.floor((Date.now() - awaitStartTime) / 1000);
          const repeatedErrors = detectRepeatedErrors(partialOutput);
          const filesModified = currentTask?.files_modified
            ? (Array.isArray(currentTask.files_modified) ? currentTask.files_modified : [])
            : [];

          decisionSignals = {
            outputBytes,
            outputDelta,
            elapsedSeconds,
            lastActivitySeconds: activity?.lastActivitySeconds ?? null,
            isStalled: activity?.isStalled ?? false,
            stallThreshold: activity?.stallThreshold ?? null,
            repeatedErrors,
            filesModified,
            filesModifiedCount: filesModified.length
          };
          heartbeatState.prevOutputBytes = outputBytes;
        }
        heartbeatState.heartbeatCount++;

        return {
          content: [{
            type: 'text',
            text: formatHeartbeat({
              taskId,
              reason,
              elapsedMs: Date.now() - awaitStartTime,
              runningTasks,
              taskCounts: {
                completed: 0,
                failed: 0,
                running: currentTask && currentTask.status === 'running' ? 1 : 0,
                pending: currentTask && !['running', 'completed', 'failed', 'cancelled', 'skipped'].includes(currentTask.status) ? 1 : 0,
              },
              partialOutput,
              alerts,
              decisionSignals,
            })
          }]
        };
      }
    }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleAwaitRestart(args) {
  try {
    const reason = args.reason || 'await_restart';
    const timeoutMinutes = Math.min(Math.max(args.timeout_minutes || 30, 0.1), 60);
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const rawHeartbeat = args.heartbeat_minutes != null ? args.heartbeat_minutes : 5;
    const heartbeatMinutes = Math.min(Math.max(rawHeartbeat, 0), 30);
    const heartbeatEnabled = heartbeatMinutes > 0;
    const heartbeatMs = heartbeatMinutes * 60 * 1000;
    const POLL_MS = 5000;
    const TERMINAL_EVENTS = ['completed', 'failed', 'cancelled'];

    // Create or attach to the barrier task via restart_server.
    const { handleToolCall } = require('../../tools');
    const restartResult = await handleToolCall('restart_server', {
      reason,
      timeout_minutes: timeoutMinutes,
    });

    const taskId = restartResult.task_id;
    if (!taskId) {
      return makeError(ErrorCodes.INTERNAL_ERROR, 'Failed to create restart barrier task');
    }

    const shutdownSignal = args.__shutdownSignal;
    const callStart = Date.now();

    const drainSnapshot = () => {
      const countByStatus = (status) => taskCore
        .listTasks({ status, limit: 1000 })
        .filter(t => t.provider !== 'system').length;
      return {
        running: countByStatus('running'),
        queuedHeld: countByStatus('queued') + countByStatus('pending'),
      };
    };

    const barrierElapsedSeconds = (barrierTask) => {
      const startedAt = barrierTask?.started_at || barrierTask?.created_at;
      if (!startedAt) return null;
      return Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    };

    const formatRestartScheduled = () => ({
      content: [{
        type: 'text',
        text: `## Restart Scheduled\n\nBarrier ${taskId.slice(0, 8)} is waiting for the successor instance to confirm startup.\nThis connection may drop before the new server is fully ready.\n\nAfter reconnect, call restart_status or await_task { task_id: "${taskId}" } to confirm the restart finished.`,
      }],
      structuredData: {
        barrier_id: taskId,
        barrier_status: 'running',
        restart_handoff_pending: true,
      },
    });

    if (restartResult.status === 'restart_scheduled') {
      return formatRestartScheduled();
    }

    try {
      const { readRestartHandoff } = require('../../execution/restart-handoff');
      const handoff = readRestartHandoff();
      if (restartResult.status === 'already_pending' && handoff?.barrier_id === taskId && drainSnapshot().running === 0) {
        return formatRestartScheduled();
      }
    } catch { /* non-fatal */ }

    // Check the barrier's terminal state. Returns a formatted response if
    // drained (completed), aborted (failed/cancelled), or missing. Returns
    // null if the barrier is still pending/running.
    const checkTerminal = () => {
      const task = taskCore.getTask(taskId);
      if (!task) {
        return makeError(ErrorCodes.TASK_NOT_FOUND, `Barrier task disappeared: ${taskId}`);
      }
      if (task.status === 'completed') {
        return {
          content: [{
            type: 'text',
            text: '## Restart Ready\n\nPipeline drained successfully.\nServer restart triggered — MCP client will reconnect with fresh code.\nRun `/mcp` to force immediate reconnection.',
          }],
        };
      }
      if (task.status === 'failed' || task.status === 'cancelled') {
        const { running, queuedHeld } = drainSnapshot();
        const detail = task.error_output
          ? `\n\nDetail: ${String(task.error_output).slice(0, 500)}`
          : '';
        return {
          content: [{
            type: 'text',
            text: `## Restart Aborted\n\nBarrier ${taskId.slice(0, 8)} ended with status **${task.status}**. ${running} task(s) still running, ${queuedHeld} queued released back to the scheduler.${detail}\n\nNothing was restarted. Queued tasks will resume normally.`,
          }],
        };
      }
      return null;
    };

    // Immediate check: empty-pipeline path may have already completed.
    const immediate = checkTerminal();
    if (immediate) return immediate;

    while (true) {
      const elapsed = Date.now() - callStart;
      if (elapsed >= timeoutMs) {
        const { running, queuedHeld } = drainSnapshot();
        return {
          content: [{
            type: 'text',
            text: `## Restart Wait Timed Out\n\nWaited ${Math.round(elapsed / 1000)}s but barrier ${taskId.slice(0, 8)} is still draining. ${running} running, ${queuedHeld} queued held.\n\nCall await_restart again to keep waiting, restart_status to check state, or cancel_task ${taskId} to abort the barrier.`,
          }],
        };
      }

      // Work out the next wake: min(poll tick, time-to-heartbeat, time-to-timeout).
      let waitMs = POLL_MS;
      let heartbeatDue = false;
      if (heartbeatEnabled) {
        const toHeartbeat = heartbeatMs - elapsed;
        if (toHeartbeat <= 0) {
          heartbeatDue = true;
        } else if (toHeartbeat < waitMs) {
          waitMs = toHeartbeat;
        }
      }
      const toTimeout = timeoutMs - elapsed;
      if (toTimeout < waitMs) waitMs = toTimeout;

      if (heartbeatDue) {
        const { running, queuedHeld } = drainSnapshot();
        const barrierTask = taskCore.getTask(taskId);
        const drainElapsed = barrierElapsedSeconds(barrierTask);
        return {
          content: [{
            type: 'text',
            text: `## Restart Drain Heartbeat\n\nBarrier ${taskId.slice(0, 8)} (${barrierTask?.status || 'unknown'}) still draining.\n- Running tasks: ${running}\n- Queued held: ${queuedHeld}\n- Barrier elapsed: ${drainElapsed != null ? drainElapsed + 's' : 'unknown'}\n- This wait: ${Math.round(elapsed / 1000)}s\n\nCall await_restart again to continue waiting.`,
          }],
          structuredData: {
            barrier_id: taskId,
            barrier_status: barrierTask?.status || null,
            running_count: running,
            queued_held_count: queuedHeld,
            barrier_elapsed_seconds: drainElapsed,
            call_elapsed_seconds: Math.floor(elapsed / 1000),
          },
        };
      }

      // Wait for a terminal event, shutdown, or timer tick.
      let signalType = 'poll';
      await new Promise((resolve) => {
        let settled = false;
        let shutdownRef = null;
        let terminalHandler = null;
        let taskEvents = null;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (shutdownSignal && shutdownRef) {
            try { shutdownSignal.removeEventListener('abort', shutdownRef); } catch { /* noop */ }
          }
          if (taskEvents && terminalHandler) {
            for (const ev of TERMINAL_EVENTS) {
              try { taskEvents.removeListener(`task:${ev}`, terminalHandler); } catch { /* noop */ }
            }
          }
        };

        const finish = (type) => {
          if (settled) return;
          settled = true;
          signalType = type;
          cleanup();
          resolve();
        };

        const timer = setTimeout(() => finish('poll'), Math.max(waitMs, 50));

        try {
          ({ taskEvents } = require('../../hooks/event-dispatch'));
          terminalHandler = (payload) => {
            const eid = payload?.id || payload?.taskId;
            if (eid && eid !== taskId) return;
            finish('terminal');
          };
          for (const ev of TERMINAL_EVENTS) {
            taskEvents.on(`task:${ev}`, terminalHandler);
          }
        } catch (err) {
          logger.debug('[await_restart] non-critical error wiring event bus: ' + (err.message || err));
        }

        if (shutdownSignal) {
          if (shutdownSignal.aborted) { finish('shutdown'); return; }
          shutdownRef = () => finish('shutdown');
          try { shutdownSignal.addEventListener('abort', shutdownRef, { once: true }); } catch { /* noop */ }
        }
      });

      if (signalType === 'shutdown') {
        return {
          content: [{ type: 'text', text: '## Await Interrupted\n\nServer is shutting down while awaiting restart.' }],
        };
      }

      // poll or terminal → re-check barrier state.
      const terminal = checkTerminal();
      if (terminal) return terminal;
    }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function createWorkflowAwaitHandlers(_deps) {
  return {
    getCommitMutex,
    buildTaskPeekArtifactSection,
    buildWorkflowPeekArtifactSection,
    syncWorkflowBlockers,
    getTaskBlockerSnapshot,
    formatBlockedDependencyDetails,
    formatWorkflowBlockerSection,
    formatDuration,
    formatHeartbeat,
    formatTaskYield,
    handleAwaitWorkflow,
    handleAwaitTask,
    handleAwaitRestart,
    formatFinalSummary,
    detectRepeatedErrors,
    recommendAction,
  };
}

module.exports = {
  getCommitMutex,
  buildTaskPeekArtifactSection,
  buildWorkflowPeekArtifactSection,
  syncWorkflowBlockers,
  getTaskBlockerSnapshot,
  formatBlockedDependencyDetails,
  formatWorkflowBlockerSection,
  formatDuration,
  formatHeartbeat,
  formatTaskYield,
  handleAwaitWorkflow,
  handleAwaitTask,
  handleAwaitRestart,
  formatFinalSummary,
  createWorkflowAwaitHandlers,
  detectRepeatedErrors,
  recommendAction,
};
