# Deprecate aider-ollama Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the aider-ollama provider entirely from TORQUE — it has an 11% success rate, is demoted in all fallback chains, and its capabilities are fully covered by hashline-ollama (single-file edits) and ollama-agentic (multi-file, file creation).

**Architecture:** Surgical removal of aider-ollama from provider registries, routing tables, fallback chains, execution paths, config keys, dashboard frontend, and documentation. The aider CLI dependency (`aider-command.js`, `aider-model-metadata.json`) is deleted. Dead code (`parseAiderOutput`, `sanitizeAiderOutput`) is removed. All references in ~134 JS/JSX files, ~27 MD files, and 1 JSON schema are updated. Existing tasks that were routed to aider-ollama will fall through to hashline-ollama or ollama in fallback chains during migration.

**Tech Stack:** Node.js, SQLite (schema migrations), Vitest (tests)

**Verify command:** `npx vitest run` (via torque-remote on Omen — NEVER run locally)

---

## File Map

### Files to DELETE (5)
| File | Reason |
|------|--------|
| `server/providers/aider-command.js` | Aider CLI command builder — entire module is aider-specific |
| `server/aider-model-metadata.json` | Aider model metadata config |
| `server/tests/aider-command.test.js` | Tests for deleted module |
| `.aider.chat.history.md` | Aider CLI chat log artifact (untracked, .gitignored) |
| `.aider.input.history` | Aider CLI input history artifact (untracked, .gitignored) |

### Files to MODIFY — Core Provider Infrastructure (~20)
| File | Change |
|------|--------|
| `server/constants.js` | Remove `'aider-ollama': 30` from STALL_THRESHOLDS |
| `server/providers/registry.js` | Remove `'aider-ollama'` from `PROVIDER_CATEGORIES.ollama` |
| `server/providers/adapter-registry.js` | Remove aider-ollama adapter registration |
| `server/providers/execute-cli.js` | Remove `buildAiderOllamaCommand()`, aider-command import, aider init deps. Keep codex + claude-cli paths |
| `server/providers/v2-local-providers.js` | Remove aider-ollama from local provider list |
| `server/providers/prompts.js` | Remove aider-ollama prompt template/instructions |
| `server/providers/agentic-capability.js` | Remove any aider-ollama references |
| `server/execution/provider-router.js` | Remove aider-ollama routing case, auto-switch logic (lines 203-211) |
| `server/execution/queue-scheduler.js` | Remove aider-ollama from scheduler logic |
| `server/execution/slot-pull-scheduler.js` | Remove aider-ollama from slot-pull logic |
| `server/execution/fallback-retry.js` | Remove aider-ollama from fallback logic |
| `server/execution/process-lifecycle.js` | Remove `'aider-ollama'` from ollama health invalidation check |
| `server/db/provider-routing-core.js` | Remove from `LOCAL_PROVIDERS`, fallback chains, smart routing upgrade logic |
| `server/db/provider-capabilities.js` | Remove aider-ollama capability entries |
| `server/db/config-keys.js` | Remove 6 aider config keys (`aider_auto_commits`, `aider_auto_switch_format`, `aider_edit_format`, `aider_map_tokens`, `aider_model_edit_formats`, `aider_subtree_only`) |
| `server/db/schema-seeds.js` | Remove aider-ollama seed data |
| `server/db/schema-migrations.js` | Add migration to remove aider config keys and mark existing aider-ollama tasks |
| `server/mcp/schemas/task.submit.json` | Remove `aider-ollama` from provider enum |

### Files to MODIFY — Handlers & Tool Defs (~12)
| File | Change |
|------|--------|
| `server/handlers/automation-handlers.js` | Remove aider-ollama references |
| `server/handlers/provider-tuning.js` | Remove aider tuning options |
| `server/handlers/provider-ollama-hosts.js` | Remove aider references |
| `server/handlers/advanced/coordination.js` | Remove aider-ollama references |
| `server/handlers/integration/infra.js` | Remove aider-ollama references |
| `server/handlers/integration/routing.js` | Remove aider-ollama references |
| `server/tool-defs/provider-defs.js` | Remove aider-ollama from provider descriptions/enums |
| `server/tool-defs/task-submission-defs.js` | Remove aider-ollama from provider enum |
| `server/tool-defs/automation-defs.js` | Remove aider references |
| `server/tool-defs/advanced-defs.js` | Remove aider references |
| `server/tool-defs/validation-defs.js` | Remove aider references |
| `server/tool-defs/workflow-defs.js` | Remove aider references |
| `server/tool-defs/integration-defs.js` | Remove aider references |

### Files to MODIFY — Validation & Utils (~8)
| File | Change |
|------|--------|
| `server/validation/auto-verify-retry.js` | Remove aider-ollama case |
| `server/validation/close-phases.js` | Remove aider-ollama case |
| `server/validation/output-safeguards.js` | Remove aider-ollama case |
| `server/validation/completion-detection.js` | Remove aider-ollama case |
| `server/utils/agent-discovery.js` | Remove aider references |
| `server/utils/host-monitoring.js` | Remove aider references |
| `server/utils/safe-env.js` | Remove aider env var handling |
| `server/task-manager.js` | Remove aider-ollama references |
| `server/task-manager-delegations.js` | Remove aider-ollama delegations |
| `server/dashboard/dashboard.js` | Remove aider-ollama from dashboard provider lists |
| `server/maintenance/orphan-cleanup.js` | Remove aider process cleanup |
| `server/workstation/routing.js` | Remove aider-ollama routing |
| `server/api/v2-provider-registry.js` | Remove aider-ollama registration |

### Files to MODIFY — Tests (~55)
All test files referencing aider-ollama need aider cases removed or rewritten. Key ones:
| File | Change |
|------|--------|
| `server/tests/test-helpers.js` | Remove aider-ollama from test fixtures |
| `server/tests/test-providers.js` | Remove aider-ollama from provider test list |
| `server/tests/execute-cli.test.js` | Remove aider-ollama build/spawn tests |
| `server/tests/e2e-cli-providers.test.js` | Remove aider e2e tests |
| `server/tests/provider-routing-core.test.js` | Remove aider from routing tests |
| `server/tests/provider-registry.test.js` | Remove aider from registry tests |
| `server/tests/smart-routing-integration.test.js` | Remove aider routing assertions |
| `server/tests/fallback-retry.test.js` | Remove aider fallback tests |
| `server/tests/queue-scheduler.test.js` | Remove aider scheduling tests |
| `server/tests/slot-pull-scheduler.test.js` | Remove aider slot-pull tests |
| Remaining ~45 test files | Remove `'aider-ollama'` from provider arrays, fixture data, assertions |

### Files to MODIFY — Dashboard Frontend (~10)
| File | Change |
|------|--------|
| `dashboard/src/constants.js` | Remove aider-ollama from provider color maps (CSS class + hex) |
| `dashboard/src/views/Providers.jsx` | Remove aider-ollama from provider views |
| `dashboard/src/views/Kanban.jsx` | Remove aider-ollama from kanban provider list |
| `dashboard/src/views/History.jsx` | Remove aider-ollama from history filters |
| `dashboard/src/views/Strategy.jsx` | Remove aider-ollama from strategy views |
| `dashboard/src/views/Schedules.jsx` | Remove aider-ollama from schedule views |
| `dashboard/src/views/RoutingTemplates.jsx` | Remove aider-ollama from template editor |
| `dashboard/src/components/TaskDetailDrawer.jsx` | Remove aider-ollama from task detail display |
| `dashboard/src/components/TaskSubmitForm.jsx` | Remove aider-ollama from provider dropdown |
| `dashboard/src/utils/providerModels.js` | Remove aider-ollama model mappings |

### Dead Code to REMOVE (embedded in other files)
| Function | Files | Notes |
|----------|-------|-------|
| `parseAiderOutput()` | `server/execution/file-context-builder.js`, callers in validation/, task-manager | Dead after provider removal |
| `sanitizeAiderOutput()` | `server/execution/task-utils.js`, callers in validation/, task-manager | Dead after provider removal |
| `isAiderCommit` rollback logic | `server/validation/post-task.js` (lines ~1557-1593) | Will never trigger |

### Files to MODIFY — Documentation (~8)
| File | Change |
|------|--------|
| `CLAUDE.md` | Remove aider-ollama from provider tables and references |
| `docs/architecture.md` | Remove aider-ollama architecture references |
| `server/docs/architecture.md` | Remove aider-ollama architecture references |
| `server/docs/guides/providers.md` | Remove aider-ollama provider guide |
| `server/docs/guides/setup.md` | Remove aider setup instructions |
| `server/docs/api/rest-api.md` | Remove aider-ollama from API docs |
| `server/docs/runbooks/troubleshooting.md` | Remove aider troubleshooting |

### Files to LEAVE ALONE (historical — don't modify)
Spec and plan docs in `docs/superpowers/specs/` and `docs/superpowers/plans/` that mention aider-ollama as historical context. These are archived records of past decisions and should not be modified.

---

## Task Breakdown

### Task 1: Schema Migration — Remove Aider Config Keys

**Files:**
- Modify: `server/db/schema-migrations.js`
- Modify: `server/db/config-keys.js`
- Modify: `server/db/schema-seeds.js`
- Test: `server/tests/schema-migrations.test.js`
- Test: `server/tests/schema-seeds.test.js`

- [ ] **Step 1: Write failing test for new migration**

```js
test('migration removes aider config keys', () => {
  // Insert aider config keys, run migration, verify they're gone
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/schema-migrations.test.js -t "aider"`
Expected: FAIL

- [ ] **Step 3: Add migration to schema-migrations.js**

Add a new migration that:
- Deletes config keys: `aider_auto_commits`, `aider_auto_switch_format`, `aider_edit_format`, `aider_map_tokens`, `aider_model_edit_formats`, `aider_subtree_only`
- **Renames** `stall_threshold_aider` → `stall_threshold_hashline` (CRITICAL: hashline-ollama currently shares this key via orphan-cleanup.js — deleting it would break hashline stall detection)
- Updates `complexity_routing` table: `UPDATE complexity_routing SET target_provider = 'hashline-ollama' WHERE target_provider = 'aider-ollama'`
- Does NOT delete historical task records — they're audit trail
- Does NOT modify existing historical migrations that reference aider (they must be preserved for migration replay)

- [ ] **Step 4: Remove aider keys from config-keys.js and schema-seeds.js**

Remove the 6 `aider_*` keys from the `KNOWN_CONFIG_KEYS` array in `config-keys.js`. Add `stall_threshold_hashline` as the renamed key.
In `schema-seeds.js`:
- Change `smart_routing_default_provider` seed from `'aider-ollama'` to `'hashline-ollama'`
- Update routing rules that target `aider-ollama` (simple-refactor, config-edit, boilerplate, lang-python, lang-javascript, lang-powershell, lang-gdscript) to target `'hashline-ollama'`
- Update failure patterns, rate limits, and output limits that reference `aider-ollama`
- Update `stall_threshold_aider` references to `stall_threshold_hashline`

- [ ] **Step 5: Run tests to verify they pass**

Run: `torque-remote npx vitest run server/tests/schema-migrations.test.js server/tests/schema-seeds.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/db/schema-migrations.js server/db/config-keys.js server/db/schema-seeds.js server/tests/schema-migrations.test.js server/tests/schema-seeds.test.js
git commit -m "feat: add migration to remove aider-ollama config keys"
```

---

### Task 2: Delete Aider-Specific Modules

**Files:**
- Delete: `server/providers/aider-command.js`
- Delete: `server/aider-model-metadata.json`
- Delete: `server/tests/aider-command.test.js`

- [ ] **Step 1: Verify no other module imports aider-command besides execute-cli.js**

Run: `grep -r "aider-command" server/ --include="*.js" -l` — should only show `execute-cli.js`, `aider-command.js`, and `aider-command.test.js`

- [ ] **Step 2: Delete the files**

```bash
git rm server/providers/aider-command.js
git rm server/aider-model-metadata.json
git rm server/tests/aider-command.test.js
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete aider-command module and metadata"
```

---

### Task 3: Remove Aider from Provider Registries & Constants

**Files:**
- Modify: `server/constants.js` (remove from STALL_THRESHOLDS)
- Modify: `server/providers/registry.js` (remove from PROVIDER_CATEGORIES)
- Modify: `server/providers/adapter-registry.js` (remove adapter)
- Modify: `server/providers/v2-local-providers.js` (remove from local list)
- Modify: `server/api/v2-provider-registry.js` (remove registration)
- Modify: `server/mcp/schemas/task.submit.json` (remove from enum)
- Test: `server/tests/constants.test.js`
- Test: `server/tests/provider-registry.test.js`
- Test: `server/tests/provider-adapter-registry.test.js`
- Test: `server/tests/adapter-registry.test.js`
- Test: `server/tests/v2-local-providers.test.js`
- Test: `server/tests/v2-provider-registry.test.js`

- [ ] **Step 1: Remove `'aider-ollama'` from all registry arrays and maps**

In each file, remove `'aider-ollama'` from provider lists, category arrays, adapter registrations, and enum values.

- [ ] **Step 2: Update tests — remove aider-ollama from test fixtures and assertions**

Remove `'aider-ollama'` from provider arrays in test data, remove test cases that specifically test aider-ollama registration.

- [ ] **Step 3: Run tests**

Run: `torque-remote npx vitest run server/tests/constants.test.js server/tests/provider-registry.test.js server/tests/provider-adapter-registry.test.js server/tests/adapter-registry.test.js server/tests/v2-local-providers.test.js server/tests/v2-provider-registry.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/constants.js server/providers/registry.js server/providers/adapter-registry.js server/providers/v2-local-providers.js server/api/v2-provider-registry.js server/mcp/schemas/task.submit.json server/tests/constants.test.js server/tests/provider-registry.test.js server/tests/provider-adapter-registry.test.js server/tests/adapter-registry.test.js server/tests/v2-local-providers.test.js server/tests/v2-provider-registry.test.js
git commit -m "feat: remove aider-ollama from provider registries and constants"
```

---

### Task 4: Remove Aider from Routing & Fallback Chains

**Files:**
- Modify: `server/db/provider-routing-core.js` (remove from LOCAL_PROVIDERS, fallback chains, smart routing upgrade)
- Modify: `server/execution/provider-router.js` (remove aider routing case, auto-switch logic)
- Modify: `server/execution/fallback-retry.js` (remove aider fallback)
- Modify: `server/execution/queue-scheduler.js` (remove aider scheduling)
- Modify: `server/execution/slot-pull-scheduler.js` (remove aider slot-pull)
- Modify: `server/workstation/routing.js` (remove aider routing)
- Test: `server/tests/provider-routing-core.test.js`
- Test: `server/tests/db-provider-routing-core.test.js`
- Test: `server/tests/smart-routing-integration.test.js`
- Test: `server/tests/smart-routing-codex-gate.test.js`
- Test: `server/tests/fallback-retry.test.js`
- Test: `server/tests/queue-scheduler.test.js`
- Test: `server/tests/slot-pull-scheduler.test.js`
- Test: `server/tests/slot-pull-routing.test.js`
- Test: `server/tests/local-first-fallback.test.js`
- Test: `server/tests/integration-routing.test.js`
- Test: `server/tests/integration-routing-handlers.test.js`
- Test: `server/tests/prefer-free-routing.test.js`
- Test: `server/tests/provider-routing-config.test.js`

- [ ] **Step 1: Remove aider-ollama from provider-routing-core.js**

- Remove from `LOCAL_PROVIDERS` array
- Remove `'aider-ollama'` fallback chain entry
- Remove `'aider-ollama'` from other providers' fallback chains (it appears as a target in some chains)
- Remove the hashline upgrade logic that upgrades `aider-ollama → hashline-ollama` (no longer needed since aider-ollama won't exist)
- Update the comment that says "aider-ollama is legacy (11% success)"

- [ ] **Step 2: Remove aider routing from provider-router.js**

- Remove the `if (provider === 'aider-ollama' && !isUserOverride)` review-task auto-switch block (lines 203-211)
- Remove any aider-ollama case in the main routing switch

- [ ] **Step 3: Remove aider from fallback-retry.js, queue-scheduler.js, slot-pull-scheduler.js, workstation/routing.js**

Remove `'aider-ollama'` from all provider checks, fallback logic, and scheduling paths.

- [ ] **Step 4: Update all routing tests**

Remove aider-ollama test cases, update provider lists in fixtures, remove assertions about aider fallback behavior.

- [ ] **Step 5: Run tests**

Run: `torque-remote npx vitest run server/tests/provider-routing-core.test.js server/tests/db-provider-routing-core.test.js server/tests/smart-routing-integration.test.js server/tests/fallback-retry.test.js server/tests/queue-scheduler.test.js server/tests/slot-pull-scheduler.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/db/provider-routing-core.js server/execution/provider-router.js server/execution/fallback-retry.js server/execution/queue-scheduler.js server/execution/slot-pull-scheduler.js server/workstation/routing.js server/tests/*.test.js
git commit -m "feat: remove aider-ollama from routing tables and fallback chains"
```

---

### Task 5: Remove Aider from Execution Path

**Files:**
- Modify: `server/providers/execute-cli.js` (remove buildAiderOllamaCommand, aider-command import, init deps)
- Modify: `server/execution/process-lifecycle.js` (remove aider-ollama from health invalidation check)
- Modify: `server/providers/prompts.js` (remove aider-ollama prompt template)
- Modify: `server/providers/agentic-capability.js` (remove aider references)
- Modify: `server/providers/execute-hashline.js` (remove aider fallback references)
- Test: `server/tests/execute-cli.test.js`
- Test: `server/tests/e2e-cli-providers.test.js`
- Test: `server/tests/provider-base-execution.test.js`
- Test: `server/tests/agentic-capability.test.js`
- Test: `server/tests/prompts.test.js`
- Test: `server/tests/prompts-tier-templates.test.js`
- Test: `server/tests/prompts-tier-integration.test.js`

- [ ] **Step 1: Remove aider from execute-cli.js**

- Remove `const aiderCommand = require('./aider-command');`
- Remove `aiderCommand.init({...})` from init()
- Remove `buildAiderOllamaCommand()` function entirely
- Update module docstring to say "CLI builders for claude-cli and codex"
- Remove `'aider-ollama'` from the health invalidation check in process-lifecycle.js

- [ ] **Step 2: Remove aider-ollama prompt template from prompts.js**

Remove the aider-ollama instruction wrapping and any aider-specific prompt logic.

- [ ] **Step 3: Remove aider references from agentic-capability.js and execute-hashline.js**

- [ ] **Step 4: Update tests**

Remove all aider-ollama test cases from execute-cli, e2e-cli-providers, prompts tests.

- [ ] **Step 5: Run tests**

Run: `torque-remote npx vitest run server/tests/execute-cli.test.js server/tests/e2e-cli-providers.test.js server/tests/prompts.test.js server/tests/agentic-capability.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/providers/execute-cli.js server/execution/process-lifecycle.js server/providers/prompts.js server/providers/agentic-capability.js server/providers/execute-hashline.js server/tests/*.test.js
git commit -m "feat: remove aider-ollama execution path from CLI provider"
```

---

### Task 6: Remove Aider from Handlers & Tool Definitions

**Files:**
- Modify: `server/handlers/automation-handlers.js`
- Modify: `server/handlers/provider-tuning.js`
- Modify: `server/handlers/provider-ollama-hosts.js`
- Modify: `server/handlers/advanced/coordination.js`
- Modify: `server/handlers/integration/infra.js`
- Modify: `server/handlers/integration/routing.js`
- Modify: `server/tool-defs/provider-defs.js`
- Modify: `server/tool-defs/task-submission-defs.js`
- Modify: `server/tool-defs/automation-defs.js`
- Modify: `server/tool-defs/advanced-defs.js`
- Modify: `server/tool-defs/validation-defs.js`
- Modify: `server/tool-defs/workflow-defs.js`
- Modify: `server/tool-defs/integration-defs.js`
- Test: `server/tests/automation-handlers.test.js`
- Test: `server/tests/automation-handlers-main.test.js`
- Test: `server/tests/automation-handlers-config.test.js`
- Test: `server/tests/provider-handlers-tuning.test.js`
- Test: `server/tests/provider-handlers-core.test.js`
- Test: `server/tests/integration-routing-handlers.test.js`

- [ ] **Step 1: Remove aider-ollama from all handler files**

Search-and-remove `'aider-ollama'` from provider lists, switch cases, and descriptions in each handler.

- [ ] **Step 2: Remove aider from all tool-defs files**

Remove `'aider-ollama'` from provider enums in tool definitions. Update descriptions that mention aider.

- [ ] **Step 3: Update handler and tool-def tests**

- [ ] **Step 4: Run tests**

Run: `torque-remote npx vitest run server/tests/automation-handlers.test.js server/tests/provider-handlers-tuning.test.js server/tests/provider-handlers-core.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/handlers/ server/tool-defs/ server/tests/*.test.js
git commit -m "feat: remove aider-ollama from handlers and tool definitions"
```

---

### Task 7: Remove Aider from Validation, Utils & Remaining Modules

**Files:**
- Modify: `server/validation/auto-verify-retry.js`
- Modify: `server/validation/close-phases.js`
- Modify: `server/validation/output-safeguards.js`
- Modify: `server/validation/completion-detection.js`
- Modify: `server/utils/agent-discovery.js`
- Modify: `server/utils/host-monitoring.js`
- Modify: `server/utils/safe-env.js`
- Modify: `server/task-manager.js`
- Modify: `server/task-manager-delegations.js`
- Modify: `server/dashboard/dashboard.js`
- Modify: `server/maintenance/orphan-cleanup.js`
- Modify: `server/db/provider-capabilities.js`
- Modify: `server/db/task-core.js`
- Modify: `server/db/host-management.js`
- Modify: `server/db/cost-tracking.js`
- Modify: `server/db/file-quality.js`
- Modify: `server/execution/file-context-builder.js`
- Modify: `server/execution/task-utils.js`
- Modify: `server/validation/post-task.js`
- Modify: `server/validation/safeguard-gates.js`
- Modify: `server/validation/hashline-verify.js`
- Tests: All remaining ~35 test files with aider references

- [ ] **Step 1: Bulk find-and-remove across validation/ and utils/**

For each file: remove `'aider-ollama'` from provider checks, arrays, switch cases, and comments.

- [ ] **Step 2: Remove aider from task-manager.js, task-manager-delegations.js, dashboard.js**

- [ ] **Step 3: Remove aider from db/ modules (provider-capabilities, task-core, host-management, cost-tracking, file-quality)**

- [ ] **Step 4: Remove aider from remaining execution/ and validation/ files**

- [ ] **Step 5: Update all remaining tests**

Bulk remove `'aider-ollama'` from test fixtures, provider arrays, and assertions across ~35 test files.

- [ ] **Step 6: Run full test suite**

Run: `torque-remote npx vitest run`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add server/
git commit -m "feat: remove all remaining aider-ollama references from server"
```

---

### Task 8: Remove Aider Dead Code (parseAiderOutput, sanitizeAiderOutput, isAiderCommit)

**Files:**
- Modify: `server/execution/file-context-builder.js` (remove `parseAiderOutput()`)
- Modify: `server/execution/task-utils.js` (remove `sanitizeAiderOutput()`)
- Modify: `server/validation/post-task.js` (remove `isAiderCommit` rollback logic)
- Modify: `server/validation/hashline-verify.js` (update JSDoc that says "repair for failed aider edits")
- Modify: All callers of these functions in `validation/close-phases.js`, `validation/output-safeguards.js`, `task-manager.js`
- Test: `server/tests/post-task.test.js`, `server/tests/close-phases.test.js`

- [ ] **Step 1: Identify all callers of parseAiderOutput and sanitizeAiderOutput**

Grep for `parseAiderOutput` and `sanitizeAiderOutput` across server/ to find every call site.

- [ ] **Step 2: Remove the functions and their call sites**

Delete the function definitions and all code paths that call them. At call sites, remove the conditional branch that invokes them (they'll be guarded by `provider === 'aider-ollama'` checks which are already being removed).

- [ ] **Step 3: Remove isAiderCommit rollback logic from post-task.js**

Remove the aider commit detection and rollback code (~lines 1557-1593).

- [ ] **Step 4: Update hashline-verify.js JSDoc**

Change "repair for failed aider edits" to reflect its actual current purpose.

- [ ] **Step 5: Run tests**

Run: `torque-remote npx vitest run server/tests/post-task.test.js server/tests/close-phases.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/execution/file-context-builder.js server/execution/task-utils.js server/validation/post-task.js server/validation/hashline-verify.js server/validation/close-phases.js server/validation/output-safeguards.js server/task-manager.js server/tests/
git commit -m "chore: remove aider dead code (parseAiderOutput, sanitizeAiderOutput, isAiderCommit)"
```

---

### Task 9: Dashboard Frontend Cleanup

**Files:**
- Modify: `dashboard/src/constants.js`
- Modify: `dashboard/src/views/Providers.jsx`
- Modify: `dashboard/src/views/Kanban.jsx`
- Modify: `dashboard/src/views/History.jsx`
- Modify: `dashboard/src/views/Strategy.jsx`
- Modify: `dashboard/src/views/Schedules.jsx`
- Modify: `dashboard/src/views/RoutingTemplates.jsx`
- Modify: `dashboard/src/components/TaskDetailDrawer.jsx`
- Modify: `dashboard/src/components/TaskSubmitForm.jsx`
- Modify: `dashboard/src/utils/providerModels.js`

- [ ] **Step 1: Remove aider-ollama from dashboard constants**

Remove from provider color maps, CSS class mappings, and any provider enum arrays in `constants.js`.

- [ ] **Step 2: Remove from all view components**

Remove `'aider-ollama'` from provider lists, filters, and display logic in all 6 view files.

- [ ] **Step 3: Remove from form and detail components**

Remove from `TaskSubmitForm.jsx` provider dropdown and `TaskDetailDrawer.jsx` provider display.

- [ ] **Step 4: Remove from providerModels.js**

Remove aider-ollama model mappings.

- [ ] **Step 5: Verify dashboard builds**

Run: `torque-remote npm run build --prefix dashboard` (or equivalent build command)
Expected: Build succeeds with no errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/
git commit -m "feat: remove aider-ollama from dashboard frontend"
```

---

### Task 10: Update Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `server/docs/architecture.md`
- Modify: `server/docs/guides/providers.md`
- Modify: `server/docs/guides/setup.md`
- Modify: `server/docs/api/rest-api.md`
- Modify: `server/docs/runbooks/troubleshooting.md`

Do NOT modify: `docs/superpowers/specs/*` or `docs/superpowers/plans/*` (historical records)

- [ ] **Step 1: Update CLAUDE.md**

- Remove `aider-ollama` from the Providers table
- Remove from the "Edit Format" table showing `aider-ollama | Aider SEARCH/REPLACE blocks`
- Remove from Smart Routing examples
- Remove from Fallback Behavior chains
- Remove from the Provider Capability Matrix
- Update provider count (13 → 12)
- Remove the feedback memory reference about aider-ollama opening visible windows (it's now irrelevant)

- [ ] **Step 2: Update server/docs/**

Remove aider-ollama from provider guides, setup instructions, API docs, troubleshooting runbooks, and architecture docs.

- [ ] **Step 3: Update docs/architecture.md**

Remove aider-ollama references from the top-level architecture doc.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture.md server/docs/
git commit -m "docs: remove aider-ollama from all documentation"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Grep for any remaining aider-ollama references**

Run: `grep -r "aider-ollama" server/ --include="*.js" -l` — should return 0 files
Run: `grep -r "aider-ollama" CLAUDE.md docs/ server/docs/` — should return only historical spec/plan files

- [ ] **Step 2: Grep for orphaned aider imports**

Run: `grep -r "aider-command" server/ --include="*.js"` — should return 0 results
Run: `grep -r "aider-model-metadata" server/` — should return 0 results

- [ ] **Step 3: Run full test suite**

Run: `torque-remote npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Verify TORQUE starts cleanly**

Restart TORQUE and verify no startup errors related to missing aider modules.

- [ ] **Step 5: Final commit if any stragglers found**

---

## Execution Notes

- **Order matters:** Tasks 1-2 must go first (migration + delete modules). Task 5 (execution path) depends on Task 2 (aider-command import removal). Tasks 3-4, 6-7 can be parallelized. Tasks 8-9 (dead code + dashboard) can be parallelized. Task 10 (docs) should be last before Task 11 (verification).
- **The other session** is working on OSS readiness and model upgrades. Coordinate via memory. Files most likely to conflict: `server/execution/provider-router.js`, `server/task-manager.js`, `server/providers/agentic-capability.js`. Check git status before touching these.
- **Don't modify historical migrations** in `server/db/schema-migrations.js` that reference aider (e.g., lines 211-281). They must be preserved for migration replay. Only ADD a new migration.
- **Don't modify historical docs** in `docs/superpowers/specs/` and `docs/superpowers/plans/` — they're archived records.
- **Don't delete task history** — existing aider-ollama task records in the DB are audit trail. The migration only removes config keys and updates routing rules.
- **Routing templates** (`server/routing/templates/*.json`) — confirmed clean, no aider references found.
- **feedback_silent_providers_only.md** memory mentions aider-ollama — update after completion.
- **User's private CLAUDE.md** (`~/.claude/CLAUDE.md`) also mentions aider-ollama — update separately.
- **Substantive test files** requiring more than simple string removal: `tda-15-placement-contract.test.js`, `execution-builders.test.js`, `provider-commands.test.js`, `provider-base-execution.test.js`, `post-task.test.js`. These have aider-specific test logic that needs careful rewriting, not just deletion.
