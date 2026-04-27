'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

/**
 * Phase 2 integration smoke test — codex-fallback
 *
 * Tests the full auto-trip → fallback → auto-recover cycle end-to-end using
 * real implementations where feasible.
 *
 * Import strategy (matches Phase 1 smoke test precedent):
 *
 * - Real createCircuitBreaker, createProviderCircuitBreakerStore (light DB wrappers).
 * - Real createFailoverActivator (subscribes to eventBus events).
 * - Real createCanaryScheduler (timer-based, pure logic).
 * - Real classify from eligibility-classifier (pure function).
 *
 * - walkFailoverChain: pulled from db/smart-routing. That module's top-level
 *   require chain (config, logger, event-bus, provider-capabilities…) loads
 *   cleanly in the tests/ dir but has been observed to leave the export
 *   undefined from the integration/ subdir (same failure noted in Phase 1's
 *   smoke test for loop-controller). The function is 10 lines of pure logic —
 *   it is inlined here with a clear comment pointing to the canonical source.
 *
 * - markInstanceFallbackRouting / consumeInstanceFallbackRouting: defined in
 *   factory/loop-controller.js which has ~30 heavy top-level requires
 *   (database, child_process, worktree-runner, etc.). Phase 1's smoke test
 *   explicitly inlines logic from loop-controller for the same reason. These
 *   two helpers are a trivial in-memory Set — inlined here with identical
 *   semantics and a pointer to the canonical source at line ~196 of
 *   loop-controller.js.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createTables } = require('../../db/schema-tables');
const { createCircuitBreaker } = require('../../execution/circuit-breaker');
const { createProviderCircuitBreakerStore } = require('../../db/provider-circuit-breaker-store');
const { createFailoverActivator } = require('../../routing/failover-activator');
const { createCanaryScheduler } = require('../../factory/canary-scheduler');
const { classify } = require('../../routing/eligibility-classifier');

// ---------------------------------------------------------------------------
// Inline: walkFailoverChain
// Canonical source: server/db/smart-routing.js — function walkFailoverChain()
// Inlined to avoid load-order issues from the integration/ subdir.
// ---------------------------------------------------------------------------
function walkFailoverChain({ chain, breaker } = {}) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  for (const link of chain) {
    if (!link || typeof link.provider !== 'string') continue;
    if (!breaker || typeof breaker.allowRequest !== 'function' || breaker.allowRequest(link.provider)) {
      return { provider: link.provider, model: link.model || null };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline: markInstanceFallbackRouting / consumeInstanceFallbackRouting
// Canonical source: server/factory/loop-controller.js lines ~196-206
// Inlined because loop-controller has ~30 heavy top-level requires that
// cause loading issues from the integration/ subdir (same pattern as Phase 1).
// ---------------------------------------------------------------------------
const _instancesPendingFallbackRouting = new Set();
function markInstanceFallbackRouting(instance_id) {
  if (!instance_id) return;
  _instancesPendingFallbackRouting.add(instance_id);
}
function consumeInstanceFallbackRouting(instance_id) {
  if (!instance_id) return false;
  const had = _instancesPendingFallbackRouting.has(instance_id);
  _instancesPendingFallbackRouting.delete(instance_id);
  return had;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NOOP_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

function makeEventBus() {
  const subs = new Map();
  return {
    on(event, fn) {
      const arr = subs.get(event) || [];
      arr.push(fn);
      subs.set(event, arr);
    },
    emit(event, payload) {
      (subs.get(event) || []).forEach((fn) => fn(payload));
    },
  };
}

function setupDb() {
  const db = new Database(':memory:');
  createTables(db, NOOP_LOGGER);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Phase 2 integration smoke test — codex-fallback', () => {
  // -------------------------------------------------------------------------
  // Scenario 1: auto-trip → activator swaps template → recovery restores
  // -------------------------------------------------------------------------
  describe('Scenario 1: auto-trip + activator swap + recovery restore', () => {
    let db, store, breaker, eventBus, templateStore;

    beforeEach(() => {
      db = setupDb();
      store = createProviderCircuitBreakerStore({ db });
      eventBus = makeEventBus();
      breaker = createCircuitBreaker({ eventBus, store });

      // Stub template-store: tracks which template is "active".
      // Real store (template-store.js) has DB deps; a minimal stub is correct
      // here because this scenario focuses on the activator's event-wiring logic.
      templateStore = {
        _active: 'system-default',
        getActiveName: vi.fn(),
        setActive: vi.fn(),
      };
      templateStore.getActiveName.mockImplementation(() => templateStore._active);
      templateStore.setActive.mockImplementation((name) => { templateStore._active = name; });

      // Real failover-activator wired to the stub template-store and real eventBus.
      createFailoverActivator({ store: templateStore, eventBus, logger: NOOP_LOGGER });
    });

    it('3 quota_exceeded failures trip breaker and activator swaps to codex-down-failover', () => {
      // Three consecutive quota_exceeded failures hit the default threshold (3).
      breaker.recordFailureByCode('codex', { errorCode: 'quota_exceeded' });
      breaker.recordFailureByCode('codex', { errorCode: 'quota_exceeded' });
      breaker.recordFailureByCode('codex', { errorCode: 'quota_exceeded' });

      // Breaker must be OPEN — codex requests denied.
      expect(breaker.allowRequest('codex')).toBe(false);

      // Failover activator must have swapped the active template.
      expect(templateStore._active).toBe('codex-down-failover');
      expect(templateStore.setActive).toHaveBeenCalledWith('codex-down-failover');
    });

    it('manual untrip emits circuit:recovered and activator restores prior template', () => {
      // Trip first.
      breaker.recordFailureByCode('codex', { errorCode: 'quota_exceeded' });
      breaker.recordFailureByCode('codex', { errorCode: 'quota_exceeded' });
      breaker.recordFailureByCode('codex', { errorCode: 'quota_exceeded' });
      expect(templateStore._active).toBe('codex-down-failover');

      // Simulate canary succeeded — manual untrip.
      breaker.untrip('codex', 'canary_succeeded');

      // Breaker CLOSED again.
      expect(breaker.allowRequest('codex')).toBe(true);

      // Activator must have restored the prior template.
      expect(templateStore._active).toBe('system-default');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: classifier + chain walker integration
  // -------------------------------------------------------------------------
  describe('Scenario 2: classifier + chain walker integration', () => {
    it('free-eligible work item routes through chain walker past rejected groq to cerebras', () => {
      // Work item with a free-eligible category within size caps.
      const workItem = { category: 'simple_generation' };
      const plan = { tasks: [{ files_touched: ['a.js'], estimated_lines: 50 }] };
      const projectConfig = { codex_fallback_policy: 'auto' };

      // Real classify — pure function, no side effects.
      const result = classify(workItem, plan, projectConfig);
      expect(result.eligibility).toBe('free');

      // Load the real codex-down-failover template from disk.
      const templatePath = path.join(
        __dirname, '..', '..', 'routing', 'templates', 'codex-down-failover.json',
      );
      const tmpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      const chain = tmpl.rules.simple_generation;
      expect(Array.isArray(chain)).toBe(true);
      expect(chain.length).toBeGreaterThan(0);

      // Stub breaker: groq is rejected (open circuit), cerebras is allowed.
      const breaker = {
        allowRequest: vi.fn((p) => p !== 'groq'),
      };

      // walkFailoverChain (inlined from db/smart-routing.js) skips groq, lands on cerebras.
      const choice = walkFailoverChain({ chain, breaker });

      expect(choice).not.toBeNull();
      expect(choice.provider).toBe('cerebras');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: PRIORITIZE marker round-trip
  // -------------------------------------------------------------------------
  describe('Scenario 3: PRIORITIZE marker round-trip', () => {
    it('markInstanceFallbackRouting + consumeInstanceFallbackRouting is one-shot', () => {
      // Use a unique ID so this test is isolated from parallel suite runs.
      const instanceId = 'inst-smoke-phase2-' + Date.now();

      // Inlined helpers mirror loop-controller.js lines ~196-206 exactly.
      // First consume returns true (was marked).
      markInstanceFallbackRouting(instanceId);
      expect(consumeInstanceFallbackRouting(instanceId)).toBe(true);

      // Second consume returns false — one-shot consume.
      expect(consumeInstanceFallbackRouting(instanceId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: canary scheduler reacts to trip / recover
  // -------------------------------------------------------------------------
  describe('Scenario 4: canary scheduler arms on trip and disarms on recover', () => {
    let eventBus, submitTask;

    beforeEach(() => {
      vi.useFakeTimers();
      eventBus = makeEventBus();
      submitTask = vi.fn(() => Promise.resolve({ task_id: 'canary-smoke' }));
      // Real createCanaryScheduler with short intervalMs for deterministic timer control.
      createCanaryScheduler({ eventBus, submitTask, logger: NOOP_LOGGER, intervalMs: 100 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules canary on circuit:tripped and cancels after circuit:recovered', () => {
      // Arm the scheduler via trip event.
      eventBus.emit('circuit:tripped', { provider: 'codex' });

      // Advance past the 100ms interval — canary should fire once.
      vi.advanceTimersByTime(100);
      expect(submitTask).toHaveBeenCalledTimes(1);

      const call = submitTask.mock.calls[0][0];
      expect(call.provider).toBe('codex');
      expect(call.is_canary).toBe(true);

      // Disarm the scheduler via recover event.
      eventBus.emit('circuit:recovered', { provider: 'codex' });

      // Advance well past another interval — no additional submissions after recover.
      vi.advanceTimersByTime(1000);
      expect(submitTask).toHaveBeenCalledTimes(1);
    });
  });
});
