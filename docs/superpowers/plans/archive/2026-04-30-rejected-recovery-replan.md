# Rejected-Item Replan Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second recovery sweep that picks up factory work items rejected for *idea-side* failures (`cannot_generate_plan`, `plan_quality_gate_rejected_after_2_attempts`, manual rejects, etc.), branches the replan strategy by reject reason (rewrite-description / decompose / escalate-architect), caps attempts at 3, then routes exhaustion to a `needs_review` inbox.

**Architecture:** Strategy registry + single dispatcher mirroring the existing `server/factory/auto-recovery/registry.js` pattern. `replan-recovery.js` runs alongside the existing `rejected-recovery.js` on the factory tick. Reason patterns are disjoint between the two sweeps; overlap is asserted at startup. Inbox surfaces via four new MCP tools (`list_recovery_inbox`, `inspect_recovery_item`, `revive_recovery_item`, `dismiss_recovery_item`) plus a `/torque-recovery-inbox` slash command.

**Tech Stack:** Node.js, better-sqlite3, vitest. Schema migration v39 in `server/db/migrations.js`. Existing TORQUE DI container, decision-log, event-bus, and factory-tick infrastructure.

**Spec reference:** `docs/superpowers/specs/2026-04-30-rejected-recovery-replan-design.md` (committed `aed57a23`).

**Branch / worktree:** `feat/recover-rejected-replan` at `.worktrees/feat-recover-rejected-replan/`.

---

## File Plan

### New files
| Path | Responsibility |
|---|---|
| `server/factory/replan-recovery.js` | Sweep + dispatcher: eligibility query, cooldown ladder, hard-cap, throttling, claim management, decision logging |
| `server/factory/replan-recovery-bootstrap.js` | One-time strategy registration + disjointness assertion vs. rejected-recovery patterns |
| `server/factory/recovery-strategies/registry.js` | Strategy registration with overlap detection; reason -> strategy lookup |
| `server/factory/recovery-strategies/rewrite-description.js` | Strategy for `cannot_generate_plan:*`, `pre_written_plan_rejected_by_quality_gate`, `Rejected by user` |
| `server/factory/recovery-strategies/decompose.js` | Strategy for `plan_quality_gate_rejected_after_2_attempts`, `replan_generation_failed` |
| `server/factory/recovery-strategies/escalate-architect.js` | Strategy for `zero_diff_across_retries`, `retry_off_scope` |
| `server/handlers/recovery-inbox-handlers.js` | MCP tool handlers: list / inspect / revive / dismiss |
| `.claude/commands/torque-recovery-inbox.md` | Slash-command workflow guide |

### Modified files
| Path | Change |
|---|---|
| `server/db/migrations.js` | Add migration v39: `recovery_attempts`, `last_recovery_at`, `recovery_history_json`, `depth` columns on `factory_work_items` |
| `server/db/factory-intake.js` | Add `needs_review`, `superseded` to `VALID_STATUSES`; add `recovery_split` to `VALID_SOURCES`; expand `CLOSED_STATUSES` |
| `server/db/config-keys.js` | Add 14 new `replan_recovery_*` keys to `KNOWN_CONFIG_KEYS` |
| `server/db/config-core.js` | Add `REPLAN_RECOVERY_CONFIG_DEFAULTS` and `getReplanRecoveryConfig()` |
| `server/factory/factory-tick.js` | Add `needs_review` and `superseded` to `CLOSED_FACTORY_WORK_ITEM_STATUSES`; invoke `runReplanRecoverySweep` after `runRejectedRecoverySweep` |
| `server/factory/rejected-recovery.js` | Add `dismissed_from_inbox:*` to `NON_RECOVERABLE_REJECT_REASON_PATTERNS` |
| `server/factory/architect-runner.js` | Add `rewriteWorkItem({workItem, history})` and `decomposeWorkItem({workItem, history, priorPlans})` helpers |
| `server/event-bus.js` | Add `factory:replan_recovery_attempted` and `factory:replan_recovery_exhausted` events |
| `server/core-tools.js` | Register `list_recovery_inbox`, `inspect_recovery_item`, `revive_recovery_item`, `dismiss_recovery_item` |
| `server/index.js` | Wire new MCP tools to handlers; invoke `cleanupStaleReplanClaims()` on startup |

---

## Task 1: Schema migration + status/source whitelisting

**Files:**
- Modify: `server/db/migrations.js` (append after migration v38)
- Modify: `server/db/factory-intake.js:11-15, 24, 3-10`
- Test: `server/tests/replan-recovery-migration.test.js`

- [ ] **Step 1: Write the failing test for the migration**

Create `server/tests/replan-recovery-migration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const { rawDb, setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

describe('replan-recovery migration v39', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`replan-recovery-migration-${Date.now()}`));
    db = rawDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('adds recovery_attempts, last_recovery_at, recovery_history_json, depth columns', () => {
    const cols = db.prepare(`PRAGMA table_info(factory_work_items)`).all();
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('recovery_attempts')).toBe(true);
    expect(colNames.has('last_recovery_at')).toBe(true);
    expect(colNames.has('recovery_history_json')).toBe(true);
    expect(colNames.has('depth')).toBe(true);
  });

  it('default values: recovery_attempts=0, depth=0, others null', () => {
    const project = factoryHealth.registerProject({
      name: `Migration Test ${Math.random().toString(16).slice(2)}`,
      path: `${testDir}/migration-test`,
      trust_level: 'dark',
    });
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'migration default test',
      description: 'check defaults',
    });
    const row = db.prepare(`SELECT recovery_attempts, last_recovery_at, recovery_history_json, depth FROM factory_work_items WHERE id = ?`).get(item.id);
    expect(row.recovery_attempts).toBe(0);
    expect(row.last_recovery_at).toBeNull();
    expect(row.recovery_history_json).toBeNull();
    expect(row.depth).toBe(0);
  });

  it('accepts needs_review and superseded as valid statuses', () => {
    const project = factoryHealth.registerProject({
      name: `Status Test ${Math.random().toString(16).slice(2)}`,
      path: `${testDir}/status-test`,
      trust_level: 'dark',
    });
    expect(() => factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'status needs_review',
      description: 'x',
      status: 'needs_review',
    })).not.toThrow();
    expect(() => factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'status superseded',
      description: 'x',
      status: 'superseded',
    })).not.toThrow();
  });

  it('accepts recovery_split as a valid source', () => {
    const project = factoryHealth.registerProject({
      name: `Source Test ${Math.random().toString(16).slice(2)}`,
      path: `${testDir}/source-test`,
      trust_level: 'dark',
    });
    expect(() => factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'recovery_split',
      title: 'split child',
      description: 'x',
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/replan-recovery-migration.test.js`
Expected: FAIL — columns and statuses don't exist yet.

- [ ] **Step 3: Add the migration**

Append to `server/db/migrations.js` immediately after the `version: 38` migration object (before the closing `];` on line 841):

```js
  {
    version: 39,
    name: 'add_replan_recovery_columns',
    up: (db) => {
      const tryAlter = (sql) => {
        try { db.prepare(sql).run(); } catch (_e) { void _e; }
      };
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0');
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN last_recovery_at TEXT');
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN recovery_history_json TEXT');
      tryAlter('ALTER TABLE factory_work_items ADD COLUMN depth INTEGER NOT NULL DEFAULT 0');
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_factory_work_items_replan_eligibility
        ON factory_work_items(status, recovery_attempts, last_recovery_at)
        WHERE status IN ('rejected', 'unactionable')
      `).run();
    },
    // No down — column drops on SQLite require table rebuild; not worth it for an additive migration.
  },
```

- [ ] **Step 4: Update VALID_SOURCES, VALID_STATUSES, and CLOSED_STATUSES**

Edit `server/db/factory-intake.js`. Around line 3-10, change `VALID_SOURCES`:

```js
const VALID_SOURCES = new Set([
  'conversational', 'conversation',
  'github_issue', 'github',
  'scheduled_scan', 'scout',
  'self_generated', 'ci',
  'api', 'webhook', 'manual',
  'plan_file', 'architect',
  'recovery_split',
]);
```

Around line 11-15, change `VALID_STATUSES`:

```js
const VALID_STATUSES = new Set([
  'pending', 'triaged', 'in_progress', 'completed', 'rejected',
  'intake', 'prioritized', 'planned', 'executing', 'verifying', 'shipped',
  'shipped_stale', 'unactionable',
  'needs_review', 'superseded',
]);
```

Around line 24, change `CLOSED_STATUSES`:

```js
const CLOSED_STATUSES = new Set(['completed', 'rejected', 'shipped', 'shipped_stale', 'unactionable', 'needs_review', 'superseded']);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/replan-recovery-migration.test.js`
Expected: PASS — all 4 assertions green.

- [ ] **Step 6: Run the full factory-intake test suite to confirm no regressions**

Run: `cd server && npx vitest run tests/factory-intake.test.js`
Expected: PASS — existing intake tests still green with expanded validators.

- [ ] **Step 7: Commit**

```bash
git add server/db/migrations.js server/db/factory-intake.js server/tests/replan-recovery-migration.test.js
git commit -m "feat(replan-recovery): schema v39 + status/source whitelisting"
```

---

## Task 2: Configuration keys + getReplanRecoveryConfig()

**Files:**
- Modify: `server/db/config-keys.js` (add to known-keys list)
- Modify: `server/db/config-core.js` (add defaults block + getter)
- Test: `server/tests/replan-recovery-config.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/replan-recovery-config.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const {
  REPLAN_RECOVERY_CONFIG_DEFAULTS,
  getReplanRecoveryConfig,
} = require('../db/config-core');

describe('replan-recovery config defaults', () => {
  it('exposes all expected default keys', () => {
    expect(REPLAN_RECOVERY_CONFIG_DEFAULTS).toMatchObject({
      replan_recovery_enabled: '0',
      replan_recovery_sweep_interval_ms: '900000',
      replan_recovery_hard_cap: '3',
      replan_recovery_max_per_project_per_sweep: '1',
      replan_recovery_max_global_per_sweep: '5',
      replan_recovery_skip_if_open_count_gte: '3',
      replan_recovery_cooldown_ms_attempt_0: '3600000',
      replan_recovery_cooldown_ms_attempt_1: '86400000',
      replan_recovery_cooldown_ms_attempt_2: '259200000',
      replan_recovery_strategy_timeout_ms: '90000',
      replan_recovery_strategy_timeout_ms_escalate: '5000',
      replan_recovery_history_max_entries: '10',
      replan_recovery_split_max_children: '5',
      replan_recovery_split_max_depth: '2',
    });
  });

  it('returns parsed numeric config and disabled flag by default', () => {
    const cfg = getReplanRecoveryConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.sweepIntervalMs).toBe(900000);
    expect(cfg.hardCap).toBe(3);
    expect(cfg.maxPerProjectPerSweep).toBe(1);
    expect(cfg.maxGlobalPerSweep).toBe(5);
    expect(cfg.skipIfOpenCountGte).toBe(3);
    expect(cfg.cooldownMs).toEqual([3600000, 86400000, 259200000]);
    expect(cfg.strategyTimeoutMs).toBe(90000);
    expect(cfg.strategyTimeoutMsEscalate).toBe(5000);
    expect(cfg.historyMaxEntries).toBe(10);
    expect(cfg.splitMaxChildren).toBe(5);
    expect(cfg.splitMaxDepth).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/replan-recovery-config.test.js`
Expected: FAIL — `REPLAN_RECOVERY_CONFIG_DEFAULTS` not exported.

- [ ] **Step 3: Add the 14 keys to `KNOWN_CONFIG_KEYS`**

In `server/db/config-keys.js`, find the existing `'reject_recovery_enabled',` entry around line 131 and add immediately after the `reject_recovery_*` block:

```js
  // replan-recovery (idea-failure recovery sweep)
  'replan_recovery_enabled',
  'replan_recovery_sweep_interval_ms',
  'replan_recovery_hard_cap',
  'replan_recovery_max_per_project_per_sweep',
  'replan_recovery_max_global_per_sweep',
  'replan_recovery_skip_if_open_count_gte',
  'replan_recovery_cooldown_ms_attempt_0',
  'replan_recovery_cooldown_ms_attempt_1',
  'replan_recovery_cooldown_ms_attempt_2',
  'replan_recovery_strategy_timeout_ms',
  'replan_recovery_strategy_timeout_ms_escalate',
  'replan_recovery_history_max_entries',
  'replan_recovery_split_max_children',
  'replan_recovery_split_max_depth',
```

- [ ] **Step 4: Add the defaults block + getter to `config-core.js`**

In `server/db/config-core.js`, immediately after the `REJECT_RECOVERY_CONFIG_DEFAULTS` block (around line 42-50), add:

```js
const REPLAN_RECOVERY_CONFIG_DEFAULTS = Object.freeze({
  replan_recovery_enabled: '0',
  replan_recovery_sweep_interval_ms: '900000',         // 15 min
  replan_recovery_hard_cap: '3',
  replan_recovery_max_per_project_per_sweep: '1',
  replan_recovery_max_global_per_sweep: '5',
  replan_recovery_skip_if_open_count_gte: '3',
  replan_recovery_cooldown_ms_attempt_0: '3600000',    // 1 hour
  replan_recovery_cooldown_ms_attempt_1: '86400000',   // 1 day
  replan_recovery_cooldown_ms_attempt_2: '259200000',  // 3 days
  replan_recovery_strategy_timeout_ms: '90000',        // 90s for architect-calling strategies
  replan_recovery_strategy_timeout_ms_escalate: '5000', // 5s for escalate (no LLM)
  replan_recovery_history_max_entries: '10',
  replan_recovery_split_max_children: '5',
  replan_recovery_split_max_depth: '2',
});
```

Then in `readConfigWithDefault` (around line 70-78), extend it to fall back to `REPLAN_RECOVERY_CONFIG_DEFAULTS` after the existing `REJECT_RECOVERY_CONFIG_DEFAULTS` lookup. The exact shape may differ in your file — adapt while preserving the goal: "fall back to REPLAN defaults after REJECT defaults."

After `getRejectRecoveryConfig`, add:

```js
function getReplanRecoveryConfig() {
  const intDefault = (key) => Number.parseInt(REPLAN_RECOVERY_CONFIG_DEFAULTS[key], 10);
  const intRead = (key) => parsePositiveIntegerConfigValue(readConfigWithDefault(key), intDefault(key));
  return {
    enabled: parseBooleanConfigValue(
      readConfigWithDefault('replan_recovery_enabled'),
      parseBooleanConfigValue(REPLAN_RECOVERY_CONFIG_DEFAULTS.replan_recovery_enabled),
    ),
    sweepIntervalMs: intRead('replan_recovery_sweep_interval_ms'),
    hardCap: intRead('replan_recovery_hard_cap'),
    maxPerProjectPerSweep: intRead('replan_recovery_max_per_project_per_sweep'),
    maxGlobalPerSweep: intRead('replan_recovery_max_global_per_sweep'),
    skipIfOpenCountGte: intRead('replan_recovery_skip_if_open_count_gte'),
    cooldownMs: [
      intRead('replan_recovery_cooldown_ms_attempt_0'),
      intRead('replan_recovery_cooldown_ms_attempt_1'),
      intRead('replan_recovery_cooldown_ms_attempt_2'),
    ],
    strategyTimeoutMs: intRead('replan_recovery_strategy_timeout_ms'),
    strategyTimeoutMsEscalate: intRead('replan_recovery_strategy_timeout_ms_escalate'),
    historyMaxEntries: intRead('replan_recovery_history_max_entries'),
    splitMaxChildren: intRead('replan_recovery_split_max_children'),
    splitMaxDepth: intRead('replan_recovery_split_max_depth'),
  };
}
```

Add `REPLAN_RECOVERY_CONFIG_DEFAULTS` and `getReplanRecoveryConfig` to the `module.exports` block at the bottom of the file (mirror how `REJECT_RECOVERY_CONFIG_DEFAULTS` is exported).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/replan-recovery-config.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/config-keys.js server/db/config-core.js server/tests/replan-recovery-config.test.js
git commit -m "feat(replan-recovery): config keys and defaults"
```

---

## Task 3: Strategy registry with overlap detection

**Files:**
- Create: `server/factory/recovery-strategies/registry.js`
- Test: `server/tests/recovery-strategies-registry.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/recovery-strategies-registry.test.js`:

```js
'use strict';

const { describe, it, expect, beforeEach } = require('vitest');
const { createRegistry } = require('../factory/recovery-strategies/registry');

const stubStrategy = (overrides = {}) => ({
  name: overrides.name || 'stub',
  reasonPatterns: overrides.reasonPatterns || [/^stub_reason$/],
  async replan() { return { outcome: 'rewrote', updates: {} }; },
  ...overrides,
});

describe('recovery-strategies registry', () => {
  let registry;
  beforeEach(() => { registry = createRegistry(); });

  it('finds a registered strategy by reject_reason', () => {
    registry.register(stubStrategy({
      name: 'rewrite',
      reasonPatterns: [/^cannot_generate_plan:/i],
    }));
    const found = registry.findByReason('cannot_generate_plan: empty desc');
    expect(found).not.toBeNull();
    expect(found.name).toBe('rewrite');
  });

  it('returns null when no strategy matches', () => {
    expect(registry.findByReason('unknown_reason')).toBeNull();
  });

  it('throws on overlap with an already-registered pattern', () => {
    registry.register(stubStrategy({
      name: 'first',
      reasonPatterns: [/^cannot_generate_plan:/i],
    }));
    expect(() => registry.register(stubStrategy({
      name: 'second',
      reasonPatterns: [/^cannot_generate_plan: empty/i],
    }))).toThrow(/overlap/i);
  });

  it('throws when strategy is missing required shape', () => {
    expect(() => registry.register({ name: 'bad' })).toThrow();
    expect(() => registry.register({ reasonPatterns: [/x/] })).toThrow();
    expect(() => registry.register({ name: 'bad', reasonPatterns: [/x/] })).toThrow(/replan/i);
  });

  it('lists all registered strategies', () => {
    registry.register(stubStrategy({ name: 'a', reasonPatterns: [/^a$/] }));
    registry.register(stubStrategy({ name: 'b', reasonPatterns: [/^b$/] }));
    const list = registry.list();
    expect(list.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('exposes a flattened reason-pattern view (for disjointness check vs. rejected-recovery)', () => {
    registry.register(stubStrategy({
      name: 'rewrite',
      reasonPatterns: [/^cannot_generate_plan:/i, /^Rejected by user$/],
    }));
    const all = registry.allReasonPatterns();
    expect(all.length).toBe(2);
    expect(all.some((p) => p.test('cannot_generate_plan: x'))).toBe(true);
    expect(all.some((p) => p.test('Rejected by user'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run tests/recovery-strategies-registry.test.js`
Expected: FAIL — registry module doesn't exist.

- [ ] **Step 3: Implement the registry**

Create `server/factory/recovery-strategies/registry.js`:

```js
'use strict';

function patternsOverlap(a, b) {
  // Two regexes overlap if either is a substring of the other's source. A
  // cheap structural check catches the common "more-specific subpattern"
  // mistake. False positives erring toward "they overlap" are acceptable;
  // false negatives are not.
  const sourceA = a.source.toLowerCase();
  const sourceB = b.source.toLowerCase();
  if (sourceA === sourceB) return true;
  if (sourceA.includes(sourceB) || sourceB.includes(sourceA)) return true;
  return false;
}

function validateStrategyShape(strategy) {
  if (!strategy || typeof strategy !== 'object') {
    throw new Error('strategy must be an object');
  }
  if (typeof strategy.name !== 'string' || !strategy.name.trim()) {
    throw new Error('strategy.name is required (string)');
  }
  if (!Array.isArray(strategy.reasonPatterns) || strategy.reasonPatterns.length === 0) {
    throw new Error(`strategy.reasonPatterns is required (non-empty array of RegExp) for "${strategy.name}"`);
  }
  for (const p of strategy.reasonPatterns) {
    if (!(p instanceof RegExp)) {
      throw new Error(`strategy.reasonPatterns must contain RegExp instances (strategy "${strategy.name}")`);
    }
  }
  if (typeof strategy.replan !== 'function') {
    throw new Error(`strategy.replan(...) function is required for "${strategy.name}"`);
  }
}

function createRegistry() {
  const strategies = new Map();

  function register(strategy) {
    validateStrategyShape(strategy);
    if (strategies.has(strategy.name)) {
      throw new Error(`strategy "${strategy.name}" already registered`);
    }
    for (const existing of strategies.values()) {
      for (const newPat of strategy.reasonPatterns) {
        for (const existingPat of existing.reasonPatterns) {
          if (patternsOverlap(newPat, existingPat)) {
            throw new Error(
              `pattern overlap: "${strategy.name}" pattern ${newPat} overlaps "${existing.name}" pattern ${existingPat}`,
            );
          }
        }
      }
    }
    strategies.set(strategy.name, strategy);
  }

  function findByReason(reason) {
    if (typeof reason !== 'string' || !reason) return null;
    for (const strategy of strategies.values()) {
      if (strategy.reasonPatterns.some((p) => p.test(reason))) {
        return strategy;
      }
    }
    return null;
  }

  function list() {
    return Array.from(strategies.values());
  }

  function allReasonPatterns() {
    const out = [];
    for (const s of strategies.values()) {
      for (const p of s.reasonPatterns) out.push(p);
    }
    return out;
  }

  function clear() { strategies.clear(); }

  return { register, findByReason, list, allReasonPatterns, clear };
}

const defaultRegistry = createRegistry();

module.exports = {
  createRegistry,
  defaultRegistry,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/recovery-strategies-registry.test.js`
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add server/factory/recovery-strategies/registry.js server/tests/recovery-strategies-registry.test.js
git commit -m "feat(replan-recovery): strategy registry with overlap detection"
```

---

## Task 4: Mock-architect test helper

**Files:**
- Create: `server/tests/helpers/mock-architect.js`

- [ ] **Step 1: Create the helper**

Create `server/tests/helpers/mock-architect.js`:

```js
'use strict';

/**
 * Mock architectRunner for strategy + dispatcher tests.
 * Returns an object with rewriteWorkItem and decomposeWorkItem methods
 * that resolve to canned responses.
 */
function createMockArchitect({
  rewrite = null,
  decompose = null,
  rewriteImpl = null,
  decomposeImpl = null,
  throwOn = null,        // 'rewrite' | 'decompose' | null
  delayMs = 0,
} = {}) {
  const calls = { rewrite: [], decompose: [] };

  async function delay() {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return {
    async rewriteWorkItem(args) {
      calls.rewrite.push(args);
      await delay();
      if (throwOn === 'rewrite') throw new Error('mock-architect: rewrite forced failure');
      if (rewriteImpl) return rewriteImpl(args);
      return rewrite ?? { title: '', description: '', acceptance_criteria: [] };
    },
    async decomposeWorkItem(args) {
      calls.decompose.push(args);
      await delay();
      if (throwOn === 'decompose') throw new Error('mock-architect: decompose forced failure');
      if (decomposeImpl) return decomposeImpl(args);
      return decompose ?? { children: [] };
    },
    calls,
  };
}

module.exports = { createMockArchitect };
```

- [ ] **Step 2: Commit**

```bash
git add server/tests/helpers/mock-architect.js
git commit -m "test(replan-recovery): mock-architect helper for strategy tests"
```

---

(Plan continues in part 2 — tasks 5 through 16. See `2026-04-30-rejected-recovery-replan-part2.md` in the same directory.)
