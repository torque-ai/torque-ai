/**
 * Workflow await / polling handlers (non-blocking yield-on-completion)
 */

const path = require('path');
const taskCore = require('../../db/task-core');
const fileTracking = require('../../db/file-tracking');
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
    decisionSignals
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

  // Decision signals section — gives Claude actionable data to judge progress
  if (decisionSignals) {
    const ds = decisionSignals;
    lines.push('### Decision Signals');

    const formatBytes = (b) => b > 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} bytes`;

    if (ds.outputBytes !== undefined) {
      const rate = ds.elapsedSeconds > 0 ? Math.round(ds.outputBytes / ds.elapsedSeconds) : 0;
      lines.push(`- **Output volume:** ${formatBytes(ds.outputBytes)} (${rate} bytes/sec)`);
    }
    if (ds.outputDelta !== null && ds.outputDelta !== undefined) {
      const deltaSign = ds.outputDelta > 0 ? '+' : '';
      lines.push(`- **Output delta:** ${deltaSign}${formatBytes(ds.outputDelta)} since last heartbeat`);
    }
    if (ds.filesModified && ds.filesModified.length > 0) {
      const fileList = ds.filesModified.slice(0, 8).join(', ');
      const more = ds.filesModified.length > 8 ? ` (+${ds.filesModified.length - 8} more)` : '';
      lines.push(`- **Files modified:** ${ds.filesModified.length} (${fileList}${more})`);
    } else if (ds.filesModifiedCount !== undefined) {
      lines.push(`- **Files modified:** ${ds.filesModifiedCount}`);
    }
    if (ds.lastActivitySeconds !== undefined) {
      lines.push(`- **Last activity:** ${ds.lastActivitySeconds}s ago`);
    }
    if (ds.isStalled !== undefined) {
      lines.push(`- **Stall status:** ${ds.isStalled ? 'STALLED' : 'Not stalled'}`);
    }
    if (ds.repeatedErrors && ds.repeatedErrors.length > 0) {
      for (const err of ds.repeatedErrors.slice(0, 3)) {
        lines.push(`- **Repeated error (${err.count}x):** ${err.line.slice(0, 120)}`);
      }
    } else {
      lines.push('- **Repeated errors:** None detected');
    }
    lines.push('');

    // Recommended action
    const action = recommendAction(ds);
    lines.push(`### Recommended Action`);
    lines.push(action);
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

  if (!decisionSignals) {
    lines.push('### Action');
    lines.push('Re-invoke to continue waiting, or take action (cancel, resubmit, etc.)');
  }

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
    const tasks = workflowEngine.getWorkflowTasks(args.workflow_id);
    if (!tasks) break;

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
          pending: workflowTasks.filter(t => ['pending', 'queued'].includes(t.status)).length
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
          decisionSignals
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
          let hasTorqueRemote = false;
          try {
            require('child_process').execFileSync('which', ['torque-remote'], { stdio: 'ignore', windowsHide: true });
            hasTorqueRemote = true;
          } catch {}
          const effectiveCommand = hasTorqueRemote
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

          // Wrap git add separately so failures are clearly attributed.
          try {
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
          } catch (addErr) {
            output += `**Auto-Commit failed (git add):** ${(addErr.message || '').substring(0, 500)}\n`;
            return output;
          }

          let stagedPaths;
          try {
            stagedPaths = executeValidatedCommandSync('git', ['diff', '--cached', '--name-only', '--relative', '--', ...commitPaths], {
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

          // Wrap git commit separately.
          try {
            executeValidatedCommandSync('git', ['commit', '-m', commitMsg, '--', ...commitPaths], {
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

    // If already terminal, return immediately
    if (terminalStates.includes(initialTask.status)) {
      const output = formatStandaloneTaskResult(initialTask, awaitStartTime);
      return { content: [{ type: 'text', text: output }] };
    }

    // Poll until terminal or heartbeat
    while (true) {
      const task = taskCore.getTask(taskId);
      if (!task) {
        return makeError(ErrorCodes.TASK_NOT_FOUND, `Task disappeared: ${taskId}`);
      }

      if (terminalStates.includes(task.status)) {
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
            try {
              let hasTorqueRemote = false;
              try {
                require('child_process').execFileSync('which', ['torque-remote'], { stdio: 'ignore', windowsHide: true });
                hasTorqueRemote = true;
              } catch {}

              let verifyResult;
              if (hasTorqueRemote) {
                verifyResult = executeValidatedCommandSync(
                  'torque-remote',
                  [args.verify_command],
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
                // Direct execution (backward compatibility)
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

function createWorkflowAwaitHandlers(_deps) {
  return {
    formatDuration,
    formatHeartbeat,
    formatTaskYield,
    handleAwaitWorkflow,
    handleAwaitTask,
    formatFinalSummary,
    detectRepeatedErrors,
    recommendAction,
  };
}

module.exports = {
  formatDuration,
  formatHeartbeat,
  formatTaskYield,
  handleAwaitWorkflow,
  handleAwaitTask,
  formatFinalSummary,
  createWorkflowAwaitHandlers,
  detectRepeatedErrors,
  recommendAction,
};
