/**
 * Task handlers — barrel re-export module
 *
 * Sub-modules:
 *   - ./core.js         — Core lifecycle (submit, check, list, cancel, configure, progress)
 *   - ./pipeline.js     — Templates, analytics, retry, pipelines, git ops, smart routing
 *   - ./operations.js   — Tags, health, scheduling, batch ops, output search, export/import, archiving
 *   - ./project.js      — Cost/token tracking, project management, groups, advanced analytics
 *   - ./intelligence.js — Streaming, control, intelligence, collaboration, bulk, duration, review
 *
 * Shared utilities in ./utils.js (formatTime, calculateDuration).
 */

module.exports = {
  ...require('./core'),
  ...require('./pipeline'),
  ...require('./operations'),
  ...require('./project'),
  ...require('./intelligence'),
};
