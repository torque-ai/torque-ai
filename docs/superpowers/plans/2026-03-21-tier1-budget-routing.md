# Budget-Aware Routing Downgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Automatically switch routing templates based on budget consumption thresholds so spending is controlled without manual intervention.

**Architecture:** A BudgetWatcher checks spending against configured budgets after each task completion. When spending crosses configurable thresholds (e.g., 80% = warning, 90% = downgrade), it auto-activates a cheaper routing template and emits a notification. Resets at period boundaries.

**Tech Stack:** Existing cost_budgets table, existing cost_tracking table, existing routing template system

**Inspired by:** CreedFlow's CostOptimizerService (auto-switch to cheapest at 90%)

---

### Task 1: BudgetWatcher module

**Files:**
- Create: `server/db/budget-watcher.js`
- Test: `server/tests/budget-watcher.test.js`

Functions:
- `checkBudgetThresholds(provider)` -- reads cost_budgets + cost_tracking, returns { budgetName, spendPercent, thresholdBreached, action }
- `getActiveBudgets()` -- returns all enabled budgets with current spend percentages
- `configureBudgetAction(budgetId, { warningPercent, downgradePercent, downgradeTemplate, hardStopPercent })` -- sets threshold actions

Default actions:
- 80% -- emit warning notification
- 90% -- auto-activate "Cost Saver" routing template
- 100% -- block new task submissions for that provider (with override flag)

- [ ] Step 1: Write failing tests for threshold detection
- [ ] Step 2: Implement BudgetWatcher
- [ ] Step 3: Run tests
- [ ] Step 4: Commit

---

### Task 2: Wire into task completion pipeline

**Files:**
- Modify: `server/handlers/task/pipeline.js` -- call checkBudgetThresholds after cost recording
- Modify: `server/db/provider-routing-core.js` -- activate_routing_template when downgrade triggered

- [ ] Step 1: After cost is recorded in task finalization, call checkBudgetThresholds
- [ ] Step 2: If downgrade threshold breached, call activate_routing_template with the configured downgrade template
- [ ] Step 3: Emit notification with details (budget name, spend percent, action taken)
- [ ] Step 4: Write integration test
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 3: MCP tool for budget status

**Files:**
- Modify: MCP tool definitions -- enhance existing budget tools or add `get_budget_status`
- Modify: `server/tool-annotations.js`

- [ ] Step 1: Add/enhance MCP tool that returns budget status with threshold proximity
- [ ] Step 2: Include "auto-downgrade active" flag in response when template was auto-switched
- [ ] Step 3: Run tests
- [ ] Step 4: Commit
