/**
 * Instance Manager Module — Extracted from task-manager.js (Phase 5, Step 5)
 *
 * Multi-session instance registration and heartbeat management.
 * Each MCP process registers itself as an instance so sibling sessions can
 * distinguish "task from crashed process" vs "task from active sibling"
 * during orphan cleanup.
 *
 * Uses init() pattern for dependency injection.
 */

'use strict';

const { INSTANCE_HEARTBEAT_INTERVAL_MS } = require('../constants');

// ---- Injected dependencies ----
let db = null;
let logger = null;

// ---- Instance constants ----
let QUEUE_LOCK_HOLDER_ID = null;
let INSTANCE_LOCK_NAME = null;
const INSTANCE_LOCK_LEASE_SECONDS = 60;

// ---- Timer handle ----
let instanceHeartbeatInterval = null;

/**
 * Register this MCP instance by acquiring an instance lock.
 * Called during server init after db.init().
 */
function registerInstance() {
  try {
    const result = db.acquireLock(INSTANCE_LOCK_NAME, QUEUE_LOCK_HOLDER_ID, INSTANCE_LOCK_LEASE_SECONDS, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }));
    if (result.acquired) {
      logger.info(`[Instance] Registered instance ${QUEUE_LOCK_HOLDER_ID} (PID ${process.pid})`);
    }
    return result;
  } catch (e) {
    logger.warn(`[Instance] Failed to register: ${e.message}`);
    return { acquired: false };
  }
}

/**
 * Renew instance lock lease (called every 10s).
 */
function heartbeatInstance() {
  try {
    // Re-acquire extends the lease since we already hold it
    db.acquireLock(INSTANCE_LOCK_NAME, QUEUE_LOCK_HOLDER_ID, INSTANCE_LOCK_LEASE_SECONDS);
    db.updateLockHeartbeat(INSTANCE_LOCK_NAME, QUEUE_LOCK_HOLDER_ID);
  } catch {
    // Database may be closing during shutdown — ignore
  }
}

/**
 * Start the heartbeat interval for this instance.
 */
function startInstanceHeartbeat() {
  if (!db || !logger) {
    return;
  }

  if (instanceHeartbeatInterval !== null) {
    clearInterval(instanceHeartbeatInterval);
    instanceHeartbeatInterval = null;
  }
  instanceHeartbeatInterval = setInterval(heartbeatInstance, INSTANCE_HEARTBEAT_INTERVAL_MS);
  instanceHeartbeatInterval.unref();
}

/**
 * Stop the heartbeat interval.
 */
function stopInstanceHeartbeat() {
  if (instanceHeartbeatInterval) {
    clearInterval(instanceHeartbeatInterval);
    instanceHeartbeatInterval = null;
  }
}

/**
 * Unregister this instance by releasing its lock.
 * Called during clean shutdown (not orphan mode).
 */
function unregisterInstance() {
  try {
    stopInstanceHeartbeat();
    db.releaseLock(INSTANCE_LOCK_NAME, QUEUE_LOCK_HOLDER_ID);
    logger.info(`[Instance] Unregistered instance ${QUEUE_LOCK_HOLDER_ID}`);
  } catch {
    // Database may already be closed
  }
}

/**
 * Update holder_info on the existing instance lock (merge new fields).
 * Called after dashboard starts to record the actual port number.
 * @param {Object} info - Fields to merge (e.g. { port: 3457 })
 */
function updateInstanceInfo(info) {
  try {
    // Read current holder_info
    const lock = db.checkLock(INSTANCE_LOCK_NAME);
    let current = {};
    if (lock.held && lock.holderInfo) {
      try { current = JSON.parse(lock.holderInfo); } catch { /* ignore */ }
    }
    // Merge new fields
    const merged = { ...current, ...info };
    // Re-acquire with updated holder_info (we already hold the lock, so this extends lease)
    db.acquireLock(INSTANCE_LOCK_NAME, QUEUE_LOCK_HOLDER_ID, INSTANCE_LOCK_LEASE_SECONDS, JSON.stringify(merged));
  } catch (e) {
    logger.warn(`[Instance] Failed to update instance info: ${e.message}`);
  }
}

/**
 * Check if a specific MCP instance is still alive (heartbeat fresh within 30s).
 * @param {string} instanceId - The QUEUE_LOCK_HOLDER_ID of the instance
 * @returns {boolean}
 */
function isInstanceAlive(instanceId) {
  try {
    const lockName = `mcp_instance:${instanceId}`;
    const staleCheck = db.isLockHeartbeatStale(lockName, 30000); // 30s threshold
    // If no lock found, instance is not registered (dead)
    // If heartbeat is stale, instance is presumed dead
    return !staleCheck.isStale && staleCheck.lastHeartbeat !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get the MCP instance ID for this process.
 * @returns {string}
 */
function getMcpInstanceId() {
  return QUEUE_LOCK_HOLDER_ID;
}

/**
 * Initialize the instance manager with dependencies.
 * @param {Object} deps
 * @param {Object} deps.db - Database module
 * @param {Object} deps.logger - Logger instance
 * @param {string} deps.instanceId - The QUEUE_LOCK_HOLDER_ID from task-manager
 */
function init(deps) {
  stopInstanceHeartbeat();
  db = deps.db;
  logger = deps.logger;
  QUEUE_LOCK_HOLDER_ID = deps.instanceId;
  INSTANCE_LOCK_NAME = `mcp_instance:${QUEUE_LOCK_HOLDER_ID}`;
}

module.exports = {
  init,
  registerInstance,
  heartbeatInstance,
  startInstanceHeartbeat,
  stopInstanceHeartbeat,
  unregisterInstance,
  updateInstanceInfo,
  isInstanceAlive,
  getMcpInstanceId,
};
