#!/usr/bin/env node
/**
 * TORQUE MCP Server v2.0
 *
 * Multi-instance parallel task delegation to OpenAI Codex CLI.
 * Enables Claude to delegate tasks to Codex and continue working in parallel.
 *
 * Features:
 * - Async task submission (non-blocking)
 * - Multiple concurrent Codex instances
 * - Task queuing with priority
 * - Progress tracking
 * - SQLite persistence
 */

const readline = require('readline');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { defaultContainer } = require('./container');
const serverConfig = require('./config');
const taskManager = require('./task-manager');
const { TASK_TIMEOUTS } = require('./constants');
const dashboard = require('./dashboard-server');
const ciWatcher = require('./ci/watcher');
const apiServer = require('./api-server');
const mcpGateway = require('./mcp');
// Use dynamic accessors so hot-reload can refresh tools without full restart
function getTools() { return require('./tools').TOOLS; }
function callTool(name, args) { return require('./tools').handleToolCall(name, args); }
const discovery = require('./discovery');
const gpuMetricsServer = require('./scripts/gpu-metrics-server');
const mcpSse = require('./mcp-sse');
const { RemoteAgentRegistry } = require('./remote/agent-registry');
const { MCPPlatform, isPlatformEnabled } = require('./mcp/platform');
const logger = require('./logger').child({ component: 'mcp-stdio' });
const mcpProtocol = require('./mcp-protocol');
const timerRegistry = require('./timer-registry');
const eventBus = require('./event-bus');
const maintenanceScheduler = require('./maintenance/scheduler');

// Stored handler ref for shutdown listener deduplication across init() calls
let _shutdownHandler = null;

// Virtual session for stdio transport (single-client)
// stdio is a trusted local pipe — always considered authenticated
const stdioSession = { toolMode: 'core', authenticated: true };

// Remote agent registry — initialized in init() after DB is ready
let agentRegistry = null;
let mcpPlatform = null;

// Single source of truth — shared with mcp-sse.js
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');

// PID file for reliable external shutdown (written on startup, cleaned on shutdown)
// PID REUSE NOTE: On Linux, PIDs cycle through the available range (typically 32768).
// After a reboot, the OS assigns new PIDs starting from 1, and a stale PID from before
// the reboot could theoretically be reused by a completely different process. However:
//   1. The PID heartbeat (10s interval) detects this: a reused PID will not write our
//      JSON heartbeat format, so heartbeatAt will be stale (>30s) after one cycle.
//   2. The command-line check (wmic/ps) further verifies the process contains 'torque'.
//   3. Both guards must pass before any kill is attempted.
// The probability of PID reuse within the heartbeat stale window (30s) AND matching the
// 'torque' command-line check is astronomically low in practice (requires another node
// process running a torque-named script to claim the exact same PID within 30s of reboot).
const PID_FILE = path.join(db.getDataDir(), 'torque.pid');

// PID heartbeat — periodic updates prove the server is alive, not just started
const PID_HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds
const PID_HEARTBEAT_STALE_MS = 30000;    // 30 seconds — older = stale
let pidHeartbeatInterval = null;

/**
 * Parse a PID record from file content. Supports both JSON heartbeat format
 * and legacy raw PID number format.
 * @param {string} content - File content
 * @returns {{ pid: number, startedAt: string|null, heartbeatAt: string|null, isLegacy: boolean }}
 */
function parsePidRecord(content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return null;
  try {
    const record = JSON.parse(trimmed);
    if (record && typeof record.pid === 'number') {
      return { pid: record.pid, startedAt: record.startedAt || null, heartbeatAt: record.heartbeatAt || null, isLegacy: false };
    }
  } catch { /* not JSON — try legacy format */ }
  const pid = parseInt(trimmed, 10);
  if (!pid || isNaN(pid)) return null;
  return { pid, startedAt: null, heartbeatAt: null, isLegacy: true };
}

/**
 * Write a JSON PID record to the PID file.
 * @param {string} startedAt - ISO timestamp of server start
 */
function writePidRecord(startedAt) {
  const record = {
    pid: process.pid,
    startedAt,
    heartbeatAt: new Date().toISOString(),
  };
  fs.writeFileSync(PID_FILE, JSON.stringify(record), 'utf8');
}

/**
 * Start periodic heartbeat updates to the PID file.
 * @param {string} startedAt - ISO timestamp of server start
 */
function startPidHeartbeat(startedAt) {
  stopPidHeartbeat(); // clear any existing
  writePidRecord(startedAt);
  pidHeartbeatInterval = timerRegistry.trackInterval(setInterval(() => {
    try {
      writePidRecord(startedAt);
    } catch {
      // Non-fatal — PID file may be inaccessible
    }
  }, PID_HEARTBEAT_INTERVAL_MS));
  pidHeartbeatInterval.unref();
}

/**
 * Stop the PID heartbeat interval.
 */
function stopPidHeartbeat() {
  if (pidHeartbeatInterval) {
    timerRegistry.remove(pidHeartbeatInterval);
    clearInterval(pidHeartbeatInterval);
    pidHeartbeatInterval = null;
  }
}

/**
 * Write debug output through the structured logger.
 * @param {string} message - Message to log.
 * @returns {void}
 */
function debugLog(message) {
  logger.debug(message);
}

// MCP Protocol version
const JSONRPC_VERSION = '2.0';

// Track readline interface for cleanup on shutdown
let readlineInterface = null;

// Track shutdown state to prevent multiple shutdown attempts
let shutdownState = 'running'; // 'running' | 'shutting-down' | 'orphan-mode' | 'done'
let slotPullScheduler = null;
let shutdownTimer = null;

// Track if we're in orphan mode (MCP disconnected but tasks still running)
let _isOrphanMode = false;
let orphanCheckInterval = null;

// Track error rate cleanup interval for proper shutdown
let errorRateCleanupInterval = null;

// P91: Periodic queue processing interval (safety net for stuck tasks)
let queueProcessingInterval = null;

// Stdio heartbeat interval — keeps MCP connection alive during long idle periods
let stdioHeartbeatInterval = null;

// Track active requests for graceful shutdown
let activeRequestCount = 0;
const SHUTDOWN_TIMEOUT_MS = 5000; // Max wait time for in-flight requests

// Error rate limiting - track recent errors to prevent log flooding
const errorRateTracker = new Map();
const ERROR_RATE_WINDOW_MS = 60000; // 1 minute window
const ERROR_RATE_LIMIT = 10; // Max errors per window per error type

/**
 * Check if an error should be logged (rate limiting)
 * Returns true if error should be logged, false if rate limited
 */
function _shouldLogError(errorKey) {
  const now = Date.now();
  const tracker = errorRateTracker.get(errorKey);

  if (!tracker) {
    errorRateTracker.set(errorKey, { count: 1, firstSeen: now, lastLogged: now });
    return true;
  }

  // Reset if window expired
  if (now - tracker.firstSeen > ERROR_RATE_WINDOW_MS) {
    errorRateTracker.set(errorKey, { count: 1, firstSeen: now, lastLogged: now });
    return true;
  }

  tracker.count++;

  // Rate limit exceeded - log summary periodically
  if (tracker.count > ERROR_RATE_LIMIT) {
    if (now - tracker.lastLogged > 10000) { // Log summary every 10 seconds
      tracker.lastLogged = now;
      debugLog(`[Rate Limited] Error '${errorKey}' occurred ${tracker.count} times in last minute`);
    }
    return false;
  }

  return true;
}

// Lazy start for error rate cleanup (called from main() to avoid running at require-time)
function startErrorRateCleanup() {
  if (errorRateCleanupInterval) return;
  errorRateCleanupInterval = timerRegistry.trackInterval(setInterval(() => {
    const now = Date.now();
    for (const [key, tracker] of errorRateTracker) {
      if (now - tracker.firstSeen > ERROR_RATE_WINDOW_MS * 2) {
        errorRateTracker.delete(key);
      }
    }
  }, ERROR_RATE_WINDOW_MS));
  errorRateCleanupInterval.unref();
}

/**
 * Graceful shutdown handler - idempotent, can be called multiple times safely
 * Waits for in-flight requests to complete before closing resources
 * For stdin-close (MCP connection loss), keeps server alive to monitor running tasks
 */
async function gracefulShutdown(signal) {
  debugLog(`gracefulShutdown called with signal: ${signal}`);

  if (shutdownState === 'shutting-down' || shutdownState === 'done') {
    debugLog(`Shutdown already in progress (received ${signal})`);
    return;
  }
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  shutdownState = 'shutting-down';

  const isConnectionLoss = signal === 'stdin-close';

  // Stop CI watchers before shutdown
  try { ciWatcher.shutdownAll(); } catch { /* ok */ }

  // NOTE: Orphan mode disabled — server survives stdin close in headless mode (see line ~1396)
  if (isConnectionLoss) {
    debugLog(`MCP connection lost - checking for running tasks...`);
  } else {
    debugLog(`Shutting down TORQUE (${signal})...`);
  }

  // Wait for active requests to complete (with timeout)
  if (activeRequestCount > 0) {
    debugLog(`Waiting for ${activeRequestCount} active request(s) to complete...`);
    const startWait = Date.now();

    while (activeRequestCount > 0 && (Date.now() - startWait) < SHUTDOWN_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (activeRequestCount > 0) {
      debugLog(`Timeout: ${activeRequestCount} request(s) still active, proceeding with shutdown`);
    }
  }

  // For connection loss, check if there are running tasks and keep server alive
  if (isConnectionLoss) {
    const runningCount = taskManager.getRunningTaskCount();
    debugLog(`Connection loss: ${runningCount} task(s) currently running`);
    if (runningCount > 0) {
      debugLog(`Entering orphan mode - server will stay alive to monitor ${runningCount} task(s)`);

      // Close readline and stop heartbeat — stdin is gone
      if (readlineInterface) {
        readlineInterface.close();
        readlineInterface = null;
      }
      if (stdioHeartbeatInterval) {
        timerRegistry.remove(stdioHeartbeatInterval);
        clearInterval(stdioHeartbeatInterval);
        stdioHeartbeatInterval = null;
      }

      // Enter orphan mode - server stays alive to monitor running tasks
      _isOrphanMode = true;
      shutdownState = 'orphan-mode'; // Allow future shutdown attempts

      // Start periodic check to exit once all tasks complete
      if (!orphanCheckInterval) {
        orphanCheckInterval = timerRegistry.trackInterval(setInterval(() => {
          const currentRunning = taskManager.getRunningTaskCount();
          if (currentRunning === 0) {
            debugLog(`All tasks completed - exiting orphan mode`);
            timerRegistry.remove(orphanCheckInterval);
            clearInterval(orphanCheckInterval);
            orphanCheckInterval = null;
            _isOrphanMode = false;
            gracefulShutdown('orphan-complete');
          } else {
            debugLog(`[Orphan mode] ${currentRunning} task(s) still running...`);
          }
        }, 30000)); // Check every 30 seconds
        orphanCheckInterval.unref();
      }

      return;
    }
    debugLog(`No running tasks - proceeding with shutdown`);
  }

  const performShutdown = () => {
    try {
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
      // Stop PID heartbeat
      stopPidHeartbeat();
      // Clear all tracked intervals (maintenance, coordination, queue, quota, stdio heartbeat, orphan check, error rate)
      timerRegistry.clearAll();
      // Close readline interface to release stdin file descriptor and event listeners
      if (readlineInterface) {
        readlineInterface.close();
        readlineInterface = null;
      }
      // Clear error rate tracker to release memory
      errorRateTracker.clear();
      // Stop tsserver sessions
      try { require('./utils/tsserver-client').shutdownAll(); } catch (e) { debugLog(`tsserver shutdown: ${e.message}`); }
      // Stop MCP SSE transport
      mcpSse.stop();
      // Stop MCP gateway transport
      mcpGateway.stop();
      if (mcpPlatform) {
        mcpPlatform.stop();
        mcpPlatform = null;
      }
      // Stop GPU metrics server
      gpuMetricsServer.stop();
      // Stop LAN discovery
      discovery.stopAutoScan();
      discovery.shutdownDiscovery();
      // Stop dashboard and API servers
      dashboard.stop();
      apiServer.stop();
      if (slotPullScheduler && typeof slotPullScheduler.stopHeartbeat === 'function') {
        slotPullScheduler.stopHeartbeat();
      }
      // cancelTasks: true for explicit shutdown (SIGTERM, API), false for orphan-complete and stdin-close
      // Only cancel tasks on intentional shutdown (SIGINT/SIGTERM), not on connection loss or orphan-complete
      const cancelTasks = !isConnectionLoss && signal !== 'orphan-complete';
      taskManager.shutdown({ cancelTasks });
      // Unregister instance so sibling sessions know we're gone
      taskManager.unregisterInstance();
      db.close();
    } catch (err) {
      debugLog(`Shutdown error: ${err.message}`);
    } finally {
      // Always clean up PID file, even if shutdown had errors
      try { fs.unlinkSync(PID_FILE); } catch { /* may already be gone */ }
    }

    // If restart was requested, spawn a new server before exiting.
    // This runs AFTER all ports are closed and DB is shut down.
    if (process._torqueRestartPending) {
      try {
        const { spawn: spawnChild } = require('child_process');
        const serverScript = path.resolve(__dirname, 'index.js');
        const child = spawnChild(process.execPath, [serverScript], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: process.env, // same env — TORQUE_DATA_DIR etc. preserved
        });
        child.unref();
        debugLog(`[Restart] Spawned new server (PID ${child.pid})`);
      } catch (spawnErr) {
        debugLog(`[Restart] Failed to spawn: ${spawnErr.message}`);
      }
    }

    process.exit(signal === 'uncaughtException' ? 1 : 0);
  };

  // For non-connection-loss shutdowns, stop accepting new SSE/API requests first.
  // Give in-flight work a grace window, then force a full process stop.
  if (!isConnectionLoss) {
    if (typeof mcpSse.setShuttingDown === 'function') {
      mcpSse.setShuttingDown(true);
    }
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      performShutdown();
    }, SHUTDOWN_TIMEOUT_MS);
    return;
  }

  performShutdown();
}

/**
 * Check for and terminate a stale TORQUE server process from a prior session.
 * Uses the PID file to identify the previous instance rather than scanning
 * all node.exe processes with wmic (which is deprecated and Windows-only).
 *
 * Safety: Only kills the process if it matches the PID file AND is not the
 * current process. Does not blindly kill all node processes.
 */
function killStaleInstance() {
  try {
    if (!fs.existsSync(PID_FILE)) return;

    const content = fs.readFileSync(PID_FILE, 'utf8');
    const record = parsePidRecord(content);
    if (!record || !record.pid || record.pid === process.pid) return;

    const oldPid = record.pid;

    // Check if the old process is still running
    try {
      process.kill(oldPid, 0); // Signal 0 = existence check, doesn't kill
    } catch {
      // Process not running — clean up stale PID file
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      return;
    }

    // Process is alive — check heartbeat freshness (JSON format only)
    if (!record.isLegacy && record.heartbeatAt) {
      const heartbeatAge = Date.now() - new Date(record.heartbeatAt).getTime();
      if (heartbeatAge < PID_HEARTBEAT_STALE_MS) {
        // Heartbeat is recent — process is actively running, don't kill
        process.stderr.write(`[TORQUE] Kill guard: PID ${oldPid} heartbeat is recent (${Math.round(heartbeatAge / 1000)}s ago), skipping\n`);
        return;
      }
    }
    // Legacy format (raw PID) or stale heartbeat — treat as stale, proceed with kill

    // Verify the stale PID is still the same TORQUE process before killing.
    // On Windows, tasklist only shows the image name ("node.exe") — not the script path.
    // Use wmic to get the full CommandLine so we can match against the TORQUE script path
    // and avoid killing unrelated node.exe processes. oldPid is a parsed integer so safe.
    try {
      let commandLine;
      if (process.platform === 'win32') {
        // wmic reports the full CommandLine including the script path.
        // execFileSync avoids shell injection risk (args passed as array).
        commandLine = childProcess.execFileSync('wmic', [
          'process', 'where', `ProcessId=${oldPid}`, 'get', 'CommandLine', '/format:list',
        ], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
      } else {
        commandLine = String(childProcess.execSync(`ps -p ${oldPid} -o args=`, { encoding: 'utf8' }));
      }
      commandLine = String(commandLine).toLowerCase();

      // Require both 'node' and 'torque' in the command line to avoid false-positive kills.
      // A node.exe process unrelated to TORQUE will not contain 'torque' in its args.
      const isTorqueProcess = commandLine.includes('node') && commandLine.includes('torque');
      if (!isTorqueProcess) {
        process.stderr.write(`[TORQUE] Kill guard: PID ${oldPid} now maps to non-TORQUE process, skipping stale cleanup\n`);
        return;
      }
    } catch {
      process.stderr.write(`[TORQUE] Kill guard: PID ${oldPid} command-line lookup failed, skipping stale cleanup\n`);
      return;
    }

    // Terminate the stale process
    try {
      if (process.platform === 'win32') {
        childProcess.execFileSync('taskkill', ['/PID', String(oldPid), '/F'], {
          timeout: TASK_TIMEOUTS.HEALTH_CHECK,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        process.kill(oldPid, 'SIGTERM');
      }
      process.stderr.write(`[TORQUE] Kill guard: terminated stale instance (PID ${oldPid})\n`);
    } catch {
      // Process may have exited between check and kill — ignore
    }

    // Clean up the old PID file (we'll write ours later)
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  } catch {
    // Non-fatal — PID file may be corrupt or inaccessible
  }
}

/**
 * Initialize the server
 */
function init() {
  // Kill guard: terminate stale TORQUE instance from a prior session (PID-file based).
  // Without this, stale instances from prior sessions can overwrite files with old code.
  killStaleInstance();

  if (isPlatformEnabled(process.env)) {
    try {
      if (!mcpPlatform) {
        mcpPlatform = new MCPPlatform();
      }
      mcpPlatform.init();
      debugLog('MCP platform initialized');
    } catch (err) {
      mcpPlatform = null;
      debugLog(`MCP platform failed to initialize: ${err.message}`);
    }
  } else {
    if (mcpPlatform) {
      mcpPlatform.stop();
      mcpPlatform = null;
    }
    debugLog('MCP platform is disabled (set TORQUE_MCP_PLATFORM_ENABLED=1 to enable)');
  }

  // Initialize database
  db.init();

  // Auth system initialization — migrate legacy keys, bootstrap first-run admin key
  try {
    const keyManager = require('./auth/key-manager');
    keyManager.init(db.getDbInstance());
    keyManager.migrateConfigApiKey(); // migrate existing config.api_key if present

    const userManager = require('./auth/user-manager');
    userManager.init(db.getDbInstance());

    // Defense-in-depth: remove stale config.api_key if new auth system has keys
    try {
      const dbInst = db.getDbInstance();
      const legacyKey = dbInst.prepare("SELECT value FROM config WHERE key = 'api_key'").get();
      if (legacyKey && keyManager.hasAnyKeys()) {
        dbInst.prepare("DELETE FROM config WHERE key = 'api_key'").run();
      }
    } catch {}

    if (!keyManager.hasAnyKeys() && !userManager.hasAnyUsers()) {
      const { key } = keyManager.createKey({ name: 'Bootstrap admin key', role: 'admin' });
      // Write key to a file so Claude Code (and the user) can find it.
      // The server often starts via nohup > /dev/null, so console output is lost.
      const keyFilePath = path.join(db.getDataDir(), '.torque-api-key');
      try {
        fs.writeFileSync(keyFilePath, key, { mode: 0o600 });
        debugLog(`Bootstrap API key written to ${keyFilePath}`);
      } catch (writeErr) {
        debugLog(`Could not write key file: ${writeErr.message}`);
      }
      console.log('\u2550'.repeat(59));
      console.log('  TORQUE Admin API Key (save this \u2014 it won\'t be shown again):');
      console.log('');
      console.log(`  ${key}`);
      console.log('');
      console.log('  Set as environment variable:');
      console.log(`  export TORQUE_API_KEY="${key}"`);
      console.log('');
      console.log(`  Key also saved to: ${keyFilePath}`);
      console.log('\u2550'.repeat(59));
    }
  } catch (err) {
    debugLog(`Auth initialization error: ${err.message}`);
  }

  // Register core singletons with DI container
  if (!defaultContainer.has('db')) {
    defaultContainer.registerValue('db', db);
    defaultContainer.registerValue('eventBus', eventBus);
    defaultContainer.registerValue('logger', logger);
    defaultContainer.registerValue('serverConfig', serverConfig);
    defaultContainer.registerValue('taskManager', taskManager);
    defaultContainer.registerValue('dashboard', dashboard);
  }

  // Initialize task-manager early deps (provider registry, config) now that DB is ready.
  // initSubModules() wires the extracted module graph; must run before queue processing.
  taskManager.initEarlyDeps();
  taskManager.initSubModules();
  serverConfig.init({ db });
  slotPullScheduler = require('./execution/slot-pull-scheduler');
  slotPullScheduler.init({
    db,
    startTask: taskManager.startTask.bind(taskManager),
    dashboard,
  });
  if (db.getConfig('scheduling_mode') === 'slot-pull') {
    slotPullScheduler.startHeartbeat();
    logger.info('Slot-pull scheduler active');
  } else if (typeof slotPullScheduler.stopHeartbeat === 'function') {
    slotPullScheduler.stopHeartbeat();
  }

  // Boot the DI container — makes registered services available via container.get()
  // boot() is internally idempotent — safe to call multiple times
  try {
    defaultContainer.boot();
  } catch (err) {
    logger.error(`Container boot failed: ${err.message}`);
    // Non-fatal during migration — existing require() paths still work
  }

  // Migrate legacy config keys (ollama_model, hashline_capable_models, etc.) into
  // model_roles and model_capabilities. Idempotent — safe on every startup.
  try {
    const { migrateConfigToRegistry } = require('./discovery/config-migrator');
    migrateConfigToRegistry(db.getDbInstance());
  } catch (err) {
    logger.warn(`Config-to-registry migration: ${err.message}`);
  }

  // Initialize remote agent registry (needs raw better-sqlite3 instance)
  agentRegistry = new RemoteAgentRegistry(db.getDbInstance());

  // Pass agentRegistry to auto-verify-retry for remote test routing
  require('./validation/auto-verify-retry').init({ agentRegistry });

  // Register this MCP instance for multi-session coordination
  taskManager.registerInstance();
  taskManager.startInstanceHeartbeat();

  // Instance-aware orphan cleanup — distinguishes tasks from crashed instances vs active siblings
  try {
    const runningTasks = db.listTasks({ status: 'running', limit: 1000 });
    const now = Date.now();
    const GRACE_PERIOD_MS = 30000; // 30 seconds grace period for startup race conditions
    let orphansCleaned = 0;
    const markStartupOrphanFailed = (task, updates) => {
      db.updateTaskStatus(task.id, 'failed', updates);
      if (task.ollama_host_id) {
        try { db.decrementHostTasks(task.ollama_host_id); } catch { /* host may not exist */ }
      }
      try {
        const { handleWorkflowTermination } = require('./execution/workflow-runtime');
        if (typeof handleWorkflowTermination === 'function') {
          handleWorkflowTermination(task.id);
        }
      } catch (workflowErr) {
        debugLog(`Startup orphan cleanup workflow bookkeeping error for ${task.id}: ${workflowErr.message}`);
      }
      orphansCleaned++;
    };

    for (const task of runningTasks) {
      const startedAt = task.started_at ? new Date(task.started_at).getTime() : 0;
      const runningTime = now - startedAt;
      const timeoutMs = (task.timeout_minutes || 30) * 60 * 1000;

      if (!task.mcp_instance_id) {
        // Legacy task with no owner — use grace period + timeout logic
        if (runningTime > Math.max(GRACE_PERIOD_MS, timeoutMs)) {
          markStartupOrphanFailed(task, {
            error_output: 'Server restarted - task was interrupted (stale, no instance owner)'
          });
        }
      } else if (task.mcp_instance_id === taskManager.getMcpInstanceId()) {
        // Our task but not in runningProcesses — leftover from our own crash/restart
        if (!taskManager.hasRunningProcess(task.id)) {
          markStartupOrphanFailed(task, {
            error_output: 'Server restarted — task orphaned from previous instance',
            completed_at: new Date().toISOString()
          });
        }
      } else {
        // Task owned by another instance — check if that instance is alive
        if (!taskManager.isInstanceAlive(task.mcp_instance_id)) {
          // Use the task's own timeout as the grace period — Codex tasks run externally
          // and may take 5-15 minutes; the 30s startup grace is too aggressive.
          // Only orphan if running time exceeds the task timeout.
          if (runningTime > timeoutMs) {
            // Auto-requeue orphaned tasks instead of failing — the work was interrupted
            // by a dead MCP session, not by a code error. A fresh attempt will likely succeed.
            const retryCount = task.retry_count || 0;
            const maxRetries = task.max_retries != null ? task.max_retries : 2;
            if (retryCount < maxRetries) {
              debugLog(`Orphaned task ${task.id} from dead instance ${task.mcp_instance_id} — requeuing (attempt ${retryCount + 1}/${maxRetries})`);
              db.updateTaskStatus(task.id, 'queued', {
                error_output: `Task requeued — owning instance ${task.mcp_instance_id} is no longer alive (auto-retry ${retryCount + 1}/${maxRetries})`,
                retry_count: retryCount + 1,
                mcp_instance_id: null, // Clear owner so any instance can pick it up
                provider: null, // Clear provider so routing can re-evaluate
              });
              if (task.ollama_host_id) {
                try { db.decrementHostTasks(task.ollama_host_id); } catch { /* host may not exist */ }
              }
              orphansCleaned++;
            } else {
              markStartupOrphanFailed(task, {
                error_output: `Task orphaned — owning instance ${task.mcp_instance_id} is no longer alive (max retries exhausted)`,
                completed_at: new Date().toISOString()
              });
            }
          }
        }
        // Instance is alive — leave task alone, sibling session is handling it
      }
    }
    if (orphansCleaned > 0) {
      debugLog(`Startup cleanup: marked ${orphansCleaned} orphaned tasks as failed`);
    }
  } catch (err) {
    debugLog(`Startup orphan cleanup error: ${err.message}`);
  }

  // Clean up orphaned git worktrees from previous crashed server runs
  try {
    const { cleanupOrphanedWorktrees } = require('./utils/git-worktree');
    cleanupOrphanedWorktrees();
  } catch (err) {
    debugLog(`Startup worktree cleanup error: ${err.message}`);
  }

  // Wire free-tier quota tracker to REST API and dashboard routes
  const apiServerCore = require('./api-server.core');
  if (apiServerCore.setFreeTierTrackerGetter && taskManager.getFreeQuotaTracker) {
    apiServerCore.setFreeTierTrackerGetter(taskManager.getFreeQuotaTracker);
  }
  try {
    const analyticsRoutes = require('./dashboard/routes/analytics');
    if (analyticsRoutes.setFreeTierTrackerGetter && taskManager.getFreeQuotaTracker) {
      analyticsRoutes.setFreeTierTrackerGetter(taskManager.getFreeQuotaTracker);
    }
  } catch (_e) { void _e; }

  // Process any queued tasks
  taskManager.processQueue();

  // Start the 30-second queue poll interval (previously ran at require()-time).
  taskManager.startQueuePoll();

  // P91: Start periodic queue processing as safety net.
  // Event-driven processQueue() calls can silently fail (lock contention,
  // timing issues with async handlers). This interval ensures queued tasks
  // are never permanently stuck. Most tasks are still started by event-driven
  // calls; this is a fallback for missed events.
  if (queueProcessingInterval) {
    timerRegistry.remove(queueProcessingInterval);
    clearInterval(queueProcessingInterval);
  }
  queueProcessingInterval = timerRegistry.trackInterval(setInterval(() => {
    try {
      const queuedCount = db.listTasks({ status: 'queued', limit: 1 }).length;
      if (queuedCount > 0) {
        taskManager.processQueue();
      }
    } catch {
      // Don't let queue check errors crash the server
    }
  }, 5000)); // Check every 5 seconds
  queueProcessingInterval.unref();

  // Reactivate CI watches — individual watches are activated via watchRepo(),
  // there is no top-level init() export.
  try {
    const activeWatches = db.listActiveCiWatches ? db.listActiveCiWatches() : [];
    for (const watch of activeWatches) {
      ciWatcher.watchRepo({ repo: watch.repo, provider: watch.provider, branch: watch.branch, poll_interval_ms: watch.poll_interval_ms });
    }
    if (db.pruneCiRunCache) db.pruneCiRunCache(7);
  } catch (e) { debugLog(`CI watcher reactivation: ${e.message}`); }

  // Initialize and start maintenance schedulers (extracted to maintenance/scheduler.js)
  maintenanceScheduler.init({
    db,
    serverConfig,
    debugLog,
    timerRegistry,
    logger,
    getAgentRegistry: () => agentRegistry,
  });
  startMaintenanceScheduler();

  // Start coordination scheduler (agent health, lease expiry, lock cleanup)
  startCoordinationScheduler();

  // Refresh quota state for providers that do not expose rate-limit headers.
  startProviderQuotaInferenceTimer();

  // Auto-start dashboard (doesn't open browser automatically)
  const dashboardPort = serverConfig.getInt('dashboard_port', 3456);
  dashboard.start({ port: dashboardPort, openBrowser: false, taskManager }).then(dashResult => {
    if (dashResult.success) {
      debugLog(`Dashboard auto-started at ${dashResult.url}`);
      // Store the actual dashboard port in the instance lock so sibling sessions can discover it
      taskManager.updateInstanceInfo({ port: dashResult.port });
    }
  }).catch(err => {
    debugLog(`Dashboard failed to start: ${err.message}`);
    process.stderr.write(`[TORQUE] Dashboard failed to start: ${err.message}\n`);
  });

  // Auto-start REST API server and MCP SSE transport.
  // If BOTH critical transports fail to bind, exit to avoid zombie processes.
  let apiStarted = false;
  let sseStarted = false;

  function checkCriticalPorts() {
    // Called after both API and SSE attempts resolve.
    // If neither bound successfully, this process is a zombie — exit.
    if (!apiStarted && !sseStarted) {
      process.stderr.write(
        `[TORQUE] FATAL: Both API (${serverConfig.getInt('api_port', 3457)}) and SSE (${serverConfig.getInt('mcp_sse_port', 3458)}) ports failed to bind.\n` +
        `[TORQUE] Another TORQUE instance is likely running. Exiting to avoid zombie process.\n` +
        `[TORQUE] Run: bash stop-torque.sh --force\n`
      );
      process.exit(1);
    }
  }

  const apiPort = serverConfig.getInt('api_port', 3457);
  const apiPromise = apiServer.start({ port: apiPort, taskManager }).then(apiResult => {
    if (apiResult.success) {
      apiStarted = true;
      debugLog(`REST API auto-started at http://127.0.0.1:${apiResult.port}`);
    }
  }).catch(err => {
    debugLog(`REST API failed to start: ${err.message}`);
    process.stderr.write(`[TORQUE] REST API failed to start: ${err.message}\n`);
  });

  // Auto-start MCP SSE transport (for plugin-based connections that survive context rollovers)
  const ssePort = serverConfig.getInt('mcp_sse_port', 3458);
  const ssePromise = mcpSse.start({ port: ssePort }).then(sseResult => {
    if (sseResult.success) {
      sseStarted = true;
      debugLog(`MCP SSE transport started at http://127.0.0.1:${sseResult.port}/sse`);
    }
  }).catch(err => {
    debugLog(`MCP SSE transport failed to start: ${err.message}`);
    process.stderr.write(`[TORQUE] MCP SSE transport failed to start: ${err.message}\n`);
  });

  // After both port binding attempts resolve, check if we're a zombie
  Promise.allSettled([apiPromise, ssePromise]).then(checkCriticalPorts);

  const enableMcpGateway = String(process.env.TORQUE_ENABLE_MCP_GATEWAY || '').toLowerCase();
  if (enableMcpGateway === '1' || enableMcpGateway === 'true' || enableMcpGateway === 'yes' || enableMcpGateway === 'on') {
    const mcpGatewayPort = serverConfig.getInt('mcp_gateway_port', 3459);
    mcpGateway.start({ port: mcpGatewayPort }).then(result => {
      if (result.success) {
        debugLog(`MCP gateway started at http://127.0.0.1:${result.port}`);
      } else {
        debugLog(`MCP gateway not started: ${result.error || result.message || 'unknown reason'}`);
      }
    }).catch(err => {
      debugLog(`MCP gateway failed to start: ${err.message}`);
      process.stderr.write(`[TORQUE] MCP gateway failed to start: ${err.message}\n`);
    });
  } else {
    debugLog('MCP gateway is disabled (set TORQUE_ENABLE_MCP_GATEWAY=1 to enable)');
  }

  // Initialize LAN discovery (mDNS + auto-scan)
  try {
    discovery.initDiscovery();
    discovery.initAutoScanFromConfig();
    debugLog('LAN discovery initialized');
  } catch (err) {
    debugLog(`LAN discovery failed to initialize: ${err.message}`);
  }

  // Auto-start GPU metrics server (serves nvidia-smi data for remote dashboard polling)
  const gpuMetricsPort = serverConfig.getInt('gpu_metrics_port', 9394);
  gpuMetricsServer.start({ port: gpuMetricsPort }).then(result => {
    if (result.success) {
      debugLog(`GPU metrics server started on port ${result.port} (hasGpu: ${result.hasGpu})`);
    } else {
      debugLog(`GPU metrics server not started (hasGpu: ${result.hasGpu})`);
    }
  }).catch(err => {
    debugLog(`GPU metrics server failed to start: ${err.message}`);
    process.stderr.write(`[TORQUE] GPU metrics server failed to start: ${err.message}\n`);
  });

  // Write PID file with JSON heartbeat format and start periodic updates
  const startedAt = new Date().toISOString();
  try {
    startPidHeartbeat(startedAt);
    debugLog(`PID heartbeat started: ${PID_FILE} (pid=${process.pid})`);
  } catch (err) {
    debugLog(`Failed to write PID file: ${err.message}`);
  }

  // Initialize shared MCP protocol handler (used by both stdio and SSE transports)
  mcpProtocol.init({
    tools: getTools(),
    coreToolNames: CORE_TOOL_NAMES,
    extendedToolNames: EXTENDED_TOOL_NAMES,
    handleToolCall: async (name, args, _session) => callTool(name, args),
  });

  // Listen for shutdown event from tools.js (e.g., restart_server)
  // This avoids circular dependency between tools.js and index.js
  // Remove previous handler to prevent accumulation on repeated init() calls
  if (_shutdownHandler) {
    eventBus.removeListener('shutdown', _shutdownHandler);
  }
  _shutdownHandler = (reason) => {
    debugLog(`torque:shutdown event received: ${reason}`);
    gracefulShutdown(reason || 'torque:shutdown');
  };
  eventBus.onShutdown(_shutdownHandler);

  // Log to stderr (not stdout which is for MCP protocol)
  debugLog('TORQUE MCP Server v2.0 started');
  debugLog(`Max concurrent tasks: ${serverConfig.get('max_concurrent')}`);
  debugLog(`PID: ${process.pid}, Instance: ${taskManager.getMcpInstanceId()}`);
}

// Maintenance, coordination, and budget schedulers — extracted to maintenance/scheduler.js
const { startMaintenanceScheduler, startCoordinationScheduler, startProviderQuotaInferenceTimer, getAutoArchiveStatuses } = maintenanceScheduler;

/**
 * Handle incoming JSON-RPC requests — thin stdio shim around shared mcp-protocol handler.
 * @param {object} request - JSON-RPC request payload.
 * @returns {Promise<object|null>} Response payload or null for notifications.
 */
async function handleRequest(request) {
  const result = await mcpProtocol.handleRequest(request, stdioSession);

  // Stdio transport-specific: send tools/list_changed notification on unlock
  if (stdioSession._toolsChanged) {
    stdioSession._toolsChanged = false;
    const notification = JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/tools/list_changed',
    }) + '\n';
    process.stdout.write(notification);
  }

  return result;
}

/**
 * Send JSON-RPC response
 * @param {string|number|null} id - JSON-RPC request identifier.
 * @param {object|null} result - JSON-RPC result payload.
 * @param {object|null} [error=null] - JSON-RPC error payload.
 * @returns {void}
 */
function sendResponse(id, result, error = null) {
  const response = {
    jsonrpc: JSONRPC_VERSION,
    id,
  };

  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }

  process.stdout.write(JSON.stringify(response) + '\n');
}

/**
 * Main entry point
 * @returns {void}
 */
function main() {
  // Initialize server
  init();

  // Start periodic cleanup intervals (deferred from module-load time)
  startErrorRateCleanup();

  // Set up readline interface for stdin
  // Store in module-level variable for cleanup on shutdown
  readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Start stdio heartbeat — send JSON-RPC notification every 30s to keep
  // the MCP connection alive during long idle periods.
  // Notifications have no `id` field so MCP clients silently ignore unknown ones.
  stdioHeartbeatInterval = timerRegistry.trackInterval(setInterval(() => {
    try {
      const heartbeat = JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/heartbeat',
        params: { timestamp: new Date().toISOString() },
      });
      process.stdout.write(heartbeat + '\n');
    } catch {
      // stdout closed — stop heartbeat
      if (stdioHeartbeatInterval) {
        timerRegistry.remove(stdioHeartbeatInterval);
        clearInterval(stdioHeartbeatInterval);
        stdioHeartbeatInterval = null;
      }
    }
  }, 30000));

  // Process incoming lines
  readlineInterface.on('line', async (line) => {
    if (typeof line !== 'string') {
      return;
    }
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }

    // F4: Reject requests during shutdown — prevents new task submissions while draining
    if (shutdownState === 'shutting-down' || shutdownState === 'done') {
      let reqId = null;
      try { reqId = JSON.parse(trimmedLine)?.id || null; } catch { /* ignore parse error */ }
      const errResponse = JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { code: -32000, message: 'Server is shutting down — task submission rejected' } });
      process.stdout.write(errResponse + '\n');
      return;
    }

    // Track active requests for graceful shutdown
    const MAX_PENDING_REQUESTS = 100;
    if (activeRequestCount >= MAX_PENDING_REQUESTS) {
      // Return JSON-RPC error — server overloaded
      let overloadReqId = null;
      try { overloadReqId = JSON.parse(trimmedLine)?.id ?? null; } catch {}
      const response = JSON.stringify({ jsonrpc: '2.0', id: overloadReqId, error: { code: -32000, message: 'Server busy — too many pending requests' } });
      process.stdout.write(response + '\n');
      return;
    }
    activeRequestCount++;

    let requestId = null;
    try {
      // Parse JSON first - separate from logic errors
      let request;
      try {
        request = JSON.parse(trimmedLine);
        requestId = request.id; // Capture ID for error responses
      } catch {
        // JSON-RPC Parse error (-32700)
        sendResponse(null, null, {
          code: -32700,
          message: 'Parse error: Invalid JSON',
        });
        return;
      }

      const result = await handleRequest(request);

      // Only send response if there's an ID (not for notifications)
      if (request.id !== undefined && result !== null) {
        sendResponse(request.id, result);
      }
    } catch (err) {
      if (err.code) {
        // JSON-RPC error with specific code
        sendResponse(requestId, null, err);
      } else {
        // Internal error (-32603)
        debugLog(`Request error: ${err.message}\n${err.stack || ''}`);
        sendResponse(requestId, null, {
          code: -32603,
          message: err.message || 'Internal error',
        });
      }
    } finally {
      // Always decrement, even on error
      activeRequestCount--;
    }
  });

  // Handle readline errors
  readlineInterface.on('error', (err) => {
    debugLog(`Readline error: ${err.message}`);
  });

  // Handle readline close (stdin closed)
  // In SSE mode, stdin close just means the launching terminal disconnected.
  // The server continues running as a headless HTTP/SSE daemon — SSE clients
  // connect over HTTP and don't depend on stdin.
  readlineInterface.on('close', () => {
    debugLog(`Readline close event received - stdin closed`);
    // Clean up stdio transport resources
    if (readlineInterface) {
      readlineInterface = null;
    }
    if (stdioHeartbeatInterval) {
      timerRegistry.remove(stdioHeartbeatInterval);
      clearInterval(stdioHeartbeatInterval);
      stdioHeartbeatInterval = null;
    }
    debugLog('Stdin closed — continuing as headless SSE server');
  });

  // Handle shutdown signals - use idempotent handler
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Global error handlers to prevent silent crashes
  //
  // Unhandled rejection counter — tracks rejections within a rolling window.
  // A small number of rejections (e.g., transient network errors) is recoverable.
  // A rapid burst indicates a systematic problem (bug loop, resource exhaustion)
  // that warrants a graceful restart rather than silent degradation.
  const UNHANDLED_REJECTION_WINDOW_MS = 60 * 1000; // 1-minute rolling window
  const UNHANDLED_REJECTION_THRESHOLD = 20; // restart after this many within the window
  const _unhandledRejectionTimestamps = [];

  process.on('unhandledRejection', (reason) => {
    debugLog(`Unhandled Promise Rejection: ${reason}`);

    // Track timestamps and purge entries outside the rolling window
    const now = Date.now();
    _unhandledRejectionTimestamps.push(now);
    while (_unhandledRejectionTimestamps.length > 0 &&
           now - _unhandledRejectionTimestamps[0] > UNHANDLED_REJECTION_WINDOW_MS) {
      _unhandledRejectionTimestamps.shift();
    }

    const recentCount = _unhandledRejectionTimestamps.length;
    if (recentCount >= UNHANDLED_REJECTION_THRESHOLD) {
      // Burst of unhandled rejections — something is systematically wrong.
      // Trigger graceful restart so the next session gets a clean slate.
      debugLog(`[FATAL] ${recentCount} unhandled rejections in last 60s — triggering graceful restart`);
      process.stderr.write(`[TORQUE] ${recentCount} unhandled rejections in 60s — restarting for stability\n`);
      gracefulShutdown('unhandled-rejection-burst');
    }
    // Below threshold: log but don't crash — let the server continue handling other requests
  });

  process.on('uncaughtException', (err) => {
    debugLog(`Uncaught Exception: ${err.message}\nStack: ${err.stack}`);

    // Check if this is a recoverable error that shouldn't crash the server
    const recoverableErrors = [
      // Network errors
      'socket hang up',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      // Task state errors (race conditions between processes)
      'Cannot transition task',
      'rollback - no transaction',
      // Stream/readline errors (can happen with large outputs)
      'Invalid string length',
      'ERR_STRING_TOO_LONG'
    ];

    const isRecoverable = recoverableErrors.some(e =>
      err.message?.includes(e) || err.code === e
    );

    if (isRecoverable) {
      debugLog(`Recoverable network error - continuing operation`);
      return; // Don't shutdown for network errors
    }

    // For truly fatal exceptions, shutdown gracefully
    gracefulShutdown('uncaughtException');
  });
}

/**
 * Get the remote agent registry instance.
 * Returns null if the server hasn't been initialized yet.
 * @returns {RemoteAgentRegistry|null}
 */
function getAgentRegistry() {
  return agentRegistry;
}

const _testing = {
  // Use db facade directly — tests may not call init() so scheduler.db may be null
  checkBudgetAlerts: () => {
    const webhookHandlers = require('./handlers/webhook-handlers');
    try {
      const triggered = db.checkBudgetAlerts();
      for (const t of triggered) {
        db.updateBudgetAlert(t.alert.id, { last_triggered_at: new Date().toISOString() });
        const payload = { alert: t.alert, currentValue: t.currentValue, thresholdValue: t.thresholdValue, percentUsed: t.percentUsed };
        if (t.alert.webhook_id) {
          const webhook = db.getWebhook(t.alert.webhook_id);
          if (webhook) webhookHandlers.sendWebhook(webhook, 'budget_alert', payload).catch(() => {});
        } else {
          webhookHandlers.triggerWebhooks('budget_alert', payload).catch(() => {});
        }
      }
    } catch { /* non-fatal in tests */ }
  },
  startPidHeartbeat,
  stopPidHeartbeat,
  getPidHeartbeatInterval: () => pidHeartbeatInterval,
  getProviderQuotaInferenceInterval: () => null, // now managed by maintenance/scheduler.js
  PID_FILE,
  PID_HEARTBEAT_INTERVAL_MS,
  PID_HEARTBEAT_STALE_MS,
  PROVIDER_QUOTA_INFERENCE_INTERVAL_MS: maintenanceScheduler.PROVIDER_QUOTA_INFERENCE_INTERVAL_MS,
  runProviderQuotaInferenceCycle: maintenanceScheduler.runProviderQuotaInferenceCycle,
  startProviderQuotaInferenceTimer,
  getMcpPlatform: () => mcpPlatform,
  resetForTest() {
    stopPidHeartbeat();
    timerRegistry.clearAll();
    maintenanceScheduler.stopAll();
    queueProcessingInterval = null;
    stdioHeartbeatInterval = null;
    errorRateCleanupInterval = null;
    orphanCheckInterval = null;
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    if (mcpPlatform) {
      mcpPlatform.stop();
      mcpPlatform = null;
    }
    shutdownState = 'running';
    _isOrphanMode = false;
  },
};

// Expose selected internals for cross-module access
module.exports = {
  getTools,
  callTool,
  debugLog,
  _shouldLogError,
  startErrorRateCleanup,
  parsePidRecord,
  writePidRecord,
  startPidHeartbeat,
  stopPidHeartbeat,
  gracefulShutdown,
  killStaleInstance,
  init,
  startMaintenanceScheduler,
  startCoordinationScheduler,
  startProviderQuotaInferenceTimer,
  getAutoArchiveStatuses,
  getAgentRegistry,
  _testing,
};

// Run the server
if (require.main === module) {
  // Early CLI handling — --create-admin creates the first admin user, then exits
  if (process.argv.includes('--create-admin')) {
    (async () => {
      const rlMod = require('readline');
      // Need to init DB first
      db.init();
      const userMgr = require('./auth/user-manager');
      userMgr.init(db.getDbInstance());

      // Ensure users table exists
      require('./db/schema-tables').ensureAllTables(db.getDbInstance());

      if (userMgr.hasAnyUsers()) {
        console.error('Users already exist. Use the dashboard to manage users.');
        process.exit(1);
      }

      const rl = rlMod.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise(r => rl.question(q, r));

      try {
        const username = await ask('Username: ');
        const password = await ask('Password: ');
        const user = userMgr.createUser({ username, password, role: 'admin' });
        console.log(`Admin user "${user.username}" created successfully.`);
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      } finally {
        rl.close();
        db.close();
        process.exit(0);
      }
    })();
  } else {
    main();
  }
}
