'use strict';

/**
 * FinalizationTracker — tracks tasks currently inside the finalization
 * pipeline (after process exit, while the close handler runs auto-verify
 * and other async work).
 *
 * Consumers:
 *   - execution/process-lifecycle.js writes markers via start()/touch()
 *     and removes them when the close handler completes.
 *   - maintenance/orphan-cleanup.js reads markers to decide whether the
 *     orphan checker should skip a task that has exited but is still being
 *     finalized; if a marker has been idle for too long it's discarded so
 *     the orphan recovery path can kick in.
 *
 * Each marker is { startedAt, lastActivityAt, stage, touches }. The
 * lastActivityAt heartbeat is what lets the stale-finalizer detector
 * recover wedged close handlers instead of leaving the DB row pinned at
 * `running` indefinitely.
 *
 * Extends Map so the prior `new Map()` callsite contract (.set/.get/.has/
 * .delete) keeps working unchanged for tests and existing consumers; the
 * domain methods `start()` and `touch()` are the preferred new entry points.
 *
 * Owned by the DI container — register via registerValue('finalizationTracker',
 * new FinalizationTracker()) so every consumer reaches the single instance.
 */
class FinalizationTracker extends Map {
  /**
   * Mark a task as entering the finalization pipeline. Initializes the
   * marker with startedAt + lastActivityAt = now and touches = 1.
   * @param {string} taskId
   * @param {string} [stage='started']
   */
  start(taskId, stage = 'started') {
    const now = Date.now();
    this.set(taskId, { startedAt: now, lastActivityAt: now, stage, touches: 1 });
  }

  /**
   * Update the heartbeat on an active marker. Creates a fresh marker if
   * the entry is missing or non-object, mirroring the prior
   * touchFinalizingMarker() shape so behavior is unchanged for callers.
   * @param {string} taskId
   * @param {string} stage
   */
  touch(taskId, stage) {
    const now = Date.now();
    const existing = this.get(taskId);
    if (existing && typeof existing === 'object') {
      existing.lastActivityAt = now;
      existing.stage = stage;
      existing.touches = (existing.touches || 0) + 1;
      return;
    }
    this.set(taskId, { startedAt: now, lastActivityAt: now, stage, touches: 1 });
  }

  /**
   * Get the marker for a task or null. Distinct from Map.get only in that
   * undefined is normalized to null for orphan-cleanup's null-check pattern.
   * @param {string} taskId
   * @returns {{startedAt: number, lastActivityAt: number, stage: string, touches: number}|null}
   */
  getMarker(taskId) {
    const marker = this.get(taskId);
    return marker === undefined ? null : marker;
  }

  /**
   * How long the marker has been idle, in milliseconds. Returns Infinity
   * if no marker exists, so the stale-finalizer threshold check naturally
   * falls through to "should not skip" in that branch.
   * @param {string} taskId
   * @returns {number}
   */
  idleMs(taskId) {
    const marker = this.get(taskId);
    if (!marker || typeof marker !== 'object') return Infinity;
    const lastActivityAt = Number(marker.lastActivityAt || marker.startedAt || 0);
    return Date.now() - lastActivityAt;
  }

  /**
   * Reset all markers (test helper).
   */
  resetAll() {
    this.clear();
  }
}

module.exports = FinalizationTracker;
