'use strict';

/**
 * Regression: getTaskAgeMs must honor provider_switched_at so failover-requeued
 * tasks reset the reclaim-grace clock.
 *
 * Live evidence (torque-public batch_id=...-2211, 2026-05-02):
 *   - Codex ran 977s, hit quota, exited with empty output
 *   - close-phases auto-failover marked task pending_provider_switch and
 *     approveProviderSwitch (server/db/smart-routing.js:1001) re-queued it
 *     with provider=NULL, intended_provider=ollama, provider_switched_at=now
 *   - Next factory tick fired ~25min later
 *   - getTaskAgeMs returned 25min (based on the original codex created_at),
 *     exceeding the default 10min reclaim grace
 *   - pre_reclaim_before_create cancelled the failover-requeued task
 *     before ollama could pick it up
 *   - Factory next-tick spawned a fresh task on codex (default), looping
 *     into the same quota failure
 *
 * Fix: prefer provider_switched_at when present so the grace window starts
 * from the failover requeue, not from the original codex submit.
 */

const assert = require('assert');
const { _internalForTests } = require('../factory/loop-controller');

const { getTaskAgeMs } = _internalForTests;

describe('getTaskAgeMs', () => {
  it('returns null for null/undefined task', () => {
    assert.strictEqual(getTaskAgeMs(null), null);
    assert.strictEqual(getTaskAgeMs(undefined), null);
  });

  it('falls back to created_at when nothing else is set', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const ageMs = getTaskAgeMs({ created_at: oneHourAgo });
    assert.ok(ageMs !== null && ageMs >= 60 * 60 * 1000 - 5_000, `expected ~1h, got ${ageMs}`);
  });

  it('prefers started_at over created_at', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const ageMs = getTaskAgeMs({ created_at: oneHourAgo, started_at: fiveMinAgo });
    // Should reflect started_at (~5min), not created_at (~1h)
    assert.ok(ageMs < 10 * 60 * 1000, `expected <10min, got ${ageMs}`);
  });

  it('prefers provider_switched_at over started_at and created_at', () => {
    // Failover-requeue case: original codex run started 30min ago and
    // failed; failover re-queued the task 30s ago.
    const created = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const started = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const switched = new Date(Date.now() - 30 * 1000).toISOString();
    const ageMs = getTaskAgeMs({
      created_at: created,
      started_at: started,
      provider_switched_at: switched,
    });
    // Should reflect provider_switched_at (~30s), not the original 30min run
    assert.ok(ageMs < 60 * 1000, `expected <60s, got ${ageMs}`);
  });

  it('also accepts camelCase providerSwitchedAt', () => {
    const created = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const switched = new Date(Date.now() - 30 * 1000).toISOString();
    const ageMs = getTaskAgeMs({
      created_at: created,
      providerSwitchedAt: switched,
    });
    assert.ok(ageMs < 60 * 1000, `expected <60s, got ${ageMs}`);
  });
});
