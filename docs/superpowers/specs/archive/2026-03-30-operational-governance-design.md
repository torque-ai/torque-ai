# Operational Governance System — Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Goal:** Move enforceable operational policies from CLAUDE.md prose into the policy engine with a dashboard UI, while keeping judgment-call policies as documented guidance.

---

## Problem

TORQUE has operational policies (never cancel without inspecting, always push before remote tests, block visible-window providers, etc.) that exist only as prose in CLAUDE.md and memory feedback files. They rely on Claude's compliance — there's no runtime enforcement, no audit trail, and no user-facing controls to enable/disable them.

## Solution

Add a Governance tab to the existing OperationsHub dashboard page. Enforceable rules are stored in the database, evaluated by hooks at task lifecycle points, and logged to the evaluation store. Users can change enforcement mode (block/warn/shadow/off) and toggle rules on/off via the dashboard or MCP tools.

---

## Architecture

### Enforcement Flow

```
Claude submits task
  → pre-submission hook checks governance rules for stage: task_submit
  → rule "block-visible-providers" is enabled, mode: BLOCK
  → provider is "codex" (visible window)
  → hook returns { blocked: true, rule: "block-visible-providers", message: "..." }
  → task submission rejected with explanation
```

```
Claude cancels task
  → pre-cancellation hook checks governance rules for stage: task_cancel
  → rule "inspect-before-cancel" is enabled, mode: BLOCK
  → task status was NOT checked in this session context
  → hook returns { blocked: true, rule: "inspect-before-cancel", message: "..." }
  → cancellation rejected — Claude must call check_status first
```

### Where Rules Evaluate

| Stage | When | Example Rules |
|-------|------|---------------|
| `task_submit` | Before task is queued | block-visible-providers |
| `task_cancel` | Before task cancellation | inspect-before-cancel |
| `task_pre_execute` | Before task starts executing | require-push-before-remote, no-local-tests |
| `task_complete` | After task finishes | verify-diff-after-codex |

---

## Components

### 1. Database — `governance_rules` table

```sql
CREATE TABLE IF NOT EXISTS governance_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  stage TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'warn',
  default_mode TEXT NOT NULL DEFAULT 'warn',
  enabled INTEGER NOT NULL DEFAULT 1,
  violation_count INTEGER NOT NULL DEFAULT 0,
  checker_id TEXT NOT NULL,
  config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_governance_rules_stage ON governance_rules(stage);
CREATE INDEX IF NOT EXISTS idx_governance_rules_enabled ON governance_rules(enabled);
```

- `mode`: one of `block`, `warn`, `shadow`, `off`
- `default_mode`: the shipped default — users can reset to this
- `checker_id`: maps to a checker function in the hooks module
- `config`: optional JSON for rule-specific parameters (e.g., list of blocked providers)

### 2. DB Module — `server/db/governance-rules.js`

Export `createGovernanceRules({ db })` factory.

Functions:
- `seedBuiltinRules()` — INSERT OR IGNORE the 5 built-in rules on boot
- `getAllRules()` — returns all rules sorted by stage, name
- `getRule(id)` — single rule or null
- `getActiveRulesForStage(stage)` — enabled rules for a lifecycle stage
- `updateRuleMode(id, mode)` — change enforcement mode
- `toggleRule(id, enabled)` — enable/disable
- `incrementViolation(id)` — bump violation_count
- `resetViolationCounts()` — zero all counts (for period reset)

### 3. Built-in Rules (seeded on boot)

| ID | Name | Stage | Default Mode | Checker | Config |
|----|------|-------|-------------|---------|--------|
| `block-visible-providers` | Block visible-window providers | `task_submit` | `block` | `checkVisibleProvider` | `{ "providers": ["codex", "claude-cli"] }` |
| `inspect-before-cancel` | Inspect before cancel | `task_cancel` | `block` | `checkInspectedBeforeCancel` | — |
| `require-push-before-remote` | Require push before remote tests | `task_pre_execute` | `warn` | `checkPushedBeforeRemote` | — |
| `no-local-tests` | No local test execution | `task_pre_execute` | `warn` | `checkNoLocalTests` | `{ "commands": ["vitest", "jest", "pytest", "dotnet test"] }` |
| `verify-diff-after-codex` | Verify diff after Codex | `task_complete` | `warn` | `checkDiffAfterCodex` | — |

### 4. Governance Hooks — `server/governance/hooks.js`

Export `createGovernanceHooks({ governanceRules, evaluationStore, logger })` factory.

The hooks module registers checker functions keyed by `checker_id`:

**`checkVisibleProvider(task, rule)`**
- Reads `rule.config.providers` (default: `["codex", "claude-cli"]`)
- Checks if `task.provider` or `task.metadata.intended_provider` is in the blocked list
- Returns `{ pass: false, message: "Provider 'codex' opens a visible terminal window. Request user consent first." }` on violation

**`checkInspectedBeforeCancel(task, rule, context)`**
- Checks if `check_status` or `get_result` was called for this task_id in the current SSE session's recent tool calls
- Implementation: the MCP handler tracks recent tool calls per session; the checker queries this
- If no prior status check found: `{ pass: false, message: "Check task status before cancelling. Use check_status first." }`

**`checkPushedBeforeRemote(task, rule)`**
- Only applies when `task.metadata.remote_execution` is true or provider routes to remote
- Runs `git log origin/main..HEAD --oneline` in `task.working_directory`
- If commits exist that aren't pushed: `{ pass: false, message: "Push to origin/main before remote execution." }`

**`checkNoLocalTests(task, rule)`**
- Only applies when a remote workstation is configured (project config has `test_station_host`)
- Checks if task description contains test commands from `rule.config.commands`
- If local test detected with remote available: `{ pass: false, message: "Route tests to remote workstation." }`

**`checkDiffAfterCodex(task, rule)`**
- Only applies post-completion for codex/codex-spark provider
- Runs `git diff --stat HEAD` in `task.working_directory`
- Logs the diff to the evaluation store as an informational check
- Returns pass always (informational, not blocking) — the diff is surfaced to Claude in the task result

**Evaluation flow:**
```js
function evaluateGovernance(stage, task, context) {
  const rules = governanceRules.getActiveRulesForStage(stage);
  const results = [];

  for (const rule of rules) {
    if (rule.mode === 'off') continue;

    const checker = CHECKERS[rule.checker_id];
    if (!checker) continue;

    const result = checker(task, rule, context);

    if (!result.pass) {
      governanceRules.incrementViolation(rule.id);
      evaluationStore.record({
        rule_id: rule.id,
        stage,
        task_id: task.id,
        outcome: rule.mode,
        message: result.message,
      });
    }

    results.push({ rule_id: rule.id, mode: rule.mode, ...result });
  }

  const blocked = results.filter(r => !r.pass && r.mode === 'block');
  const warned = results.filter(r => !r.pass && r.mode === 'warn');
  const shadowed = results.filter(r => !r.pass && r.mode === 'shadow');

  return { blocked, warned, shadowed, allPassed: blocked.length === 0 };
}
```

### 5. MCP Tools

**`get_governance_rules`**
- Input: `{ stage?: string, enabled_only?: boolean }`
- Returns: array of rules with current mode, enabled state, violation count

**`set_governance_rule_mode`**
- Input: `{ rule_id: string, mode: 'block' | 'warn' | 'shadow' | 'off' }`
- Updates the rule's enforcement mode

**`toggle_governance_rule`**
- Input: `{ rule_id: string, enabled: boolean }`
- Enables/disables the rule

### 6. REST API

- `GET /api/governance/rules` — list all rules (query: `?stage=task_submit&enabled_only=true`)
- `GET /api/governance/rules/:id` — single rule with violation history
- `PATCH /api/governance/rules/:id` — update mode and/or enabled state
- `POST /api/governance/rules/:id/reset` — reset violation count

### 7. Dashboard — `Governance.jsx`

New lazy-loaded view in OperationsHub:

```js
// OperationsHub.jsx additions
const Governance = lazy(() => import('./Governance'));

const TABS = [
  { id: 'routing', label: 'Routing' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'coordination', label: 'Coordination' },
  { id: 'budget', label: 'Budget' },
  { id: 'governance', label: 'Governance' },  // new
];
```

**Governance.jsx layout** (matches approved mockup):
1. **StatCards row** — Active Rules, Blocking, Warning, Violations (24h)
2. **Enforceable Rules table** — name, description, stage, mode dropdown, violation count, enable toggle
3. **Judgment Policies section** — read-only list of non-enforceable guidance

Data fetched from `GET /api/governance/rules`. Mode changes via `PATCH`. Toggle via `PATCH`.

### 8. Container Registration

In `server/container.js` initModules():
```js
if (!_defaultContainer.has('governanceRules')) {
  const { createGovernanceRules } = require('./db/governance-rules');
  const gr = createGovernanceRules({ db });
  gr.seedBuiltinRules();
  _defaultContainer.registerValue('governanceRules', gr);
}
if (!_defaultContainer.has('governanceHooks')) {
  const { createGovernanceHooks } = require('./governance/hooks');
  const governanceRules = _defaultContainer.get('governanceRules');
  _defaultContainer.registerValue('governanceHooks', createGovernanceHooks({ governanceRules, logger }));
}
```

### 9. Hook Integration Points

**Task submission** (`server/handlers/task/pipeline.js` or `smart_submit_task` handler):
```js
const governance = defaultContainer.get('governanceHooks');
if (governance) {
  const result = governance.evaluate('task_submit', task);
  if (!result.allPassed) {
    return makeError('GOVERNANCE_BLOCKED', result.blocked[0].message);
  }
}
```

**Task cancellation** (`cancel_task` handler):
```js
const result = governance.evaluate('task_cancel', task, { sessionContext });
```

**Task pre-execution** (`task-startup.js` or `queue-scheduler.js`):
```js
const result = governance.evaluate('task_pre_execute', task);
```

**Task completion** (`completion-pipeline.js` or `task-finalizer.js`):
```js
governance.evaluate('task_complete', task);
```

### 10. CLAUDE.md Update

Replace the current enforceable policy prose with a reference:

```markdown
## Operational Governance

Enforceable operational rules are managed by the governance engine.
View and configure rules in the dashboard under Operations > Governance,
or via MCP tools: get_governance_rules, set_governance_rule_mode, toggle_governance_rule.

Built-in rules: block-visible-providers, inspect-before-cancel,
require-push-before-remote, no-local-tests, verify-diff-after-codex.

### Judgment Policies (not machine-enforced)

These policies require Claude's judgment and cannot be reduced to rules:

- **Never manually implement what TORQUE should produce** — types, data, events,
  systems, tests, and wiring are TORQUE's job. Claude should plan, submit, verify.
- **Investigate before deleting unknown files** — untracked files may be work
  products from other sessions. Never run git clean.
- **Prefer hashline tools over Read/Edit** — use hashline_read + hashline_edit
  when TORQUE is available for higher edit precision.
```

---

## Testing

- `server/tests/governance-rules.test.js` — DB CRUD, seeding, mode changes, violation counting
- `server/tests/governance-hooks.test.js` — each checker function, evaluation flow, mode enforcement
- `server/tests/governance-integration.test.js` — end-to-end: rule blocks task submission, rule warns but allows, shadow logs without blocking
- `dashboard/src/views/Governance.test.jsx` — component renders rules, mode change dispatches PATCH, toggle works

---

## File Map

| File | Action |
|------|--------|
| `server/db/governance-rules.js` | Create — DB module |
| `server/db/schema-tables.js` | Modify — add governance_rules table |
| `server/db/schema-migrations.js` | Modify — add migration |
| `server/governance/hooks.js` | Create — checker functions + evaluation |
| `server/handlers/governance-handlers.js` | Create — MCP tool handlers |
| `server/tool-defs/governance-defs.js` | Create — MCP tool schemas |
| `server/tools.js` | Modify — wire governance tools |
| `server/tool-annotations.js` | Modify — add annotations |
| `server/container.js` | Modify — register governance services |
| `server/handlers/task/pipeline.js` | Modify — add governance hook at submission |
| `server/execution/task-startup.js` | Modify — add governance hook at pre-execute |
| `server/execution/completion-pipeline.js` | Modify — add governance hook at completion |
| `dashboard/src/views/Governance.jsx` | Create — dashboard view |
| `dashboard/src/views/OperationsHub.jsx` | Modify — add governance tab |
| `dashboard/src/api.js` | Modify — add governance API calls |
| `server/dashboard/router.js` | Modify — add governance REST routes |
| `server/tests/governance-rules.test.js` | Create — DB tests |
| `server/tests/governance-hooks.test.js` | Create — hook tests |
| `server/tests/governance-integration.test.js` | Create — integration tests |
| `CLAUDE.md` | Modify — reference governance engine |

---

## What This Does NOT Include

- Custom user-defined rules (future — the schema supports it, but no UI for creation yet)
- Per-project rule overrides (all rules are global for now)
- Rule templating or sharing between TORQUE instances
- Judgment policy enforcement (these remain prose by design)
