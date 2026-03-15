/**
 * Advanced handlers — barrel re-export module
 *
 * Sub-modules:
 *   - ./approval.js      — Approval gates & audit (7 handlers)
 *   - ./scheduling.js    — Cron schedules & resource management (6 handlers)
 *   - ./artifacts.js     — Task artifacts with file operations (6 handlers)
 *   - ./debugger.js      — Breakpoints & debugging (6 handlers)
 *   - ./intelligence.js  — Caching, prioritization, prediction, retry, experiments (26 handlers)
 *   - ./coordination.js  — Multi-agent coordination, claiming, routing, failover (27 handlers)
 *   - ./performance.js   — Query analysis & DB optimization (5 handlers)
 */

module.exports = {
  ...require('./approval'),
  ...require('./scheduling'),
  ...require('./artifacts'),
  ...require('./debugger'),
  ...require('./intelligence'),
  ...require('./coordination'),
  ...require('./performance'),
};
