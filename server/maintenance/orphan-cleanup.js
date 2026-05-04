/**
 * Orphan Cleanup Module — Extracted from task-manager.js (Phase 5, Step 2)
 *
 * Handles cleanup of orphaned/zombie/stale processes and tasks:
 * - Orphaned processes from crashed sessions
 * - Orphaned dotnet processes from interrupted tests/builds
 * - Stale running tasks that exceeded timeout
 * - Zombie processes (close event never fired)
 * - Orphaned host tasks when a host goes down
 * - Stalled tasks (no output beyond threshold)
 *
 * Uses init() pattern for dependency injection.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { killProcessGraceful, killOrphanByPid } = require('../execution/process-lifecycle');
const serverConfig = require('../config');
const { parseModelSizeB } = require('../utils/model');
const {
  appendRollbackReport,
  rollbackAgenticTaskChanges,
} = require('../execution/agentic-orphan-rollback');
const {
  COMPLETION_GRACE_MS,
  COMPLETION_GRACE_CODEX_MS,
} = require('../constants');
const {
  resolveActivityAwareTimeoutDecision,
  resolvePlanGenerationHardCapMs,
} = require('../utils/activity-timeout');

// ---- Injected dependencies (set via init()) ----
let db = null;
let dashboard = null;
let logger = null;
let runningProcesses = null;
let stallRecoveryAttempts = null;
let TASK_TIMEOUTS = null;
let cancelTask = null;
let processQueue = null;
let tryLocalFirstFallback = null;
let getTaskActivity = null;
let tryStallRecovery = null;
let detectOutputCompletion = null;
let isInstanceAlive = null;
let getMcpInstanceId = null;
let reportRuntimeTaskProblem = null;

// ---- Timer handles ----
let dotnetCleanupInterval = null;
let staleCheckInterval = null;
let zombieCheckInterval = null;
let stallCheckInterval = null;
let timersStarted = false;
let staleCheckTimeout = null;
let staleOwnerRecoveryTimeout = null;

/**
 * Check if a PID is still alive.
 * Uses process.kill(pid, 0) as a portability-safe existence probe.
 * @param {number|string|undefined|null} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- Stall detection constants ----

/**
 * Base stall detection threshold in seconds
 * This is the minimum - larger models get longer thresholds
 */
const BASE_STALL_THRESHOLD_SECONDS = 180; // 3 minutes without output = stalled

// Per-provider stall thresholds (in seconds)
// These are base thresholds before model-size adjustments
const PROVIDER_STALL_THRESHOLDS = {
  'ollama': 240,            // 4 minutes - direct API is faster
  'claude-cli': 600,        // 10 minutes - claude can be slow on complex tasks
  'codex': 600,             // 10 minutes - only kills truly orphaned codex processes (monitored tasks are excluded)
  'codex-spark': 300,       // 5 minutes - spark is fast
  'anthropic': 300,         // 5 minutes - API can be slow
  'groq': 120,              // 2 minutes - groq is fast
  'ollama-cloud': 300,      // 5 minutes - cloud inference on large models
  'cerebras': 120,          // 2 minutes - cerebras is ultra-fast
  'google-ai': 180,         // 3 minutes - Gemini free tier
  'openrouter': 180,        // 3 minutes - varies by upstream model
};

// Map provider names to stall config keys (configure_stall_detection writes these)
const PROVIDER_STALL_CONFIG_KEYS = {
  'ollama': 'stall_threshold_ollama',
  'claude-cli': 'stall_threshold_claude',
  'codex': 'stall_threshold_codex',
  'anthropic': 'stall_threshold_claude',
  'groq': 'stall_threshold_ollama',
  'ollama-cloud': 'stall_threshold_ollama_cloud',
  'cerebras': 'stall_threshold_cerebras',
  'google-ai': 'stall_threshold_google_ai',
  'openrouter': 'stall_threshold_openrouter',
};

function getCompletionGraceMs(provider) {
  return provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
}

// Track tasks that have already received a stall warning (prevent duplicates)
const _stallWarningEmitted = new Set();

// ---- Zombie check state ----
let zombieCheckCycle = 0;

// ============================================================
// Orphaned Process Cleanup
// ============================================================

/**
 * Kill orphaned dotnet processes from previous crashed sessions
 * This prevents .NET processes from accumulating when tests/builds are interrupted
 * Uses async execFile (not execSync/execFileSync) to avoid blocking the event loop
 * Only kills processes NOT tracked in our runningProcesses map
 */
async function cleanupOrphanedDotnetProcesses() {
  try {
    let dotnetPids = [];

    if (process.platform === 'win32') {
      // Windows: use WMIC to find dotnet processes
      try {
        const { stdout: result } = await execFileAsync(
          'wmic',
          ['process', 'where', "name like '%dotnet%'", 'get', 'processid,commandline', '/format:list'],
          { encoding: 'utf8', timeout: TASK_TIMEOUTS.PROCESS_QUERY, windowsHide: true }
        );
        // Parse PIDs from WMIC output, filtering for test/build processes
        const lines = result.split('\n');
        let currentPid = null;
        let currentCmd = '';
        for (const line of lines) {
          if (line.startsWith('CommandLine=')) {
            currentCmd = line.slice(12).toLowerCase();
          } else if (line.startsWith('ProcessId=')) {
            currentPid = parseInt(line.slice(10), 10);
            // Only target test/build/run processes, not VS or other dotnet tools
            if (currentPid && (currentCmd.includes('dotnet test') ||
                currentCmd.includes('dotnet build') ||
                currentCmd.includes('dotnet run'))) {
              dotnetPids.push(currentPid);
            }
            currentPid = null;
            currentCmd = '';
          }
        }
      } catch {
        // WMIC might not be available or no matches
      }
    } else {
      // Linux/Mac (including WSL): use pgrep with execFile
      // Target dotnet test, build, and run processes
      const patterns = ['dotnet.*test', 'dotnet.*build', 'dotnet.*run'];
      for (const pattern of patterns) {
        try {
          const { stdout: result } = await execFileAsync(
            'pgrep',
            ['-f', pattern],
            { encoding: 'utf8', timeout: TASK_TIMEOUTS.PROCESS_QUERY }
          );
          const pids = result.trim().split('\n').filter(p => p).map(p => parseInt(p, 10));
          dotnetPids.push(...pids);
        } catch {
          // pgrep returns non-zero if no matches - this is expected
        }
      }
      // Deduplicate PIDs
      dotnetPids = [...new Set(dotnetPids)];
    }

    // Filter out PIDs that are tracked in our runningProcesses map
    // These are legitimate running tasks, not orphans. Critically, we
    // also expand each tracked PID's *descendant* tree: TORQUE-tracked
    // tasks routinely spawn `dotnet test` as a grandchild (codex.exe →
    // dotnet, or bash → dotnet), and trackedPids only holds the
    // immediate child PID. Without this expansion, a 5-min orphan sweep
    // running mid-verify would taskkill /T the dotnet PID and the
    // verify command "fails" with no useful diagnosis.
    const trackedPids = new Set();
    for (const [_taskId, proc] of runningProcesses.entries()) {
      const pid = proc?.process?.pid;
      if (pid) trackedPids.add(pid);
    }
    const safePids = new Set(trackedPids);
    try {
      const { collectWindowsProcessTree, collectPosixProcessTree } = require('../utils/process-activity');
      const collectTree = process.platform === 'win32' ? collectWindowsProcessTree : collectPosixProcessTree;
      for (const rootPid of trackedPids) {
        try {
          const { processIds } = collectTree(rootPid) || { processIds: new Set() };
          for (const descendantPid of processIds) safePids.add(descendantPid);
        } catch { /* tree walk failed for one root — skip it, fall back to parent-only */ }
      }
    } catch { /* process-activity not available — fall back to parent-only filter */ }
    const orphanedPids = dotnetPids.filter(pid => !safePids.has(pid));

    if (orphanedPids.length > 0) {
      logger.info(`[Cleanup] Found ${orphanedPids.length} orphaned dotnet process(es): ${orphanedPids.join(', ')}`);

      for (const pid of orphanedPids) {
        killOrphanByPid(pid, `dotnet-orphan-${pid}`, 3000, 'DotnetOrphan');
      }
    }
  } catch (err) {
    logger.info(`[Cleanup] Error cleaning up orphaned dotnet processes: ${err.message}`);
  }
}

// ============================================================
// Stale Task Timeout Check
// ============================================================

function resolveTaskTimeoutMinutes(task) {
  const parsed = parseInt(task?.timeout_minutes, 10);
  if (parsed === 0) return 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 480;
}

function buildTrackedTaskTimeoutProc(task, proc) {
  const taskStartedAtMs = new Date(task?.started_at).getTime();
  return {
    ...proc,
    startTime: Number.isFinite(taskStartedAtMs) ? taskStartedAtMs : proc?.startTime,
  };
}

function getTrackedTaskIdleState(task, timeoutMs) {
  if (!runningProcesses || !runningProcesses.has(task.id)) {
    return { tracked: false, active: false, idleMs: null, timeoutDecision: null, hardCapMs: 0 };
  }

  const proc = runningProcesses.get(task.id);
  const resolveDecision = () => resolveActivityAwareTimeoutDecision({
    proc: buildTrackedTaskTimeoutProc(task, proc),
    timeoutMs,
    task,
    metadata: proc?.metadata,
    now: Date.now(),
  });
  let timeoutDecision = resolveDecision();
  let idleMs = timeoutDecision.idleMs;

  if (idleMs >= timeoutMs && typeof getTaskActivity === 'function') {
    try {
      // Lets filesystem/CPU activity rescue active agent tasks before stale
      // timeout enforcement decides they are dead.
      getTaskActivity(task.id);
      timeoutDecision = resolveDecision();
      idleMs = timeoutDecision.idleMs;
    } catch (activityErr) {
      logger?.info?.(`[Stale Check] Activity probe failed for ${task.id}: ${activityErr.message}`);
    }
  }

  return {
    tracked: true,
    active: timeoutDecision.action === 'extend',
    idleMs,
    timeoutDecision,
    hardCapMs: resolvePlanGenerationHardCapMs(proc?.metadata, task?.metadata, task?.task_metadata),
  };
}

function getRuntimeProblemReporter() {
  if (typeof reportRuntimeTaskProblem === 'function') {
    return reportRuntimeTaskProblem;
  }
  try {
    return require('../factory/runtime-problem-intake').reportRuntimeTaskProblem;
  } catch (error) {
    logger?.info?.(`[RuntimeProblemIntake] Reporter unavailable: ${error.message}`);
    return null;
  }
}

function hasReportedRuntimeProblem(proc, problem) {
  return Boolean(proc?.runtimeProblemReports?.[problem]);
}

function markRuntimeProblemReported(proc, problem) {
  if (!proc) return;
  if (!proc.runtimeProblemReports || typeof proc.runtimeProblemReports !== 'object') {
    proc.runtimeProblemReports = {};
  }
  proc.runtimeProblemReports[problem] = new Date().toISOString();
}

function maybeReportRuntimeProblem(task, problem, details = {}) {
  const proc = task?.id && runningProcesses ? runningProcesses.get(task.id) : null;
  if (proc && hasReportedRuntimeProblem(proc, problem)) {
    return;
  }

  const reporter = getRuntimeProblemReporter();
  if (!reporter) {
    return;
  }

  try {
    const result = reporter({
      db,
      task,
      problem,
      details,
      logger,
    });
    if (proc && result?.reported) {
      markRuntimeProblemReported(proc, problem);
    }
  } catch (error) {
    logger?.info?.(`[RuntimeProblemIntake] Failed to report ${problem} for ${task?.id}: ${error.message}`);
  }
}

/**
 * Check for stale running tasks that should have timed out
 * This catches tasks that exceeded their timeout but weren't cancelled
 * (e.g., if server was restarted and timeout handles were lost)
 * Also reconciles host task counts to prevent stale counts
 *
 * Uses lightweight query to avoid fetching large TEXT columns (output, context)
 * which significantly improves performance under load
 */
function checkStaleRunningTasks() {
  if (!db || (typeof db.isReady === 'function' && !db.isReady())) return;
  // Skip during post-wake grace period — sleep inflates elapsed times
  try {
    const { isInSleepGracePeriod } = require('./sleep-watchdog');
    if (isInSleepGracePeriod()) {
      logger.info('[Stale Check] Skipped — sleep grace period active');
      return;
    }
  } catch { /* watchdog not loaded — proceed normally */ }
  try {
    // First, reconcile host task counts to fix any stale counts
    // This ensures hosts show accurate running task numbers
    try {
      db.reconcileHostTaskCounts();
    } catch (reconcileErr) {
      if (logger) logger.info(`[Stale Check] Reconcile error: ${reconcileErr.message}`);
    }

    // Use lightweight query - only fetches essential columns for stale check
    // This is much faster than listTasks() which fetches output, context, etc.
    const runningTasks = db.getRunningTasksLightweight();
    let recoveredOrphans = 0;

    for (const task of runningTasks) {
      if (!task.started_at) continue;

      // Skip tasks whose close handler is still running (auto-verify can take 90s+).
      // The process exited (no longer in runningProcesses) but finalization is in progress.
      if (shouldSkipFinalizingTask(task)) {
        continue;
      }

      const currentInstanceId = typeof getMcpInstanceId === 'function'
        ? getMcpInstanceId()
        : null;
      const isTrackedLocally = runningProcesses.has(task.id);
      const retryCount = task.retry_count || 0;
      const maxRetries = task.max_retries != null ? task.max_retries : 2;
      const requeueOrFailDeadOwner = (reason) => {
        const rollbackResult = rollbackAgenticTaskChanges(task, { logger });
        if (retryCount < maxRetries) {
          logger.info(`[Stale Check] ${reason} - requeueing ${task.id} (attempt ${retryCount + 1}/${maxRetries})`);
          const errorOutput = appendRollbackReport(
            `${reason} — requeued for re-execution (attempt ${retryCount + 1}/${maxRetries})`,
            rollbackResult
          );
          db.updateTaskStatus(task.id, 'queued', {
            error_output: errorOutput,
            retry_count: retryCount + 1,
            mcp_instance_id: null,
            provider: null,
            ollama_host_id: null,
          });
        } else {
          logger.info(`[Stale Check] ${reason} - failing ${task.id} (max retries exhausted: ${retryCount}/${maxRetries})`);
          const errorOutput = appendRollbackReport(
            `${reason} (max retries exhausted: ${retryCount}/${maxRetries})`,
            rollbackResult
          );
          db.updateTaskStatus(task.id, 'failed', {
            error_output: errorOutput,
            completed_at: new Date().toISOString(),
            mcp_instance_id: null,
            ollama_host_id: null,
          });
        }
        if (task.ollama_host_id && typeof db.decrementHostTasks === 'function') {
          try { db.decrementHostTasks(task.ollama_host_id); } catch { /* ignore */ }
        }
        try { dashboard?.notifyTaskUpdated?.(task.id); } catch { /* ignore */ }
        recoveredOrphans++;
      };

      if (task.mcp_instance_id) {
        if (currentInstanceId && task.mcp_instance_id === currentInstanceId) {
          if (!isTrackedLocally) {
            requeueOrFailDeadOwner(`Task orphaned — current instance ${task.mcp_instance_id} has no tracked process`);
            continue;
          }
        } else if (typeof isInstanceAlive === 'function' && !isInstanceAlive(task.mcp_instance_id)) {
          requeueOrFailDeadOwner(`Task orphaned — owning instance ${task.mcp_instance_id} is no longer alive`);
          continue;
        }
      }

      const elapsedMs = Date.now() - new Date(task.started_at).getTime();
      const timeoutMinutes = resolveTaskTimeoutMinutes(task);
      if (timeoutMinutes === 0) {
        continue;
      }
      const timeoutMs = timeoutMinutes * 60 * 1000;

      if (elapsedMs > timeoutMs) {
        const idleState = getTrackedTaskIdleState(task, timeoutMs);
        if (idleState.tracked && idleState.active) {
          const elapsedMin = Math.round(elapsedMs / 60000);
          const idleMin = Math.round(idleState.idleMs / 60000);
          logger.info(`[Stale Check] Task ${task.id} has been running for ${elapsedMin}min (timeout: ${timeoutMinutes}min) but had activity ${idleMin}min ago - leaving running`);
          if (idleState.hardCapMs > 0) {
            const hardCapMin = Math.round(idleState.hardCapMs / 60000);
            logger.info(`[Stale Check] Factory plan-generation task ${task.id} remains active before hard cap (${hardCapMin}min) - suppressing timeout_overrun_active intake`);
          } else {
            maybeReportRuntimeProblem(task, 'timeout_overrun_active', {
              timeoutMinutes,
              elapsedMinutes: elapsedMin,
              idleMinutes: idleMin,
            });
          }
          continue;
        }

        const elapsedMin = Math.round(elapsedMs / 60000);
        if (idleState.tracked && idleState.timeoutDecision?.reason === 'factory_plan_generation_hard_cap') {
          maybeReportRuntimeProblem(task, 'timeout_overrun_active', {
            timeoutMinutes,
            elapsedMinutes: elapsedMin,
            idleMinutes: Math.round((idleState.idleMs || 0) / 60000),
            hardCapMinutes: Math.round((idleState.hardCapMs || 0) / 60000),
            reason: idleState.timeoutDecision.reason,
          });
        }
        logger.info(`[Stale Check] Task ${task.id} has been running for ${elapsedMin}min (timeout: ${timeoutMinutes}min) - failing`);

        // Fail via cancelTask if process is tracked, otherwise update DB directly.
        if (runningProcesses.has(task.id)) {
          cancelTask(task.id, 'Timeout exceeded (stale check)', { cancel_reason: 'timeout' });
        } else {
          // Process not tracked (server restarted) - update DB directly
          db.updateTaskStatus(task.id, 'failed', {
            error_output: `Auto-failed: Task exceeded ${timeoutMinutes} minute timeout (detected by stale check)`,
            completed_at: new Date().toISOString(),
            mcp_instance_id: null,
            ollama_host_id: null,
          });
          // Reconcile again after direct DB update to fix host counts
          try {
            db.reconcileHostTaskCounts();
          } catch { /* ignore */ }
        }
      }
    }

    if (recoveredOrphans > 0) {
      try {
        db.reconcileHostTaskCounts();
      } catch { /* ignore */ }
      try {
        processQueue();
      } catch { /* ignore */ }
    }
  } catch (err) {
    logger.info(`[Stale Check] Error: ${err.message} STACK: ${err.stack?.split('\n').slice(0, 5).join(' >> ')}`);
  }
}

// ============================================================
// Zombie Process Detection
// ============================================================

/**
 * Check for zombie processes: tasks in 'running' state whose child process has
 * already exited but the 'close' event never fired (Windows .cmd wrapper issue).
 * Also detects tasks whose output signals completion but the process lingers.
 */
async function checkZombieProcesses() {
  zombieCheckCycle++;
  try {
    const count = runningProcesses.size;
    // P105: Heartbeat log every 10th cycle (5 minutes) to confirm checker is running
    if (zombieCheckCycle % 10 === 0) {
      logger.info(`[Zombie Check] Heartbeat: cycle ${zombieCheckCycle}, tracking ${count} process(es)`);
    }

    for (const [taskId, proc] of runningProcesses) {
      // Check 1: Process exited but close event didn't fire
      // On Windows, .cmd wrappers can orphan — process.killed or exitCode being set
      // means the process is gone but Node didn't emit 'close'.
      if (proc.process.exitCode !== null && proc.process.exitCode !== undefined) {
        logger.info(`[Zombie Check] Task ${taskId} process has exitCode ${proc.process.exitCode} but is still tracked. Forcing cleanup.`);
        proc.process.emit('close', proc.process.exitCode);
        continue;
      }

      // Check 2: Process killed or signalCode set (Node knows it's dead)
      if (proc.process.killed || proc.process.signalCode) {
        logger.info(`[Zombie Check] Task ${taskId} process killed=${proc.process.killed} signal=${proc.process.signalCode} but still tracked. Forcing cleanup.`);
        proc.process.emit('close', proc.process.exitCode || 1);
        continue;
      }

      // Check 3: POSIX signal check — works on Linux, unreliable on Windows
      // On Windows, process.kill(pid, 0) can succeed for dead processes because
      // Node.js holds an open process handle. Handle ALL error codes, not just ESRCH.
      if (proc.process.pid) {
        try {
          process.kill(proc.process.pid, 0);
        } catch (err) {
          logger.info(`[Zombie Check] Task ${taskId} PID ${proc.process.pid} signal check failed (${err.code}). Forcing cleanup.`);
          const exitCode = proc.completionDetected ? 0 : 1;
          proc.process.emit('close', exitCode);
          continue;
        }
      }

      // Check 4 (P105): Windows-specific — use tasklist to verify PID actually exists.
      // process.kill(pid, 0) can succeed on Windows even for dead processes because
      // Node.js holds an open handle. tasklist queries the OS kernel directly.
      if (process.platform === 'win32' && proc.process.pid) {
        try {
          const { stdout: result } = await execFileAsync(
            'tasklist',
            ['/FI', `PID eq ${proc.process.pid}`, '/NH', '/FO', 'CSV'],
            { encoding: 'utf8', timeout: TASK_TIMEOUTS.PROCESS_QUERY, windowsHide: true }
          );
          // tasklist returns a CSV line with the PID if found, or "INFO: No tasks..." if not
          if (!result.includes(String(proc.process.pid))) {
            logger.info(`[Zombie Check] Task ${taskId} PID ${proc.process.pid} not found in tasklist. Process is dead. Forcing cleanup.`);
            const exitCode = proc.completionDetected ? 0 : 1;
            proc.process.emit('close', exitCode);
            continue;
          }
        } catch (err) {
          // tasklist failed — log but don't force cleanup
          logger.info(`[Zombie Check] Task ${taskId} tasklist check failed: ${err.message}`);
        }
      }

      // Check 5: DB-status mismatch — task cancelled/failed/completed in DB but still tracked.
      // Catches zombie processes left behind by batch_cancel or external DB updates that
      // only changed the status without killing the child process.
      try {
        const dbTask = db.getTask(taskId);
        if (dbTask && dbTask.status !== 'running') {
          logger.info(`[Zombie Check] Task ${taskId} is '${dbTask.status}' in DB but still tracked in runningProcesses. Killing process and cleaning up.`);
          killProcessGraceful(proc, taskId, 5000, 'ZombieCheck');
          setTimeout(() => {
            const stillRunning = runningProcesses.get(taskId);
            if (stillRunning && stillRunning === proc) {
              proc.process.emit('close', proc.process.exitCode || 1);
            }
          }, 5000);
          continue;
        }
      } catch {
        // DB query failed — skip this check, other checks will catch it
      }

      // Check 6: output completion grace missed — process-streams schedules a
      // force-close timer when output proves the provider finished. If that
      // timer is lost or delayed, the task can stay DB-running forever even
      // though Codex already committed and wrote its final answer.
      if (proc.completionDetected) {
        const completionIdleMs = Date.now() - (proc.lastOutputAt || proc.startTime || Date.now());
        const graceMs = getCompletionGraceMs(proc.provider);
        if (completionIdleMs > graceMs + 30 * 1000) {
          logger.info(`[Zombie Check] Task ${taskId} completion detected ${Math.round(completionIdleMs / 1000)}s ago but task is still running. Emitting synthetic successful close.`);
          proc.process.emit('close', 0);
          continue;
        }
      }

      // Check 7: Short-output completion — tasks with very short output that contain completion
      // patterns but never triggered detectOutputCompletion (which requires 1KB minimum).
      // If output is short, idle for 2+ minutes, and contains completion patterns, treat
      // as completed. This catches edge-case tasks with minimal output (e.g., "no changes needed").
      if (!proc.completionDetected && detectOutputCompletion) {
        const output = proc.output || '';
        const shortOutputIdleMs = Date.now() - (proc.lastOutputAt || proc.startTime || Date.now());
        const SHORT_OUTPUT_IDLE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
        if (output.length > 20 && output.length < 1000 && shortOutputIdleMs > SHORT_OUTPUT_IDLE_THRESHOLD_MS) {
          // Run completion patterns without the 8KB guard — check last 2000 chars
          const tail = output.slice(-2000).toLowerCase();
          const shortCompletionPatterns = [
            /no changes needed/,
            /no changes (are )?(needed|required)/,
            /(?:file|feature|implementation) already (exists?|implemented|up[- ]to[- ]date)/,
            /all \d+ tests?\s+(pass|passing|passed)/,
            /test run successful/,
            /tests? passed,\s*0 failed/,
            /applied edit to\s+\S+/,
            /^patched\s+\[[^\]\n]+\]\([^)]+\)/im,
            /completed?\./i,
            /done\./i,
          ];
          for (const pattern of shortCompletionPatterns) {
            if (pattern.test(tail)) {
              logger.info(`[Zombie Check] Task ${taskId} has short output (${output.length} bytes) idle for ${Math.round(shortOutputIdleMs / 1000)}s with completion pattern. Force-completing.`);
              proc.completionDetected = true;
              proc.process.emit('close', 0);
              break;
            }
          }
          if (proc.completionDetected) continue;
        }
      }

      // Check 6 (P105): Inactivity timeout — if no output for 10 minutes, force cleanup.
      // Catches cases where the process is alive but stuck (e.g., waiting for dead Ollama).
      const lastActivity = proc.lastOutputAt || proc.startTime || Date.now();
      const inactiveMs = Date.now() - lastActivity;
      const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
      if (inactiveMs > INACTIVITY_TIMEOUT_MS) {
        if (typeof getTaskActivity === 'function') {
          try {
            getTaskActivity(taskId);
            const refreshedLastActivity = proc.lastOutputAt || proc.startTime || Date.now();
            const refreshedInactiveMs = Date.now() - refreshedLastActivity;
            if (refreshedInactiveMs <= INACTIVITY_TIMEOUT_MS) {
              logger.info(`[Zombie Check] Task ${taskId} appeared inactive for ${Math.round(inactiveMs / 60000)} minutes but has fresh activity; leaving running.`);
              continue;
            }
          } catch (activityErr) {
            logger.info(`[Zombie Check] Activity probe failed for ${taskId}: ${activityErr.message}`);
          }
        }
        logger.info(`[Zombie Check] Task ${taskId} has been inactive for ${Math.round(inactiveMs / 60000)} minutes. Forcing cleanup.`);
        killProcessGraceful(proc, taskId, 5000, 'Inactivity');
        setTimeout(() => {
          const stillRunning = runningProcesses.get(taskId);
          if (stillRunning && stillRunning === proc) {
            proc.process.emit('close', 1);
          }
        }, 5000);
      }
    }
  } catch (err) {
    logger.info(`[Zombie Check] Error: ${err.message}`);
  }
}

// ============================================================
// Stalled Task Detection
// ============================================================

/**
 * Check for stalled tasks and attempt recovery or cancel
 * @param {boolean} autoCancel - Whether to auto-cancel/recover stalled tasks
 * @returns {Array} Array of stalled task IDs
 */
function checkStalledTasks(autoCancel = false) {
  // Skip during post-wake grace period — sleep inflates lastActivitySeconds
  try {
    const { isInSleepGracePeriod } = require('./sleep-watchdog');
    if (isInSleepGracePeriod()) {
      logger.info('[Stall Check] Skipped — sleep grace period active');
      return [];
    }
  } catch { /* watchdog not loaded — proceed normally */ }

  const stalledTasks = [];
  // Stall detection is controlled via PROVIDER_STALL_THRESHOLDS
  // Providers with null threshold are excluded; queued tasks are never checked
  const recoveryEnabled = serverConfig.getBool('stall_recovery_enabled');

  for (const taskId of runningProcesses.keys()) {
    const activity = getTaskActivity(taskId);
    if (!activity) continue;

    let isStalled = activity.isStalled;

    // If the process is still alive, extend the threshold by 50% before aborting.
    // This catches long I/O waits or external blocking where PID is active.
    const proc = runningProcesses.get(taskId);
    if (isStalled && proc && proc.process && typeof proc.process.pid !== 'undefined' && typeof activity.stallThreshold === 'number') {
      const aliveThreshold = activity.stallThreshold * 1.5;
      if (isProcessAlive(proc.process.pid) && activity.lastActivitySeconds <= aliveThreshold) {
        logger.warn(`[Heartbeat] Task ${taskId} output stalled for ${activity.lastActivitySeconds}s but PID ${proc.process.pid} is still alive; extending stall threshold from ${activity.stallThreshold}s to ${aliveThreshold}s.`);
        maybeReportRuntimeProblem({ id: taskId }, 'stall_threshold_extended', {
          lastActivitySeconds: activity.lastActivitySeconds,
          stallThresholdSeconds: activity.stallThreshold,
          aliveThresholdSeconds: aliveThreshold,
        });
        isStalled = false;
        activity.stallThreshold = aliveThreshold;
      }
    }

    // Emit stall warning at 80% of threshold (once per task)
    const stallThreshold = activity.stallThreshold;
    if (!isStalled && stallThreshold !== null && !_stallWarningEmitted.has(taskId)) {
      const warningThreshold = stallThreshold * 0.8;
      if (activity.lastActivitySeconds >= warningThreshold) {
        _stallWarningEmitted.add(taskId);
        try {
          const { taskEvents } = require('../hooks/event-dispatch');
          taskEvents.emit('task:stall_warning', {
            taskId,
            provider: proc?.provider || 'unknown',
            elapsed: activity.lastActivitySeconds,
            threshold: Math.round(stallThreshold),
            description: proc?.description || ''
          });
        } catch {
          // Non-fatal
        }
      }
    }

    // isStalled is false if threshold is null (provider excluded)
    if (isStalled) {
      // If a Claude session is actively monitoring this task (via await_task,
      // await_workflow, or subscribe_task_events), defer stall handling to Claude.
      // Claude receives heartbeat check-ins and can decide to cancel/resubmit itself.
      let monitored = false;
      try {
        const { isTaskMonitored } = require('../transports/sse/session');
        monitored = isTaskMonitored(taskId);
      } catch (_) { /* SSE session module not available */ }

      if (monitored) {
        logger.info(`[Heartbeat] Task ${taskId} appears stalled (${activity.lastActivitySeconds}s) but has active session monitor — deferring to Claude`);
        // Still emit the warning event so Claude's heartbeat picks it up
        try {
          const { taskEvents } = require('../hooks/event-dispatch');
          taskEvents.emit('task:stall_warning', {
            taskId,
            provider: proc?.provider || 'unknown',
            elapsed: activity.lastActivitySeconds,
            threshold: Math.round(activity.stallThreshold || 0),
            description: proc?.description || '',
            deferred_to_session: true,
          });
        } catch { /* non-fatal */ }
        continue;
      }

      stalledTasks.push({
        taskId,
        lastActivitySeconds: activity.lastActivitySeconds
      });

      if (autoCancel) {
        // Try recovery if enabled, otherwise direct cancel
        if (recoveryEnabled) {
          tryStallRecovery(taskId, activity);
        } else {
          logger.info(`[Heartbeat] Auto-cancelling stalled task ${taskId} (no output for ${activity.lastActivitySeconds}s)`);
          cancelTask(taskId, `Stalled - no output for ${activity.lastActivitySeconds}s`, { cancel_reason: 'stall' });
        }
      }
    }
  }
  return stalledTasks;
}

// ============================================================
// Host Failover Cleanup
// ============================================================

/**
 * Cleanup orphaned tasks when a host goes down mid-task.
 * Marks running tasks on the failed host as failed and triggers retry via provider fallback.
 * @param {string} hostId - The host ID that went down
 * @param {string} hostName - The host name for logging
 * @returns {void}
 */
function cleanupOrphanedHostTasks(hostId, hostName) {
  try {
    const orphanedTasks = db.getRunningTasksForHost(hostId);
    if (!orphanedTasks || orphanedTasks.length === 0) {
      return;
    }

    logger.info(`[Host Failover] Host '${hostName}' went down with ${orphanedTasks.length} running task(s)`);

    for (const task of orphanedTasks) {
      // Remove from runningProcesses if present (process may have already exited)
      const proc = runningProcesses.get(task.id);
      if (proc) {
        // Clear timeouts
        if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
        if (proc.startupTimeoutHandle) clearTimeout(proc.startupTimeoutHandle);
        runningProcesses.delete(task.id);
        stallRecoveryAttempts.delete(task.id);
        _stallWarningEmitted.delete(task.id);
      }

      // Mark task as failed with clear error message.
      const errorMessage = `Host '${hostName}' became unavailable while task was running`;
      db.updateTaskStatus(task.id, 'failed', {
        error_output: (task.error_output || '') + `\n[HOST FAILOVER] ${errorMessage}\n`,
        completed_at: new Date().toISOString(),
      });

      logger.info(`[Host Failover] Task ${task.id} marked as failed due to host '${hostName}' going down`);

      // Check if task should be retried via local-first fallback
      try {
        const retryInfo = db.incrementRetry(task.id);
        if (retryInfo && retryInfo.shouldRetry) {
          tryLocalFirstFallback(task.id, task, `Host '${hostName}' went down`);
          logger.info(`[Host Failover] Task ${task.id} queued for local-first retry`);
        }
      } catch (retryErr) {
        logger.info(`[Host Failover] Failed to setup retry for task ${task.id}: ${retryErr.message}`);
      }

      if (dashboard) dashboard.notifyTaskUpdated(task.id);
    }

    // Process queue to pick up any retried tasks
    processQueue();
  } catch (err) {
    logger.info(`[Host Failover] Error cleaning up orphaned tasks for host '${hostName}': ${err.message}`);
  }
}

// ============================================================
// Stall Threshold Calculation
// ============================================================

/**
 * Calculate dynamic stall threshold based on model size and provider.
 * Priority: runtime config override > model-size heuristic > provider default > base.
 * @param {string} model - Model name (e.g., "some-model:32b")
 * @param {string} provider - Provider name (e.g., "ollama")
 * @returns {number|null} Stall threshold in seconds, or null if stall detection disabled for provider
 */
function getStallThreshold(model, provider) {
  // Check runtime config override first (set by configure_stall_detection tool)
  const configKey = PROVIDER_STALL_CONFIG_KEYS[provider];
  if (configKey) {
    const configValue = serverConfig.get(configKey);
    if (configValue === 'null') return null;  // Explicitly disabled
    if (configValue === '0') return null;     // Explicitly disabled
    if (configValue && configValue !== 'null') {
      const override = parseInt(configValue, 10);
      if (!isNaN(override) && override > 0) {
        return override;  // Runtime override takes priority
      }
    }
  }

  // Check if stall detection is disabled for this provider
  if (PROVIDER_STALL_THRESHOLDS[provider] === null) {
    return null; // Stall detection disabled
  }

  // Get provider-specific base threshold
  const threshold = PROVIDER_STALL_THRESHOLDS[provider] || BASE_STALL_THRESHOLD_SECONDS;

  if (!model) return threshold;

  const modelLower = model.toLowerCase();

  // Thinking models (qwen3, deepseek-r1) generate invisible <think> blocks before responding.
  // This thinking phase produces no stdout output, so stall detection must be more lenient.
  // Ollama's think:false parameter isn't accessible through Aider/litellm (P60).
  const isThinkingModel = /^(qwen3|deepseek-r1)/i.test(model);
  const thinkingMultiplier = isThinkingModel ? 1.5 : 1;

  const modelSizeB = parseModelSizeB(model);
  if (modelSizeB >= 32) return Math.round(Math.max(threshold, 360) * thinkingMultiplier);
  if (modelSizeB >= 15 && modelSizeB <= 25) return Math.round(300 * thinkingMultiplier);
  if (modelSizeB >= 14) return Math.round(Math.max(threshold, 240) * thinkingMultiplier);
  if (modelSizeB >= 8) return Math.round(Math.max(threshold, 210) * thinkingMultiplier);

  // Check for large model indicators in name
  if (modelLower.includes('70b') || modelLower.includes('65b')) return Math.round(420 * thinkingMultiplier);
  if (modelLower.includes('32b') || modelLower.includes('34b')) return Math.round(360 * thinkingMultiplier);

  return threshold;
}

// ============================================================
// Timer Management
// ============================================================

/**
 * Start all periodic cleanup timers.
 * Called from task-manager init() after dependencies are available.
 */
function startTimers() {
  if (timersStarted) return;
  timersStarted = true;

  // Run initial cleanups immediately
  cleanupOrphanedDotnetProcesses();

  // Periodic dotnet cleanup every 5 minutes
  dotnetCleanupInterval = setInterval(cleanupOrphanedDotnetProcesses, 5 * 60 * 1000);
  dotnetCleanupInterval.unref();

  // Stale task check every 2 minutes
  staleCheckInterval = setInterval(checkStaleRunningTasks, 2 * 60 * 1000);
  staleCheckInterval.unref();

  // Zombie process check every 30 seconds
  zombieCheckInterval = setInterval(checkZombieProcesses, 30 * 1000);
  zombieCheckInterval.unref();

  // Also run stale check once on startup after a short delay
  staleCheckTimeout = setTimeout(checkStaleRunningTasks, 10000);
  staleCheckTimeout.unref();

  // Dead instance locks can still look fresh for ~30s right after a restart.
  // Run a second pass after that freshness window so orphaned running tasks
  // do not occupy slots until the regular 2-minute sweep.
  staleOwnerRecoveryTimeout = setTimeout(checkStaleRunningTasks, 45000);
  staleOwnerRecoveryTimeout.unref();

  // Auto-cancel stalled tasks every 60 seconds
  stallCheckInterval = setInterval(() => {
    const autoCancel = serverConfig.getBool('auto_cancel_stalled');
    if (autoCancel) {
      checkStalledTasks(true);
    }
  }, 60 * 1000);
  stallCheckInterval.unref();
}

/**
 * Stop all periodic cleanup timers.
 * Called from task-manager shutdown().
 */
function stopTimers() {
  if (dotnetCleanupInterval) clearInterval(dotnetCleanupInterval);
  if (staleCheckInterval) clearInterval(staleCheckInterval);
  if (zombieCheckInterval) clearInterval(zombieCheckInterval);
  if (stallCheckInterval) clearInterval(stallCheckInterval);
  if (staleCheckTimeout) clearTimeout(staleCheckTimeout);
  if (staleOwnerRecoveryTimeout) clearTimeout(staleOwnerRecoveryTimeout);
  dotnetCleanupInterval = null;
  staleCheckInterval = null;
  zombieCheckInterval = null;
  stallCheckInterval = null;
  staleCheckTimeout = null;
  staleOwnerRecoveryTimeout = null;
  timersStarted = false;
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize the orphan cleanup module with dependencies.
 * @param {Object} deps - Dependencies from task-manager.js
 */
let finalizingTasks = null;

function getFinalizingMarker(taskId) {
  if (!finalizingTasks) return null;
  if (typeof finalizingTasks.get === 'function') {
    const marker = finalizingTasks.get(taskId);
    return marker === undefined ? null : marker;
  }
  return typeof finalizingTasks.has === 'function' && finalizingTasks.has(taskId)
    ? true
    : null;
}

function shouldSkipFinalizingTask(task) {
  const marker = getFinalizingMarker(task.id);
  if (!marker) return false;

  if (marker === true || typeof marker !== 'object') {
    return true;
  }

  const lastActivityAt = Number(marker.lastActivityAt || marker.startedAt || 0);
  const idleMs = Date.now() - lastActivityAt;
  const staleMs = Math.max(
    60 * 1000,
    serverConfig.getInt('finalizing_task_stale_minutes', 15) * 60 * 1000,
  );
  if (Number.isFinite(idleMs) && idleMs <= staleMs) {
    return true;
  }

  logger.info(`[Stale Check] Finalization marker for ${task.id} has been idle for ${Math.round(idleMs / 60000)}min at ${marker.stage || 'unknown'} - allowing orphan recovery`);
  try { finalizingTasks.delete?.(task.id); } catch { /* non-critical */ }
  return false;
}

function init(deps) {
  db = deps.db;
  serverConfig.init({ db: deps.db });
  dashboard = deps.dashboard;
  logger = deps.logger;

  // The three shared-state maps (running processes, finalizing markers,
  // stall recovery state) are owned by the DI container — pull them from
  // there so callers don't have to thread the same instance through
  // init() every time. Test fixtures that pass bare Maps via deps still
  // win, so the legacy override path is preserved.
  const { defaultContainer } = require('../container');
  const processTracker = deps.runningProcesses
    || defaultContainer.peek('processTracker')
    || null;
  runningProcesses = processTracker;
  stallRecoveryAttempts = deps.stallRecoveryAttempts
    || (processTracker && processTracker.stallAttempts)
    || null;
  finalizingTasks = deps.finalizingTasks
    || defaultContainer.peek('finalizationTracker')
    || null;

  TASK_TIMEOUTS = deps.TASK_TIMEOUTS;
  cancelTask = deps.cancelTask;
  processQueue = deps.processQueue;
  tryLocalFirstFallback = deps.tryLocalFirstFallback;
  getTaskActivity = deps.getTaskActivity;
  tryStallRecovery = deps.tryStallRecovery;
  detectOutputCompletion = deps.detectOutputCompletion;
  isInstanceAlive = deps.isInstanceAlive;
  getMcpInstanceId = deps.getMcpInstanceId;
  reportRuntimeTaskProblem = deps.reportRuntimeTaskProblem || null;
}

module.exports = {
  init,
  startTimers,
  stopTimers,
  // Cleanup functions
  cleanupOrphanedDotnetProcesses,
  checkStaleRunningTasks,
  checkZombieProcesses,
  checkStalledTasks,
  cleanupOrphanedHostTasks,
  // Stall threshold (used by getTaskActivity in task-manager.js)
  getStallThreshold,
  // Constants (exported for testing)
  BASE_STALL_THRESHOLD_SECONDS,
  PROVIDER_STALL_THRESHOLDS,
  PROVIDER_STALL_CONFIG_KEYS,
};
