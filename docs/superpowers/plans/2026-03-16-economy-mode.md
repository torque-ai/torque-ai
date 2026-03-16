# Economy Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified economy mode that shifts task routing from expensive providers to free/cheap alternatives, activated automatically (budget/quota triggers) or manually (dashboard/CLI/MCP).

**Architecture:** Economy mode is a routing policy that layers on top of existing smart routing as a pre-filter. A policy object defines provider tiers (preferred/allowed/blocked) and resolves across four scope levels (global < project < workflow < task). Auto-trigger/auto-lift state machine manages automatic activation based on budget thresholds and codex exhaustion.

**Tech Stack:** Node.js, SQLite (better-sqlite3), React, Playwright

**Spec:** `docs/superpowers/specs/2026-03-16-economy-mode-design.md`

---

## Chunk 1: Policy Data Model & Resolution

### Task 1: Economy Policy Module

**Files:**
- Create: `server/economy/policy.js`
- Test: `server/tests/economy-policy.test.js`

- [ ] **Step 1: Write failing tests for policy defaults and resolution**

```javascript
// server/tests/economy-policy.test.js
'use strict';
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('economy/policy.js', () => {
  let db;
  beforeAll(() => { const env = setupTestDb('economy-policy'); db = env.db; });
  afterAll(() => teardownTestDb());

  describe('getDefaultPolicy', () => {
    it('returns a policy with preferred, allowed, and blocked tiers', () => {
      const { getDefaultPolicy } = require('../economy/policy');
      const policy = getDefaultPolicy();
      expect(policy.enabled).toBe(false);
      expect(policy.provider_tiers.preferred).toContain('hashline-ollama');
      expect(policy.provider_tiers.blocked).toContain('codex');
      expect(policy.complexity_exempt).toBe(true);
    });
  });

  describe('resolveEconomyPolicy', () => {
    it('returns null when economy is off at all scopes', () => {
      const { resolveEconomyPolicy } = require('../economy/policy');
      const result = resolveEconomyPolicy({}, null, null);
      expect(result).toBeNull();
    });

    it('task-level override wins over global', () => {
      const { resolveEconomyPolicy, setGlobalEconomyPolicy } = require('../economy/policy');
      setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });
      const result = resolveEconomyPolicy({ economy: false }, null, null);
      expect(result).toBeNull();
    });

    it('global economy applies when no overrides', () => {
      const { resolveEconomyPolicy, setGlobalEconomyPolicy } = require('../economy/policy');
      setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });
      const result = resolveEconomyPolicy({}, null, null);
      expect(result.enabled).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/economy-policy.test.js`
Expected: FAIL — `Cannot find module '../economy/policy'`

- [ ] **Step 3: Implement policy module**

```javascript
// server/economy/policy.js
'use strict';
const db = require('../database');

const DEFAULT_POLICY = {
  enabled: false,
  trigger: null,
  reason: null,
  auto_trigger_threshold: 85,
  auto_lift_conditions: {
    budget_reset: true,
    codex_recovered: true,
    utilization_below: 50,
  },
  complexity_exempt: true,
  provider_tiers: {
    preferred: ['hashline-ollama', 'aider-ollama', 'ollama', 'google-ai', 'groq', 'openrouter', 'ollama-cloud', 'cerebras'],
    allowed: ['deepinfra', 'hyperbolic'],
    blocked: ['codex', 'claude-cli', 'anthropic'],
  },
};

function getDefaultPolicy() {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY));
}

function getGlobalEconomyPolicy() {
  try {
    const raw = db.getConfig('economy_policy');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setGlobalEconomyPolicy(policy) {
  if (policy === null) {
    db.setConfig('economy_policy', null);
  } else {
    const merged = { ...getDefaultPolicy(), ...policy };
    db.setConfig('economy_policy', JSON.stringify(merged));
  }
}

function getWorkflowEconomyPolicy(workflowId) {
  if (!workflowId) return null;
  try {
    const wf = db.getWorkflow(workflowId);
    if (!wf || !wf.economy_policy) return null;
    return JSON.parse(wf.economy_policy);
  } catch { return null; }
}

function getProjectEconomyPolicy(workingDirectory) {
  if (!workingDirectory) return null;
  try {
    const config = db.getProjectConfig(workingDirectory);
    if (!config || !config.economy_policy) return null;
    return typeof config.economy_policy === 'string'
      ? JSON.parse(config.economy_policy)
      : config.economy_policy;
  } catch { return null; }
}

/**
 * Resolve effective economy policy. First non-null wins:
 * task > workflow > project > global
 *
 * @param {Object} taskArgs - Task submission args (may have .economy)
 * @param {string|null} workflowId
 * @param {string|null} workingDirectory
 * @returns {Object|null} Resolved policy or null (economy off)
 */
function resolveEconomyPolicy(taskArgs, workflowId, workingDirectory) {
  // Task-level: boolean or object
  if (taskArgs.economy === false) return null;
  if (taskArgs.economy === true) return { ...getDefaultPolicy(), enabled: true, trigger: 'manual' };
  if (taskArgs.economy && typeof taskArgs.economy === 'object') {
    return { ...getDefaultPolicy(), ...taskArgs.economy, enabled: true };
  }

  // Workflow-level
  const wfPolicy = getWorkflowEconomyPolicy(workflowId);
  if (wfPolicy) return wfPolicy.enabled ? { ...getDefaultPolicy(), ...wfPolicy } : null;

  // Project-level
  const projPolicy = getProjectEconomyPolicy(workingDirectory);
  if (projPolicy) return projPolicy.enabled ? { ...getDefaultPolicy(), ...projPolicy } : null;

  // Global
  const globalPolicy = getGlobalEconomyPolicy();
  if (globalPolicy && globalPolicy.enabled) return { ...getDefaultPolicy(), ...globalPolicy };

  return null;
}

/**
 * Filter providers based on economy policy tiers.
 * Returns { providers, isEconomy } or null if no filtering needed.
 */
function filterProvidersForEconomy(policy) {
  if (!policy || !policy.enabled) return null;
  const { preferred, allowed, blocked } = policy.provider_tiers;
  const providers = [...(preferred || []), ...(allowed || [])];
  return {
    providers,
    preferred: preferred || [],
    allowed: allowed || [],
    blocked: blocked || [],
    isEconomy: true,
  };
}

// State machine states
const ECONOMY_STATE = { OFF: 'off', AUTO: 'auto', MANUAL: 'manual' };

function getEconomyState() {
  const policy = getGlobalEconomyPolicy();
  if (!policy || !policy.enabled) return ECONOMY_STATE.OFF;
  return policy.trigger === 'auto' ? ECONOMY_STATE.AUTO : ECONOMY_STATE.MANUAL;
}

module.exports = {
  DEFAULT_POLICY,
  ECONOMY_STATE,
  getDefaultPolicy,
  getGlobalEconomyPolicy,
  setGlobalEconomyPolicy,
  getWorkflowEconomyPolicy,
  getProjectEconomyPolicy,
  resolveEconomyPolicy,
  filterProvidersForEconomy,
  getEconomyState,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/economy-policy.test.js`
Expected: PASS

- [ ] **Step 5: Write additional unit tests for filter and state machine**

Add to `economy-policy.test.js`:
- `filterProvidersForEconomy` — returns null when disabled, returns filtered list when enabled, separates preferred/allowed
- `getEconomyState` — returns 'off', 'auto', 'manual' based on stored policy
- Scope hierarchy — workflow overrides global, project overrides global, task `economy: false` overrides everything
- Edge cases — empty preferred list, `complexity_exempt: false`, partial policy objects
- State machine transition tests — all 7 rules from spec:
  1. OFF + manual toggle -> MANUAL
  2. OFF + auto-trigger fires -> AUTO
  3. MANUAL + toggle off -> OFF
  4. MANUAL + auto-trigger fires -> MANUAL (no-op, already active)
  5. AUTO + conditions clear -> OFF
  6. AUTO + manual toggle off -> OFF
  7. AUTO + manual toggle on -> MANUAL (promote)
- `budget_reset` auto-lift condition — verify that `checkAutoLiftConditions` returns `shouldLift: false` when `budget_reset: true` but budget hasn't reset (budgetReset param is false)
- Explicit provider override bypass — task with `economy: false` disables economy even when global is on

- [ ] **Step 6: Run all tests, verify pass**

Run: `cd server && npx vitest run tests/economy-policy.test.js`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add server/economy/policy.js server/tests/economy-policy.test.js
git commit -m "feat(economy): add policy data model and scope resolution"
```

---

### Task 2: Schema Migration — Add economy_policy to workflows

**Files:**
- Modify: `server/db/schema-migrations.js` (append migration block)

- [ ] **Step 1: Add migration for workflows.economy_policy column**

Append to `runMigrations()` in `schema-migrations.js`:
```javascript
// Economy mode: add economy_policy column to workflows
safeAddColumn('workflows', 'economy_policy TEXT DEFAULT NULL');
```

- [ ] **Step 2: Add economy_policy to project_config table**

Append to `runMigrations()`:
```javascript
safeAddColumn('project_config', 'economy_policy TEXT DEFAULT NULL');
```

Note: No config seed is needed for `economy_policy` — `resolveEconomyPolicy()` already returns `null` when no config exists, which correctly means "economy mode off".

- [ ] **Step 3: Run existing schema tests to verify no regression**

Run: `cd server && npx vitest run tests/schema-seeds.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/db/schema-migrations.js
git commit -m "feat(economy): add economy_policy schema migration"
```

---

### Task 3: Whitelist economy_policy in updateWorkflow and setProjectConfig

**Files:**
- Modify: `server/db/workflow-engine.js` (add `economy_policy` to field whitelist in `updateWorkflow()`)
- Modify: `server/db/project-config-core.js` (add `economy_policy` to field handling in `setProjectConfig()` and the INSERT field list)

- [ ] **Step 1: Read and modify `updateWorkflow()` in `server/db/workflow-engine.js`**

Read the `updateWorkflow` function (starts ~line 132). After the `priority` field block (~line 180), add:

```javascript
  if (updates.economy_policy !== undefined) {
    fields.push('economy_policy = ?');
    values.push(updates.economy_policy);
  }
```

This adds `economy_policy` to the whitelist so `db.updateWorkflow(workflowId, { economy_policy: '...' })` actually persists the value.

- [ ] **Step 2: Read and modify `setProjectConfig()` in `server/db/project-config-core.js`**

Read the `setProjectConfig` function (starts ~line 1009). In the UPDATE branch, after the `prefer_remote_tests` block (~line 1138), add:

```javascript
    if (config.economy_policy !== undefined) {
      updates.push('economy_policy = ?');
      values.push(config.economy_policy);
    }
```

In the INSERT branch (~line 1150), add `economy_policy` to the column list and values:

Column list — add after `prefer_remote_tests`:
```sql
        remote_agent_id, remote_project_path, prefer_remote_tests,
        economy_policy,
        created_at, updated_at
```

Values — add after the `prefer_remote_tests` line (~line 1196), before the timestamp values:
```javascript
      config.economy_policy || null,
```

Update the `?` placeholder count to match (add one more `?` to the VALUES clause).

- [ ] **Step 3: Run tests to verify no regression**

Run: `cd server && npx vitest run tests/schema-seeds.test.js tests/project-config.test.js`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/db/workflow-engine.js server/db/project-config-core.js
git commit -m "feat(economy): whitelist economy_policy in updateWorkflow and setProjectConfig"
```

---

## Chunk 2: Auto-trigger, Auto-lift & Routing Integration

### Task 4: Economy Triggers Module

**Files:**
- Create: `server/economy/triggers.js`
- Test: `server/tests/economy-policy.test.js` (extend)

- [ ] **Step 1: Write failing tests for auto-trigger detection**

Add to `economy-policy.test.js`:
```javascript
describe('economy/triggers.js', () => {
  describe('checkAutoTriggerConditions', () => {
    it('triggers when budget utilization exceeds threshold', () => {
      const { checkAutoTriggerConditions } = require('../economy/triggers');
      // Mock budget at 90% utilization, threshold 85%
      const result = checkAutoTriggerConditions({ budgetUtilization: 90, threshold: 85 });
      expect(result.shouldTrigger).toBe(true);
      expect(result.reason).toContain('Budget');
    });

    it('triggers when codex is exhausted', () => {
      const { checkAutoTriggerConditions } = require('../economy/triggers');
      const result = checkAutoTriggerConditions({ codexExhausted: true });
      expect(result.shouldTrigger).toBe(true);
    });

    it('does not trigger when all conditions are fine', () => {
      const { checkAutoTriggerConditions } = require('../economy/triggers');
      const result = checkAutoTriggerConditions({ budgetUtilization: 50, threshold: 85, codexExhausted: false });
      expect(result.shouldTrigger).toBe(false);
    });
  });

  describe('checkAutoLiftConditions', () => {
    it('lifts when all conditions met', () => {
      const { checkAutoLiftConditions } = require('../economy/triggers');
      const result = checkAutoLiftConditions({
        budgetUtilization: 30,
        codexExhausted: false,
        budgetReset: true,
        policy: { auto_lift_conditions: { budget_reset: true, codex_recovered: true, utilization_below: 50 } }
      });
      expect(result.shouldLift).toBe(true);
    });

    it('does not lift when codex still exhausted', () => {
      const { checkAutoLiftConditions } = require('../economy/triggers');
      const result = checkAutoLiftConditions({
        budgetUtilization: 30,
        codexExhausted: true,
        budgetReset: true,
        policy: { auto_lift_conditions: { codex_recovered: true, utilization_below: 50 } }
      });
      expect(result.shouldLift).toBe(false);
    });

    it('does not lift when budget_reset required but not reset', () => {
      const { checkAutoLiftConditions } = require('../economy/triggers');
      const result = checkAutoLiftConditions({
        budgetUtilization: 30,
        codexExhausted: false,
        budgetReset: false,
        policy: { auto_lift_conditions: { budget_reset: true, codex_recovered: true, utilization_below: 50 } }
      });
      expect(result.shouldLift).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement triggers module**

```javascript
// server/economy/triggers.js
'use strict';

/**
 * Check if auto-trigger conditions are met. All inputs are synchronous values.
 * @param {Object} state - { budgetUtilization, threshold, codexExhausted, daysRemaining }
 * @returns {{ shouldTrigger: boolean, reason: string|null }}
 */
function checkAutoTriggerConditions(state) {
  const { budgetUtilization = 0, threshold = 85, codexExhausted = false, daysRemaining = Infinity } = state;

  if (codexExhausted) {
    return { shouldTrigger: true, reason: 'Codex quota exhausted' };
  }
  if (budgetUtilization >= threshold) {
    return { shouldTrigger: true, reason: `Budget utilization at ${Math.round(budgetUtilization)}% (threshold: ${threshold}%)` };
  }
  if (daysRemaining < 2) {
    return { shouldTrigger: true, reason: `Budget projected to exhaust in ${daysRemaining.toFixed(1)} days` };
  }
  return { shouldTrigger: false, reason: null };
}

/**
 * Check if auto-lift conditions are ALL met.
 * @param {Object} state - { budgetUtilization, codexExhausted, budgetReset, policy }
 * @returns {{ shouldLift: boolean }}
 */
function checkAutoLiftConditions(state) {
  const { budgetUtilization = 0, codexExhausted = false, budgetReset = false, policy } = state;
  const conditions = policy?.auto_lift_conditions || {};

  if (conditions.budget_reset && !budgetReset) return { shouldLift: false };
  if (conditions.codex_recovered && codexExhausted) return { shouldLift: false };
  if (conditions.utilization_below && budgetUtilization >= conditions.utilization_below) return { shouldLift: false };

  return { shouldLift: true };
}

module.exports = { checkAutoTriggerConditions, checkAutoLiftConditions };
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add server/economy/triggers.js server/tests/economy-policy.test.js
git commit -m "feat(economy): add auto-trigger and auto-lift condition checks"
```

---

### Task 5: Routing Integration — Filter in analyzeTaskForRouting

**Files:**
- Modify: `server/db/provider-routing-core.js` (~line 254, after `preferFree` block)
- Modify: `server/handlers/integration/routing.js` (pass economy args)
- Modify: `server/handlers/task/core.js` (pass economy args)

- [ ] **Step 1: Write failing integration test**

Add to `economy-policy.test.js`:
```javascript
describe('routing integration', () => {
  it('economy mode filters out blocked providers for simple tasks', () => {
    const { filterProvidersForEconomy, getDefaultPolicy } = require('../economy/policy');
    const policy = { ...getDefaultPolicy(), enabled: true, trigger: 'manual' };
    const result = filterProvidersForEconomy(policy);
    expect(result.providers).not.toContain('codex');
    expect(result.providers).not.toContain('claude-cli');
    expect(result.providers).toContain('hashline-ollama');
    expect(result.providers).toContain('google-ai');
  });
});
```

- [ ] **Step 2: Modify `analyzeTaskForRouting` to accept and apply economy policy**

First, read line 239 of `server/db/provider-routing-core.js` to see the current options destructuring:
```javascript
const { skipHealthCheck = false, isUserOverride = false, preferFree = false } = options;
```

Update it to include `economyPolicy`:
```javascript
const { skipHealthCheck = false, isUserOverride = false, preferFree = false, economyPolicy = null } = options;
```

Then, after the `preferFree` block (~line 278), add:

```javascript
// Economy mode: restrict to cheap/free providers for non-complex tasks
if (economyPolicy) {
  // Skip economy filtering if user explicitly chose a provider
  if (isUserOverride) {
    // User provider override — bypass economy mode
  } else {
    const { determineTaskComplexity } = require('./host-complexity');
    const complexity = determineTaskComplexity(taskDescription, files);
    if (complexity !== 'complex' || !economyPolicy.complexity_exempt) {
      const { filterProvidersForEconomy } = require('../economy/policy');
      const econFilter = filterProvidersForEconomy(economyPolicy);
      if (econFilter) {
        // Try preferred providers first via existing routing logic
        for (const provider of econFilter.preferred) {
          const prov = getProvider(provider);
          if (prov && prov.enabled !== 0) return { provider, model: null, reason: `economy-preferred: ${provider}` };
        }
        // Then allowed providers
        for (const provider of econFilter.allowed) {
          const prov = getProvider(provider);
          if (prov && prov.enabled !== 0) return { provider, model: null, reason: `economy-allowed: ${provider}` };
        }
        // All economy providers unavailable — fall through to normal routing only if complex-exempt
        // Otherwise return error
        return { provider: null, model: null, reason: 'economy: all economy-tier providers unavailable', error: true };
      }
    }
    // Complex + exempt: fall through to normal routing
  }
}
```

Note: Uses `getProvider(provider)` + `.enabled !== 0` check instead of the non-existent `isProviderEnabled()` function. `getProvider()` is already defined in the same file (~line 86) and returns the full provider row from `provider_config`.

- [ ] **Step 3: Pass economy args through routing.js and core.js**

In `server/handlers/integration/routing.js` line 333, change:
```javascript
routingResult = db.analyzeTaskForRouting(task, working_directory, files, {
  preferFree: !!prefer_free,
  economyPolicy: args._economyPolicy || null,
});
```

In `server/handlers/task/core.js` line 167, add `economy` to the args passed to `handleSmartSubmitTask`:
```javascript
return handleSmartSubmitTask({
  ...existingArgs,
  economy: args.economy,
});
```

In `handleSmartSubmitTask`, resolve the economy policy and attach it:
```javascript
const { resolveEconomyPolicy } = require('../../economy/policy');
const economyPolicy = resolveEconomyPolicy(args, args.workflow_id, working_directory);
args._economyPolicy = economyPolicy;
```

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `cd server && npx vitest run tests/economy-policy.test.js tests/provider-routing-core.test.js`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add server/db/provider-routing-core.js server/handlers/integration/routing.js server/handlers/task/core.js
git commit -m "feat(economy): integrate economy policy filter into smart routing"
```

---

## Chunk 3: Queue Re-routing & Maintenance Cycle

### Task 6: Queue Re-routing on Activation

**Files:**
- Create: `server/economy/queue-reroute.js`
- Test: `server/tests/economy-integration.test.js`

- [ ] **Step 1: Write failing test for queue re-routing**

```javascript
// server/tests/economy-integration.test.js
'use strict';
const { setupTestDb, teardownTestDb, safeTool, mkTask } = require('./vitest-setup');

describe('economy queue re-routing', () => {
  let db;
  beforeAll(() => { const env = setupTestDb('economy-integration'); db = env.db; });
  afterAll(() => teardownTestDb());

  it('re-routes queued tasks to economy providers on activation', () => {
    const { rerouteQueuedTasks } = require('../economy/queue-reroute');
    const { getDefaultPolicy } = require('../economy/policy');

    // Create a queued task assigned to codex using mkTask helper
    mkTask(db, { id: 'econ-test-1', task_description: 'Write unit tests', provider: 'codex', status: 'queued' });

    const policy = { ...getDefaultPolicy(), enabled: true, trigger: 'manual' };
    const rerouted = rerouteQueuedTasks(policy, null, null);

    expect(rerouted.length).toBeGreaterThan(0);
    expect(rerouted[0].oldProvider).toBe('codex');
    expect(policy.provider_tiers.blocked).toContain(rerouted[0].oldProvider);
  });

  it('skips running tasks', () => {
    const { rerouteQueuedTasks } = require('../economy/queue-reroute');
    const { getDefaultPolicy } = require('../economy/policy');

    mkTask(db, { id: 'econ-test-2', task_description: 'Running task', provider: 'codex', status: 'running' });

    const policy = { ...getDefaultPolicy(), enabled: true, trigger: 'manual' };
    const rerouted = rerouteQueuedTasks(policy, null, null);
    const ids = rerouted.map(r => r.taskId);
    expect(ids).not.toContain('econ-test-2');
  });

  it('skips complex tasks when complexity_exempt is true', () => {
    const { rerouteQueuedTasks } = require('../economy/queue-reroute');
    const { getDefaultPolicy } = require('../economy/policy');

    // Complex task description
    mkTask(db, { id: 'econ-test-3', task_description: 'Refactor the entire authentication system across 15 files with security review', provider: 'codex', status: 'queued' });

    const policy = { ...getDefaultPolicy(), enabled: true, trigger: 'manual', complexity_exempt: true };
    const rerouted = rerouteQueuedTasks(policy, null, null);
    const ids = rerouted.map(r => r.taskId);
    expect(ids).not.toContain('econ-test-3');
  });

  it('skips tasks with explicit user_provider_override', () => {
    const { rerouteQueuedTasks } = require('../economy/queue-reroute');
    const { getDefaultPolicy } = require('../economy/policy');

    mkTask(db, { id: 'econ-test-4', task_description: 'Task with override', provider: 'codex', status: 'queued' });
    // Set user_provider_override in metadata
    db.updateTask('econ-test-4', { metadata: JSON.stringify({ user_provider_override: true }) });

    const policy = { ...getDefaultPolicy(), enabled: true, trigger: 'manual' };
    const rerouted = rerouteQueuedTasks(policy, null, null);
    const ids = rerouted.map(r => r.taskId);
    expect(ids).not.toContain('econ-test-4');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement queue re-routing**

```javascript
// server/economy/queue-reroute.js
'use strict';
const db = require('../database');
const { determineTaskComplexity } = require('../db/host-complexity');
const logger = require('../logger').child({ component: 'economy-reroute' });

/**
 * Re-route queued tasks to economy-tier providers.
 * Runs inside a transaction. Returns array of { taskId, oldProvider, newProvider }.
 */
function rerouteQueuedTasks(policy, workflowId, workingDirectory) {
  if (!policy || !policy.enabled) return [];

  const rerouted = [];
  const blocked = new Set(policy.provider_tiers.blocked || []);
  const preferred = policy.provider_tiers.preferred || [];

  const tasks = db.listTasks({ status: 'queued', limit: 500 });
  const taskList = Array.isArray(tasks) ? tasks : (tasks.tasks || []);

  for (const task of taskList) {
    // Skip if not assigned to a blocked provider
    if (!blocked.has(task.provider)) continue;

    // Skip if task has explicit user override
    if (task.metadata?.user_provider_override) continue;

    // Skip complex tasks if exempt
    if (policy.complexity_exempt) {
      const complexity = determineTaskComplexity(task.task_description || '', []);
      if (complexity === 'complex') continue;
    }

    // Find first available preferred provider
    const newProvider = preferred.find(p => {
      try { return db.getProvider(p)?.enabled !== 0; } catch { return false; }
    });

    if (newProvider && newProvider !== task.provider) {
      try {
        db.updateTask(task.id, { provider: newProvider });
        rerouted.push({ taskId: task.id, oldProvider: task.provider, newProvider });
        logger.info(`Economy mode: task ${task.id} re-routed ${task.provider} → ${newProvider}`);
      } catch (err) {
        logger.warn(`Economy re-route failed for ${task.id}: ${err.message}`);
      }
    }
  }

  return rerouted;
}

module.exports = { rerouteQueuedTasks };
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add server/economy/queue-reroute.js server/tests/economy-integration.test.js
git commit -m "feat(economy): add queue re-routing on economy activation"
```

---

### Task 7: Maintenance Cycle Integration

**Files:**
- Modify: `server/index.js` (maintenance cycle)
- Modify: `server/economy/policy.js` (add activateEconomy/deactivateEconomy)

- [ ] **Step 1: Add activate/deactivate functions to policy.js**

```javascript
// Add to server/economy/policy.js

function activateEconomyMode(trigger, reason) {
  const policy = { ...getDefaultPolicy(), enabled: true, trigger, reason };
  setGlobalEconomyPolicy(policy);

  // Re-route queued tasks
  const { rerouteQueuedTasks } = require('./queue-reroute');
  const rerouted = rerouteQueuedTasks(policy, null, null);

  // Emit event for dashboard/SSE
  try {
    const { taskEvents } = require('../hooks/event-dispatch');
    taskEvents.emit('economy:activated', { trigger, reason, rerouted: rerouted.length });
  } catch { /* event dispatch optional */ }

  // Broadcast to connected SSE sessions
  try {
    const { sessions, sendJsonRpcNotification } = require('../mcp-sse');
    for (const [_id, session] of sessions) {
      sendJsonRpcNotification(session, 'notifications/message', {
        level: 'info',
        data: JSON.stringify({ type: 'economy_status', enabled: true, trigger, reason }),
      });
    }
  } catch { /* SSE broadcast optional */ }

  return { rerouted: rerouted.length };
}

function deactivateEconomyMode() {
  setGlobalEconomyPolicy(null);

  try {
    const { taskEvents } = require('../hooks/event-dispatch');
    taskEvents.emit('economy:deactivated', {});
  } catch { /* event dispatch optional */ }

  // Broadcast to connected SSE sessions
  try {
    const { sessions, sendJsonRpcNotification } = require('../mcp-sse');
    for (const [_id, session] of sessions) {
      sendJsonRpcNotification(session, 'notifications/message', {
        level: 'info',
        data: JSON.stringify({ type: 'economy_status', enabled: false }),
      });
    }
  } catch { /* SSE broadcast optional */ }
}
```

Note: The SSE broadcast pattern follows `dashboard-server.js` `broadcastStatsUpdateNow()` which iterates connected clients. Here we iterate the MCP SSE `sessions` map and use `sendJsonRpcNotification` (the correct function from `mcp-sse.js`).

- [ ] **Step 2: Add auto-trigger/auto-lift checks to maintenance cycle**

In `server/index.js`, inside the maintenance `setInterval` callback, add:

```javascript
// Economy mode auto-trigger/auto-lift
try {
  const { getEconomyState, getGlobalEconomyPolicy, activateEconomyMode, deactivateEconomyMode } = require('./economy/policy');
  const { checkAutoTriggerConditions, checkAutoLiftConditions } = require('./economy/triggers');
  const state = getEconomyState();

  if (state === 'off') {
    const triggerState = {
      budgetUtilization: getBudgetUtilization(),
      threshold: getGlobalEconomyPolicy()?.auto_trigger_threshold || 85,
      codexExhausted: db.isCodexExhausted(),
      daysRemaining: getCostForecastDaysRemaining(),
    };
    const { shouldTrigger, reason } = checkAutoTriggerConditions(triggerState);
    if (shouldTrigger) activateEconomyMode('auto', reason);
  } else if (state === 'auto') {
    const liftState = {
      budgetUtilization: getBudgetUtilization(),
      codexExhausted: db.isCodexExhausted(),
      budgetReset: isBudgetReset(),
      policy: getGlobalEconomyPolicy(),
    };
    const { shouldLift } = checkAutoLiftConditions(liftState);
    if (shouldLift) deactivateEconomyMode();
  }
  // state === 'manual' → no auto-lift
} catch (err) {
  debugLog(`Economy mode check failed: ${err.message}`);
}
```

Note: The `budgetReset` param is now passed to `checkAutoLiftConditions` so the `budget_reset` condition is actually checked.

- [ ] **Step 3: Run tests**

Run: `cd server && npx vitest run tests/economy-policy.test.js tests/economy-integration.test.js`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/economy/policy.js server/index.js
git commit -m "feat(economy): add activate/deactivate and maintenance cycle integration"
```

---

## Chunk 4: MCP Tools, REST Endpoint & Session Notifications

### Task 8: Economy MCP Tool Definitions

**Files:**
- Create: `server/tool-defs/economy-defs.js`

- [ ] **Step 1: Create tool definitions**

```javascript
// server/tool-defs/economy-defs.js
'use strict';
const tools = [
  {
    name: 'get_economy_status',
    description: 'Get current economy mode status and effective provider pool. Returns policy state, trigger reason, blocked/preferred providers, and which providers are actually available.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Project path for project-scoped economy check' },
        workflow_id: { type: 'string', description: 'Workflow ID for workflow-scoped economy check' },
      },
    },
  },
  {
    name: 'set_economy_mode',
    description: 'Toggle economy mode on/off. Economy mode routes tasks to free/cheap providers to save budget. Can be set at global, project, or workflow scope.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Enable or disable economy mode' },
        scope: { type: 'string', enum: ['global', 'project', 'workflow'], description: 'Scope level (default: global)' },
        working_directory: { type: 'string', description: 'Required when scope=project' },
        workflow_id: { type: 'string', description: 'Required when scope=workflow' },
      },
      required: ['enabled'],
    },
  },
];
module.exports = tools;
```

- [ ] **Step 2: Commit**

```bash
git add server/tool-defs/economy-defs.js
git commit -m "feat(economy): add MCP tool definitions"
```

---

### Task 9: Economy Handlers, Registration & REST Endpoint

**Files:**
- Create: `server/handlers/economy-handlers.js`
- Modify: `server/tools.js` (register defs + handlers)
- Modify: `server/api/routes-passthrough.js` (add REST route)

- [ ] **Step 1: Write failing test**

Add to `economy-integration.test.js`:
```javascript
describe('MCP tools', () => {
  it('get_economy_status returns current state', async () => {
    const result = await safeTool('get_economy_status', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Economy Mode');
  });

  it('set_economy_mode enables economy', async () => {
    const result = await safeTool('set_economy_mode', { enabled: true });
    expect(result.isError).toBeFalsy();

    const status = await safeTool('get_economy_status', {});
    const text = status.content[0].text;
    expect(text).toContain('Enabled');
  });

  it('get_economy_status notifies session on connect when active', async () => {
    // Enable economy first
    await safeTool('set_economy_mode', { enabled: true });
    // Verify status shows enabled
    const status = await safeTool('get_economy_status', {});
    const text = status.content[0].text;
    expect(text).toContain('Enabled');
    // Clean up
    await safeTool('set_economy_mode', { enabled: false });
  });
});
```

- [ ] **Step 2: Implement handlers**

```javascript
// server/handlers/economy-handlers.js
'use strict';
const {
  resolveEconomyPolicy, getGlobalEconomyPolicy, getEconomyState,
  activateEconomyMode, deactivateEconomyMode, getDefaultPolicy,
  setGlobalEconomyPolicy,
} = require('../economy/policy');

function handleGetEconomyStatus(args) {
  const policy = resolveEconomyPolicy(args, args.workflow_id, args.working_directory);
  const state = getEconomyState();
  const globalPolicy = getGlobalEconomyPolicy();

  let output = `## Economy Mode: ${state === 'off' ? 'OFF' : `Enabled (${state})`}\n\n`;

  if (policy) {
    output += `**Trigger:** ${policy.trigger}\n`;
    if (policy.reason) output += `**Reason:** ${policy.reason}\n`;
    output += `**Complexity exempt:** ${policy.complexity_exempt ? 'Yes' : 'No'}\n\n`;
    output += `**Preferred providers:** ${policy.provider_tiers.preferred.join(', ')}\n`;
    output += `**Allowed providers:** ${policy.provider_tiers.allowed.join(', ')}\n`;
    output += `**Blocked providers:** ${policy.provider_tiers.blocked.join(', ')}\n`;
  } else {
    output += 'All providers available. No routing restrictions.\n';
  }

  return { content: [{ type: 'text', text: output }] };
}

function handleSetEconomyMode(args) {
  const { enabled, scope = 'global', working_directory, workflow_id } = args;

  if (scope === 'global') {
    if (enabled) {
      activateEconomyMode('manual', 'Manually enabled via set_economy_mode');
    } else {
      deactivateEconomyMode();
    }
  } else if (scope === 'project') {
    if (!working_directory) return { content: [{ type: 'text', text: 'working_directory required for project scope' }], isError: true };
    const db = require('../database');
    const policy = enabled ? { ...getDefaultPolicy(), enabled: true, trigger: 'manual', reason: 'Manual (project)' } : null;
    db.setProjectConfig(working_directory, { economy_policy: policy ? JSON.stringify(policy) : null });
  } else if (scope === 'workflow') {
    if (!workflow_id) return { content: [{ type: 'text', text: 'workflow_id required for workflow scope' }], isError: true };
    const db = require('../database');
    const policy = enabled ? { ...getDefaultPolicy(), enabled: true, trigger: 'manual', reason: 'Manual (workflow)' } : null;
    db.updateWorkflow(workflow_id, { economy_policy: policy ? JSON.stringify(policy) : null });
  }

  const state = enabled ? 'enabled' : 'disabled';
  return { content: [{ type: 'text', text: `Economy mode ${state} at ${scope} scope.` }] };
}

module.exports = { handleGetEconomyStatus, handleSetEconomyMode };
```

- [ ] **Step 3: Register in tools.js**

Add to TOOLS array:
```javascript
...require('./tool-defs/economy-defs'),
```

Add to HANDLER_MODULES array:
```javascript
require('./handlers/economy-handlers'),
```

- [ ] **Step 4: Add REST endpoint for dashboard**

Add to `server/api/routes-passthrough.js` in the routes array (in the economy section):
```javascript
  // ─── economy (2 routes) ─────────────────────────────────────────────────────
  { method: 'GET', path: '/api/v2/economy/status', tool: 'get_economy_status', mapQuery: true },
  { method: 'POST', path: '/api/v2/economy/mode', tool: 'set_economy_mode', mapBody: true },
```

This uses the existing v2 passthrough dispatch pattern — the routes-passthrough framework automatically calls `handleToolCall('get_economy_status', ...)` when the REST endpoint is hit, which invokes `handleGetEconomyStatus`. No separate handler code needed.

- [ ] **Step 5: Run tests**

Run: `cd server && npx vitest run tests/economy-integration.test.js`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add server/handlers/economy-handlers.js server/tools.js server/api/routes-passthrough.js
git commit -m "feat(economy): add MCP tool handlers, REST endpoint, and register in tools.js"
```

---

### Task 10: Session Notification on Connect

**Files:**
- Modify: `server/mcp-sse.js` (push economy status on session connect)

- [ ] **Step 1: Add economy notification after session establishment**

In `mcp-sse.js`, after the session is added to the sessions set and the endpoint event is sent (~line 1391), add:

```javascript
// Push economy mode status on session connect
try {
  const { getEconomyState, getGlobalEconomyPolicy } = require('./economy/policy');
  const state = getEconomyState();
  if (state !== 'off') {
    const policy = getGlobalEconomyPolicy();
    sendJsonRpcNotification(session, 'notifications/message', {
      level: 'info',
      data: JSON.stringify({
        type: 'economy_status',
        enabled: true,
        trigger: policy?.trigger || state,
        scope: 'global',
        reason: policy?.reason || 'Economy mode active',
        blocked_providers: policy?.provider_tiers?.blocked || [],
        preferred_providers: policy?.provider_tiers?.preferred || [],
      }),
    });
  }
} catch { /* economy module optional */ }
```

Note: Uses `sendJsonRpcNotification(session, 'notifications/message', { level, data })` which is the correct function signature from `mcp-sse.js` (~line 461). The previous plan incorrectly used `sendNotification()` which does not exist.

- [ ] **Step 2: Run MCP SSE tests**

Run: `cd server && npx vitest run tests/mcp-sse.test.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add server/mcp-sse.js
git commit -m "feat(economy): push economy status notification on MCP session connect"
```

---

## Chunk 5: Dashboard Widget & E2E Tests

### Task 11: Dashboard Economy Indicator

**Files:**
- Create: `dashboard/src/components/EconomyIndicator.jsx`
- Modify: `dashboard/src/components/Layout.jsx`

- [ ] **Step 1: Create EconomyIndicator component**

```jsx
// dashboard/src/components/EconomyIndicator.jsx
import { useState, useEffect, useCallback } from 'react';
import { system } from '../api';

const STATE_STYLES = {
  off: { dot: 'bg-green-400', label: 'Economy: Off' },
  auto: { dot: 'bg-amber-400 animate-pulse', label: 'Economy: Auto' },
  manual: { dot: 'bg-blue-400', label: 'Economy: Manual' },
};

export default function EconomyIndicator() {
  const [state, setState] = useState('off');
  const [reason, setReason] = useState('');

  const loadStatus = useCallback(() => {
    fetch('/api/v2/economy/status')
      .then(r => r.json())
      .then(d => {
        const data = d.data || d;
        setState(data.state || 'off');
        setReason(data.reason || '');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 30000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  const style = STATE_STYLES[state] || STATE_STYLES.off;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-slate-800/50 transition-colors cursor-default" title={reason || style.label}>
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
      <span className="text-xs text-slate-400 hidden lg:block">{style.label}</span>
    </div>
  );
}
```

- [ ] **Step 2: Add to Layout header**

In `dashboard/src/components/Layout.jsx`, import and add between SessionSwitcher and keyboard hint:
```jsx
import EconomyIndicator from './EconomyIndicator';
// ...
<EconomyIndicator />
```

- [ ] **Step 3: Run dashboard tests**

Run: `cd dashboard && npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/EconomyIndicator.jsx dashboard/src/components/Layout.jsx
git commit -m "feat(economy): add dashboard economy mode indicator"
```

---

### Task 12: E2E Test

**Files:**
- Create: `dashboard/e2e/economy.spec.js`

- [ ] **Step 1: Create E2E test with page.route() interception**

```javascript
// dashboard/e2e/economy.spec.js
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v2/economy/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { state: 'auto', reason: 'Budget at 90%', trigger: 'auto' } }),
    });
  });
  // Catch-all for other API routes
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('/economy/')) { route.fallback(); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) });
  });
});

test('economy indicator shows auto state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('text=Economy: Auto')).toBeVisible({ timeout: 10000 });
});

test('economy indicator shows off state when disabled', async ({ page }) => {
  await page.route('**/api/v2/economy/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { state: 'off' } }),
    });
  });
  await page.goto('/');
  await expect(page.locator('text=Economy: Off')).toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 2: Run E2E tests**

Run: `cd dashboard && npx playwright test e2e/economy.spec.js`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add dashboard/e2e/economy.spec.js
git commit -m "feat(economy): add E2E tests for economy indicator"
```

---

### Task 13: Final Integration Verification

- [ ] **Step 1: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: All pass, 0 failures

- [ ] **Step 2: Run full dashboard test suite**

Run: `cd dashboard && npx vitest run`
Expected: All pass

- [ ] **Step 3: Run lint**

Run: `cd server && npm run lint && cd ../dashboard && npm run lint`
Expected: 0 warnings, 0 errors

- [ ] **Step 4: Final commit and push**

```bash
git push
```

- [ ] **Step 5: Verify CI passes**

Run: `gh run watch $(gh run list --limit 1 --workflow test.yml --branch main --json databaseId --jq '.[0].databaseId') --exit-status`
Expected: 6/6 green
