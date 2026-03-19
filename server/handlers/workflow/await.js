/**
 * Workflow await / polling handlers (non-blocking yield-on-completion)
 */

const path = require('path');
const db = require('../../database');
const {
  buildPeekArtifactReferencesFromTaskArtifacts,
  formatPeekArtifactReferenceSection,
} = require('../../contracts/peek');
const { requireTask, requireWorkflow, ErrorCodes, makeError } = require('../shared');
const { TASK_TIMEOUTS } = require('../../constants');
const { safeExecChain } = require('../../utils/safe-exec');
const { executeValidatedCommandSync } = require('../../execution/command-policy');
const { checkResourceGate } = require('../../utils/resource-gate');
const hostMonitoring = require('../../utils/host-monitoring');
const { handlePeekUi } = require('../peek-handlers');
const logger = require('../../logger').child({ component: 'workflow-await' });

function buildTaskPeekArtifactSection(taskId, options = {}) {
  if (!taskId || typeof db.listArtifacts !== 'function') {
    return '';
  }

  try {
    const refs = buildPeekArtifactReferencesFromTaskArtifacts(db.listArtifacts(taskId), options);
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
        ...buildPeekArtifactReferencesFromTaskArtifacts(db.listArtifacts(task.id), {
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

function normalizeCommitPath(filePath, workingDir) {
  if (!workingDir || typeof filePath !== 'string') return null;

  const trimmed = filePath.trim().replace(/^"+|"+$/g, '');
  if (!trimmed) return null;

  const resolvedWorkingDir = path.resolve(workingDir);
  if (path.isAbsolute(trimmed)) {
    const resolvedFile = path.resolve(trimmed);
    const relativePath = path.relative(resolvedWorkingDir, resolvedFile);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return relativePath.replace(/\\/g, '/');
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
    const taskChanges = db.getTaskFileChanges(taskId) || [];
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
    const fullTask = db.getTask(taskId);
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
 * Format a heartbeat response for await_task / await_workflow.
 * Pure formatter — no side effects, no DB access.
 * Returns a markdown string suitable for returning as an MCP text content block.
 */
function formatHeartbeat(opts) {
  const {
    taskId, reason, elapsedMs, runningTasks = [], taskCounts = {},
    partialOutput, alerts = [], nextUpTasks
  } = opts;

  const elapsed = formatDuration(elapsedMs);
  const context = opts.isWorkflow ? 'Await Workflow' : 'Await Task';
  const lines = [];

  lines.push(`## Heartbeat — ${context} ${taskId}`);
  lines.push('');
  lines.push(`**Reason:** ${reason}`);
  lines.push(`**Elapsed:** ${elapsed}`);
  lines.push(`**Tasks:** ${taskCounts.completed || 0} completed, ${taskCounts.failed || 0} failed, ${taskCounts.running || 0} running, ${taskCounts.pending || 0} pending`);
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

  lines.push('### Partial Output');
  if (partialOutput && partialOutput.length > 0) {
    const truncated = partialOutput.length > 1500
      ? '...(truncated)\n' + partialOutput.slice(-1500)
      : partialOutput;
    lines.push('```');
    lines.push(truncated);
    lines.push('```');
  } else {
    lines.push('No output captured yet (provider buffers until completion)');
  }
  lines.push('');

  if (alerts.length > 0) {
    lines.push('### Alerts');
    for (const alert of alerts) {
      lines.push(`- ${alert}`);
    }
    lines.push('');
  }

  if (nextUpTasks && nextUpTasks.length > 0) {
    lines.push('### Next Up');
    for (const t of nextUpTasks.slice(0, 5)) {
      lines.push(`- ${t.id}: ${(t.description || '').slice(0, 60)}`);
    }
    lines.push('');
  }

  lines.push('### Action');
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

  // Error output for failed tasks
  if (task.status === 'failed' && task.error_output) {
    const errTrimmed = task.error_output.substring(0, 2000);
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
  const timeoutMs = Math.min(Math.max(args.timeout_minutes || 30, 0.01) * 60000, 3600000);
  const startTime = Date.now();
  const shutdownSignal = args.__shutdownSignal;

  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;
  

  // Load acknowledged set from workflow context
  const ctx = workflow.context || {};
  const acknowledged = new Set(ctx.acknowledged_tasks || []);
  const terminalStates = ['completed', 'failed', 'cancelled', 'skipped'];

  // Poll until we find an unacknowledged terminal task, or all are done
  while (true) {
    const tasks = db.getWorkflowTasks(args.workflow_id);
    if (!tasks) break;

    // Find terminal tasks not yet acknowledged
    const unacked = tasks.filter(t => terminalStates.includes(t.status) && !acknowledged.has(t.id));

    if (unacked.length > 0) {
      // Yield the first unacknowledged terminal task
      const task = unacked[0];
      acknowledged.add(task.id);

      // Persist acknowledged set to workflow context
      const updatedCtx = { ...ctx, acknowledged_tasks: Array.from(acknowledged) };
      db.updateWorkflow(args.workflow_id, { context: updatedCtx });

      // Visual verification if task metadata has visual_verify config
      let visualContent = [];
      if (task.status === 'completed' && task.metadata) {
        try {
          const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
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
        return { content: [{ type: 'text', text: formatFinalSummary(args, workflow, tasks, task, startTime) }] };
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
      return { content: [{ type: 'text', text: formatFinalSummary(args, workflow, tasks, null, startTime) }] };
    }

    // Shutdown check — return early so the response reaches the client before SSE closes
    if (shutdownSignal && shutdownSignal.aborted) {
      let output = `## Server Shutting Down\n\n`;
      output += `**Workflow:** ${workflow.name}\n`;
      output += `**ID:** ${args.workflow_id}\n`;
      output += `**Waited:** ${Math.round((Date.now() - startTime) / 1000)}s\n`;
      output += `**Acknowledged:** ${acknowledged.size} / ${tasks.length} tasks\n\n`;
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
      output += `Workflow is still running. Call \`await_workflow\` again to continue receiving results.\n`;
      return { content: [{ type: 'text', text: output }] };
    }

    // Wait for either a task event or the poll interval — whichever comes first.
    // This gives instant wakeup when tasks complete instead of sleeping the full interval.
    await new Promise(r => {
      let resolved = false;
      let taskEventsRef = null;
      let handlerRef = null;

      let shutdownRef = null;

      const cleanup = () => {
        if (taskEventsRef && handlerRef) {
          for (const ev of terminalStates) {
            taskEventsRef.removeListener(`task:${ev}`, handlerRef);
          }
        }
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

      const timer = setTimeout(done, pollMs);

      // Wake immediately on server shutdown
      if (shutdownSignal) {
        if (shutdownSignal.aborted) { done(); return; }
        shutdownRef = done;
        shutdownSignal.addEventListener('abort', done, { once: true });
      }

      try {
        const { taskEvents } = require('../../hooks/event-dispatch');
        taskEventsRef = taskEvents;
        handlerRef = () => done();
        for (const ev of terminalStates) {
          taskEvents.once(`task:${ev}`, handlerRef);
        }
      } catch (err) {
        // event-dispatch not available — fall back to pure timer
        logger.debug('[workflow-handlers] non-critical error wiring fallback timer path:', err.message || err);
      }
    });
  }

  return makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow disappeared: ${args.workflow_id}`);
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Build the final summary output (verify + commit), shown when all tasks are acknowledged.
 */
function formatFinalSummary(args, workflow, tasks, lastTask, startTime) {
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

  output += buildWorkflowPeekArtifactSection(tasks);

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
      const verifyResult = safeExecChain(args.verify_command, {
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
      executeValidatedCommandSync('git', ['add', '--', ...commitPaths], {
        profile: 'advanced_shell',
        dangerous: true,
        source: 'await_workflow',
        caller: 'formatFinalSummary',
        cwd,
        timeout: TASK_TIMEOUTS.GIT_ADD,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const stagedPaths = executeValidatedCommandSync('git', ['diff', '--cached', '--name-only', '--relative', '--', ...commitPaths], {
        profile: 'safe_verify',
        source: 'await_workflow',
        caller: 'formatFinalSummary',
        cwd,
        timeout: TASK_TIMEOUTS.GIT_STATUS,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (!stagedPaths) {
        output += `No changes to commit.\n`;
        return output;
      }

      executeValidatedCommandSync('git', ['commit', '-m', commitMsg, '--', ...commitPaths], {
        profile: 'advanced_shell',
        dangerous: true,
        source: 'await_workflow',
        caller: 'formatFinalSummary',
        cwd,
        timeout: TASK_TIMEOUTS.HTTP_REQUEST,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
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
      }
    } catch (commitErr) {
      output += `**Commit failed:** ${(commitErr.message || '').substring(0, 500)}\n`;
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
    const errTrimmed = task.error_output.substring(0, 2000);
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
 * Block until a standalone task completes or fails, then return its result.
 * Uses the same event-bus wakeup as await_workflow for instant notification.
 * Optionally runs verify_command and auto-commits on success.
 */
async function handleAwaitTask(args) {
  try {
    const pollMs = Math.min(Math.max(args.poll_interval_ms || 5000, 1000), 30000);
    const timeoutMinutes = Math.min(Math.max(args.timeout_minutes || 30, 0.01), 60);
    const timeoutMs = timeoutMinutes * 60000;
    const awaitStartTime = Date.now();
    const terminalStates = ['completed', 'failed', 'cancelled', 'skipped'];
    const shutdownSignal = args.__shutdownSignal;
    const taskId = args.task_id;

    // Heartbeat configuration: default 5 min, min 0 (disabled), max 30
    const rawHeartbeat = args.heartbeat_minutes != null ? args.heartbeat_minutes : 5;
    const heartbeatMinutes = Math.min(Math.max(rawHeartbeat, 0), 30);
    const heartbeatEnabled = heartbeatMinutes > 0;
    const heartbeatMs = heartbeatMinutes * 60 * 1000;

    // Reason name mapping for notable events
    const REASON_MAP = {
      started: 'task_started',
      stall_warning: 'stall_warning',
      retry: 'task_retried',
      fallback: 'provider_fallback'
    };

    const { task: initialTask, error: taskErr } = requireTask(db, taskId);
    if (taskErr) return taskErr;

    // If already terminal, return immediately
    if (terminalStates.includes(initialTask.status)) {
      const output = formatStandaloneTaskResult(initialTask, awaitStartTime);
      return { content: [{ type: 'text', text: output }] };
    }

    // Poll until terminal or heartbeat
    while (true) {
      const task = db.getTask(taskId);
      if (!task) {
        return makeError(ErrorCodes.TASK_NOT_FOUND, `Task disappeared: ${taskId}`);
      }

      if (terminalStates.includes(task.status)) {
        let output = formatStandaloneTaskResult(task, awaitStartTime);

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
            try {
              const verifyResult = executeValidatedCommandSync(
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
              output += `\n### Verify Command\n✅ Passed\n\`\`\`\n${(verifyResult || '').toString().trim().substring(0, 1000)}\n\`\`\`\n`;
            } catch (err) {
              const errMsg = (err.stderr || err.stdout || err.message || '').toString().substring(0, 1500);
              output += `\n### Verify Command\n❌ Failed\n\`\`\`\n${errMsg}\n\`\`\`\n`;
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
              const commitPaths = taskPaths.length > 0 ? taskPaths : getFallbackCommitPaths(cwd);
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
                  timeout: TASK_TIMEOUTS.HTTP_REQUEST,
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
        const currentTask = db.getTask(taskId);
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
            })
          }]
        };
      }
    }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

module.exports = {
  formatDuration,
  formatHeartbeat,
  formatTaskYield,
  handleAwaitWorkflow,
  handleAwaitTask,
  formatFinalSummary
};
