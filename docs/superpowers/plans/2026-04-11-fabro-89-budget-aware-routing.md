# Fabro #89: Budget-Aware Routing (LiteLLM)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn Plan 6's cost ceilings from passive limits into **active routing policy**: per-tenant/user/project spend feeds provider selection. When a tenant is close to its budget, TORQUE routes to cheaper providers; when at budget, it blocks or falls back to free local. Inspired by LiteLLM.

**Architecture:** A `budget-tracker.js` records spend against scopes (`tenant`, `user`, `project`, `domain`). Before each provider call, `budget-aware-router.js` asks the tracker for remaining budget and filters candidate providers: if cheapest remaining option fits, use it; otherwise fall back. Spend rows are written after each call with actual token usage × provider price. Admin REST surface exposes current spend + budgets + remaining.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 3 (stylesheet routing), 6 (cost ceilings), 33 (concurrency keys), 38 (domains).

---

> See `docs/superpowers/plan-authoring.md` for the alignment checklist.

---

## File Structure

**New files:**
- `server/migrations/0NN-budget-tracker.sql`
- `server/billing/budget-tracker.js`
- `server/billing/budget-aware-router.js`
- `server/billing/provider-pricing.js` — price table per provider/model
- `server/tests/budget-tracker.test.js`
- `server/tests/budget-aware-router.test.js`

**Modified files:**
- `server/execution/provider-router.js` — consult budget before provider choice
- `server/execution/task-finalizer.js` — record spend after completion

---

## Task 1: Budget tracker

- [ ] **Step 1: Migration**

`server/migrations/0NN-budget-tracker.sql`:

```sql
CREATE TABLE IF NOT EXISTS budget_limits (
  scope_type TEXT NOT NULL,         -- 'tenant' | 'user' | 'project' | 'domain' | 'global'
  scope_id TEXT NOT NULL,
  window TEXT NOT NULL,             -- 'daily' | 'weekly' | 'monthly' | 'total'
  amount_usd REAL NOT NULL,
  warn_at_fraction REAL DEFAULT 0.8,
  hard_cap INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_type, scope_id, window)
);

CREATE TABLE IF NOT EXISTS spend_records (
  record_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  task_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  amount_usd REAL NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spend_scope_time ON spend_records(scope_type, scope_id, occurred_at);
```

- [ ] **Step 2: Tests**

Create `server/tests/budget-tracker.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createBudgetTracker } = require('../billing/budget-tracker');

describe('budgetTracker', () => {
  let db, tracker;
  beforeEach(() => {
    db = setupTestDb();
    tracker = createBudgetTracker({ db });
  });

  it('setLimit + getLimit roundtrips', () => {
    tracker.setLimit({ scopeType: 'tenant', scopeId: 'acme', window: 'monthly', amountUsd: 1000 });
    const lim = tracker.getLimit({ scopeType: 'tenant', scopeId: 'acme', window: 'monthly' });
    expect(lim.amount_usd).toBe(1000);
  });

  it('recordSpend accumulates + spendForWindow sums correctly', () => {
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'acme', provider: 'codex', amountUsd: 1.5 });
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'acme', provider: 'codex', amountUsd: 2.0 });
    expect(tracker.spendForWindow({ scopeType: 'tenant', scopeId: 'acme', window: 'monthly' })).toBe(3.5);
  });

  it('spendForWindow=daily only counts today', () => {
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'a', provider: 'p', amountUsd: 1 });
    db.prepare(`UPDATE spend_records SET occurred_at = datetime('now', '-2 days')`).run();
    expect(tracker.spendForWindow({ scopeType: 'tenant', scopeId: 'a', window: 'daily' })).toBe(0);
  });

  it('remaining returns limit - spent, or Infinity when no limit', () => {
    tracker.setLimit({ scopeType: 'tenant', scopeId: 'a', window: 'monthly', amountUsd: 100 });
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'a', provider: 'p', amountUsd: 30 });
    expect(tracker.remaining({ scopeType: 'tenant', scopeId: 'a', window: 'monthly' })).toBe(70);
    expect(tracker.remaining({ scopeType: 'tenant', scopeId: 'nope', window: 'monthly' })).toBe(Infinity);
  });

  it('shouldWarn returns true when spent >= warn_at_fraction × limit', () => {
    tracker.setLimit({ scopeType: 'tenant', scopeId: 'a', window: 'monthly', amountUsd: 100, warnAtFraction: 0.8 });
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'a', provider: 'p', amountUsd: 85 });
    expect(tracker.shouldWarn({ scopeType: 'tenant', scopeId: 'a', window: 'monthly' })).toBe(true);
  });

  it('isOver returns true when spent >= limit', () => {
    tracker.setLimit({ scopeType: 'tenant', scopeId: 'a', window: 'monthly', amountUsd: 100 });
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'a', provider: 'p', amountUsd: 101 });
    expect(tracker.isOver({ scopeType: 'tenant', scopeId: 'a', window: 'monthly' })).toBe(true);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/billing/budget-tracker.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

const WINDOW_SQL = {
  daily:   `occurred_at >= datetime('now', 'start of day')`,
  weekly:  `occurred_at >= datetime('now', '-7 days')`,
  monthly: `occurred_at >= datetime('now', 'start of month')`,
  total:   `1=1`,
};

function createBudgetTracker({ db }) {
  function setLimit({ scopeType, scopeId, window, amountUsd, warnAtFraction = 0.8, hardCap = true }) {
    db.prepare(`
      INSERT OR REPLACE INTO budget_limits (scope_type, scope_id, window, amount_usd, warn_at_fraction, hard_cap)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scopeType, scopeId, window, amountUsd, warnAtFraction, hardCap ? 1 : 0);
  }

  function getLimit({ scopeType, scopeId, window }) {
    return db.prepare(`SELECT * FROM budget_limits WHERE scope_type = ? AND scope_id = ? AND window = ?`)
      .get(scopeType, scopeId, window);
  }

  function recordSpend({ scopeType, scopeId, taskId = null, provider, model = null, promptTokens = 0, completionTokens = 0, amountUsd }) {
    const id = `spend_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO spend_records (record_id, scope_type, scope_id, task_id, provider, model, prompt_tokens, completion_tokens, amount_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, scopeType, scopeId, taskId, provider, model, promptTokens, completionTokens, amountUsd);
  }

  function spendForWindow({ scopeType, scopeId, window }) {
    const where = WINDOW_SQL[window] || WINDOW_SQL.total;
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM spend_records WHERE scope_type = ? AND scope_id = ? AND ${where}
    `).get(scopeType, scopeId);
    return row.total;
  }

  function remaining({ scopeType, scopeId, window }) {
    const lim = getLimit({ scopeType, scopeId, window });
    if (!lim) return Infinity;
    return Math.max(0, lim.amount_usd - spendForWindow({ scopeType, scopeId, window }));
  }

  function shouldWarn({ scopeType, scopeId, window }) {
    const lim = getLimit({ scopeType, scopeId, window });
    if (!lim) return false;
    return spendForWindow({ scopeType, scopeId, window }) >= lim.amount_usd * lim.warn_at_fraction;
  }

  function isOver({ scopeType, scopeId, window }) {
    const lim = getLimit({ scopeType, scopeId, window });
    if (!lim) return false;
    return spendForWindow({ scopeType, scopeId, window }) >= lim.amount_usd;
  }

  return { setLimit, getLimit, recordSpend, spendForWindow, remaining, shouldWarn, isOver };
}

module.exports = { createBudgetTracker };
```

Run tests → PASS. Commit: `feat(billing): budget tracker with windowed spend + limit evaluation`.

---

## Task 2: Budget-aware router

- [ ] **Step 1: Pricing + tests**

Create `server/billing/provider-pricing.js`:

```js
'use strict';

// Approximate per-1M-token pricing for rough cost estimation.
// Overridable via serverConfig.set('provider_pricing_<name>', ...) per deployment.
const DEFAULT_PRICING_USD = {
  codex:             { prompt_per_m: 3.0,  completion_per_m: 15.0 },
  'codex-spark':     { prompt_per_m: 1.0,  completion_per_m: 5.0 },
  'claude-cli':      { prompt_per_m: 3.0,  completion_per_m: 15.0 },
  anthropic:         { prompt_per_m: 3.0,  completion_per_m: 15.0 },
  deepinfra:         { prompt_per_m: 0.13, completion_per_m: 0.50 },
  hyperbolic:        { prompt_per_m: 0.40, completion_per_m: 1.20 },
  groq:              { prompt_per_m: 0.15, completion_per_m: 0.30 },
  cerebras:          { prompt_per_m: 0.10, completion_per_m: 0.20 },
  'google-ai':       { prompt_per_m: 0.40, completion_per_m: 1.60 },
  openrouter:        { prompt_per_m: 1.00, completion_per_m: 4.00 },
  ollama:            { prompt_per_m: 0,    completion_per_m: 0 },
  'ollama-cloud':    { prompt_per_m: 0,    completion_per_m: 0 },
};

function estimateCost({ provider, promptTokens, completionTokens, overrides = null }) {
  const p = (overrides || {})[provider] || DEFAULT_PRICING_USD[provider] || DEFAULT_PRICING_USD.codex;
  return (promptTokens / 1_000_000) * p.prompt_per_m + (completionTokens / 1_000_000) * p.completion_per_m;
}

function estimatePromptCost({ provider, expectedPromptTokens, expectedCompletionTokens = 500, overrides = null }) {
  return estimateCost({ provider, promptTokens: expectedPromptTokens, completionTokens: expectedCompletionTokens, overrides });
}

module.exports = { estimateCost, estimatePromptCost, DEFAULT_PRICING_USD };
```

Create `server/tests/budget-aware-router.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createBudgetTracker } = require('../billing/budget-tracker');
const { createBudgetAwareRouter } = require('../billing/budget-aware-router');

describe('budgetAwareRouter.pick', () => {
  let db, tracker, router;
  beforeEach(() => {
    db = setupTestDb();
    tracker = createBudgetTracker({ db });
    router = createBudgetAwareRouter({ tracker });
  });

  it('returns preferred provider when plenty of budget remains', () => {
    tracker.setLimit({ scopeType: 'tenant', scopeId: 'acme', window: 'monthly', amountUsd: 100 });
    const r = router.pick({
      scope: { scopeType: 'tenant', scopeId: 'acme' },
      window: 'monthly',
      preferred: ['codex', 'ollama'],
      expectedPromptTokens: 2000,
      expectedCompletionTokens: 500,
    });
    expect(r.provider).toBe('codex');
    expect(r.reason).toMatch(/within budget/);
  });

  it('falls back to cheaper provider near budget edge', () => {
    tracker.setLimit({ scopeType: 'tenant', scopeId: 'acme', window: 'monthly', amountUsd: 10 });
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'acme', provider: 'codex', amountUsd: 9.9 });
    const r = router.pick({
      scope: { scopeType: 'tenant', scopeId: 'acme' },
      window: 'monthly',
      preferred: ['codex', 'deepinfra', 'ollama'],
      expectedPromptTokens: 2000,
      expectedCompletionTokens: 500,
    });
    expect(r.provider).toBe('ollama');
    expect(r.reason).toMatch(/cheaper fallback/);
  });

  it('refuses when over hard budget cap + no free fallback', () => {
    tracker.setLimit({ scopeType: 'tenant', scopeId: 'acme', window: 'monthly', amountUsd: 10, hardCap: true });
    tracker.recordSpend({ scopeType: 'tenant', scopeId: 'acme', provider: 'codex', amountUsd: 11 });
    const r = router.pick({
      scope: { scopeType: 'tenant', scopeId: 'acme' },
      window: 'monthly',
      preferred: ['codex', 'anthropic'],
      expectedPromptTokens: 2000, expectedCompletionTokens: 500,
    });
    expect(r.provider).toBeNull();
    expect(r.reason).toMatch(/hard cap/);
  });

  it('no limit = pick first preferred', () => {
    const r = router.pick({
      scope: { scopeType: 'tenant', scopeId: 'nope' }, window: 'monthly',
      preferred: ['codex'], expectedPromptTokens: 100,
    });
    expect(r.provider).toBe('codex');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/billing/budget-aware-router.js`:

```js
'use strict';
const { estimatePromptCost, DEFAULT_PRICING_USD } = require('./provider-pricing');

function createBudgetAwareRouter({ tracker, pricingOverrides = null }) {
  function costFor(provider, expectedPromptTokens, expectedCompletionTokens) {
    return estimatePromptCost({ provider, expectedPromptTokens, expectedCompletionTokens, overrides: pricingOverrides });
  }

  function pick({ scope, window = 'monthly', preferred, expectedPromptTokens, expectedCompletionTokens = 500 }) {
    const remaining = tracker.remaining({ scopeType: scope.scopeType, scopeId: scope.scopeId, window });
    if (remaining === Infinity) return { provider: preferred[0], reason: 'no limit set' };

    // Sort candidates by estimated cost ascending
    const candidates = preferred.map(p => ({
      provider: p, estimated: costFor(p, expectedPromptTokens, expectedCompletionTokens),
    })).sort((a, b) => a.estimated - b.estimated);

    const preferredProvider = preferred[0];
    const preferredCost = costFor(preferredProvider, expectedPromptTokens, expectedCompletionTokens);
    if (preferredCost <= remaining) {
      return { provider: preferredProvider, reason: 'within budget', estimated_cost_usd: preferredCost, remaining_usd: remaining };
    }

    // Find cheapest candidate within remaining budget
    for (const c of candidates) {
      if (c.estimated <= remaining) {
        return { provider: c.provider, reason: `cheaper fallback (preferred ${preferredProvider} would exceed budget)`, estimated_cost_usd: c.estimated, remaining_usd: remaining };
      }
    }

    // Check hard cap
    const lim = tracker.getLimit({ scopeType: scope.scopeType, scopeId: scope.scopeId, window });
    if (lim?.hard_cap) {
      return { provider: null, reason: 'hard cap: remaining budget is 0 and no fallback fits', remaining_usd: remaining };
    }
    return { provider: preferredProvider, reason: 'soft cap exceeded, proceeding anyway', estimated_cost_usd: preferredCost, remaining_usd: remaining };
  }

  return { pick };
}

module.exports = { createBudgetAwareRouter };
```

Run tests → PASS. Commit: `feat(billing): budget-aware router with cheapest-fits fallback + hard cap`.

---

## Task 3: Wire into provider router + record on finalize + MCP

- [ ] **Step 1: Provider-router integration**

In `server/execution/provider-router.js` before final provider selection:

```js
const tracker = defaultContainer.get('budgetTracker');
const router = defaultContainer.get('budgetAwareRouter');
const scope = { scopeType: 'domain', scopeId: task.domain_id || 'default' };
const decision = router.pick({
  scope, window: 'monthly',
  preferred: [task.provider, ...fallbackProviders],
  expectedPromptTokens: estimateTokensFromPrompt(task.task_description),
});
if (decision.provider === null) {
  // Block the task
  return { provider: null, failed: true, reason: decision.reason };
}
task.provider = decision.provider;
addTaskTag(taskId, `budget:${decision.provider}`);
```

- [ ] **Step 2: Finalizer records spend**

In `server/execution/task-finalizer.js` after success:

```js
const tracker = defaultContainer.get('budgetTracker');
const { estimateCost } = require('../billing/provider-pricing');
const actualCost = estimateCost({
  provider: task.provider,
  promptTokens: task.prompt_tokens || 0,
  completionTokens: task.completion_tokens || 0,
});
tracker.recordSpend({
  scopeType: 'domain', scopeId: task.domain_id || 'default',
  taskId, provider: task.provider, model: task.model,
  promptTokens: task.prompt_tokens, completionTokens: task.completion_tokens,
  amountUsd: actualCost,
});
```

- [ ] **Step 3: Admin REST + MCP**

```js
set_budget: { description: 'Set a monthly/weekly/daily budget limit for a scope.', inputSchema: {...} },
get_spend: { description: 'Get current spend for a scope + window.', inputSchema: {...} },
list_budgets: { description: 'List configured budgets + current spend.', inputSchema: {...} },
```

`await_restart`. Smoke: set `{scopeType:'domain', scopeId:'test', window:'monthly', amountUsd:5}`. Submit a codex task with prompt estimated to cost $6 — confirm router switches to ollama (tag `budget:ollama`). After completion, confirm spend recorded and visible via `get_spend`.

Commit: `feat(billing): wire budget-aware routing + spend recording into task lifecycle`.
