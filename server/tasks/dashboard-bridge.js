'use strict';

/**
 * tasks/dashboard-bridge.js — lazy dashboard accessor + broadcaster facade.
 *
 * The dashboard server (dashboard/server.js) and the task manager
 * import each other transitively. To avoid a circular require, we
 * resolve the dashboard module lazily on first call and route
 * broadcast notifications through a fixed method-name list so the
 * task manager can publish events without holding a hard reference.
 *
 * Extracted from task-manager.js to reduce that file's surface area
 * and to give the dashboard-bridge concern a clear home.
 */

let _dashboard = null;

function getDashboard() {
  if (!_dashboard) _dashboard = require('../dashboard/server');
  return _dashboard;
}

const DASHBOARD_BROADCAST_METHODS = Object.freeze([
  'broadcastUpdate',
  'broadcastTaskUpdate',
  'broadcastTaskOutput',
  'broadcastStatsUpdate',
  'notifyTaskCreated',
  'notifyTaskUpdated',
  'notifyTaskOutput',
  'notifyTaskDeleted',
  'notifyHostActivityUpdated',
  'notifyTaskEvent',
]);

let _dashboardBroadcaster = null;

function getDashboardBroadcaster() {
  if (_dashboardBroadcaster) return _dashboardBroadcaster;

  _dashboardBroadcaster = {};
  for (const methodName of DASHBOARD_BROADCAST_METHODS) {
    _dashboardBroadcaster[methodName] = (...args) => {
      const dashboard = getDashboard();
      const method = dashboard && dashboard[methodName];
      if (typeof method !== 'function') return undefined;
      return method.apply(dashboard, args);
    };
  }
  return _dashboardBroadcaster;
}

module.exports = {
  getDashboard,
  getDashboardBroadcaster,
  DASHBOARD_BROADCAST_METHODS,
};
