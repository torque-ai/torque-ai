# Fabro #89: Budget-Aware Routing (LiteLLM)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn Plan 6's cost ceilings from passive limits into **active routing policy**: per-tenant/user/project spend feeds provider selection. When a tenant is close to its budget, TORQUE routes to cheaper providers; when at budget, it blocks or falls back to free local. Inspired by LiteLLM.

**Architecture:** A `budget-tracker.js` records spend against scopes (`tenant`, `user`, `project`, `domain`). Before each provider call, `budget-aware-router.js` asks the tracker for remaining budget and filters candidate providers: if cheapest remaining option fits, use it; otherwise fall back. Spend rows are written after each call with actual token usage × provider price. Admin REST surface exposes current spend + budgets + remaining.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 3 (stylesheet routing), 6 (cost ceilings), 33 (concurrency keys), 38 (domains).

---

The existing simple MCP budget surface stays in place. `set_budget` and `get_budget_status` continue to use the current cost-tracking/budget-watcher flow and must remain backward-compatible. The new scope-aware surface is additive: use `set_scope_budget`, `get_scope_spend`, and `list_scope_budgets`. Do not introduce a second `set_budget`, and do not reuse the earlier draft names `get_spend` / `list_budgets`.

Keep the new passthrough routes under the existing `validation` domain (`set-scope-budget`, `get-scope-spend`, `list-scope-budgets`) so `server/tests/rest-passthrough-coverage.test.js` stays on a known domain segment and no new `EXPECTED_DOMAINS` entry is needed.

## File Structure

**New files:**
- `server/migrations/0NN-budget-tracker.sql`
- `server/billing/budget-tracker.js`
- `server/billing/budget-aware-router.js`
- `server/billing/provider-pricing.js`
- `server/tests/budget-tracker.test.js`
- `server/tests/budget-aware-router.test.js`
- `server/tests/provider-pricing.test.js`

**Modified files:**
- `server/container.js`
- `server/execution/provider-router.js`
- `server/execution/task-finalizer.js`
- `server/tool-defs/validation-defs.js`
- `server/handlers/validation/index.js`
- `server/tool-annotations.js`
- `server/core-tools.js`
- `server/tool-output-schemas.js`
- `server/api/routes-passthrough.js`
- `server/tests/rest-passthrough-coverage.test.js`
- `server/tests/schema-tables.test.js`
- `server/tests/schema-migrations.test.js`
- `server/tests/vitest-setup.js`
- `server/tests/test-container-helper.js`
- `server/tests/validation-cost-handlers.test.js`
- `server/tests/validation-handlers.test.js`
- `server/tests/provider-failover.test.js`
- `server/tests/task-finalizer.test.js`

## Task 0: Companion-file updates

- [ ] **Step 0a: Register tool def** in `server/tool-defs/validation-defs.js` — add `set_scope_budget`, `get_scope_spend`, and `list_scope_budgets`; do not rename or alter the existing `set_budget`
- [ ] **Step 0b: Add annotations** in `server/tool-annotations.js` for each new tool name (readOnlyHint, destructiveHint, idempotentHint, openWorldHint — match style of nearby entries)
- [ ] **Step 0c: Expose in tier** in `server/core-tools.js` (`CORE_TOOL_NAMES`, `EXTENDED_TOOL_NAMES` on current main; use the appropriate tier)
- [ ] **Step 0d: Output schema** in `server/tool-output-schemas.js` if the tool returns structured data; include the tool name in the EXPECTED list is no longer needed (property-based now)
- [ ] **Step 0e: REST passthrough route** in `server/api/routes-passthrough.js` if the tool should be reachable over v2 REST; new domain segment must be added to `EXPECTED_DOMAINS` in `server/tests/rest-passthrough-coverage.test.js`
- [ ] **Step 0f: Study-context schema** — if this tool emits task_description-like content, no-op; otherwise verify no new required fields the validation surface depends on

Task 4 completes Task 0a-0f for each new tool. The old `set_budget` tool, its current route, and its existing tests remain in place except where shared wiring must continue to pass legacy behavior.

After making the edits, stop.

## Task 1: Budget tracker foundation

- [ ] **Step 1: Add the migration and schema expectations**

    CREATE TABLE IF NOT EXISTS budget_limits (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      window TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      warn_at_fraction REAL NOT NULL DEFAULT 0.8,
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

    CREATE INDEX IF NOT EXISTS idx_spend_scope_time
      ON spend_records(scope_type, scope_id, occurred_at);

    Update `server/tests/schema-tables.test.js` and `server/tests/schema-migrations.test.js` in the same task so the new tables/indexes are part of the enforced schema inventory. Also update `server/tests/vitest-setup.js` so the test DB creates `budget_limits` and `spend_records` before any handler or router tests run.

- [ ] **Step 2: Implement `server/billing/budget-tracker.js`**

    Create `createBudgetTracker({ db })` with `setLimit`, `getLimit`, `recordSpend`, `spendForWindow`, `remaining`, `shouldWarn`, and `isOver`. Keep scope arguments named `scopeType` / `scopeId`, support `tenant`, `user`, `project`, `domain`, and `global`, and keep "no configured limit" semantics as `Infinity` for `remaining(...)`.

- [ ] **Step 3: Add tracker tests**

    Add `server/tests/budget-tracker.test.js` covering limit roundtrips, daily/monthly window aggregation, warning threshold behavior, hard-cap comparisons, and the no-limit path. Do not fold the legacy `set_budget` tests into this file; this is the new scoped storage layer only.

After making the edits, stop.

## Task 2: Test container wiring

- [ ] **Step 1: Register tracker and router in test bootstrap**

    In `server/tests/vitest-setup.js`, once `budget_limits` and `spend_records` exist, add a helper that installs the scoped budget services for the current DB handle. Main currently uses `defaultContainer.registerValue(...)` and `defaultContainer.resetForTest()` rather than `set(...)` / `clear(...)`, so follow the real container API instead of inventing new methods.

    const { createBudgetTracker } = require('../billing/budget-tracker');
    const { createBudgetAwareRouter } = require('../billing/budget-aware-router');

    function installBudgetTestServices(container, dbHandle) {
      const tracker = createBudgetTracker({ db: dbHandle });
      const router = createBudgetAwareRouter({ tracker });
      container.registerValue('budgetTracker', tracker);
      container.registerValue('budgetAwareRouter', router);
      return { tracker, router };
    }

    Use the helper from `server/tests/vitest-setup.js` for `safeTool(...)` suites, and mirror the same registrations in `server/tests/test-container-helper.js` so fresh per-test containers resolve the new services too.

- [ ] **Step 2: Reset between tests**

    Ensure the helper is re-run after any `defaultContainer.resetForTest()` call so a fresh `budgetTracker` / `budgetAwareRouter` pair is installed per test file or per suite. Replace any assumption that `defaultContainer.clear('budgetTracker')` exists; current main does not expose `clear()`.

- [ ] **Step 3: Wire legacy budget suites**

    In `server/tests/validation-handlers.test.js` and any other suites that reset the default container before calling `safeTool(...)`, install the scoped budget services in `beforeEach` so handler resolution sees the new tracker/router without breaking existing `budgetWatcher` coverage.

After making the edits, stop.

## Task 3: Configurable pricing and router integration

- [ ] **Step 1: Make provider pricing configurable**

    In `server/billing/provider-pricing.js`, export a default per-1M-token pricing table and a helper that merges `process.env.TORQUE_PROVIDER_PRICING_OVERRIDE` (JSON) over the defaults. Override values win field-for-field, and tests must set and restore the env var instead of relying on the default table never changing.

- [ ] **Step 2: Implement `server/billing/budget-aware-router.js`**

    Build a router that consumes `budgetTracker` plus the merged pricing table. Preserve the caller's preferred provider when budget permits, choose the cheapest candidate that still fits when the preferred provider would overspend, and return a structured "blocked by hard cap" result when no allowed fallback fits.

- [ ] **Step 3: Register runtime services**

    In `server/container.js`, register `budgetTracker` and `budgetAwareRouter` as additive runtime services alongside the existing `budgetWatcher`. Keep `budgetWatcher` behavior intact for today's `get_budget_status` and downgrade-template flows; the new router is a scoped routing input, not a replacement for the existing watcher.

- [ ] **Step 4: Wire routing and spend recording**

    Update `server/execution/provider-router.js` to consult the scoped router before final provider selection, and update `server/execution/task-finalizer.js` to record actual spend after completion using `prompt_tokens`, `completion_tokens`, provider, model, and the merged pricing table.

- [ ] **Step 5: Update routing regressions**

    Update `server/tests/provider-failover.test.js` and `server/tests/task-finalizer.test.js` in the same task. Keep the current cost/budget smoke behavior green, then add deterministic budget-pressure cases that set `TORQUE_PROVIDER_PRICING_OVERRIDE` and assert the router either downgrades to the cheaper provider or blocks on a hard cap.

After making the edits, stop.

## Task 4: Scope-aware MCP budget surface

- [ ] **Step 1: Keep legacy `set_budget` intact and add the new names**

    The existing `set_budget` tool in `server/tool-defs/validation-defs.js`, `server/handlers/validation/index.js`, and current docs/tests stays untouched. The new scope-aware tools are `set_scope_budget`, `get_scope_spend`, and `list_scope_budgets`; do not add another `set_budget`, and do not rename the current one.

- [ ] **Step 2: Implement async handlers with `makeError(...)` only**

    Add the new handlers in `server/handlers/validation/index.js` and follow `handleScheduleWorkflowSpec` in `server/handlers/schedule-handlers.js`: validate inputs with `makeError(ErrorCodes.X, ...)`, wrap the full body in `try/catch`, and return `makeError(ErrorCodes.OPERATION_FAILED, ...)` from the catch block. This task must satisfy `server/tests/p3-async-trycatch.test.js` and `server/tests/p3-raw-throws.test.js`.

    async function handleSetScopeBudget(args) {
      try {
        const scopeType = typeof args?.scope_type === 'string' ? args.scope_type.trim() : '';
        const scopeId = typeof args?.scope_id === 'string' ? args.scope_id.trim() : '';
        if (!scopeType || !scopeId) {
          return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'scope_type and scope_id are required');
        }

        return {
          content: [{ type: 'text', text: 'scope budget updated' }],
          structuredData: { ok: true },
        };
      } catch (err) {
        return makeError(ErrorCodes.OPERATION_FAILED, `Failed to set scope budget: ${err.message}`);
      }
    }

    `handleGetScopeSpend(...)` and `handleListScopeBudgets(...)` must use the same pattern. Never author raw exceptions in these handlers.

- [ ] **Step 3: Complete Task 0a-0f for each new tool**

    Finish Task 0a-0f for `set_scope_budget`, `get_scope_spend`, and `list_scope_budgets`: tool defs in `server/tool-defs/validation-defs.js`, annotations in `server/tool-annotations.js`, tier exposure in `server/core-tools.js`, output schemas in `server/tool-output-schemas.js`, passthrough routes in `server/api/routes-passthrough.js`, and no new `EXPECTED_DOMAINS` entry because the routes remain under the existing `validation` passthrough domain.

- [ ] **Step 4: Update `server/tests/validation-cost-handlers.test.js`**

    Keep the legacy `set_budget` coverage exactly as the backward-compat guard, then add new scope-aware write/read cases alongside it. If shared helpers are introduced, cover both the existing provider/global shape and the new `scope_type` / `scope_id` shape in the same file.

- [ ] **Step 5: Update `server/tests/validation-handlers.test.js`**

    Install `budgetTracker` / `budgetAwareRouter` in `beforeEach` when the suite touches the new handlers, preserve the current `set_budget` expectations, and add failure-path assertions for missing params, invalid windows, and catch-path `OPERATION_FAILED` responses.

After making the edits, stop.

## Task 5: Targeted verification slices

- [ ] **Step 1: Run tracker, pricing, and router tests**

    npx vitest run server/tests/budget-tracker.test.js server/tests/provider-pricing.test.js server/tests/budget-aware-router.test.js

- [ ] **Step 2: Run handler and routing regressions**

    npx vitest run server/tests/validation-cost-handlers.test.js server/tests/validation-handlers.test.js server/tests/provider-failover.test.js server/tests/task-finalizer.test.js

- [ ] **Step 3: Run alignment and schema guards**

    npx vitest run server/tests/schema-tables.test.js server/tests/schema-migrations.test.js server/tests/p3-async-trycatch.test.js server/tests/p3-raw-throws.test.js server/tests/rest-passthrough-coverage.test.js server/tests/mcp-tool-alignment.test.js

After making the edits, stop.
