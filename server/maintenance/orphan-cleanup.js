/**
 * Orphan Cleanup Module — Extracted from task-manager.js (Phase 5, Step 2)
 *
 * Handles cleanup of orphaned/zombie/stale processes and tasks:
 * - Orphaned aider processes from crashed sessions
 * - Orphaned dotnet processes from interrupted tests/builds
 * - Stale running tasks that exceeded timeout
 * - Zombie processes (close event never fired)
 * - Orphaned host tasks when a host goes down
 * - Stalled tasks (no output beyond threshold)
 *
 * Uses init() pattern for dependency injection.
 */

const { execFileSync } = require('child_process');
const { killProcessGraceful, killOrphanByPid } = require('../execution/process-lifecycle');
const serverConfig = require('../config');

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

// ---- Timer handles ----
let dotnetCleanupInterval = null;
let staleCheckInterval = null;
let zombieCheckInterval = null;
let stallCheckInterval = null;
let timersStarted = false;
let staleCheckTimeout = null;

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
  'aider-ollama': 300,      // 5 minutes - aider needs time for file analysis
  'hashline-ollama': 300,   // 5 minutes - hashline edits need similar time
  'ollama': 240,            // 4 minutes - direct API is faster
  'claude-cli': 600,        // 10 minutes - claude can be slow on complex tasks
  'codex': 600,             // 10 minutes - catches hung processes below 30-min hard timeout
  'anthropic': 300,         // 5 minutes - API can be slow
  'groq': 120,              // 2 minutes - groq is fast
  'ollama-cloud': 300,      // 5 minutes - cloud inference on large models
  'cerebras': 120,          // 2 minutes - cerebras is ultra-fast
  'google-ai': 180,         // 3 minutes - Gemini free tier
  'openrouter': 180,        // 3 minutes - varies by upstream model
};

// Map provider names to stall config keys (configure_stall_detection writes these)
const PROVIDER_STALL_CONFIG_KEYS = {
  'aider-ollama': 'stall_threshold_aider',
  'hashline-ollama': 'stall_threshold_aider',  // shares aider config
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

// Track tasks that have already received a stall warning (prevent duplicates)
const _stallWarningEmitted = new Set();

// ---- Zombie check state ----
let zombieCheckCycle = 0;

// ============================================================
// Orphaned Process Cleanup
// ============================================================

/**
 * Kill orphaned aider processes from previous crashed sessions
 * This prevents overloading Ollama when MCP crashes and restarts
 * Uses execFileSync (not execSync) to avoid shell injection vulnerabilities
 * Only kills processes NOT tracked in our runningProcesses map
 */
function cleanupOrphanedAiderProcesses() {
  try {
    let aiderPids = [];

    if (process.platform === 'win32') {
      // Windows: use WMIC to find aider processes
      // execFileSync with static args - no user input, safe from injection
      try {
        const result = execFileSync('wmic', [
          'process', 'where', 'name like \'%aider%\'', 'get', 'processid', '/format:list'
        ], { encoding: 'utf8', timeout: TASK_TIMEOUTS.PROCESS_QUERY });
        aiderPids = result.match(/ProcessId=(\d+)/g)?.map(m => parseInt(m.split('=')[1])) || [];
      } catch {
        // WMIC might not be available or no matches
      }
    } else {
      // Linux/Mac: use pgrep with execFileSync
      // Static pattern - no user input, safe from injection
      try {
        const result = execFileSync('pgrep', ['-f', 'aider.*--model.*ollama'], {
          encoding: 'utf8',
          timeout: TASK_TIMEOUTS.PROCESS_QUERY
        });
        aiderPids = result.trim().split('\n').filter(p => p).map(p => parseInt(p));
      } catch {
        // pgrep returns non-zero if no matches - this is expected
      }
    }

    // Filter out PIDs that are tracked in our runningProcesses map
    // These are legitimate running tasks, not orphans
    const trackedPids = new Set();
    for (const [_taskId, proc] of runningProcesses.entries()) {
      if (proc.process && proc.process.pid) {
        trackedPids.add(proc.process.pid);
      }
    }
    const orphanedPids = aiderPids.filter(pid => !trackedPids.has(pid));

    if (orphanedPids.length > 0) {
      logger.info(`[Cleanup] Found ${orphanedPids.length} orphaned aider process(es): ${orphanedPids.join(', ')}`);

      for (const pid of orphanedPids) {
        killOrphanByPid(pid, `aider-orphan-${pid}`, 2000, 'AiderOrphan');
      }
    }
    // Don't log if no orphans - it's noisy
  } catch (err) {
    logger.info(`[Cleanup] Error cleaning up orphaned processes: ${err.message}`);
  }
}

/**
 * Kill orphaned dotnet processes from previous crashed sessions
 * This prevents .NET processes from accumulating when tests/builds are interrupted
 * Uses execFileSync (not execSync) to avoid shell injection vulnerabilities
 * Only kills processes NOT tracked in our runningProcesses map
 */
function cleanupOrphanedDotnetProcesses() {
  try {
    let dotnetPids = [];

    if (process.platform === 'win32') {
      // Windows: use WMIC to find dotnet processes
      try {
        const result = execFileSync('wmic', [
          'process', 'where', 'name like \'%dotnet%\'', 'get', 'processid,commandline', '/format:list'
        ], { encoding: 'utf8', timeout: TASK_TIMEOUTS.PROCESS_QUERY });
        // Parse PIDs from WMIC output, filtering for test/build processes
        const lines = result.split('\n');
        let currentPid = null;
        let currentCmd = '';
        for (const line of lines) {
          if (line.startsWith('CommandLine=')) {
            currentCmd = line.slice(12).toLowerCase();
          } else if (line.startsWith('ProcessId=')) {
            currentPid = parseInt(line.slice(10));
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
      // Linux/Mac (including WSL): use pgrep with execFileSync
      // Target dotnet test, build, and run processes
      const patterns = ['dotnet.*test', 'dotnet.*build', 'dotnet.*run'];
      for (const pattern of patterns) {
        try {
          const result = execFileSync('pgrep', ['-f', pattern], {
            encoding: 'utf8',
            timeout: TASK_TIMEOUTS.PROCESS_QUERY
          });
          const pids = result.trim().split('\n').filter(p => p).map(p => parseInt(p));
          dotnetPids.push(...pids);
        } catch {
          // pgrep returns non-zero if no matches - this is expected
        }
      }
      // Deduplicate PIDs
      dotnetPids = [...new Set(dotnetPids)];
    }

    // Filter out PIDs that are tracked in our runningProcesses map
    // These are legitimate running tasks, not orphans
    const trackedPids = new Set();
    for (const [_taskId, proc] of runningProcesses.entries()) {
      if (proc.process && proc.process.pid) {
        trackedPids.add(proc.process.pid);
      }
    }
    const orphanedPids = dotnetPids.filter(pid => !trackedPids.has(pid));

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

    for (const task of runningTasks) {
      if (!task.started_at) continue;

      const elapsedMs = Date.now() - new Date(task.started_at).getTime();
      const timeoutMs = (task.timeout_minutes || 30) * 60 * 1000;

      if (elapsedMs > timeoutMs) {
        const elapsedMin = Math.round(elapsedMs / 60000);
        logger.info(`[Stale Check] Task ${task.id} has been running for ${elapsedMin}min (timeout: ${task.timeout_minutes || 30}min) - cancelling`);

        // Cancel via cancelTask if process is tracked, otherwise update DB directly
        if (runningProcesses.has(task.id)) {
          cancelTask(task.id, 'Timeout exceeded (stale check)');
        } else {
          // Process not tracked (server restarted) - update DB directly
          db.updateTaskStatus(task.id, 'cancelled', {
            error_output: `Auto-cancelled: Task exceeded ${task.timeout_minutes || 30} minute timeout (detected by stale check)`
          });
          // Reconcile again after direct DB update to fix host counts
          try {
            db.reconcileHostTaskCounts();
          } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    logger.info(`[Stale Check] Error: ${err.message} STACK: ${err.stack?.split('\n').slice(0, 5).join(' >> ')}`);
  }
}

/**
 * Check for zombie processes: tasks in 'running' state whose child process has
 * already exited but the 'close' event never fired (Windows .cmd wrapper issue).
 * Also detects tasks whose output signals completion but the process lingers.
 */
function checkZombieProcesses() {
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
          const result = execFileSync('tasklist', ['/FI', `PID eq ${proc.process.pid}`, '/NH', '/FO', 'CSV'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: TASK_TIMEOUTS.PROCESS_QUERY
          });
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
        } catch (e) {
          // Non-fatal
        }
      }
    }

    // isStalled is false if threshold is null (provider excluded)
    if (isStalled) {
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
          cancelTask(taskId, `Stalled - no output for ${activity.lastActivitySeconds}s`);
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

      // Mark task as failed with clear error message
      const errorMessage = `Host '${hostName}' became unavailable while task was running`;
      db.updateTaskStatus(task.id, 'failed', {
        error_output: (task.error_output || '') + `\n[HOST FAILOVER] ${errorMessage}\n`,
        completed_at: new Date().toISOString()
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
 * @param {string} model - Model name (e.g., "qwen2.5-coder:32b")
 * @param {string} provider - Provider name (e.g., "aider-ollama")
 * @returns {number|null} Stall threshold in seconds, or null if stall detection disabled for provider
 */
function getStallThreshold(model, provider) {
  // Check runtime config override first (set by configure_stall_detection tool)
  const configKey = PROVIDER_STALL_CONFIG_KEYS[provider];
  if (configKey) {
    const configValue = serverConfig.get(configKey);
    if (configValue && configValue !== 'null') {
      const override = parseInt(configValue, 10);
      if (!isNaN(override) && override > 0) {
        return override;  // Runtime override takes priority
      }
      if (configValue === '0' || configValue === 'null') {
        return null;  // Explicitly disabled via config
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

  // Extract size from model name (e.g., "32b" from "qwen2.5-coder:32b")
  const sizeMatch = modelLower.match(/:(\d+)b/);
  if (sizeMatch) {
    const sizeB = parseInt(sizeMatch[1], 10);
    // Scale threshold: 32b+ gets 6 min, 14b+ gets 4 min, 8b+ gets 3.5 min
    if (sizeB >= 32) return Math.round(Math.max(threshold, 360) * thinkingMultiplier);
    if (sizeB >= 14) return Math.round(Math.max(threshold, 240) * thinkingMultiplier);
    if (sizeB >= 8) return Math.round(Math.max(threshold, 210) * thinkingMultiplier);
  }

  // Check for large model indicators in name
  if (modelLower.includes('70b') || modelLower.includes('65b')) return Math.round(420 * thinkingMultiplier);
  if (modelLower.includes('32b') || modelLower.includes('34b')) return Math.round(360 * thinkingMultiplier);
  if (modelLower.includes('codestral') || modelLower.includes('22b')) return Math.round(300 * thinkingMultiplier);

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
  cleanupOrphanedAiderProcesses();
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
  dotnetCleanupInterval = null;
  staleCheckInterval = null;
  zombieCheckInterval = null;
  stallCheckInterval = null;
  staleCheckTimeout = null;
  timersStarted = false;
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize the orphan cleanup module with dependencies.
 * @param {Object} deps - Dependencies from task-manager.js
 */
function init(deps) {
  db = deps.db;
  serverConfig.init({ db: deps.db });
  dashboard = deps.dashboard;
  logger = deps.logger;
  runningProcesses = deps.runningProcesses;
  stallRecoveryAttempts = deps.stallRecoveryAttempts;
  TASK_TIMEOUTS = deps.TASK_TIMEOUTS;
  cancelTask = deps.cancelTask;
  processQueue = deps.processQueue;
  tryLocalFirstFallback = deps.tryLocalFirstFallback;
  getTaskActivity = deps.getTaskActivity;
  tryStallRecovery = deps.tryStallRecovery;
  detectOutputCompletion = deps.detectOutputCompletion;
}

module.exports = {
  init,
  startTimers,
  stopTimers,
  // Cleanup functions
  cleanupOrphanedAiderProcesses,
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
