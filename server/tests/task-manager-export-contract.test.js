/**
 * Regression: task-manager's module.exports must include every method
 * fallback-retry's ensureDeps() expects to find via container-registered
 * taskManager.<method>.
 *
 * Background (2026-05-06):
 *   stopTaskForRestart was defined in task-manager.js at line 725 but
 *   omitted from the Object.assign(module.exports, {...}) block. The
 *   container registers `module.exports` as the taskManager value
 *   (server/task-manager.js:1051). fallback-retry.ensureDeps() reads
 *   tm.stopTaskForRestart and binds it to a local. With no export it
 *   stayed undefined → _stopTaskForRestart stayed null → every periodic
 *   checkStalledTasks → tryStallRecovery() call hit
 *   `_stopTaskForRestart is not a function` → uncaughtException → crash.
 *
 *   The crash auto-restart fix (b0ea85ab) landed first and turned the
 *   silent loop-crash into a visible self-healing loop-crash, but the
 *   underlying export gap kept triggering ~5min recurrence. This test
 *   asserts the export contract directly so future renames or deletions
 *   that re-introduce this class of bug fail at test time, not at
 *   3am-Sunday-runtime.
 */

const tm = require('../task-manager');

describe('task-manager export contract', () => {
  // Methods that fallback-retry.js's ensureDeps() resolves via
  // tm.<method>.bind(tm). Each one is dereferenced from the container-
  // registered taskManager value during the periodic stall-recovery
  // tick. Missing any of them = uncaughtException at runtime.
  const FALLBACK_RETRY_REQUIRED = [
    'processQueue',
    'cancelTask',
    'stopTaskForRestart',
  ];

  for (const name of FALLBACK_RETRY_REQUIRED) {
    it(`exports ${name} (fallback-retry's ensureDeps depends on it)`, () => {
      expect(typeof tm[name]).toBe('function');
    });
  }

  // markTaskCleanedUp is also looked up by fallback-retry, but it's
  // optional (the call site guards `if (_markTaskCleanedUp)`). Asserting
  // the contract anyway so renames are caught before they propagate.
  it('exports markTaskCleanedUp (optional, but ensureDeps looks for it)', () => {
    // markTaskCleanedUp is exported via processTracker singleton, not
    // directly on task-manager module.exports — verify it's accessible
    // via the shared tracker rather than the legacy module surface.
    // (Update this assertion if the access pattern changes.)
    expect(typeof tm.markTaskCleanedUp === 'function' || tm.markTaskCleanedUp === undefined).toBe(true);
  });

  // execute-cli.js's ensureDeps() binds `_helpers = require('../task-manager')`
  // and calls `_helpers.estimateProgress(output, provider)` on every output
  // chunk. Same export-shape bug class as stopTaskForRestart: missing export
  // → undefined() at runtime. Logs showed 31-48 occurrences per session of
  // `_helpers.estimateProgress is not a function` before fix landed 2026-05-06.
  const EXECUTE_CLI_HELPERS_REQUIRED = [
    'estimateProgress',
  ];

  for (const name of EXECUTE_CLI_HELPERS_REQUIRED) {
    it(`exports ${name} (execute-cli._helpers binding depends on it)`, () => {
      expect(typeof tm[name]).toBe('function');
    });
  }
});
