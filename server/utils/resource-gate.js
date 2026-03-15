'use strict';

/**
 * Resource Gate — CPU/RAM threshold checks for test execution gating.
 *
 * Prevents verify commands and test execution when a host exceeds
 * resource thresholds. Does NOT gate Ollama inference tasks.
 */

const RESOURCE_THRESHOLDS = Object.freeze({ cpu: 85, ram: 85 });

function resolveThreshold(value, fallback) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Check if a host's metrics exceed resource thresholds.
 * Unknown/null metrics are treated as pass (don't block on missing data).
 *
 * @param {Object|null} metrics - { cpuPercent, ramPercent } from hostActivityCache gpuMetrics
 * @param {Object} [thresholds] - Custom thresholds { cpu, ram }
 * @returns {boolean} true if overloaded
 */
function isHostOverloaded(metrics, thresholds) {
  if (!metrics) return false;
  const t = thresholds || RESOURCE_THRESHOLDS;
  if (typeof metrics.cpuPercent === 'number' && metrics.cpuPercent >= t.cpu) return true;
  if (typeof metrics.ramPercent === 'number' && metrics.ramPercent >= t.ram) return true;
  return false;
}

/**
 * Get current thresholds, checking config table for overrides.
 * @param {Object} [db] - Database instance with getConfig()
 * @returns {{ cpu: number, ram: number }}
 */
function getThresholds(db) {
  if (!db || typeof db.getConfig !== 'function') {
    return { ...RESOURCE_THRESHOLDS };
  }

  try {
    return {
      cpu: resolveThreshold(db.getConfig('resource_gate_cpu_threshold'), RESOURCE_THRESHOLDS.cpu),
      ram: resolveThreshold(db.getConfig('resource_gate_ram_threshold'), RESOURCE_THRESHOLDS.ram),
    };
  } catch {
    return { ...RESOURCE_THRESHOLDS };
  }
}

/**
 * Check resource gate for a specific host.
 *
 * @param {Map} hostActivityCache - The hostActivityCache from host-monitoring.js
 * @param {string|null} hostId - Host to check, or null for local
 * @param {Object} [db] - Optional database for config-based thresholds
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkResourceGate(hostActivityCache, hostId, db) {
  if (!hostId) return { allowed: true };
  const activity = hostActivityCache?.get(hostId);
  if (!activity || !activity.gpuMetrics) return { allowed: true };

  const thresholds = getThresholds(db);
  const metrics = activity.gpuMetrics;
  if (!isHostOverloaded(metrics, thresholds)) return { allowed: true };

  const parts = [];
  if (typeof metrics.cpuPercent === 'number' && metrics.cpuPercent >= thresholds.cpu) {
    parts.push(`CPU at ${metrics.cpuPercent}%`);
  }
  if (typeof metrics.ramPercent === 'number' && metrics.ramPercent >= thresholds.ram) {
    parts.push(`RAM at ${metrics.ramPercent}%`);
  }

  const thresholdLabel = thresholds.cpu === thresholds.ram
    ? `${thresholds.cpu}%`
    : `CPU ${thresholds.cpu}%, RAM ${thresholds.ram}%`;

  return {
    allowed: false,
    reason: `Host overloaded: ${parts.join(', ')} (threshold: ${thresholdLabel})`,
  };
}

module.exports = { isHostOverloaded, checkResourceGate, getThresholds, RESOURCE_THRESHOLDS };
