/**
 * maintenance/scheduler.js — Maintenance, coordination, and budget schedulers
 *
 * Extracted from index.js to keep the entry point under 1500 lines.
 * All scheduler functions were previously defined inline in index.js.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { executeScheduledTask } = require('../execution/schedule-runner');

// Late-bound dependencies (set via init())
let db = null;
let serverConfig = null;
let debugLog = null;
let timerRegistry = null;
let logger = null;

// Interval handles
let maintenanceInterval = null;
let coordinationAgentInterval = null;
let coordinationLockInterval = null;
let providerQuotaInferenceInterval = null;

const PROVIDER_QUOTA_INFERENCE_INTERVAL_MS = 5 * 60 * 1000;
const PROVIDER_QUOTA_INFERENCE_LIMITS = Object.freeze({
  'google-ai': { rpm: 15 },
});

function getRunDirManager() {
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('runDirManager')) {
      return defaultContainer.get('runDirManager');
    }
  } catch {
    // Best-effort: retention can still prune task rows even if the artifact manager is unavailable.
  }
  return null;
}

/**
 * Initialize scheduler dependencies. Must be called before any scheduler starts.
 */
function init(deps) {
  db = deps.db;
  serverConfig = deps.serverConfig;
  debugLog = deps.debugLog;
  timerRegistry = deps.timerRegistry;
  logger = deps.logger;
}

/**
 * F5: Check available disk space on the database partition.
 * Uses fs.statfsSync (Node 18.15+) to detect low-disk conditions.
 * @param {string} dirPath - Directory path to check (typically the DB directory)
 * @returns {{ freeMB: number, critical: boolean, warning: boolean }}
 */
function checkDiskSpace(dirPath) {
  try {
    const stats = fs.statfsSync(dirPath);
    const freeBytes = stats.bfree * stats.bsize;
    const freeMB = Math.round(freeBytes / (1024 * 1024));
    return { freeMB, critical: freeMB < 100, warning: freeMB < 500 };
  } catch { return { freeMB: -1, critical: false, warning: false }; }
}

/**
 * Start the maintenance scheduler
 * Runs scheduled maintenance tasks at configured intervals
 * Idempotent - safe to call multiple times
 */
function startMaintenanceScheduler(opts = {}) {
  // Clear existing interval to prevent duplicate schedulers
  // This handles cases where the module is reloaded or init is called multiple times
  if (maintenanceInterval) {
    timerRegistry.remove(maintenanceInterval);
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }

  // Check for due maintenance tasks every minute
  maintenanceInterval = timerRegistry.trackInterval(setInterval(() => {
    try {
      const dueTasks = db.getDueMaintenanceTasks();

      for (const schedule of dueTasks) {
        debugLog(`Running scheduled maintenance: ${schedule.task_type}`);

        // Run the maintenance task
        runMaintenanceTask(schedule.task_type);

        // Mark as run and update next run time
        db.markMaintenanceRun(schedule.id);
      }

      // F5: Check disk space on the database partition
      try {
        const dbDir = path.dirname(db.getDbPath ? db.getDbPath() : path.join(process.cwd(), 'torque.db'));
        const diskStatus = checkDiskSpace(dbDir);
        if (diskStatus.critical) {
          debugLog(`[CRITICAL] Disk space critically low: ${diskStatus.freeMB}MB free — database writes may fail`);
        } else if (diskStatus.warning) {
          debugLog(`[WARNING] Disk space low: ${diskStatus.freeMB}MB free`);
        }
      } catch (diskErr) {
        debugLog(`Disk space check error: ${diskErr.message}`);
      }

      // Also check budget alerts after maintenance
      checkBudgetAlerts();

      // Archive old terminal tasks (completed/failed/cancelled > 24h)
      try {
        const archived = db.archiveOldTasks(24);
        if (archived > 0) debugLog(`Archived ${archived} old task(s)`);
      } catch (archErr) {
        debugLog(`Task archival error: ${archErr.message}`);
      }

      // C-2: Execute due user cron scheduled tasks
      try {
        const dueSchedules = db.getDueScheduledTasks();
        for (const schedule of dueSchedules) {
          try {
            // executeScheduledTask is now async (awaits handleRunWorkflow
            // which awaits taskManager.startTask). Fire-and-forget is fine
            // here — the maintenance tick doesn't need the result, just
            // needs unhandled rejections caught so a single bad schedule
            // doesn't crash the loop.
            Promise.resolve(executeScheduledTask(schedule, {
              db,
              debugLog,
              logger,
              runWorkflow: opts?.runWorkflow,
            })).catch((schedErr) => {
              logger.error(`Scheduled task execution failed: ${schedErr.message}`);
              debugLog(`Failed to execute scheduled task "${schedule.name}": ${schedErr.message}`);
            });
          } catch (schedErr) {
            logger.error(`Scheduled task execution failed: ${schedErr.message}`);
            debugLog(`Failed to execute scheduled task "${schedule.name}": ${schedErr.message}`);
          }
        }
      } catch (cronErr) {
        debugLog(`Cron schedule check error: ${cronErr.message}`);
      }

      // Unconditional growth table purge — trim high-volume tables regardless
      // of cleanup_log_days setting to prevent unbounded DB growth
      try {
        if (db.purgeGrowthTables) {
          const purged = db.purgeGrowthTables();
          if (purged.coordination_events > 0 || purged.health_status > 0 || purged.task_file_writes > 0) {
            debugLog(`Growth table purge: coordination_events=${purged.coordination_events}, health_status=${purged.health_status}, task_file_writes=${purged.task_file_writes}`);
          }
        }
      } catch (purgeErr) {
        debugLog(`Growth table purge error: ${purgeErr.message}`);
      }
    } catch (err) {
      debugLog(`Maintenance scheduler error: ${err.message}`);
    }
  }, 60000)); // Check every minute
  maintenanceInterval.unref();
}

/**
 * Start the coordination scheduler
 * C-3: Runs agent health checks, lease expiry, and lock cleanup on separate intervals
 * H-3: Periodically records agent load metrics for online agents
 * Idempotent - safe to call multiple times
 */
function startCoordinationScheduler() {
  // Startup sweep: mark all agents as offline (no SSE sessions survive a restart)
  try {
    const onlineAgents = db.listAgents({ status: 'online' });
    for (const agent of onlineAgents) {
      if (db.updateAgent) {
        db.updateAgent(agent.id, { status: 'offline' });
      }
    }
    if (onlineAgents.length > 0) {
      debugLog(`Startup sweep: marked ${onlineAgents.length} stale agents as offline`);
    }
  } catch (err) {
    debugLog(`Startup agent sweep error: ${err.message}`);
  }

  // Clear existing intervals to prevent duplicates
  if (coordinationAgentInterval) {
    timerRegistry.remove(coordinationAgentInterval);
    clearInterval(coordinationAgentInterval);
    coordinationAgentInterval = null;
  }
  if (coordinationLockInterval) {
    timerRegistry.remove(coordinationLockInterval);
    clearInterval(coordinationLockInterval);
    coordinationLockInterval = null;
  }

  // Every 30 seconds: check offline agents and expire stale leases
  coordinationAgentInterval = timerRegistry.trackInterval(setInterval(() => {
    try {
      db.checkOfflineAgents();
    } catch (err) {
      debugLog(`checkOfflineAgents error: ${err.message}`);
    }
    try {
      db.expireStaleLeases();
    } catch (err) {
      debugLog(`expireStaleLeases error: ${err.message}`);
    }
    // Renew active claims for running tasks
    try {
      const activeClaims = db.listClaims({ status: 'active' });
      for (const claim of activeClaims) {
        const task = db.getTask(claim.task_id);
        if (task && task.status === 'running') {
          db.renewLease(claim.id, 600);
        }
      }
    } catch (err) {
      debugLog(`Lease renewal error: ${err.message}`);
    }
  }, 30000));
  coordinationAgentInterval.unref();

  // Every 5 minutes: clean up expired locks + record agent metrics
  coordinationLockInterval = timerRegistry.trackInterval(setInterval(() => {
    try {
      db.cleanupExpiredLocks();
    } catch (err) {
      debugLog(`cleanupExpiredLocks error: ${err.message}`);
    }

    // H-3: Record agent load metrics for online agents
    try {
      const now = new Date().toISOString();
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const onlineAgents = db.listAgents({ status: 'online' });
      for (const agent of onlineAgents) {
        try {
          db.recordAgentMetric(agent.id, 'current_load', agent.current_load || 0, fiveMinAgo, now);
        } catch (metricErr) {
          debugLog(`recordAgentMetric error for agent ${agent.id}: ${metricErr.message}`);
        }
      }
    } catch (err) {
      debugLog(`Agent metrics collection error: ${err.message}`);
    }
  }, 300000));
  coordinationLockInterval.unref();
}

function runProviderQuotaInferenceCycle() {
  const quotaStore = require('../db/provider-quotas').getQuotaStore();
  const rawDb = typeof db.getDbInstance === 'function' ? db.getDbInstance() : null;
  if (!rawDb || typeof rawDb.prepare !== 'function') return;

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const tokenRow = rawDb
    .prepare('SELECT SUM(total_tokens) as total FROM token_usage WHERE recorded_at > ?')
    .get(hourAgo);
  const tokensLastHour = Number(tokenRow?.total) || 0;

  for (const [provider, limits] of Object.entries(PROVIDER_QUOTA_INFERENCE_LIMITS)) {
    const existing = quotaStore.getQuota(provider);
    if (existing && existing.source === 'headers') continue;

    const tasks = db.listTasks({ provider, from_date: hourAgo, status: 'completed', limit: 1000 });
    const taskList = Array.isArray(tasks) ? tasks : (tasks?.tasks || []);

    quotaStore.updateFromInference(provider, {
      tasksLastHour: taskList.length,
      tokensLastHour,
    }, limits);
  }
}

function startProviderQuotaInferenceTimer() {
  if (providerQuotaInferenceInterval) {
    timerRegistry.remove(providerQuotaInferenceInterval);
    clearInterval(providerQuotaInferenceInterval);
    providerQuotaInferenceInterval = null;
  }

  try {
    runProviderQuotaInferenceCycle();
  } catch (err) {
    debugLog(`[Quota Inference] ${err.message}`);
  }

  providerQuotaInferenceInterval = timerRegistry.trackInterval(setInterval(() => {
    try {
      runProviderQuotaInferenceCycle();
    } catch (err) {
      debugLog(`[Quota Inference] ${err.message}`);
    }
  }, PROVIDER_QUOTA_INFERENCE_INTERVAL_MS));
  providerQuotaInferenceInterval.unref();
}

/**
 * Run a specific maintenance task
 * Each subtask is wrapped individually to prevent one failure from blocking others
 */
function safeConfigInt(configKey, defaultVal) {
  return serverConfig.getInt(configKey, defaultVal);
}

function getAutoArchiveStatuses() {
  const raw = serverConfig.get('auto_archive_status');
  if (!raw) return ['completed', 'failed', 'cancelled'];

  const parsed = db.safeJsonParse(raw, null);
  if (Array.isArray(parsed)) return parsed;

  const fromCsv = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return fromCsv.length > 0 ? fromCsv : ['completed', 'failed', 'cancelled'];
}

function runMaintenanceTask(taskType) {
  const runSafe = (name, fn) => {
    try {
      fn();
    } catch (err) {
      debugLog(`Maintenance subtask '${name}' failed: ${err.message}`);
      if (err.stack) {
        debugLog(`Stack: ${err.stack}`);
      }
    }
  };

  try {
    switch (taskType) {
      case 'archive_old_tasks': {
        const archiveDays = serverConfig.getInt('auto_archive_days', 0);
        if (archiveDays > 0) {
          const statuses = getAutoArchiveStatuses();
          db.archiveTasks({ days_old: archiveDays, statuses });
        }
        break;
      }

      case 'cleanup_logs': {
        const cleanupDays = serverConfig.getInt('cleanup_log_days', 0);
        if (cleanupDays > 0) {
          runSafe('cleanupHealthHistory', () => db.cleanupHealthHistory(cleanupDays * 24));
          runSafe('cleanupWebhookLogs', () => db.cleanupWebhookLogs(cleanupDays));
          runSafe('cleanupStreamData', () => db.cleanupStreamData(cleanupDays));
          runSafe('cleanupAnalytics', () => db.cleanupAnalytics(cleanupDays));
          runSafe('cleanupCoordinationEvents', () => db.cleanupCoordinationEvents(cleanupDays));
        }
        // Always clean up stale webhook retries (7 day default)
        runSafe('cleanupStaleWebhookRetries', () => db.cleanupStaleWebhookRetries(7));
        break;
      }

      case 'enforce_limits':
        // Hard limits to prevent unbounded growth even if cleanup doesn't run
        runSafe('enforceEventTableLimits', () => db.enforceEventTableLimits());
        runSafe('enforceWebhookLogLimits', () => db.enforceWebhookLogLimits());
        break;

      case 'aggregate_metrics':
        db.aggregateSuccessMetrics('day');
        break;

      case 'vacuum_database':
        // Reclaim disk space and optimize database
        // Should be run periodically (e.g., weekly) during low-activity periods
        runSafe('checkMemoryPressure', () => {
          const pressure = db.checkMemoryPressure();
          if (pressure.level === 'critical') {
            debugLog(`Memory pressure critical, running emergency cleanup first`);
            db.runEmergencyCleanup();
          }
        });
        runSafe('vacuum', () => db.vacuum());
        break;

      case 'cleanup_stale_tasks': {
        // Clean up tasks stuck in running/queued state
        // Runs every 5 minutes by default, catches orphaned tasks from crashes/restarts
        const staleRunningMin = serverConfig.getInt('stale_running_minutes', 60);
        const staleQueuedMin = serverConfig.getInt('stale_queued_minutes', 120);
        const result = db.cleanupStaleTasks(staleRunningMin, staleQueuedMin);
        if (result.total > 0) {
          debugLog(`Stale task cleanup: ${result.running_cleaned} running, ${result.queued_cleaned} queued`);
        }
        break;
      }

      case 'prune_old_tasks': {
        const maxRetained = safeConfigInt('task_retention_count', 5000);
        const result = db.pruneOldTasks(maxRetained);
        if (result.pruned > 0) {
          debugLog(`Pruned old tasks: ${result.pruned}`);
        }
        const runDirManager = getRunDirManager();
        if (runDirManager && Array.isArray(result.task_ids) && result.task_ids.length > 0) {
          let sweptFiles = 0;
          for (const taskId of result.task_ids) {
            try {
              const sweep = runDirManager.sweepRunDir(taskId);
              sweptFiles += Number(sweep?.deleted) || 0;
            } catch (err) {
              debugLog(`Run-dir retention sweep failed for ${taskId}: ${err.message}`);
            }
          }
          if (sweptFiles > 0) {
            debugLog(`Swept ${sweptFiles} run artifact file(s) from pruned tasks`);
          }
        }
        break;
      }

      case 'purge_task_output': {
        const retentionDays = safeConfigInt('task_output_retention_days', 30);
        if (retentionDays > 0) {
          const purged = db.purgeOldTaskOutput(retentionDays);
          if (purged > 0) {
            debugLog(`Purged output from ${purged} old task(s) (retention: ${retentionDays} days)`);
          }
        }
        break;
      }

      case 'all':
        // Run each task type, continuing even if one fails
        runSafe('cleanup_stale_tasks', () => runMaintenanceTask('cleanup_stale_tasks'));
        runSafe('prune_old_tasks', () => runMaintenanceTask('prune_old_tasks'));
        runSafe('purge_task_output', () => runMaintenanceTask('purge_task_output'));
        runSafe('archive_old_tasks', () => runMaintenanceTask('archive_old_tasks'));
        runSafe('cleanup_logs', () => runMaintenanceTask('cleanup_logs'));
        runSafe('enforce_limits', () => runMaintenanceTask('enforce_limits'));
        runSafe('aggregate_metrics', () => runMaintenanceTask('aggregate_metrics'));
        runSafe('vacuum_database', () => runMaintenanceTask('vacuum_database'));
        break;
    }
  } catch (err) {
    debugLog(`Maintenance task '${taskType}' failed: ${err.message}`);
    if (err.stack) {
      debugLog(`Stack: ${err.stack}`);
    }
  }
}

/**
 * Check budget alerts and trigger webhooks if thresholds are exceeded
 */
function checkBudgetAlerts() {
  try {
    const triggered = db.checkBudgetAlerts();
    const webhookHandlers = require('../handlers/webhook-handlers');

    for (const t of triggered) {
      // Update alert last triggered time
      db.updateBudgetAlert(t.alert.id, {
        last_triggered_at: new Date().toISOString()
      });

      const payload = {
        alert: t.alert,
        currentValue: t.currentValue,
        thresholdValue: t.thresholdValue,
        percentUsed: t.percentUsed
      };

      // Trigger webhook if configured
      if (t.alert.webhook_id) {
        const webhook = db.getWebhook(t.alert.webhook_id);
        if (webhook) {
          webhookHandlers.sendWebhook(webhook, 'budget_alert', payload).catch(err => {
            debugLog(`Budget alert webhook error: ${err.message}`);
          });
        }
      } else {
        webhookHandlers.triggerWebhooks('budget_alert', payload).catch(err => {
          debugLog(`Budget alert webhook error: ${err.message}`);
        });
      }

      debugLog(`Budget alert triggered: ${t.alert.alert_type} at ${t.percentUsed}%`);
    }
  } catch (err) {
    debugLog(`Budget alert check error: ${err.message}`);
  }
}

/**
 * Stop all scheduler intervals. Called during test cleanup.
 */
function stopAll() {
  if (maintenanceInterval) {
    timerRegistry.remove(maintenanceInterval);
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
  if (coordinationAgentInterval) {
    timerRegistry.remove(coordinationAgentInterval);
    clearInterval(coordinationAgentInterval);
    coordinationAgentInterval = null;
  }
  if (coordinationLockInterval) {
    timerRegistry.remove(coordinationLockInterval);
    clearInterval(coordinationLockInterval);
    coordinationLockInterval = null;
  }
  if (providerQuotaInferenceInterval) {
    timerRegistry.remove(providerQuotaInferenceInterval);
    clearInterval(providerQuotaInferenceInterval);
    providerQuotaInferenceInterval = null;
  }
}

module.exports = {
  init,
  checkDiskSpace,
  startMaintenanceScheduler,
  startCoordinationScheduler,
  runProviderQuotaInferenceCycle,
  startProviderQuotaInferenceTimer,
  getAutoArchiveStatuses,
  checkBudgetAlerts,
  stopAll,
  PROVIDER_QUOTA_INFERENCE_INTERVAL_MS,
  PROVIDER_QUOTA_INFERENCE_LIMITS,
};
