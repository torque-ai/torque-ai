# Operational Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move enforceable operational policies into the policy engine with dashboard controls, REST API, and MCP tools.

**Architecture:** A `governance_rules` table stores rule definitions with per-rule enforcement modes. A hooks module maps `checker_id` to checker functions that evaluate at task lifecycle points. The OperationsHub dashboard gains a Governance tab for viewing/toggling rules. Judgment policies stay in CLAUDE.md as prose.

**Tech Stack:** Node.js, better-sqlite3, React (JSX), Vitest, existing TORQUE DI container + policy evaluation store

**Spec:** `docs/superpowers/specs/2026-03-30-operational-governance-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/db/governance-rules.js` | Create | DB module with CRUD, seed, query |
| `server/governance/hooks.js` | Create | Checker functions and evaluation loop |
| `server/handlers/governance-handlers.js` | Create | MCP tool and REST handlers |
| `server/tool-defs/governance-defs.js` | Create | MCP tool schemas |
| `server/db/schema-tables.js` | Modify | Add governance_rules to VALID_TABLE_NAMES and createTables |
| `server/db/schema-migrations.js` | Modify | Add governance_rules migration |
| `server/tools.js` | Modify | Wire governance tool defs and handlers |
| `server/tool-annotations.js` | Modify | Add annotations for 3 tools |
| `server/container.js` | Modify | Register governanceRules and governanceHooks |
| `server/handlers/task/pipeline.js` | Modify | Add governance hook at task_submit |
| `server/execution/completion-pipeline.js` | Modify | Add governance hook at task_complete |
| `dashboard/src/views/Governance.jsx` | Create | Dashboard Governance tab view |
| `dashboard/src/views/OperationsHub.jsx` | Modify | Add Governance tab |
| `dashboard/src/api.js` | Modify | Add governance API calls |
| `server/dashboard/router.js` | Modify | Add governance REST routes |
| `server/tests/governance-rules.test.js` | Create | DB module tests |
| `server/tests/governance-hooks.test.js` | Create | Hook and checker tests |
| `server/tests/governance-integration.test.js` | Create | End-to-end tests |

---

### Task 1: Schema and DB Module

**Files:**
- Create: `server/db/governance-rules.js`
- Create: `server/tests/governance-rules.test.js`
- Modify: `server/db/schema-tables.js`
- Modify: `server/db/schema-migrations.js`

- [ ] **Step 1: Write failing test for governance rules DB module**

Create `server/tests/governance-rules.test.js` with in-memory SQLite (use globals, NOT require('vitest')). Create the governance_rules table in beforeEach. Test:
1. seedBuiltinRules inserts 5 rules
2. seedBuiltinRules is idempotent
3. getRule returns a single rule or null
4. getActiveRulesForStage returns enabled rules for a stage
5. updateRuleMode changes mode
6. updateRuleMode rejects invalid mode
7. toggleRule disables and enables
8. incrementViolation bumps count
9. resetViolationCounts zeros all counts
10. getAllRules returns rules sorted by stage then name

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/governance-rules.test.js`
Expected: FAIL with Cannot find module

- [ ] **Step 3: Implement `server/db/governance-rules.js`**

Export `createGovernanceRules({ db })` factory. VALID_MODES = ['block', 'warn', 'shadow', 'off']. BUILTIN_RULES array with 5 rules: block-visible-providers (task_submit, block), inspect-before-cancel (task_cancel, block), require-push-before-remote (task_pre_execute, warn), no-local-tests (task_pre_execute, warn), verify-diff-after-codex (task_complete, warn). seedBuiltinRules uses INSERT OR IGNORE. All functions close over db. Export BUILTIN_RULES and VALID_MODES alongside the factory.

- [ ] **Step 4: Add governance_rules to schema-tables.js**

Add 'governance_rules' to VALID_TABLE_NAMES. Add CREATE TABLE and indexes in createTables().

- [ ] **Step 5: Add migration to schema-migrations.js**

Add the CREATE TABLE and indexes in runMigrations() before migrateModelAgnostic(db).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && npx vitest run tests/governance-rules.test.js`
Expected: All 10 tests PASS

- [ ] **Step 7: Commit**

---

### Task 2: Governance Hooks and Checkers

**Files:**
- Create: `server/governance/hooks.js`
- Create: `server/tests/governance-hooks.test.js`

- [ ] **Step 1: Write failing test for governance hooks**

Create `server/tests/governance-hooks.test.js` with in-memory SQLite (use globals). Seed rules in beforeEach. Test:
1. checkVisibleProvider blocks codex provider
2. checkVisibleProvider blocks claude-cli provider
3. checkVisibleProvider passes for ollama
4. checkVisibleProvider blocks when intended_provider in metadata is codex
5. warn mode allows but adds warning
6. shadow mode allows and logs silently
7. off mode skips evaluation entirely
8. violation count increments on failure
9. violation count does not increment on pass
10. no rules for stage returns allPassed
11. disabled rules are skipped

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/governance-hooks.test.js`
Expected: FAIL with Cannot find module

- [ ] **Step 3: Implement `server/governance/hooks.js`**

Export `createGovernanceHooks({ governanceRules, logger })` factory. CHECKERS object maps checker_id to functions. Each checker takes (task, rule, context) and returns { pass: boolean, message?: string }. Checkers: checkVisibleProvider (checks provider against config.providers list), checkInspectedBeforeCancel (checks context.recentToolCalls for check_status), checkPushedBeforeRemote (uses execFileSync git log), checkNoLocalTests (checks task description for test commands), checkDiffAfterCodex (runs git diff, always passes, informational). evaluate(stage, task, context) gets active rules, runs checkers, increments violations, returns { blocked, warned, shadowed, allPassed }.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/governance-hooks.test.js`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

---

### Task 3: MCP Tools and REST Endpoints

**Files:**
- Create: `server/tool-defs/governance-defs.js`
- Create: `server/handlers/governance-handlers.js`
- Modify: `server/tools.js`
- Modify: `server/tool-annotations.js`
- Modify: `server/dashboard/router.js`

- [ ] **Step 1: Create tool definitions**

3 tools: get_governance_rules (stage?, enabled_only?), set_governance_rule_mode (rule_id, mode), toggle_governance_rule (rule_id, enabled).

- [ ] **Step 2: Create handlers**

Each handler lazy-loads governanceRules from container with try/catch. handleGetGovernanceRules supports stage filter and enabled_only. handleSetGovernanceRuleMode validates rule exists then updates. handleToggleGovernanceRule validates rule exists then toggles.

- [ ] **Step 3: Wire into tools.js**

Add defs to TOOLS array, handlers to HANDLER_MODULES, explicit routeMap entries.

- [ ] **Step 4: Add tool annotations**

get_governance_rules: readOnlyHint true. set_governance_rule_mode: readOnlyHint false. toggle_governance_rule: readOnlyHint false.

- [ ] **Step 5: Add REST routes**

GET /api/governance/rules, PATCH /api/governance/rules/:id, POST /api/governance/rules/:id/reset.

- [ ] **Step 6: Commit**

---

### Task 4: Container Registration and Lifecycle Hooks

**Files:**
- Modify: `server/container.js`
- Modify: `server/handlers/task/pipeline.js`
- Modify: `server/execution/completion-pipeline.js`
- Create: `server/tests/governance-integration.test.js`

- [ ] **Step 1: Register in container.js**

Register governanceRules (with seedBuiltinRules call) and governanceHooks in initModules().

- [ ] **Step 2: Add governance hook at task submission**

In pipeline.js, evaluate task_submit stage. If blocked, return error. Wrap in try/catch.

- [ ] **Step 3: Add governance hook at task completion**

In completion-pipeline.js, evaluate task_complete stage. Non-blocking (informational only for now).

- [ ] **Step 4: Write integration test**

Test: block mode rejects, warn mode allows with warning, shadow mode logs without blocking, disabled rule skipped, task_complete stage runs checker.

- [ ] **Step 5: Run integration test**

Run: `cd server && npx vitest run tests/governance-integration.test.js`
Expected: All 5 tests PASS

- [ ] **Step 6: Commit**

---

### Task 5: Dashboard Governance Tab

**Files:**
- Create: `dashboard/src/views/Governance.jsx`
- Modify: `dashboard/src/views/OperationsHub.jsx`
- Modify: `dashboard/src/api.js`

- [ ] **Step 1: Add governance API calls to api.js**

governance.getRules(params), governance.updateRule(id, body), governance.resetViolations(id).

- [ ] **Step 2: Create Governance.jsx**

React component matching approved mockup. StatCards row (Active Rules, Blocking, Warning, Violations). Rules table with mode dropdown, violation count, enable toggle. Judgment Policies section. Uses existing components (StatCard, LoadingSkeleton, Toast). Follows Tailwind patterns from Approvals.jsx.

- [ ] **Step 3: Add Governance tab to OperationsHub.jsx**

Lazy import, add to TABS array, add render case.

- [ ] **Step 4: Commit**

---

### Task 6: CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace enforceable policy prose with governance engine reference**

Replace the operational rule prose with a reference to the governance system. Keep judgment policies as prose.

- [ ] **Step 2: Commit**

---

## Dependency Graph

```
Task 1 (DB + schema) ────┐
                          ├── Task 3 (MCP + REST) ── Task 4 (container + hooks wiring)
Task 2 (hooks + checkers) ┘                                    |
                                                               ├── Task 5 (dashboard)
                                                               └── Task 6 (CLAUDE.md)
```

- Tasks 1 and 2 are independent and can run in parallel
- Task 3 depends on both 1 and 2
- Task 4 depends on 3
- Tasks 5 and 6 can run in parallel after Task 4
