# Factory Auto-Recovery Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TORQUE's ad-hoc paused-project reconcilers with a pluggable Auto-Recovery Engine that classifies failures declaratively, selects recovery strategies from a registry, and unsticks today's two observed failure classes (dotnet file-lock races, Codex phantom plan-generation) with a surface that makes every future failure class a one-rule, one-strategy patch.

**Architecture:** Three layers — (1) plugin-contract extension for `classifierRules` + `recoveryStrategies`; (2) core engine (`server/factory/auto-recovery/`) that reads decision-log history, classifies via registered rules, runs a selected strategy, and writes every step back to the decision log; (3) built-in `auto-recovery-core` plugin (always-loaded) shipping day-one rules + strategies. Engine runs from `factory-tick.js` and `startup-reconciler.js`. Existing `verify-stall-recovery.js` stays live as belt-and-suspenders; one-line cooldown gate prevents double-retries.

**Tech Stack:** Node.js, better-sqlite3, vitest, existing TORQUE factory subsystems (decision-log, loop-controller, factory-decisions DB table, plugin loader).

**Spec:** `docs/superpowers/specs/2026-04-21-factory-auto-recovery-engine-design.md`

**Test fixture convention:** Tests seed schemas by iterating `statement.split(';')` into individual `db.prepare(stmt).run()` calls rather than multi-statement DDL. Example helper used across tests:

```javascript
function runDDL(db, sql) {
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    db.prepare(stmt).run();
  }
}
```

---

## File Structure

**New files (created by this plan):**

Engine core:
- `server/factory/auto-recovery/index.js` — public entrypoint: `createAutoRecoveryEngine({ db, services })`, exposes `tick()` and `reconcileOnStartup()`
- `server/factory/auto-recovery/backoff.js` — pure exponential backoff helper, single responsibility
- `server/factory/auto-recovery/classifier.js` — matches a decision against registered rules, returns classification
- `server/factory/auto-recovery/registry.js` — holds merged rule/strategy tables from all loaded plugins
- `server/factory/auto-recovery/engine.js` — the recon loop: fetch candidates → classify → pick strategy → run → log
- `server/factory/auto-recovery/services.js` — builds the services bundle injected into `strategy.run(ctx)`, including `cleanupWorktreeBuildArtifacts`
- `server/factory/auto-recovery/candidate-query.js` — the SQL for "paused projects eligible for recovery" (fixes VERIFY_FAIL bug)

Built-in plugin:
- `server/plugins/auto-recovery-core/index.js` — plugin contract shell, registers rules + strategies
- `server/plugins/auto-recovery-core/rules.js` — 5 day-one classifier rules
- `server/plugins/auto-recovery-core/strategies/retry.js`
- `server/plugins/auto-recovery-core/strategies/clean-and-retry.js`
- `server/plugins/auto-recovery-core/strategies/retry-with-fresh-session.js`
- `server/plugins/auto-recovery-core/strategies/fallback-provider.js`
- `server/plugins/auto-recovery-core/strategies/retry-plan-generation.js`
- `server/plugins/auto-recovery-core/strategies/fresh-worktree.js`
- `server/plugins/auto-recovery-core/strategies/reject-and-advance.js`
- `server/plugins/auto-recovery-core/strategies/escalate.js`

MCP handlers:
- `server/handlers/auto-recovery-handlers.js` — `listRecoveryStrategies`, `getRecoveryHistory`, `clearAutoRecovery`, `triggerAutoRecovery`

Tests (one per unit + integration + E2E):
- `server/tests/auto-recovery-backoff.test.js`
- `server/tests/auto-recovery-classifier.test.js`
- `server/tests/auto-recovery-registry.test.js`
- `server/tests/auto-recovery-candidate-query.test.js`
- `server/tests/auto-recovery-services.test.js`
- `server/tests/auto-recovery-engine.test.js`
- `server/tests/auto-recovery-core-rules.test.js`
- `server/tests/auto-recovery-strategies-simple.test.js`
- `server/tests/auto-recovery-strategies-complex.test.js`
- `server/tests/auto-recovery-plugin-contract.test.js`
- `server/tests/auto-recovery-mcp-tools.test.js`
- `server/tests/auto-recovery-e2e-sourcelink.test.js`
- `server/tests/auto-recovery-e2e-never-started.test.js`
- `server/tests/auto-recovery-deconfliction.test.js`
- `server/tests/auto-recovery-schema.test.js`
- `server/tests/auto-recovery-wiring.test.js`
- `server/tests/auto-recovery-rest-route.test.js`

**Modified files:**
- `server/plugins/plugin-contract.js` — add `classifierRules`, `recoveryStrategies` to `OPTIONAL_METHODS`
- `server/db/schema-migrations.js` — add 4 ALTER TABLE columns on `factory_projects`
- `server/db/factory-decisions.js` — add `'auto-recovery'` to `VALID_ACTORS`
- `server/index.js` — add `'auto-recovery-core'` to `DEFAULT_PLUGIN_NAMES`; wire engine into DI container
- `server/factory/factory-tick.js` — call `autoRecoveryEngine.tick()` each tick
- `server/factory/startup-reconciler.js` — call `autoRecoveryEngine.reconcileOnStartup()` on startup
- `server/factory/verify-stall-recovery.js` — add cooldown skip check
- `server/tool-defs/factory-defs.js` — register 4 new MCP tools
- `server/tool-annotations.js` — add annotations for new tools
- `server/core-tools.js` — route 4 new handlers
- `server/api/routes/factory-routes.js` — add `GET /api/v2/factory/projects/:id/recovery_history`
- Dashboard files (exact paths resolved during Task 14)

---

## Task 1: Extend plugin contract for recovery registrations

**Files:**
- Modify: `server/plugins/plugin-contract.js`
- Test: `server/tests/auto-recovery-plugin-contract.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-plugin-contract.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const { validatePlugin } = require('../plugins/plugin-contract');

function baseValid() {
  return {
    name: 'p', version: '1', install: () => {}, uninstall: () => {},
    middleware: () => null, mcpTools: () => [],
    eventHandlers: () => ({}), configSchema: () => null,
  };
}

describe('plugin-contract auto-recovery fields', () => {
  it('accepts classifierRules as an array', () => {
    const r = validatePlugin({ ...baseValid(), classifierRules: [] });
    expect(r.valid).toBe(true);
  });
  it('accepts recoveryStrategies as an array', () => {
    const r = validatePlugin({ ...baseValid(), recoveryStrategies: [] });
    expect(r.valid).toBe(true);
  });
  it('rejects classifierRules that is not an array', () => {
    const r = validatePlugin({ ...baseValid(), classifierRules: 'nope' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /classifierRules/.test(e))).toBe(true);
  });
  it('rejects recoveryStrategies that is not an array', () => {
    const r = validatePlugin({ ...baseValid(), recoveryStrategies: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /recoveryStrategies/.test(e))).toBe(true);
  });
  it('accepts plugins that omit both fields', () => {
    expect(validatePlugin(baseValid()).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-plugin-contract.test.js`
Expected: array-type checks don't exist yet — 2 tests fail.

- [ ] **Step 3: Add fields to plugin-contract.js**

Edit `server/plugins/plugin-contract.js`. Extend `OPTIONAL_METHODS`:

```javascript
const OPTIONAL_METHODS = [
  { name: 'tierTools', type: 'function' },
  { name: 'classifierRules', type: 'object' },
  { name: 'recoveryStrategies', type: 'object' },
];
```

Replace the optional-method validation loop with:

```javascript
for (const { name, type } of OPTIONAL_METHODS) {
  if (name in plugin) {
    if (typeof plugin[name] !== type) {
      errors.push(`optional method ${name} must be a ${type} when provided`);
    } else if ((name === 'classifierRules' || name === 'recoveryStrategies')
               && !Array.isArray(plugin[name])) {
      errors.push(`optional method ${name} must be an array when provided`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-plugin-contract.test.js`
Expected: all 5 PASS.

- [ ] **Step 5: Run loader tests to confirm no regression**

Run: `npx vitest run server/plugins/loader.test.js`
Expected: all prior tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add server/plugins/plugin-contract.js server/tests/auto-recovery-plugin-contract.test.js
git commit -m "feat(plugins): accept classifierRules and recoveryStrategies as optional plugin fields"
```

---

## Task 2: Add auto-recovery columns to `factory_projects` + whitelist `auto-recovery` actor

**Files:**
- Modify: `server/db/schema-migrations.js` (around line 187)
- Modify: `server/db/factory-decisions.js` (line 6, `VALID_ACTORS`)
- Test: `server/tests/auto-recovery-schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-schema.test.js`:

```javascript
'use strict';
const { describe, it, expect, beforeAll } = require('vitest');
const Database = require('better-sqlite3');
const { runSchemaMigrations } = require('../db/schema-migrations');

describe('factory_projects auto-recovery columns', () => {
  let db;
  beforeAll(() => {
    db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_projects (
      id TEXT PRIMARY KEY, name TEXT, status TEXT,
      loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT
    )`).run();
    runSchemaMigrations(db);
  });

  const expected = [
    { name: 'auto_recovery_attempts', type: 'INTEGER', dflt: '0' },
    { name: 'auto_recovery_last_action_at', type: 'TEXT', dflt: null },
    { name: 'auto_recovery_exhausted', type: 'INTEGER', dflt: '0' },
    { name: 'auto_recovery_last_strategy', type: 'TEXT', dflt: null },
  ];

  for (const col of expected) {
    it(`adds column ${col.name}`, () => {
      const columns = db.prepare('PRAGMA table_info(factory_projects)').all();
      const found = columns.find(c => c.name === col.name);
      expect(found).toBeTruthy();
      expect(String(found.type).toUpperCase()).toBe(col.type);
      if (col.dflt === null) {
        expect(found.dflt_value).toBeNull();
      } else {
        expect(String(found.dflt_value)).toBe(col.dflt);
      }
    });
  }

  it('is idempotent (running again does not throw)', () => {
    expect(() => runSchemaMigrations(db)).not.toThrow();
  });
});

describe('factory-decisions VALID_ACTORS', () => {
  it('accepts auto-recovery as a valid actor', () => {
    const { recordDecision, setDb } = require('../db/factory-decisions');
    const db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      stage TEXT, actor TEXT, action TEXT,
      reasoning TEXT, inputs_json TEXT, outcome_json TEXT,
      confidence REAL, batch_id TEXT, created_at TEXT
    )`).run();
    setDb(db);
    expect(() => recordDecision({
      project_id: 'p1', stage: 'verify', actor: 'auto-recovery',
      action: 'auto_recovery_classified', confidence: 1,
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-schema.test.js`
Expected: all fail.

- [ ] **Step 3: Add the columns to schema-migrations.js**

In `server/db/schema-migrations.js`, immediately after the existing `verify_recovery_attempts` ALTER block (around line 191), insert 4 more:

```javascript
  try {
    db.exec(`ALTER TABLE factory_projects ADD COLUMN auto_recovery_attempts INTEGER DEFAULT 0`);
  } catch (_e) { void _e; }
  try {
    db.exec(`ALTER TABLE factory_projects ADD COLUMN auto_recovery_last_action_at TEXT`);
  } catch (_e) { void _e; }
  try {
    db.exec(`ALTER TABLE factory_projects ADD COLUMN auto_recovery_exhausted INTEGER DEFAULT 0`);
  } catch (_e) { void _e; }
  try {
    db.exec(`ALTER TABLE factory_projects ADD COLUMN auto_recovery_last_strategy TEXT`);
  } catch (_e) { void _e; }
```

(Yes, production migration code uses `db.exec` on ALTER statements — same pattern as the surrounding code. Only test fixtures avoid multi-statement `exec`.)

- [ ] **Step 4: Whitelist `auto-recovery` as a valid actor**

In `server/db/factory-decisions.js`, change line 6 from:

```javascript
const VALID_ACTORS = new Set(['health_model', 'architect', 'planner', 'executor', 'verifier', 'human']);
```

to:

```javascript
const VALID_ACTORS = new Set(['health_model', 'architect', 'planner', 'executor', 'verifier', 'human', 'auto-recovery']);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-schema.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema-migrations.js server/db/factory-decisions.js server/tests/auto-recovery-schema.test.js
git commit -m "feat(factory): add auto-recovery columns and whitelist 'auto-recovery' actor"
```

---

## Task 3: Exponential backoff helper

**Files:**
- Create: `server/factory/auto-recovery/backoff.js`
- Test: `server/tests/auto-recovery-backoff.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-backoff.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const { nextBackoffMs, isWithinCooldown, BACKOFF_CAP_MS, BASE_BACKOFF_MS } =
  require('../factory/auto-recovery/backoff');

describe('auto-recovery backoff', () => {
  it('exports a 30-second base and 30-minute cap', () => {
    expect(BASE_BACKOFF_MS).toBe(30_000);
    expect(BACKOFF_CAP_MS).toBe(30 * 60 * 1000);
  });

  it('returns base for attempt 0', () => {
    expect(nextBackoffMs(0)).toBe(30_000);
  });

  it('doubles per attempt until cap', () => {
    expect(nextBackoffMs(1)).toBe(60_000);
    expect(nextBackoffMs(2)).toBe(120_000);
    expect(nextBackoffMs(3)).toBe(240_000);
    expect(nextBackoffMs(4)).toBe(480_000);
    expect(nextBackoffMs(5)).toBe(960_000);
  });

  it('caps at 30 minutes', () => {
    expect(nextBackoffMs(10)).toBe(30 * 60 * 1000);
    expect(nextBackoffMs(100)).toBe(30 * 60 * 1000);
  });

  it('treats non-finite attempts as 0', () => {
    expect(nextBackoffMs(NaN)).toBe(30_000);
    expect(nextBackoffMs(-1)).toBe(30_000);
    expect(nextBackoffMs(undefined)).toBe(30_000);
  });

  it('isWithinCooldown is true when now < lastAction + backoff', () => {
    const now = Date.parse('2026-04-21T12:00:00Z');
    expect(isWithinCooldown('2026-04-21T11:59:30Z', 1, now)).toBe(true);
  });

  it('isWithinCooldown is false when cooldown elapsed', () => {
    const now = Date.parse('2026-04-21T12:05:00Z');
    expect(isWithinCooldown('2026-04-21T11:59:30Z', 1, now)).toBe(false);
  });

  it('isWithinCooldown is false when lastAction is null', () => {
    expect(isWithinCooldown(null, 3, Date.now())).toBe(false);
  });

  it('isWithinCooldown is false when lastAction is unparseable', () => {
    expect(isWithinCooldown('not a date', 3, Date.now())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-backoff.test.js`
Expected: module not found.

- [ ] **Step 3: Implement backoff.js**

Create `server/factory/auto-recovery/backoff.js`:

```javascript
'use strict';

const BASE_BACKOFF_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

function nextBackoffMs(attempts) {
  const n = Number.isFinite(attempts) && attempts >= 0 ? attempts : 0;
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, n), BACKOFF_CAP_MS);
}

function isWithinCooldown(lastActionAt, attempts, nowMs = Date.now()) {
  if (!lastActionAt) return false;
  const lastMs = Date.parse(lastActionAt);
  if (!Number.isFinite(lastMs)) return false;
  return (nowMs - lastMs) < nextBackoffMs(attempts);
}

module.exports = { BASE_BACKOFF_MS, BACKOFF_CAP_MS, nextBackoffMs, isWithinCooldown };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-backoff.test.js`
Expected: all 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/auto-recovery/backoff.js server/tests/auto-recovery-backoff.test.js
git commit -m "feat(auto-recovery): exponential backoff helper with 30s base and 30min cap"
```

---

## Task 4: Classifier module

**Files:**
- Create: `server/factory/auto-recovery/classifier.js`
- Test: `server/tests/auto-recovery-classifier.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-classifier.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const { createClassifier, UNKNOWN_CLASSIFICATION } =
  require('../factory/auto-recovery/classifier');

const rule1 = {
  name: 'file_lock', category: 'transient', priority: 100, confidence: 0.9,
  match: {
    stage: 'verify', action: 'worktree_verify_failed',
    outcome_path: 'output_preview',
    outcome_regex: 'being used by another process',
  },
  suggested_strategies: ['clean_and_retry', 'retry'],
};

const rule2 = {
  name: 'fallback_phantom', category: 'sandbox_interrupt', priority: 50, confidence: 0.7,
  match: { action: 'cannot_generate_plan' },
  suggested_strategies: ['retry_with_fresh_session'],
};

const rule3 = {
  name: 'catch_all', category: 'unknown', priority: 10, confidence: 0.1,
  match: {},
  suggested_strategies: ['escalate'],
};

const fnRule = {
  name: 'by_function', category: 'transient', priority: 200, confidence: 1.0,
  match_fn: (d) => d.outcome?.retry_attempts === 99,
  suggested_strategies: ['retry'],
};

describe('classifier', () => {
  it('returns UNKNOWN when no rules are registered', () => {
    const c = createClassifier({ rules: [] });
    expect(c.classify({ stage: 'verify' })).toEqual(UNKNOWN_CLASSIFICATION);
  });

  it('matches a rule by stage + action + outcome regex', () => {
    const c = createClassifier({ rules: [rule1] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { output_preview: 'error: being used by another process' },
    });
    expect(r.category).toBe('transient');
    expect(r.matched_rule).toBe('file_lock');
    expect(r.suggested_strategies).toEqual(['clean_and_retry', 'retry']);
  });

  it('does not match when outcome regex fails', () => {
    const c = createClassifier({ rules: [rule1] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { output_preview: 'different error' },
    });
    expect(r.category).toBe('unknown');
  });

  it('picks highest-priority rule on multi-match', () => {
    const c = createClassifier({ rules: [rule3, rule2] });
    const r = c.classify({ action: 'cannot_generate_plan' });
    expect(r.matched_rule).toBe('fallback_phantom');
  });

  it('match_fn rules are honored', () => {
    const c = createClassifier({ rules: [fnRule] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { retry_attempts: 99 },
    });
    expect(r.matched_rule).toBe('by_function');
  });

  it('malformed rules are skipped', () => {
    const c = createClassifier({ rules: [{ name: 'broken' }] });
    expect(c.classify({ action: 'anything' }).category).toBe('unknown');
  });

  it('classification surfaces confidence from matched rule', () => {
    const c = createClassifier({ rules: [rule1] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { output_preview: 'being used by another process' },
    });
    expect(r.confidence).toBe(0.9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-classifier.test.js`
Expected: module not found.

- [ ] **Step 3: Implement classifier.js**

Create `server/factory/auto-recovery/classifier.js`:

```javascript
'use strict';

const UNKNOWN_CLASSIFICATION = Object.freeze({
  category: 'unknown',
  matched_rule: null,
  confidence: 0,
  suggested_strategies: ['retry', 'escalate'],
});

function getOutcomePath(outcome, pathStr) {
  if (!outcome || !pathStr) return null;
  let cur = outcome;
  for (const p of String(pathStr).split('.')) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur == null ? null : String(cur);
}

function matchDeclarative(rule, decision) {
  const m = rule.match || {};
  if (m.stage && decision.stage !== m.stage) return false;
  if (m.action && decision.action !== m.action) return false;
  if (m.reasoning_regex) {
    const re = new RegExp(m.reasoning_regex);
    if (!decision.reasoning || !re.test(decision.reasoning)) return false;
  }
  if (m.outcome_regex) {
    const target = m.outcome_path
      ? getOutcomePath(decision.outcome, m.outcome_path)
      : JSON.stringify(decision.outcome || {});
    if (target == null) return false;
    if (!new RegExp(m.outcome_regex, 'i').test(target)) return false;
  }
  return true;
}

function ruleMatches(rule, decision) {
  if (!rule || typeof rule !== 'object') return false;
  if (!rule.name || !rule.category) return false;
  if (typeof rule.match_fn === 'function') {
    try { return !!rule.match_fn(decision); } catch { return false; }
  }
  if (!rule.match || typeof rule.match !== 'object') return false;
  return matchDeclarative(rule, decision);
}

function createClassifier({ rules }) {
  const sorted = Array.isArray(rules)
    ? [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0))
    : [];

  function classify(decision) {
    if (!decision || typeof decision !== 'object') return UNKNOWN_CLASSIFICATION;
    for (const rule of sorted) {
      if (ruleMatches(rule, decision)) {
        return {
          category: rule.category,
          matched_rule: rule.name,
          confidence: typeof rule.confidence === 'number' ? rule.confidence : 0.5,
          suggested_strategies: Array.isArray(rule.suggested_strategies)
            ? [...rule.suggested_strategies]
            : ['retry', 'escalate'],
        };
      }
    }
    return UNKNOWN_CLASSIFICATION;
  }

  return { classify };
}

module.exports = { createClassifier, UNKNOWN_CLASSIFICATION };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-classifier.test.js`
Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/auto-recovery/classifier.js server/tests/auto-recovery-classifier.test.js
git commit -m "feat(auto-recovery): declarative classifier with priority tiebreak and match_fn escape hatch"
```

---

## Task 5: Registry module

**Files:**
- Create: `server/factory/auto-recovery/registry.js`
- Test: `server/tests/auto-recovery-registry.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-registry.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const { createRegistry } = require('../factory/auto-recovery/registry');

describe('auto-recovery registry', () => {
  it('merges rules from plugins, sorted by priority desc', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('A', {
      classifierRules: [{ name: 'a1', category: 'transient', priority: 10, match: {} }],
      recoveryStrategies: [],
    });
    reg.registerFromPlugin('B', {
      classifierRules: [{ name: 'b1', category: 'transient', priority: 20, match: {} }],
      recoveryStrategies: [],
    });
    expect(reg.getRules().map(r => r.name)).toEqual(['b1', 'a1']);
  });

  it('merges strategies from plugins by name', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('A', {
      classifierRules: [],
      recoveryStrategies: [{ name: 'retry', applicable_categories: ['transient'], run: async () => ({}) }],
    });
    reg.registerFromPlugin('B', {
      classifierRules: [],
      recoveryStrategies: [{ name: 'escalate', applicable_categories: ['any'], run: async () => ({}) }],
    });
    expect(reg.getStrategyByName('retry')).toBeTruthy();
    expect(reg.getStrategyByName('escalate')).toBeTruthy();
    expect(reg.getStrategyByName('missing')).toBeNull();
  });

  it('pick() returns the first suggested strategy applicable to the category', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('p', {
      classifierRules: [],
      recoveryStrategies: [
        { name: 'retry', applicable_categories: ['transient'], run: async () => ({}) },
        { name: 'escalate', applicable_categories: ['unknown', 'terminal'], run: async () => ({}) },
      ],
    });
    const picked = reg.pick({
      category: 'transient',
      suggested_strategies: ['clean_and_retry', 'retry'],
    });
    expect(picked.name).toBe('retry');
  });

  it('pick() returns null when no suggested strategies apply', () => {
    const reg = createRegistry();
    expect(reg.pick({ category: 'x', suggested_strategies: ['none'] })).toBeNull();
  });

  it('rejects malformed rules, keeps valid ones', () => {
    const reg = createRegistry({ logger: { warn: () => {} } });
    reg.registerFromPlugin('p', {
      classifierRules: [
        { name: 'good', category: 'transient', priority: 1, match: {} },
        { category: 'bad' },
      ],
      recoveryStrategies: [],
    });
    expect(reg.getRules().map(r => r.name)).toEqual(['good']);
  });

  it('rejects strategies without run()', () => {
    const reg = createRegistry({ logger: { warn: () => {} } });
    reg.registerFromPlugin('p', {
      classifierRules: [],
      recoveryStrategies: [
        { name: 'nope', applicable_categories: ['any'] },
        { name: 'ok', applicable_categories: ['any'], run: async () => ({}) },
      ],
    });
    expect(reg.getStrategyByName('nope')).toBeNull();
    expect(reg.getStrategyByName('ok')).toBeTruthy();
  });

  it('getStrategies() returns all registered strategies', () => {
    const reg = createRegistry();
    reg.registerFromPlugin('p', {
      classifierRules: [],
      recoveryStrategies: [
        { name: 's1', applicable_categories: ['a'], run: async () => ({}) },
        { name: 's2', applicable_categories: ['b'], run: async () => ({}) },
      ],
    });
    expect(reg.getStrategies().map(s => s.name).sort()).toEqual(['s1', 's2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-registry.test.js`
Expected: module not found.

- [ ] **Step 3: Implement registry.js**

Create `server/factory/auto-recovery/registry.js`:

```javascript
'use strict';

function isValidRule(r) {
  return !!(r && typeof r === 'object'
    && typeof r.name === 'string' && r.name.length
    && typeof r.category === 'string' && r.category.length
    && (typeof r.match === 'object' || typeof r.match_fn === 'function'));
}

function isValidStrategy(s) {
  return !!(s && typeof s === 'object'
    && typeof s.name === 'string' && s.name.length
    && typeof s.run === 'function'
    && Array.isArray(s.applicable_categories));
}

function createRegistry({ logger = { warn: () => {} } } = {}) {
  const rules = [];
  const strategies = new Map();

  function registerFromPlugin(pluginName, plugin) {
    if (Array.isArray(plugin?.classifierRules)) {
      for (const rule of plugin.classifierRules) {
        if (isValidRule(rule)) rules.push({ ...rule, _plugin: pluginName });
        else logger.warn('auto-recovery: rejected invalid classifier rule', { plugin: pluginName, rule });
      }
    }
    if (Array.isArray(plugin?.recoveryStrategies)) {
      for (const strat of plugin.recoveryStrategies) {
        if (isValidStrategy(strat)) {
          if (strategies.has(strat.name)) {
            logger.warn('auto-recovery: duplicate strategy name; last registration wins', {
              name: strat.name, plugin: pluginName,
            });
          }
          strategies.set(strat.name, { ...strat, _plugin: pluginName });
        } else {
          logger.warn('auto-recovery: rejected invalid strategy', { plugin: pluginName, strat });
        }
      }
    }
  }

  function getRules() {
    return [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  function getStrategies() {
    return [...strategies.values()];
  }

  function getStrategyByName(name) {
    return strategies.get(name) || null;
  }

  function pick(classification) {
    if (!classification?.suggested_strategies?.length) return null;
    for (const name of classification.suggested_strategies) {
      const strat = strategies.get(name);
      if (!strat) continue;
      if (!strat.applicable_categories.includes(classification.category)
          && !strat.applicable_categories.includes('any')) continue;
      return strat;
    }
    return null;
  }

  return { registerFromPlugin, getRules, getStrategies, getStrategyByName, pick };
}

module.exports = { createRegistry };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-registry.test.js`
Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/auto-recovery/registry.js server/tests/auto-recovery-registry.test.js
git commit -m "feat(auto-recovery): plugin registry with rule sort, strategy pick, and validation"
```

---

## Task 6: Candidate query (paused-project eligibility SQL)

**Files:**
- Create: `server/factory/auto-recovery/candidate-query.js`
- Test: `server/tests/auto-recovery-candidate-query.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-candidate-query.test.js`:

```javascript
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const Database = require('better-sqlite3');
const { listRecoveryCandidates } = require('../factory/auto-recovery/candidate-query');

const SCHEMA = `CREATE TABLE factory_projects (
  id TEXT PRIMARY KEY, name TEXT, status TEXT,
  loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
  auto_recovery_attempts INTEGER DEFAULT 0,
  auto_recovery_last_action_at TEXT,
  auto_recovery_exhausted INTEGER DEFAULT 0,
  auto_recovery_last_strategy TEXT
)`;

function seedProject(db, overrides) {
  const row = {
    id: 'p1', name: 'test', status: 'running',
    loop_state: null, loop_paused_at_stage: null, loop_last_action_at: null,
    auto_recovery_attempts: 0, auto_recovery_last_action_at: null,
    auto_recovery_exhausted: 0, auto_recovery_last_strategy: null,
    ...overrides,
  };
  db.prepare(`INSERT INTO factory_projects
    (id, name, status, loop_state, loop_paused_at_stage, loop_last_action_at,
     auto_recovery_attempts, auto_recovery_last_action_at,
     auto_recovery_exhausted, auto_recovery_last_strategy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.name, row.status, row.loop_state, row.loop_paused_at_stage,
         row.loop_last_action_at, row.auto_recovery_attempts,
         row.auto_recovery_last_action_at, row.auto_recovery_exhausted,
         row.auto_recovery_last_strategy);
}

describe('listRecoveryCandidates', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.prepare(SCHEMA).run();
  });

  it('matches VERIFY_FAIL-paused projects (SpudgetBooks bug)', () => {
    seedProject(db, {
      id: 'sb', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T03:00:00Z',
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).toContain('sb');
  });

  it('matches projects paused at any stage, not just VERIFY', () => {
    seedProject(db, {
      id: 'p1', loop_state: 'PAUSED', loop_paused_at_stage: 'EXECUTE_FAIL',
      loop_last_action_at: '2026-04-21T00:00:00Z',
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).toContain('p1');
  });

  it('matches never-started projects (status=paused, loop_last_action_at IS NULL)', () => {
    seedProject(db, { id: 'st', status: 'paused', loop_state: 'IDLE' });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).toContain('st');
  });

  it('excludes exhausted projects', () => {
    seedProject(db, {
      id: 'ex', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T03:00:00Z', auto_recovery_exhausted: 1,
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).not.toContain('ex');
  });

  it('excludes projects inside their cooldown window', () => {
    seedProject(db, {
      id: 'cd', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T12:59:00Z',
      auto_recovery_last_action_at: '2026-04-21T12:59:50Z',
    });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).not.toContain('cd');
  });

  it('excludes fresh paused projects (inside pause-grace period)', () => {
    seedProject(db, {
      id: 'fresh', loop_state: 'PAUSED', loop_paused_at_stage: 'VERIFY_FAIL',
      loop_last_action_at: '2026-04-21T12:59:50Z',
    });
    const c = listRecoveryCandidates(db, {
      nowMs: Date.parse('2026-04-21T13:00:00Z'),
      graceMs: 60_000,
    });
    expect(c.map(r => r.id)).not.toContain('fresh');
  });

  it('ignores running projects without a pause signal', () => {
    seedProject(db, { id: 'run', status: 'running', loop_state: 'EXECUTE' });
    const c = listRecoveryCandidates(db, { nowMs: Date.parse('2026-04-21T13:00:00Z') });
    expect(c.map(r => r.id)).not.toContain('run');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-candidate-query.test.js`
Expected: module not found.

- [ ] **Step 3: Implement candidate-query.js**

Create `server/factory/auto-recovery/candidate-query.js`:

```javascript
'use strict';

const { isWithinCooldown } = require('./backoff');

const DEFAULT_GRACE_MS = 60_000;

function listRecoveryCandidates(db, { nowMs = Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  const rows = db.prepare(`
    SELECT id, name, status, loop_state, loop_paused_at_stage, loop_last_action_at,
           auto_recovery_attempts, auto_recovery_last_action_at,
           auto_recovery_exhausted, auto_recovery_last_strategy
    FROM factory_projects
    WHERE COALESCE(auto_recovery_exhausted, 0) = 0
      AND (
        COALESCE(UPPER(loop_state), '') = 'PAUSED'
        OR (UPPER(status) = 'PAUSED' AND loop_last_action_at IS NULL)
      )
  `).all();

  return rows.filter((row) => {
    if (isWithinCooldown(row.auto_recovery_last_action_at,
                         row.auto_recovery_attempts || 0, nowMs)) return false;
    if (row.loop_last_action_at) {
      const lastMs = Date.parse(row.loop_last_action_at);
      if (Number.isFinite(lastMs) && (nowMs - lastMs) < graceMs) return false;
    }
    return true;
  });
}

module.exports = { listRecoveryCandidates, DEFAULT_GRACE_MS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-candidate-query.test.js`
Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/auto-recovery/candidate-query.js server/tests/auto-recovery-candidate-query.test.js
git commit -m "feat(auto-recovery): candidate query covering VERIFY_FAIL and never-started projects"
```

---

## Task 7: Services bundle (including `cleanupWorktreeBuildArtifacts`)

**Files:**
- Create: `server/factory/auto-recovery/services.js`
- Test: `server/tests/auto-recovery-services.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-services.test.js`:

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { createAutoRecoveryServices, detectTechStack, cleanupPaths } =
  require('../factory/auto-recovery/services');

describe('detectTechStack', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-tech-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('detects dotnet from csproj', () => {
    fs.writeFileSync(path.join(tmp, 'Foo.csproj'), '<Project/>');
    expect(detectTechStack(tmp)).toContain('dotnet');
  });
  it('detects node from package.json', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    expect(detectTechStack(tmp)).toContain('node');
  });
  it('detects python from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '');
    expect(detectTechStack(tmp)).toContain('python');
  });
  it('detects rust from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '');
    expect(detectTechStack(tmp)).toContain('rust');
  });
  it('detects go from go.mod', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), '');
    expect(detectTechStack(tmp)).toContain('go');
  });
  it('returns empty for unknown project', () => {
    expect(detectTechStack(tmp)).toEqual([]);
  });
});

describe('cleanupPaths', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-clean-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('deletes existing paths recursively and reports them', () => {
    const obj = path.join(tmp, 'obj', 'Debug');
    fs.mkdirSync(obj, { recursive: true });
    fs.writeFileSync(path.join(obj, 'a.json'), '{}');
    const deleted = cleanupPaths(tmp, ['obj', 'bin']);
    expect(deleted).toContain(path.join(tmp, 'obj'));
    expect(fs.existsSync(path.join(tmp, 'obj'))).toBe(false);
  });
  it('is idempotent when paths are absent', () => {
    expect(cleanupPaths(tmp, ['obj'])).toEqual([]);
  });
  it('refuses paths outside the project root', () => {
    expect(cleanupPaths(tmp, ['../../../etc'])).toEqual([]);
  });
});

describe('createAutoRecoveryServices bundle shape', () => {
  it('includes the expected keys', () => {
    const s = createAutoRecoveryServices({
      db: {}, eventBus: {}, logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    expect(typeof s.cleanupWorktreeBuildArtifacts).toBe('function');
    expect(s.db).toBeTruthy();
    expect(s.eventBus).toBeTruthy();
    expect(s.logger).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-services.test.js`
Expected: module not found.

- [ ] **Step 3: Implement services.js**

Create `server/factory/auto-recovery/services.js`:

```javascript
'use strict';

const fs = require('fs');
const path = require('path');

const STACK_SIGNALS = {
  dotnet: (root) => {
    try { return fs.readdirSync(root).some((f) => /\.(csproj|sln|fsproj|vbproj)$/i.test(f)); }
    catch { return false; }
  },
  node: (root) => fs.existsSync(path.join(root, 'package.json')),
  python: (root) =>
    fs.existsSync(path.join(root, 'pyproject.toml'))
    || fs.existsSync(path.join(root, 'setup.py'))
    || fs.existsSync(path.join(root, 'requirements.txt')),
  rust: (root) => fs.existsSync(path.join(root, 'Cargo.toml')),
  go: (root) => fs.existsSync(path.join(root, 'go.mod')),
};

const STACK_CLEAN_PATHS = {
  dotnet: ['obj', 'bin', 'TestResults'],
  node: ['node_modules/.cache', 'dist', '.next/cache'],
  python: ['__pycache__', '.pytest_cache', 'build'],
  rust: ['target/debug/incremental'],
  go: ['pkg', 'bin'],
};

function detectTechStack(root) {
  const hits = [];
  for (const [name, probe] of Object.entries(STACK_SIGNALS)) {
    try { if (probe(root)) hits.push(name); } catch { /* ignore */ }
  }
  return hits;
}

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function cleanupPaths(root, relativePaths) {
  const deleted = [];
  if (!root || !fs.existsSync(root)) return deleted;
  for (const rel of relativePaths || []) {
    const abs = path.resolve(root, rel);
    if (!isPathInside(root, abs)) continue;
    if (!fs.existsSync(abs)) continue;
    try { fs.rmSync(abs, { recursive: true, force: true }); deleted.push(abs); }
    catch { /* best-effort */ }
  }
  return deleted;
}

function createAutoRecoveryServices({ db, eventBus, logger, extras = {} }) {
  async function cleanupWorktreeBuildArtifacts(project, batchId) {
    const worktreeRoot = project?.worktree_path || project?.path;
    if (!worktreeRoot) return { deleted: [], stacks: [] };
    const stacks = detectTechStack(worktreeRoot);
    const paths = stacks.flatMap(s => STACK_CLEAN_PATHS[s] || []);
    const deleted = cleanupPaths(worktreeRoot, paths);
    logger.info?.('auto-recovery cleaned worktree artifacts', {
      project_id: project.id, batch_id: batchId, stacks, deleted_count: deleted.length,
    });
    return { deleted, stacks };
  }

  return {
    db, eventBus, logger,
    cleanupWorktreeBuildArtifacts,
    retryFactoryVerify: extras.retryFactoryVerify || null,
    internalTaskSubmit: extras.internalTaskSubmit || null,
    smartSubmitTask: extras.smartSubmitTask || null,
    worktreeManager: extras.worktreeManager || null,
    architectRunner: extras.architectRunner || null,
    cancelTask: extras.cancelTask || null,
    rejectWorkItem: extras.rejectWorkItem || null,
    advanceLoop: extras.advanceLoop || null,
    pauseProject: extras.pauseProject || null,
    retryPlanGeneration: extras.retryPlanGeneration || null,
    recreateWorktree: extras.recreateWorktree || null,
  };
}

module.exports = { createAutoRecoveryServices, detectTechStack, cleanupPaths, STACK_CLEAN_PATHS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-services.test.js`
Expected: all 11 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/auto-recovery/services.js server/tests/auto-recovery-services.test.js
git commit -m "feat(auto-recovery): services bundle with tech-stack-aware worktree cleanup"
```

---

## Task 8: Engine core + public entrypoint

**Files:**
- Create: `server/factory/auto-recovery/engine.js`
- Create: `server/factory/auto-recovery/index.js`
- Test: `server/tests/auto-recovery-engine.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-engine.test.js`:

```javascript
'use strict';
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');
const { createAutoRecoveryEngine } = require('../factory/auto-recovery');

function seedSchema(db) {
  db.prepare(`CREATE TABLE factory_projects (
    id TEXT PRIMARY KEY, name TEXT, status TEXT,
    loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
    auto_recovery_attempts INTEGER DEFAULT 0,
    auto_recovery_last_action_at TEXT,
    auto_recovery_exhausted INTEGER DEFAULT 0,
    auto_recovery_last_strategy TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, stage TEXT, actor TEXT, action TEXT,
    reasoning TEXT, inputs_json TEXT, outcome_json TEXT,
    confidence REAL, batch_id TEXT, created_at TEXT
  )`).run();
}

function makeLogger() {
  const rows = [];
  const push = (lvl) => (...args) => rows.push({ lvl, args });
  return { warn: push('warn'), error: push('error'), info: push('info'), debug: push('debug'), rows };
}

describe('auto-recovery engine.tick', () => {
  let db, logger;
  beforeEach(() => { db = new Database(':memory:'); seedSchema(db); logger = makeLogger(); });

  it('classifies, picks, runs, and logs a successful recovery', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p1', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, reasoning, created_at, outcome_json)
                VALUES ('p1', 'verify', 'verifier', 'worktree_verify_failed',
                        'flaky', '2026-04-21T03:00:00Z',
                        '{"output_preview":"being used by another process"}')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'file_lock', category: 'transient', priority: 100, confidence: 0.9,
        match: { stage: 'verify', action: 'worktree_verify_failed',
                 outcome_path: 'output_preview', outcome_regex: 'being used by another' },
        suggested_strategies: ['retry'],
      }],
      strategies: [{
        name: 'retry', applicable_categories: ['transient'],
        async run(ctx) { ran.push(ctx.project.id); return { success: true, next_action: 'retry', outcome: {} }; },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(ran).toEqual(['p1']);
    expect(summary.attempts).toBe(1);

    const actions = db.prepare(`SELECT action FROM factory_decisions
                                WHERE actor='auto-recovery' ORDER BY id`).all();
    expect(actions.map(a => a.action)).toEqual([
      'auto_recovery_classified',
      'auto_recovery_strategy_selected',
      'auto_recovery_strategy_succeeded',
    ]);
    const p = db.prepare('SELECT * FROM factory_projects WHERE id=?').get('p1');
    expect(p.auto_recovery_attempts).toBe(1);
    expect(p.auto_recovery_last_strategy).toBe('retry');
  });

  it('logs _failed when strategy throws', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p2', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p2', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T03:00:00Z')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['boom'] }],
      strategies: [{
        name: 'boom', applicable_categories: ['unknown', 'any'],
        async run() { throw new Error('strategy exploded'); },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();
    const failed = db.prepare(`SELECT COUNT(*) AS n FROM factory_decisions
                               WHERE actor='auto-recovery' AND action='auto_recovery_strategy_failed'`).get();
    expect(failed.n).toBe(1);
  });

  it('marks exhausted after MAX_ATTEMPTS and logs _exhausted', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, loop_last_action_at, auto_recovery_attempts)
                VALUES ('p3', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z', 4)`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p3', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T03:00:00Z')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['any'], run: async () => ({ success: true, next_action: 'retry' }) }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();
    const p = db.prepare('SELECT auto_recovery_exhausted FROM factory_projects WHERE id=?').get('p3');
    expect(p.auto_recovery_exhausted).toBe(1);
    const exhausted = db.prepare(`SELECT COUNT(*) AS n FROM factory_decisions
                                  WHERE actor='auto-recovery' AND action='auto_recovery_exhausted'`).get();
    expect(exhausted.n).toBe(1);
  });

  it('skips candidates inside cooldown window', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, loop_last_action_at,
                 auto_recovery_attempts, auto_recovery_last_action_at)
                VALUES ('p4', 'running', 'PAUSED', 'VERIFY_FAIL',
                        '2026-04-21T12:59:00Z', 0, '2026-04-21T12:59:50Z')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['any'],
                     run: async (ctx) => { ran.push(ctx.project.id); return { success: true }; } }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });
    await engine.tick();
    expect(ran).toEqual([]);
  });

  it('handles never-started projects with no prior decisions', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state)
                VALUES ('p5', 'paused', 'IDLE')`).run();
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'ns', category: 'never_started', priority: 1,
                match_fn: (d) => d.action === 'never_started',
                suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['never_started'],
                     run: async () => ({ success: true, next_action: 'retry' }) }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });
    const summary = await engine.tick();
    expect(summary.attempts).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-engine.test.js`
Expected: module not found.

- [ ] **Step 3: Implement engine.js**

Create `server/factory/auto-recovery/engine.js`:

```javascript
'use strict';

const { listRecoveryCandidates } = require('./candidate-query');
const { createClassifier } = require('./classifier');
const { createRegistry } = require('./registry');

const MAX_ATTEMPTS = 5;

function latestRealDecisionForProject(db, projectId) {
  const row = db.prepare(`
    SELECT id, project_id, stage, actor, action, reasoning,
           inputs_json, outcome_json, confidence, batch_id, created_at
    FROM factory_decisions
    WHERE project_id = ? AND COALESCE(actor, '') != 'auto-recovery'
    ORDER BY id DESC LIMIT 1
  `).get(projectId);
  if (!row) return null;
  let outcome = null;
  try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null; } catch {}
  return { ...row, outcome };
}

function logDecision(db, { project_id, stage, action, reasoning, outcome, confidence, batch_id }) {
  db.prepare(`INSERT INTO factory_decisions
    (project_id, stage, actor, action, reasoning, outcome_json, confidence, batch_id, created_at)
    VALUES (?, ?, 'auto-recovery', ?, ?, ?, ?, ?, ?)`)
    .run(project_id, stage || 'verify', action, reasoning || null,
         outcome ? JSON.stringify(outcome) : null,
         typeof confidence === 'number' ? confidence : 1,
         batch_id || null,
         new Date().toISOString());
}

function createAutoRecoveryEngine({
  db, logger, eventBus,
  rules = [], strategies = [],
  services = null,
  nowMs = () => Date.now(),
}) {
  const registry = createRegistry({ logger });
  registry.registerFromPlugin('engine-direct', {
    classifierRules: rules, recoveryStrategies: strategies,
  });
  const classifier = createClassifier({ rules: registry.getRules() });

  function markExhausted(projectId, reason) {
    db.prepare(`UPDATE factory_projects SET auto_recovery_exhausted = 1 WHERE id = ?`).run(projectId);
    logDecision(db, {
      project_id: projectId, stage: 'verify',
      action: 'auto_recovery_exhausted',
      reasoning: `Auto-recovery exhausted: ${reason}`,
      outcome: { reason, max_attempts: MAX_ATTEMPTS },
    });
    eventBus?.emit?.('factory.auto_recovery.exhausted', { project_id: projectId, reason });
  }

  async function recoverOne(project) {
    const decision = latestRealDecisionForProject(db, project.id);
    const classifyInput = decision
      ? decision
      : { action: 'never_started', stage: 'plan', outcome: {} };
    const classification = classifier.classify(classifyInput);

    logDecision(db, {
      project_id: project.id, stage: decision?.stage || 'verify',
      action: 'auto_recovery_classified',
      reasoning: `Classified as ${classification.category} (rule: ${classification.matched_rule || 'none'})`,
      outcome: classification,
      confidence: classification.confidence,
      batch_id: decision?.batch_id || null,
    });

    const strategy = registry.pick(classification);
    if (!strategy) {
      logDecision(db, {
        project_id: project.id, stage: decision?.stage || 'verify',
        action: 'auto_recovery_no_strategy',
        reasoning: `No strategy registered for category ${classification.category}`,
        outcome: { category: classification.category, suggested: classification.suggested_strategies },
        batch_id: decision?.batch_id || null,
      });
      markExhausted(project.id, 'no_strategy');
      return { attempted: false, strategy: null };
    }

    logDecision(db, {
      project_id: project.id, stage: decision?.stage || 'verify',
      action: 'auto_recovery_strategy_selected',
      reasoning: `Selected ${strategy.name} for ${classification.category}`,
      outcome: { strategy: strategy.name, classification },
      batch_id: decision?.batch_id || null,
    });

    const attempts = (project.auto_recovery_attempts || 0) + 1;
    db.prepare(`UPDATE factory_projects
                SET auto_recovery_attempts = ?, auto_recovery_last_strategy = ?,
                    auto_recovery_last_action_at = ?
                WHERE id = ?`)
      .run(attempts, strategy.name, new Date().toISOString(), project.id);

    try {
      const result = await strategy.run({ project, decision, classification, services, logger });
      logDecision(db, {
        project_id: project.id, stage: decision?.stage || 'verify',
        action: 'auto_recovery_strategy_succeeded',
        reasoning: `${strategy.name} returned next_action=${result?.next_action || 'unknown'}`,
        outcome: { strategy: strategy.name, result },
        batch_id: decision?.batch_id || null,
      });
      eventBus?.emit?.('factory.auto_recovery.attempted', {
        project_id: project.id, strategy: strategy.name, attempts, success: true,
      });
    } catch (err) {
      logDecision(db, {
        project_id: project.id, stage: decision?.stage || 'verify',
        action: 'auto_recovery_strategy_failed',
        reasoning: `${strategy.name} threw: ${err.message}`,
        outcome: { strategy: strategy.name, error: err.message, stack: err.stack },
        batch_id: decision?.batch_id || null,
      });
      eventBus?.emit?.('factory.auto_recovery.attempted', {
        project_id: project.id, strategy: strategy.name, attempts, success: false,
      });
    }

    if (attempts >= MAX_ATTEMPTS) markExhausted(project.id, 'max_attempts');
    return { attempted: true, strategy: strategy.name };
  }

  async function tick() {
    const candidates = listRecoveryCandidates(db, { nowMs: nowMs() });
    let attempts = 0;
    for (const project of candidates) {
      try {
        const r = await recoverOne(project);
        if (r.attempted) attempts += 1;
      } catch (err) {
        logger.error?.('auto-recovery engine error', { project_id: project.id, err: err.message });
      }
    }
    return { candidates: candidates.length, attempts };
  }

  async function reconcileOnStartup() { return tick(); }

  return {
    tick, reconcileOnStartup, recoverOne, MAX_ATTEMPTS,
    _registry: { getRules: () => registry.getRules(), getStrategies: () => registry.getStrategies() },
  };
}

module.exports = { createAutoRecoveryEngine, MAX_ATTEMPTS };
```

- [ ] **Step 4: Create the public entrypoint index.js**

Create `server/factory/auto-recovery/index.js`:

```javascript
'use strict';

const { createAutoRecoveryEngine, MAX_ATTEMPTS } = require('./engine');
const { createAutoRecoveryServices } = require('./services');
const { createClassifier, UNKNOWN_CLASSIFICATION } = require('./classifier');
const { createRegistry } = require('./registry');
const { listRecoveryCandidates } = require('./candidate-query');
const backoff = require('./backoff');

module.exports = {
  createAutoRecoveryEngine,
  createAutoRecoveryServices,
  createClassifier,
  createRegistry,
  listRecoveryCandidates,
  UNKNOWN_CLASSIFICATION,
  MAX_ATTEMPTS,
  ...backoff,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-engine.test.js`
Expected: all 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/factory/auto-recovery/engine.js server/factory/auto-recovery/index.js server/tests/auto-recovery-engine.test.js
git commit -m "feat(auto-recovery): engine core with classify-select-run-log pipeline"
```

---

## Task 9: Simple strategies — retry, clean_and_retry, reject_and_advance, escalate

**Files:**
- Create: `server/plugins/auto-recovery-core/strategies/retry.js`
- Create: `server/plugins/auto-recovery-core/strategies/clean-and-retry.js`
- Create: `server/plugins/auto-recovery-core/strategies/reject-and-advance.js`
- Create: `server/plugins/auto-recovery-core/strategies/escalate.js`
- Test: `server/tests/auto-recovery-strategies-simple.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-strategies-simple.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const retry = require('../plugins/auto-recovery-core/strategies/retry');
const cleanAndRetry = require('../plugins/auto-recovery-core/strategies/clean-and-retry');
const rejectAndAdvance = require('../plugins/auto-recovery-core/strategies/reject-and-advance');
const escalate = require('../plugins/auto-recovery-core/strategies/escalate');

function makeServices(overrides = {}) {
  const calls = {};
  return {
    calls,
    retryFactoryVerify: async (x) => { calls.retry = x; return { ok: true }; },
    cleanupWorktreeBuildArtifacts: async () => ({ deleted: ['/x/obj'], stacks: ['dotnet'] }),
    rejectWorkItem: async (x) => { calls.reject = x; return { ok: true }; },
    advanceLoop: async (x) => { calls.advance = x; return { ok: true }; },
    pauseProject: async (x) => { calls.pause = x; return { ok: true }; },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

const project = { id: 'p1', worktree_path: '/tmp/wt' };
const decision = { stage: 'verify', action: 'worktree_verify_failed', batch_id: 'b1' };

describe('simple strategies', () => {
  it('retry submits retryFactoryVerify', async () => {
    const services = makeServices();
    const r = await retry.run({ project, decision, services, classification: { category: 'transient' } });
    expect(r.next_action).toBe('retry');
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });

  it('clean_and_retry cleans then retries', async () => {
    const services = makeServices();
    const r = await cleanAndRetry.run({ project, decision, services, classification: { category: 'transient' } });
    expect(r.success).toBe(true);
    expect(r.outcome.cleanup.deleted).toEqual(['/x/obj']);
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });

  it('clean_and_retry still retries when cleanup finds nothing', async () => {
    const services = makeServices({
      cleanupWorktreeBuildArtifacts: async () => ({ deleted: [], stacks: [] }),
    });
    await cleanAndRetry.run({ project, decision, services, classification: { category: 'transient' } });
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });

  it('reject_and_advance rejects and advances', async () => {
    const services = makeServices();
    const workDecision = { ...decision, outcome: { work_item_id: 42 } };
    const r = await rejectAndAdvance.run({
      project, decision: workDecision, services,
      classification: { category: 'structural_failure' },
    });
    expect(r.next_action).toBe('advance');
    expect(services.calls.reject).toEqual({
      project_id: 'p1', work_item_id: 42, reason: 'auto_recovery_reject_and_advance',
    });
    expect(services.calls.advance).toEqual({ project_id: 'p1' });
  });

  it('escalate pauses the project', async () => {
    const services = makeServices();
    const r = await escalate.run({ project, decision, services, classification: { category: 'unknown' } });
    expect(r.next_action).toBe('escalate');
    expect(services.calls.pause).toEqual({ project_id: 'p1', reason: 'auto_recovery_exhausted' });
  });

  it('each strategy exposes name + applicable_categories + run + max_attempts_per_project', () => {
    for (const s of [retry, cleanAndRetry, rejectAndAdvance, escalate]) {
      expect(typeof s.name).toBe('string');
      expect(Array.isArray(s.applicable_categories)).toBe(true);
      expect(typeof s.run).toBe('function');
    }
    expect(retry.max_attempts_per_project).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-strategies-simple.test.js`
Expected: modules not found.

- [ ] **Step 3: Implement retry.js**

Create `server/plugins/auto-recovery-core/strategies/retry.js`:

```javascript
'use strict';

module.exports = {
  name: 'retry',
  applicable_categories: ['transient', 'unknown', 'infrastructure', 'any'],
  max_attempts_per_project: 3,

  async run({ project, decision, services }) {
    if (typeof services.retryFactoryVerify !== 'function') {
      throw new Error('retry strategy requires services.retryFactoryVerify');
    }
    await services.retryFactoryVerify({ project_id: project.id });
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'retry', batch_id: decision?.batch_id || null },
    };
  },
};
```

- [ ] **Step 4: Implement clean-and-retry.js**

Create `server/plugins/auto-recovery-core/strategies/clean-and-retry.js`:

```javascript
'use strict';

module.exports = {
  name: 'clean_and_retry',
  applicable_categories: ['transient', 'infrastructure'],
  max_attempts_per_project: 2,

  async run({ project, decision, services }) {
    if (typeof services.cleanupWorktreeBuildArtifacts !== 'function') {
      throw new Error('clean_and_retry requires services.cleanupWorktreeBuildArtifacts');
    }
    if (typeof services.retryFactoryVerify !== 'function') {
      throw new Error('clean_and_retry requires services.retryFactoryVerify');
    }
    const cleanup = await services.cleanupWorktreeBuildArtifacts(project, decision?.batch_id);
    await services.retryFactoryVerify({ project_id: project.id });
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'clean_and_retry', cleanup, batch_id: decision?.batch_id || null },
    };
  },
};
```

- [ ] **Step 5: Implement reject-and-advance.js**

Create `server/plugins/auto-recovery-core/strategies/reject-and-advance.js`:

```javascript
'use strict';

module.exports = {
  name: 'reject_and_advance',
  applicable_categories: ['transient', 'structural_failure'],
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    const workItemId = decision?.outcome?.work_item_id
                     || decision?.inputs_json?.work_item_id
                     || null;
    if (typeof services.rejectWorkItem === 'function' && workItemId) {
      await services.rejectWorkItem({
        project_id: project.id, work_item_id: workItemId,
        reason: 'auto_recovery_reject_and_advance',
      });
    }
    if (typeof services.advanceLoop === 'function') {
      await services.advanceLoop({ project_id: project.id });
    }
    return {
      success: true, next_action: 'advance',
      outcome: { strategy: 'reject_and_advance', work_item_id: workItemId },
    };
  },
};
```

- [ ] **Step 6: Implement escalate.js**

Create `server/plugins/auto-recovery-core/strategies/escalate.js`:

```javascript
'use strict';

module.exports = {
  name: 'escalate',
  applicable_categories: ['unknown', 'terminal', 'any'],
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    if (typeof services.pauseProject === 'function') {
      await services.pauseProject({ project_id: project.id, reason: 'auto_recovery_exhausted' });
    }
    return {
      success: true, next_action: 'escalate',
      outcome: { strategy: 'escalate', last_decision_action: decision?.action || null },
    };
  },
};
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-strategies-simple.test.js`
Expected: all 6 PASS.

- [ ] **Step 8: Commit**

```bash
git add server/plugins/auto-recovery-core/strategies/retry.js \
        server/plugins/auto-recovery-core/strategies/clean-and-retry.js \
        server/plugins/auto-recovery-core/strategies/reject-and-advance.js \
        server/plugins/auto-recovery-core/strategies/escalate.js \
        server/tests/auto-recovery-strategies-simple.test.js
git commit -m "feat(auto-recovery-core): retry, clean_and_retry, reject_and_advance, escalate strategies"
```

---

## Task 10: Complex strategies — retry_with_fresh_session, fallback_provider, retry_plan_generation, fresh_worktree

**Files:**
- Create: `server/plugins/auto-recovery-core/strategies/retry-with-fresh-session.js`
- Create: `server/plugins/auto-recovery-core/strategies/fallback-provider.js`
- Create: `server/plugins/auto-recovery-core/strategies/retry-plan-generation.js`
- Create: `server/plugins/auto-recovery-core/strategies/fresh-worktree.js`
- Test: `server/tests/auto-recovery-strategies-complex.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-strategies-complex.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const freshSession = require('../plugins/auto-recovery-core/strategies/retry-with-fresh-session');
const fallback = require('../plugins/auto-recovery-core/strategies/fallback-provider');
const retryPlan = require('../plugins/auto-recovery-core/strategies/retry-plan-generation');
const freshWorktree = require('../plugins/auto-recovery-core/strategies/fresh-worktree');

function baseServices(overrides = {}) {
  const calls = {};
  return {
    calls,
    cancelTask: async (x) => { calls.cancel = x; return { ok: true }; },
    smartSubmitTask: async (x) => { calls.submit = x; return { task_id: 't1' }; },
    retryFactoryVerify: async (x) => { calls.retry = x; return { ok: true }; },
    retryPlanGeneration: async (x) => { calls.plan = x; return { ok: true }; },
    recreateWorktree: async (x) => { calls.recreate = x; return { worktree_path: '/new' }; },
    logger: { info: () => {}, warn: () => {} },
    ...overrides,
  };
}

describe('complex strategies', () => {
  it('retry_with_fresh_session cancels then resubmits', async () => {
    const services = baseServices();
    const decision = { stage: 'plan', action: 'cannot_generate_plan',
                       outcome: { generation_task_id: 'tX', work_item_id: 7 }, batch_id: 'b1' };
    const r = await freshSession.run({
      project: { id: 'p1' }, decision, services,
      classification: { category: 'sandbox_interrupt' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.cancel).toEqual({ task_id: 'tX', reason: 'auto_recovery_fresh_session' });
  });

  it('fallback_provider resubmits with a different provider', async () => {
    const services = baseServices();
    const decision = { stage: 'plan', action: 'cannot_generate_plan',
                       outcome: { last_provider: 'codex', work_item_id: 9 }, batch_id: 'b1' };
    const r = await fallback.run({
      project: { id: 'p1' }, decision, services,
      classification: { category: 'plan_failure' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.submit.provider_hint).toBeDefined();
    expect(services.calls.submit.provider_hint).not.toBe('codex');
  });

  it('retry_plan_generation re-invokes architect', async () => {
    const services = baseServices();
    const decision = { stage: 'plan', action: 'cannot_generate_plan',
                       outcome: { work_item_id: 42 }, batch_id: 'b1' };
    const r = await retryPlan.run({
      project: { id: 'p1' }, decision, services,
      classification: { category: 'plan_failure' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.plan).toEqual({ project_id: 'p1', work_item_id: 42 });
  });

  it('fresh_worktree recreates then retries verify', async () => {
    const services = baseServices();
    const decision = { stage: 'verify', action: 'worktree_verify_failed', batch_id: 'b1',
                       outcome: { worktree_path: '/old', branch: 'feat/x' } };
    const r = await freshWorktree.run({
      project: { id: 'p1', worktree_path: '/old' }, decision, services,
      classification: { category: 'infrastructure' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.recreate).toEqual({ project_id: 'p1', batch_id: 'b1', branch: 'feat/x' });
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-strategies-complex.test.js`
Expected: modules not found.

- [ ] **Step 3: Implement retry-with-fresh-session.js**

Create `server/plugins/auto-recovery-core/strategies/retry-with-fresh-session.js`:

```javascript
'use strict';

module.exports = {
  name: 'retry_with_fresh_session',
  applicable_categories: ['sandbox_interrupt', 'provider_overload'],
  max_attempts_per_project: 2,

  async run({ project, decision, services }) {
    const stuckTaskId = decision?.outcome?.generation_task_id
                      || decision?.outcome?.task_id
                      || null;
    if (stuckTaskId && typeof services.cancelTask === 'function') {
      await services.cancelTask({ task_id: stuckTaskId, reason: 'auto_recovery_fresh_session' });
    }
    if (decision?.stage === 'plan' && typeof services.retryPlanGeneration === 'function') {
      const workItemId = decision?.outcome?.work_item_id || null;
      await services.retryPlanGeneration({ project_id: project.id, work_item_id: workItemId });
    } else if (typeof services.retryFactoryVerify === 'function') {
      await services.retryFactoryVerify({ project_id: project.id });
    }
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'retry_with_fresh_session', cancelled_task_id: stuckTaskId },
    };
  },
};
```

- [ ] **Step 4: Implement fallback-provider.js**

Create `server/plugins/auto-recovery-core/strategies/fallback-provider.js`:

```javascript
'use strict';

const PROVIDER_CHAINS = {
  codex: ['deepinfra', 'hyperbolic', 'claude-cli'],
  'codex-spark': ['deepinfra', 'codex'],
  'claude-cli': ['codex', 'deepinfra'],
  ollama: ['cerebras', 'groq', 'deepinfra'],
  deepinfra: ['hyperbolic', 'codex'],
  hyperbolic: ['deepinfra', 'codex'],
  groq: ['cerebras', 'ollama'],
  cerebras: ['groq', 'ollama'],
};
const DEFAULT_FALLBACK = ['deepinfra', 'codex'];

module.exports = {
  name: 'fallback_provider',
  applicable_categories: ['plan_failure', 'sandbox_interrupt', 'provider_overload'],
  max_attempts_per_project: 2,

  async run({ project, decision, services }) {
    if (typeof services.smartSubmitTask !== 'function') {
      throw new Error('fallback_provider requires services.smartSubmitTask');
    }
    const lastProvider = decision?.outcome?.last_provider || decision?.outcome?.provider || null;
    const candidates = (PROVIDER_CHAINS[lastProvider] || DEFAULT_FALLBACK)
      .filter((p) => p !== lastProvider);
    const providerHint = candidates[0] || 'deepinfra';
    const workItemId = decision?.outcome?.work_item_id || null;

    await services.smartSubmitTask({
      project_id: project.id, work_item_id: workItemId,
      provider_hint: providerHint,
      original_stage: decision?.stage || 'plan',
      context: 'auto_recovery_fallback_provider',
    });

    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'fallback_provider', prev_provider: lastProvider, new_provider: providerHint },
    };
  },
};
```

- [ ] **Step 5: Implement retry-plan-generation.js**

Create `server/plugins/auto-recovery-core/strategies/retry-plan-generation.js`:

```javascript
'use strict';

module.exports = {
  name: 'retry_plan_generation',
  applicable_categories: ['plan_failure', 'never_started'],
  max_attempts_per_project: 3,

  async run({ project, decision, services }) {
    if (typeof services.retryPlanGeneration !== 'function') {
      throw new Error('retry_plan_generation requires services.retryPlanGeneration');
    }
    const workItemId = decision?.outcome?.work_item_id
                     || decision?.inputs?.work_item_id
                     || null;
    await services.retryPlanGeneration({ project_id: project.id, work_item_id: workItemId });
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'retry_plan_generation', work_item_id: workItemId },
    };
  },
};
```

- [ ] **Step 6: Implement fresh-worktree.js**

Create `server/plugins/auto-recovery-core/strategies/fresh-worktree.js`:

```javascript
'use strict';

module.exports = {
  name: 'fresh_worktree',
  applicable_categories: ['infrastructure'],
  max_attempts_per_project: 1,

  async run({ project, decision, services }) {
    if (typeof services.recreateWorktree !== 'function') {
      throw new Error('fresh_worktree requires services.recreateWorktree');
    }
    const branch = decision?.outcome?.branch || null;
    const batchId = decision?.batch_id || null;
    const recreated = await services.recreateWorktree({
      project_id: project.id, batch_id: batchId, branch,
    });
    if (typeof services.retryFactoryVerify === 'function') {
      await services.retryFactoryVerify({ project_id: project.id });
    }
    return {
      success: true, next_action: 'retry',
      outcome: { strategy: 'fresh_worktree', new_worktree_path: recreated?.worktree_path || null },
    };
  },
};
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-strategies-complex.test.js`
Expected: all 4 PASS.

- [ ] **Step 8: Commit**

```bash
git add server/plugins/auto-recovery-core/strategies/retry-with-fresh-session.js \
        server/plugins/auto-recovery-core/strategies/fallback-provider.js \
        server/plugins/auto-recovery-core/strategies/retry-plan-generation.js \
        server/plugins/auto-recovery-core/strategies/fresh-worktree.js \
        server/tests/auto-recovery-strategies-complex.test.js
git commit -m "feat(auto-recovery-core): fresh-session, fallback-provider, retry-plan-generation, fresh-worktree"
```

---

## Task 11: Built-in plugin — rules + plugin shell

**Files:**
- Create: `server/plugins/auto-recovery-core/rules.js`
- Create: `server/plugins/auto-recovery-core/index.js`
- Test: `server/tests/auto-recovery-core-rules.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-core-rules.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const { createPlugin } = require('../plugins/auto-recovery-core');
const { createClassifier } = require('../factory/auto-recovery/classifier');

describe('auto-recovery-core day-one rules', () => {
  const plugin = createPlugin();
  const classifier = createClassifier({ rules: plugin.classifierRules });

  it('classifies the SpudgetBooks sourcelink file-lock as transient', () => {
    const decision = {
      stage: 'verify', action: 'worktree_verify_failed',
      reasoning: 'Worktree remote verify FAILED ... pausing loop at VERIFY_FAIL.',
      outcome: {
        output_preview: `error : Error writing to source link file 'obj\\Debug\\net8.0\\SpudgetBooks.Application.Tests.sourcelink.json' ... because it is being used by another process.`,
        retry_attempts: 1,
      },
    };
    const r = classifier.classify(decision);
    expect(r.category).toBe('transient');
    expect(r.matched_rule).toBe('dotnet_sourcelink_file_lock');
    expect(r.suggested_strategies[0]).toBe('clean_and_retry');
  });

  it('classifies a plan generation failure', () => {
    const r = classifier.classify({
      stage: 'execute', action: 'cannot_generate_plan',
      reasoning: 'Codex exited mid-task', outcome: { work_item_id: 659 },
    });
    expect(['plan_failure', 'sandbox_interrupt']).toContain(r.category);
  });

  it('classifies an unclassified VERIFY_FAIL as verify_fail_unclassified', () => {
    const r = classifier.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      reasoning: 'something unusual',
      outcome: { output_preview: 'new failure kind' },
    });
    expect(r.matched_rule).toBe('verify_fail_unclassified');
  });

  it('every rule suggests strategies known to the plugin', () => {
    const strategyNames = new Set(plugin.recoveryStrategies.map(s => s.name));
    for (const rule of plugin.classifierRules) {
      for (const s of rule.suggested_strategies || []) {
        expect(strategyNames.has(s)).toBe(true);
      }
    }
  });

  it('plugin validates against plugin-contract', () => {
    const { validatePlugin } = require('../plugins/plugin-contract');
    expect(validatePlugin(plugin).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auto-recovery-core-rules.test.js`
Expected: plugin module not found.

- [ ] **Step 3: Implement rules.js**

Create `server/plugins/auto-recovery-core/rules.js`:

```javascript
'use strict';

module.exports = [
  {
    name: 'dotnet_sourcelink_file_lock',
    category: 'transient',
    priority: 200,
    confidence: 0.9,
    match: {
      stage: 'verify', action: 'worktree_verify_failed',
      outcome_path: 'output_preview',
      outcome_regex: 'being used by another process|sourcelink\\.json',
    },
    suggested_strategies: ['clean_and_retry', 'retry', 'reject_and_advance'],
  },
  {
    name: 'codex_phantom_success',
    category: 'sandbox_interrupt',
    priority: 150,
    confidence: 0.7,
    match: {
      action: 'cannot_generate_plan',
      outcome_regex: 'Reconnecting|high[- ]demand|workspace-write|\\bsandbox\\b',
    },
    suggested_strategies: ['retry_with_fresh_session', 'fallback_provider', 'escalate'],
  },
  {
    name: 'plan_generation_failed',
    category: 'plan_failure',
    priority: 100,
    confidence: 0.8,
    match: { action: 'cannot_generate_plan' },
    suggested_strategies: ['retry_plan_generation', 'fallback_provider', 'reject_and_advance'],
  },
  {
    name: 'never_started_paused_project',
    category: 'never_started',
    priority: 90,
    confidence: 0.9,
    match_fn: (d) => d && d.action === 'never_started',
    suggested_strategies: ['retry_plan_generation', 'escalate'],
  },
  {
    name: 'verify_fail_unclassified',
    category: 'unknown',
    priority: 10,
    confidence: 0.3,
    match: { stage: 'verify', action: 'worktree_verify_failed' },
    suggested_strategies: ['retry', 'escalate'],
  },
];
```

- [ ] **Step 4: Implement plugin index.js**

Create `server/plugins/auto-recovery-core/index.js`:

```javascript
'use strict';

const rules = require('./rules');
const retry = require('./strategies/retry');
const cleanAndRetry = require('./strategies/clean-and-retry');
const retryWithFreshSession = require('./strategies/retry-with-fresh-session');
const fallbackProvider = require('./strategies/fallback-provider');
const retryPlanGeneration = require('./strategies/retry-plan-generation');
const freshWorktree = require('./strategies/fresh-worktree');
const rejectAndAdvance = require('./strategies/reject-and-advance');
const escalate = require('./strategies/escalate');

const PLUGIN_NAME = 'auto-recovery-core';
const PLUGIN_VERSION = '1.0.0';

function createPlugin() {
  return {
    name: PLUGIN_NAME, version: PLUGIN_VERSION,
    install() {}, uninstall() {},
    middleware() { return null; },
    mcpTools() { return []; },
    eventHandlers() { return {}; },
    configSchema() { return null; },
    classifierRules: rules,
    recoveryStrategies: [
      retry, cleanAndRetry, retryWithFreshSession, fallbackProvider,
      retryPlanGeneration, freshWorktree, rejectAndAdvance, escalate,
    ],
  };
}

module.exports = { createPlugin, PLUGIN_NAME, PLUGIN_VERSION };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/auto-recovery-core-rules.test.js`
Expected: all 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/plugins/auto-recovery-core/rules.js server/plugins/auto-recovery-core/index.js \
        server/tests/auto-recovery-core-rules.test.js
git commit -m "feat(auto-recovery-core): day-one classifier rules and plugin shell"
```

---

## Task 12: Wire engine into server — DI container, factory-tick, startup-reconciler, verify-stall cooldown gate

**Files:**
- Modify: `server/index.js`
- Modify: `server/factory/factory-tick.js`
- Modify: `server/factory/startup-reconciler.js`
- Modify: `server/factory/verify-stall-recovery.js`
- Test: `server/tests/auto-recovery-wiring.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-wiring.test.js`:

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('vitest');

describe('auto-recovery wiring', () => {
  it('DEFAULT_PLUGIN_NAMES includes auto-recovery-core', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(src).toMatch(/DEFAULT_PLUGIN_NAMES.*auto-recovery-core/s);
  });
  it('factory-tick imports auto-recovery and calls engine.tick', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'factory', 'factory-tick.js'), 'utf8');
    expect(src).toMatch(/auto-recovery/);
    expect(src).toMatch(/autoRecoveryEngine/);
  });
  it('startup-reconciler calls reconcileOnStartup', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'factory', 'startup-reconciler.js'), 'utf8');
    expect(src).toMatch(/reconcileOnStartup/);
  });
  it('verify-stall-recovery adds cooldown skip gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'factory', 'verify-stall-recovery.js'), 'utf8');
    expect(src).toMatch(/auto_recovery_last_action_at/);
  });
});
```

- [ ] **Step 2: Run test (fails on all 4)**

Run: `npx vitest run server/tests/auto-recovery-wiring.test.js`
Expected: all 4 FAIL.

- [ ] **Step 3: Add to DEFAULT_PLUGIN_NAMES in server/index.js**

Edit `server/index.js` line 58:

```javascript
const DEFAULT_PLUGIN_NAMES = Object.freeze(['snapscope', 'version-control', 'remote-agents', 'model-freshness', 'auto-recovery-core']);
```

- [ ] **Step 4: Build engine after plugins load in server/index.js**

Locate the section in `server/index.js` where plugins are loaded (search for `loadPlugins`). After the plugins load block (after line ~1145), add:

```javascript
// Build auto-recovery engine with rules and strategies from loaded plugins.
try {
  const autoRecovery = require('./factory/auto-recovery');
  const { createAutoRecoveryServices } = require('./factory/auto-recovery/services');
  const { handleRetryFactoryVerify } = require('./handlers/factory-handlers');

  const allRules = [];
  const allStrategies = [];
  for (const plugin of loadedPlugins || []) {
    if (Array.isArray(plugin?.classifierRules)) allRules.push(...plugin.classifierRules);
    if (Array.isArray(plugin?.recoveryStrategies)) allStrategies.push(...plugin.recoveryStrategies);
  }

  const rawDb = (typeof database.getDbInstance === 'function')
    ? database.getDbInstance() : database;

  const services = createAutoRecoveryServices({
    db: rawDb, eventBus, logger,
    extras: {
      retryFactoryVerify: async (args) => handleRetryFactoryVerify(args),
      // Other services wired on demand via container.get() inside strategies if needed.
    },
  });

  const autoRecoveryEngine = autoRecovery.createAutoRecoveryEngine({
    db: rawDb, logger, eventBus,
    rules: allRules, strategies: allStrategies, services,
  });
  container.register('autoRecoveryEngine', autoRecoveryEngine);
} catch (err) {
  logger.warn('Failed to build auto-recovery engine', { err: err.message });
}
```

(Names `database`, `container`, `loadedPlugins`, `logger`, `eventBus` should already be in scope at that location. If not, use `require('./container').defaultContainer` and `require('./event-bus')`.)

- [ ] **Step 5: Call engine.tick() in factory-tick.js**

In `server/factory/factory-tick.js`, inside the main tick loop (the function that iterates all projects), at the very end of the loop (after the for-loop that calls `tickProject`), add:

```javascript
// Auto-recovery sweep — once per tick, across all eligible projects.
try {
  const container = require('../container').defaultContainer;
  const engine = container.get('autoRecoveryEngine');
  if (engine) {
    const summary = await engine.tick();
    if (summary.attempts > 0) {
      logger.info('auto-recovery tick ran recovery attempts', summary);
    }
  }
} catch (err) {
  logger.warn('auto-recovery tick failed', { err: err.message });
}
```

- [ ] **Step 6: Call engine.reconcileOnStartup() in startup-reconciler.js**

In `server/factory/startup-reconciler.js`, at the end of the outer `reconcile()` async function (after all existing reconciler calls finish), add:

```javascript
try {
  const container = require('../container').defaultContainer;
  const engine = container.get('autoRecoveryEngine');
  if (engine) {
    const summary = await engine.reconcileOnStartup();
    safeLog(logger, 'info', 'auto-recovery startup reconcile completed', summary);
  }
} catch (err) {
  safeLog(logger, 'warn', 'auto-recovery startup reconcile failed', { err: err.message });
}
```

- [ ] **Step 7: Add cooldown skip gate to verify-stall-recovery.js**

In `server/factory/verify-stall-recovery.js`, modify `listStalledVerifyLoops`. Extend the SELECT and the flatMap filter:

Find the existing prepare statement (around line 63) and change it to include `auto_recovery_last_action_at`:

```javascript
const rows = db.prepare(`
  SELECT
    id AS project_id,
    loop_state,
    loop_paused_at_stage AS paused_at_stage,
    loop_last_action_at AS last_action_at,
    auto_recovery_last_action_at AS ar_last_action_at,
    auto_recovery_attempts AS ar_attempts
    ${attemptsSelect}
  FROM factory_projects
  WHERE loop_last_action_at IS NOT NULL
    AND (
      COALESCE(UPPER(loop_state), 'IDLE') = 'VERIFY'
      OR (
        COALESCE(UPPER(loop_state), 'IDLE') = 'PAUSED'
        AND COALESCE(UPPER(loop_paused_at_stage), '') = 'VERIFY'
      )
    )
  ORDER BY loop_last_action_at ASC
`).all();
```

Add require at the top of the file:

```javascript
const { isWithinCooldown } = require('./auto-recovery/backoff');
```

Inside the flatMap body (after parsing `lastActionMs` and the threshold check), add:

```javascript
if (isWithinCooldown(row.ar_last_action_at, row.ar_attempts || 0, nowMs)) {
  return [];  // engine is actively handling this project; skip double-retry
}
```

- [ ] **Step 8: Run the wiring test**

Run: `npx vitest run server/tests/auto-recovery-wiring.test.js`
Expected: all 4 PASS.

- [ ] **Step 9: Run full factory-related suite remotely**

Run: `torque-remote npx vitest run server/tests/factory-*.test.js server/tests/verify-stall-*.test.js server/tests/auto-recovery-*.test.js`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add server/index.js server/factory/factory-tick.js server/factory/startup-reconciler.js \
        server/factory/verify-stall-recovery.js server/tests/auto-recovery-wiring.test.js
git commit -m "feat(factory): wire auto-recovery engine into tick, startup, DEFAULT_PLUGIN_NAMES + cooldown gate"
```

---

## Task 13: MCP tools — list / history / clear / trigger

**Files:**
- Create: `server/handlers/auto-recovery-handlers.js`
- Modify: `server/tool-defs/factory-defs.js`
- Modify: `server/tool-annotations.js`
- Modify: `server/core-tools.js`
- Test: `server/tests/auto-recovery-mcp-tools.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/auto-recovery-mcp-tools.test.js`:

```javascript
'use strict';
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');
const {
  listRecoveryStrategies, getRecoveryHistory, clearAutoRecovery, triggerAutoRecovery,
} = require('../handlers/auto-recovery-handlers');

function seedDb() {
  const db = new Database(':memory:');
  db.prepare(`CREATE TABLE factory_projects (
    id TEXT PRIMARY KEY, name TEXT, status TEXT,
    loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
    auto_recovery_attempts INTEGER DEFAULT 0,
    auto_recovery_last_action_at TEXT,
    auto_recovery_exhausted INTEGER DEFAULT 0,
    auto_recovery_last_strategy TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, stage TEXT, actor TEXT, action TEXT,
    reasoning TEXT, outcome_json TEXT, confidence REAL,
    batch_id TEXT, created_at TEXT
  )`).run();
  return db;
}

describe('auto-recovery MCP handlers', () => {
  let db;
  beforeEach(() => { db = seedDb(); });

  it('list_recovery_strategies returns rules + strategies', () => {
    const engine = {
      _registry: {
        getRules: () => [{ name: 'r1', category: 'transient', priority: 1 }],
        getStrategies: () => [{ name: 's1', applicable_categories: ['transient'] }],
      },
    };
    const res = listRecoveryStrategies({ engine });
    expect(res.rules).toHaveLength(1);
    expect(res.strategies).toHaveLength(1);
  });

  it('get_recovery_history returns only auto-recovery decisions', () => {
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p1', 'verify', 'auto-recovery', 'auto_recovery_classified', '2026-04-21T12:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p1', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T11:00:00Z')`).run();
    const res = getRecoveryHistory({ db, project_id: 'p1' });
    expect(res.decisions).toHaveLength(1);
    expect(res.decisions[0].action).toBe('auto_recovery_classified');
  });

  it('clear_auto_recovery resets counter + logs', () => {
    db.prepare(`INSERT INTO factory_projects (id, auto_recovery_attempts, auto_recovery_exhausted)
                VALUES ('p1', 4, 1)`).run();
    const res = clearAutoRecovery({ db, project_id: 'p1' });
    const p = db.prepare('SELECT * FROM factory_projects WHERE id=?').get('p1');
    expect(p.auto_recovery_attempts).toBe(0);
    expect(p.auto_recovery_exhausted).toBe(0);
    expect(res.cleared).toBe(true);
    const logged = db.prepare(`SELECT * FROM factory_decisions WHERE action=?`)
                     .get('auto_recovery_operator_cleared');
    expect(logged).toBeTruthy();
  });

  it('trigger_auto_recovery bypasses cooldown and calls engine.recoverOne', async () => {
    db.prepare(`INSERT INTO factory_projects (id, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p1', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T12:00:00Z')`).run();
    let called = false;
    const engine = { recoverOne: async () => { called = true; return { attempted: true, strategy: 'retry' }; } };
    const res = await triggerAutoRecovery({ db, engine, project_id: 'p1' });
    expect(called).toBe(true);
    expect(res.attempted).toBe(true);
  });

  it('trigger_auto_recovery rejects missing project_id', async () => {
    const engine = { recoverOne: async () => ({ attempted: true }) };
    await expect(triggerAutoRecovery({ db, engine })).rejects.toThrow(/project_id/);
  });
});
```

- [ ] **Step 2: Run test (fails — module missing)**

Run: `npx vitest run server/tests/auto-recovery-mcp-tools.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement handlers**

Create `server/handlers/auto-recovery-handlers.js`:

```javascript
'use strict';

function listRecoveryStrategies({ engine }) {
  if (!engine || !engine._registry) throw new Error('engine not initialized');
  return {
    rules: engine._registry.getRules().map(r => ({
      name: r.name, category: r.category, priority: r.priority,
      confidence: r.confidence, suggested_strategies: r.suggested_strategies,
    })),
    strategies: engine._registry.getStrategies().map(s => ({
      name: s.name, applicable_categories: s.applicable_categories,
      max_attempts_per_project: s.max_attempts_per_project || null,
    })),
  };
}

function getRecoveryHistory({ db, project_id, limit = 100 }) {
  if (!project_id) throw new Error('project_id is required');
  const rows = db.prepare(`
    SELECT id, project_id, stage, actor, action, reasoning,
           outcome_json, confidence, batch_id, created_at
    FROM factory_decisions
    WHERE project_id = ? AND actor = 'auto-recovery'
    ORDER BY id DESC LIMIT ?
  `).all(project_id, limit);
  return {
    decisions: rows.map(r => {
      let outcome = null;
      try { outcome = r.outcome_json ? JSON.parse(r.outcome_json) : null; } catch {}
      return { ...r, outcome };
    }),
  };
}

function clearAutoRecovery({ db, project_id }) {
  if (!project_id) throw new Error('project_id is required');
  db.prepare(`UPDATE factory_projects
              SET auto_recovery_attempts = 0,
                  auto_recovery_exhausted = 0,
                  auto_recovery_last_action_at = NULL,
                  auto_recovery_last_strategy = NULL
              WHERE id = ?`).run(project_id);
  db.prepare(`INSERT INTO factory_decisions
              (project_id, stage, actor, action, reasoning, confidence, created_at)
              VALUES (?, 'verify', 'auto-recovery', 'auto_recovery_operator_cleared',
                      'Operator cleared auto-recovery counters', 1, ?)`)
    .run(project_id, new Date().toISOString());
  return { cleared: true, project_id };
}

async function triggerAutoRecovery({ db, engine, project_id }) {
  if (!project_id) throw new Error('project_id is required');
  if (!engine || typeof engine.recoverOne !== 'function') throw new Error('engine not initialized');
  const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(project_id);
  if (!project) throw new Error(`project not found: ${project_id}`);
  return engine.recoverOne(project);
}

module.exports = { listRecoveryStrategies, getRecoveryHistory, clearAutoRecovery, triggerAutoRecovery };
```

- [ ] **Step 4: Register tool defs**

In `server/tool-defs/factory-defs.js`, add to the exported tools array:

```javascript
{
  name: 'list_recovery_strategies',
  description: 'Lists registered auto-recovery classifier rules and strategies.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
},
{
  name: 'get_recovery_history',
  description: 'Returns auto-recovery decisions for a factory project.',
  inputSchema: {
    type: 'object', required: ['project_id'],
    properties: {
      project_id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    },
    additionalProperties: false,
  },
},
{
  name: 'clear_auto_recovery',
  description: "Resets a project's auto-recovery counters and exhausted flag.",
  inputSchema: {
    type: 'object', required: ['project_id'],
    properties: { project_id: { type: 'string' } },
    additionalProperties: false,
  },
},
{
  name: 'trigger_auto_recovery',
  description: 'Manually kicks the auto-recovery engine on one project, bypassing cooldown.',
  inputSchema: {
    type: 'object', required: ['project_id'],
    properties: { project_id: { type: 'string' } },
    additionalProperties: false,
  },
},
```

- [ ] **Step 5: Add tool annotations**

In `server/tool-annotations.js`, add these keys to the main annotations map:

```javascript
list_recovery_strategies:   { readOnly: true,  idempotent: true  },
get_recovery_history:       { readOnly: true,  idempotent: true  },
clear_auto_recovery:        { readOnly: false, idempotent: true  },
trigger_auto_recovery:      { readOnly: false, idempotent: false },
```

- [ ] **Step 6: Route handlers in core-tools.js**

In `server/core-tools.js`, add four case branches in the tool-dispatch switch (find the section routing to factory handlers):

```javascript
case 'list_recovery_strategies': {
  const { listRecoveryStrategies } = require('./handlers/auto-recovery-handlers');
  const engine = container.get('autoRecoveryEngine');
  return listRecoveryStrategies({ engine });
}
case 'get_recovery_history': {
  const { getRecoveryHistory } = require('./handlers/auto-recovery-handlers');
  const rawDb = container.get('db').getDbInstance();
  return getRecoveryHistory({ db: rawDb, ...args });
}
case 'clear_auto_recovery': {
  const { clearAutoRecovery } = require('./handlers/auto-recovery-handlers');
  const rawDb = container.get('db').getDbInstance();
  return clearAutoRecovery({ db: rawDb, ...args });
}
case 'trigger_auto_recovery': {
  const { triggerAutoRecovery } = require('./handlers/auto-recovery-handlers');
  const rawDb = container.get('db').getDbInstance();
  const engine = container.get('autoRecoveryEngine');
  return triggerAutoRecovery({ db: rawDb, engine, ...args });
}
```

- [ ] **Step 7: Run the test**

Run: `npx vitest run server/tests/auto-recovery-mcp-tools.test.js`
Expected: all 5 PASS.

- [ ] **Step 8: Commit**

```bash
git add server/handlers/auto-recovery-handlers.js server/tool-defs/factory-defs.js \
        server/tool-annotations.js server/core-tools.js \
        server/tests/auto-recovery-mcp-tools.test.js
git commit -m "feat(auto-recovery): MCP tools for list, history, clear, and trigger"
```

---

## Task 14: REST route + dashboard surfacing

**Files:**
- Modify: `server/api/routes/factory-routes.js`
- Modify: dashboard source files (explored during this task)
- Test: `server/tests/auto-recovery-rest-route.test.js`

- [ ] **Step 1: Write failing REST-route test**

Create `server/tests/auto-recovery-rest-route.test.js`:

```javascript
'use strict';
const { describe, it, expect } = require('vitest');
const fs = require('fs');
const path = require('path');

describe('auto-recovery REST route', () => {
  it('factory-routes.js registers /projects/:id/recovery_history', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'factory-routes.js'), 'utf8');
    expect(src).toMatch(/recovery_history/);
  });
});
```

- [ ] **Step 2: Run it (fails)**

Run: `npx vitest run server/tests/auto-recovery-rest-route.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the REST route**

In `server/api/routes/factory-routes.js`, find the existing `/projects/:id/decisions` handler and add right after it:

```javascript
router.get('/projects/:id/recovery_history', async (req, res) => {
  try {
    const { getRecoveryHistory } = require('../../handlers/auto-recovery-handlers');
    const rawDb = container.get('db').getDbInstance();
    const limit = Number.parseInt(req.query.limit, 10) || 100;
    const result = getRecoveryHistory({ db: rawDb, project_id: req.params.id, limit });
    res.json({ data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Explore dashboard layout**

Run: `ls dashboard/src/components/ dashboard/src/pages/ 2>/dev/null`. Identify the factory project tile component and the factory project detail page. Read each to learn the banner/badge/panel conventions already in use.

- [ ] **Step 5: Add red banner + amber badge to the project tile**

In the factory project tile (exact file from Step 4), near other banners:

```jsx
{project.auto_recovery_exhausted === 1 && (
  <Banner tone="error">
    Auto-recovery exhausted — operator action required.
    <button onClick={() => clearAutoRecovery(project.id)}>Clear & retry</button>
  </Banner>
)}
{project.auto_recovery_attempts > 0 && project.auto_recovery_exhausted !== 1 && (
  <Badge tone="warning" title={`Last strategy: ${project.auto_recovery_last_strategy}`}>
    Auto-recovering: attempt {project.auto_recovery_attempts}/5
  </Badge>
)}
```

`clearAutoRecovery` is a helper that POSTs to the MCP endpoint or calls the existing MCP bridge (match how other dashboard buttons invoke MCP tools).

- [ ] **Step 6: Add Recovery History panel to project detail page**

Following the existing "Decision Log" panel pattern:

```jsx
<Panel title="Recovery History">
  {recoveryHistory.length === 0 && <Empty>No recovery events yet.</Empty>}
  {recoveryHistory.map(d => (
    <Row key={d.id}>
      <Timestamp>{d.created_at}</Timestamp>
      <Action>{d.action}</Action>
      <Reasoning>{d.reasoning}</Reasoning>
    </Row>
  ))}
</Panel>
```

Data source: `GET /api/v2/factory/projects/:id/recovery_history`.

- [ ] **Step 7: Run test + smoke test the dashboard**

Run: `npx vitest run server/tests/auto-recovery-rest-route.test.js`
Expected: PASS.

Then start the server, open the dashboard, create a test row with `auto_recovery_exhausted=1`, confirm the banner renders. Set `auto_recovery_attempts=3`, confirm the badge. Visit the project detail page, confirm the recovery-history panel populates.

- [ ] **Step 8: Commit**

```bash
git add server/api/routes/factory-routes.js server/tests/auto-recovery-rest-route.test.js dashboard/
git commit -m "feat(dashboard): auto-recovery banner, badge, and recovery-history panel"
```

---

## Task 15: End-to-end tests + deconfliction + live smoke test

**Files:**
- Create: `server/tests/auto-recovery-e2e-sourcelink.test.js`
- Create: `server/tests/auto-recovery-e2e-never-started.test.js`
- Create: `server/tests/auto-recovery-deconfliction.test.js`

- [ ] **Step 1: Write E2E — SpudgetBooks sourcelink**

Create `server/tests/auto-recovery-e2e-sourcelink.test.js`:

```javascript
'use strict';
const Database = require('better-sqlite3');
const { describe, it, expect } = require('vitest');
const autoRecovery = require('../factory/auto-recovery');
const { createPlugin } = require('../plugins/auto-recovery-core');

function seed(db) {
  db.prepare(`CREATE TABLE factory_projects (
    id TEXT PRIMARY KEY, name TEXT, status TEXT, path TEXT,
    loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
    auto_recovery_attempts INTEGER DEFAULT 0,
    auto_recovery_last_action_at TEXT,
    auto_recovery_exhausted INTEGER DEFAULT 0,
    auto_recovery_last_strategy TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, stage TEXT, actor TEXT, action TEXT,
    reasoning TEXT, outcome_json TEXT, confidence REAL,
    batch_id TEXT, created_at TEXT
  )`).run();
}

describe('E2E: SpudgetBooks sourcelink scenario', () => {
  it('classifies as transient, runs clean_and_retry, logs success', async () => {
    const db = new Database(':memory:');
    seed(db);
    db.prepare(`INSERT INTO factory_projects
                (id, name, status, path, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('sb', 'SpudgetBooks', 'running', '/fake/sb', 'PAUSED', 'VERIFY_FAIL',
                        '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, reasoning, outcome_json, created_at, batch_id)
                VALUES ('sb', 'verify', 'verifier', 'worktree_verify_failed',
                        'paused at VERIFY_FAIL', ?, '2026-04-21T03:00:00Z', 'b514')`)
       .run(JSON.stringify({
         output_preview: `error : Error writing to source link file sourcelink.json ... being used by another process`,
         retry_attempts: 1,
       }));

    const plugin = createPlugin();
    let cleanupCalled = false, retryCalled = false;
    const engine = autoRecovery.createAutoRecoveryEngine({
      db, logger: { info: () => {}, warn: () => {}, error: () => {} },
      eventBus: { emit: () => {} },
      rules: plugin.classifierRules,
      strategies: plugin.recoveryStrategies,
      services: {
        cleanupWorktreeBuildArtifacts: async () => { cleanupCalled = true; return { deleted: ['/fake/sb/obj'], stacks: ['dotnet'] }; },
        retryFactoryVerify: async () => { retryCalled = true; return { ok: true }; },
        logger: { info: () => {}, warn: () => {} },
      },
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(summary.attempts).toBe(1);
    expect(cleanupCalled).toBe(true);
    expect(retryCalled).toBe(true);

    const actions = db.prepare(`SELECT action FROM factory_decisions
                                WHERE actor='auto-recovery' ORDER BY id`).all().map(d => d.action);
    expect(actions).toContain('auto_recovery_classified');
    expect(actions).toContain('auto_recovery_strategy_selected');
    expect(actions).toContain('auto_recovery_strategy_succeeded');

    const classified = db.prepare(`SELECT outcome_json FROM factory_decisions
                                   WHERE action='auto_recovery_classified'`).get();
    expect(classified.outcome_json).toContain('dotnet_sourcelink_file_lock');
  });
});
```

- [ ] **Step 2: Run — expect PASS**

Run: `npx vitest run server/tests/auto-recovery-e2e-sourcelink.test.js`
Expected: PASS.

- [ ] **Step 3: Write E2E — StateTrace never-started**

Create `server/tests/auto-recovery-e2e-never-started.test.js`:

```javascript
'use strict';
const Database = require('better-sqlite3');
const { describe, it, expect } = require('vitest');
const autoRecovery = require('../factory/auto-recovery');
const { createPlugin } = require('../plugins/auto-recovery-core');

describe('E2E: StateTrace never-started', () => {
  it('classifies as never_started, runs retry_plan_generation', async () => {
    const db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_projects (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, path TEXT,
      loop_state TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
      auto_recovery_attempts INTEGER DEFAULT 0,
      auto_recovery_last_action_at TEXT,
      auto_recovery_exhausted INTEGER DEFAULT 0,
      auto_recovery_last_strategy TEXT
    )`).run();
    db.prepare(`CREATE TABLE factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT, stage TEXT, actor TEXT, action TEXT,
      reasoning TEXT, outcome_json TEXT, confidence REAL,
      batch_id TEXT, created_at TEXT
    )`).run();
    db.prepare(`INSERT INTO factory_projects (id, name, status, path, loop_state)
                VALUES ('st', 'StateTrace', 'paused', '/fake/st', 'IDLE')`).run();

    const plugin = createPlugin();
    let retryPlanCalled = false;
    const engine = autoRecovery.createAutoRecoveryEngine({
      db, logger: { info: () => {}, warn: () => {}, error: () => {} },
      eventBus: { emit: () => {} },
      rules: plugin.classifierRules,
      strategies: plugin.recoveryStrategies,
      services: {
        retryPlanGeneration: async () => { retryPlanCalled = true; return { ok: true }; },
        retryFactoryVerify: async () => ({ ok: true }),
        logger: { info: () => {}, warn: () => {} },
      },
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(summary.attempts).toBe(1);
    expect(retryPlanCalled).toBe(true);
  });
});
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run server/tests/auto-recovery-e2e-never-started.test.js`
Expected: PASS.

- [ ] **Step 5: Write deconfliction test**

Create `server/tests/auto-recovery-deconfliction.test.js`:

```javascript
'use strict';
const Database = require('better-sqlite3');
const { describe, it, expect } = require('vitest');
const { listStalledVerifyLoops } = require('../factory/verify-stall-recovery');

describe('deconfliction — verify-stall-recovery yields to engine', () => {
  it('skips projects the engine touched within cooldown', () => {
    const db = new Database(':memory:');
    db.prepare(`CREATE TABLE factory_projects (
      id TEXT PRIMARY KEY, loop_state TEXT, loop_paused_at_stage TEXT,
      loop_last_action_at TEXT, verify_recovery_attempts INTEGER DEFAULT 0,
      auto_recovery_attempts INTEGER DEFAULT 0,
      auto_recovery_last_action_at TEXT,
      auto_recovery_exhausted INTEGER DEFAULT 0,
      auto_recovery_last_strategy TEXT
    )`).run();

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();

    db.prepare(`INSERT INTO factory_projects
                (id, loop_state, loop_paused_at_stage, loop_last_action_at,
                 auto_recovery_attempts, auto_recovery_last_action_at)
                VALUES ('engine-held', 'VERIFY', NULL, ?, 1, ?)`)
      .run(twoHoursAgo, tenSecondsAgo);

    const stalled = listStalledVerifyLoops(db);
    expect(stalled.map(r => r.project_id)).not.toContain('engine-held');
  });
});
```

- [ ] **Step 6: Run — expect PASS (Task 12 added the gate)**

Run: `npx vitest run server/tests/auto-recovery-deconfliction.test.js`
Expected: PASS.

- [ ] **Step 7: Full factory suite on remote**

Run: `torque-remote npx vitest run server/tests/auto-recovery-*.test.js server/tests/factory-*.test.js server/tests/verify-stall-*.test.js`
Expected: all PASS.

- [ ] **Step 8: Live smoke test against today's stuck projects**

Restart TORQUE via the barrier primitive so the new code loads:

```bash
# Using the MCP barrier — preferred path per CLAUDE.md
# (Claude-invocation path; in manual terms: restart_server via MCP + await_restart)
```

Then check state for the two projects:

```bash
curl -s http://127.0.0.1:3457/api/v2/factory/projects/cdc70fb7-6fe4-48ca-adb8-8a14c45cc3bc \
  | python -c "import sys,json; d=json.load(sys.stdin)['data']; print('SB:', d['loop_state'], d.get('loop_paused_at_stage'), 'ar_attempts=', d.get('auto_recovery_attempts'))"

curl -s http://127.0.0.1:3457/api/v2/factory/projects/ad3e2bb6-7eeb-4927-b31c-5cce0f70dbf6 \
  | python -c "import sys,json; d=json.load(sys.stdin)['data']; print('ST:', d['status'], d['loop_state'], 'ar_attempts=', d.get('auto_recovery_attempts'))"
```

Wait ~5 minutes for one factory tick. Confirm:
1. SpudgetBooks `auto_recovery_attempts >= 1` and loop has advanced (or retry task is queued).
2. StateTrace `status='running'` or `auto_recovery_attempts >= 1`.
3. `curl -s http://127.0.0.1:3457/api/v2/factory/projects/<id>/recovery_history` shows `auto_recovery_classified` and `auto_recovery_strategy_selected` rows for both.

- [ ] **Step 9: Commit**

```bash
git add server/tests/auto-recovery-e2e-sourcelink.test.js \
        server/tests/auto-recovery-e2e-never-started.test.js \
        server/tests/auto-recovery-deconfliction.test.js
git commit -m "test(auto-recovery): E2E SpudgetBooks + StateTrace scenarios + deconfliction gate"
```

---

## Self-Review

**Spec coverage:**
- Plugin contract extension → Task 1 ✓
- Schema columns + `auto-recovery` actor → Task 2 ✓
- Engine core (backoff, classifier, registry, candidate-query, services, engine, entrypoint) → Tasks 3-8 ✓
- Built-in plugin (rules + 8 strategies) → Tasks 9, 10, 11 ✓
- Wiring (DEFAULT_PLUGIN_NAMES, factory-tick, startup-reconciler, verify-stall cooldown gate, DI container) → Task 12 ✓
- MCP tools (4) → Task 13 ✓
- REST route + dashboard surfacing → Task 14 ✓
- E2E: SpudgetBooks sourcelink, StateTrace never-started, deconfliction + live smoke test → Task 15 ✓

**Type consistency check:**
- Strategy interface `{name, applicable_categories, max_attempts_per_project, run(ctx)}` identical across all 8 strategies ✓
- Classifier return shape `{category, matched_rule, confidence, suggested_strategies}` consistent everywhere ✓
- Decision-log verbs consistent with spec: `auto_recovery_classified`, `_strategy_selected`, `_strategy_succeeded`, `_strategy_failed`, `_no_strategy`, `_exhausted`, `_operator_cleared` ✓
- `services` bundle shape consistent between Task 7 (definition) and Tasks 9-10 (consumption) ✓

**Placeholder scan:** none. Dashboard task has an explicit exploration step (Step 4) to identify exact file paths, which is correct scope rather than a missing spec.

Plan is self-consistent and covers the spec in full.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-21-factory-auto-recovery-engine.md`. Three execution options:

**1. Subagent-Driven (recommended for speed)** — fresh subagent per task, code-reviewer pass between tasks.

**2. Inline Execution** — all 15 tasks in this session using superpowers:executing-plans with checkpoints.

**3. TORQUE team pipeline** (`/torque-team`) — matches your global instruction *"Claude's role: architect + orchestrator; never manually implement what TORQUE should produce."* Planner submits tasks to Codex in parallel where dependencies allow; QC reviews each; Remediation fixes failures.

Which approach?
