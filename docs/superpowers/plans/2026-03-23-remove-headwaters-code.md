# Remove Headwaters-Specific Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all Headwaters/Deluge-specific code from TORQUE, making it a clean, project-agnostic orchestration tool.

**Architecture:** 10 MCP tools are being deleted (3 wiring wrappers, 5 batch lifecycle tools, 2 validation tools), plus the `handleContinuousBatchSubmission` internal callback (Headwaters-specific auto-chaining). Their handlers, tool definitions, REST routes, tier registrations, annotations, and tests are all removed. Two generic tools (`generate_feature_tasks`, `run_batch`) keep their generic functionality but have Headwaters-specific defaults stripped. The benchmark suite gets generic examples.

**Tech Stack:** Node.js, CommonJS modules, vitest tests

---

## Summary of Removals

| Tool | Category | File |
|------|----------|------|
| `wire_system_to_gamescene` | Wiring wrapper | automation-ts-tools.js |
| `wire_events_to_eventsystem` | Wiring wrapper | automation-ts-tools.js |
| `wire_notifications_to_bridge` | Wiring wrapper | automation-ts-tools.js |
| `cache_feature_gaps` | Batch lifecycle | automation-batch-orchestration.js |
| `plan_next_batch` | Batch lifecycle | automation-batch-orchestration.js |
| `run_full_batch` | Batch lifecycle | automation-batch-orchestration.js |
| `extract_feature_spec` | Batch lifecycle | automation-batch-orchestration.js |
| `update_project_stats` | Batch lifecycle | automation-handlers.js |
| `validate_event_consistency` | Validation | automation-ts-tools.js |
| `audit_class_completeness` | Validation | automation-ts-tools.js |

---

### Task 1: Remove Headwaters wiring wrappers from automation-ts-tools.js

**Files:**
- Modify: `server/handlers/automation-ts-tools.js:1094-1275`

- [x] **Step 1: Delete the Headwaters Convenience Wrappers section**

Remove lines 1094-1254 (the comment header + `handleWireSystemToGamescene`, `handleWireEventsToEventsystem`, `handleWireNotificationsToBridge` functions).

- [x] **Step 2: Remove validate_event_consistency and audit_class_completeness handlers**

Delete `handleValidateEventConsistency` (lines 456-655) and `handleAuditClassCompleteness` (lines 743-834).

- [x] **Step 3: Update module.exports**

Remove from exports:
```js
  // These lines are deleted:
  handleValidateEventConsistency,
  handleAuditClassCompleteness,
  handleWireSystemToGamescene,
  handleWireEventsToEventsystem,
  handleWireNotificationsToBridge,
```

Also remove the `// Validation & audit` and `// Headwaters convenience wrappers` comment groups.

- [x] **Step 4: Update the file header comment**

Remove line 9: `* - Headwaters wrappers: wire_system_to_gamescene, wire_events_to_eventsystem, wire_notifications_to_bridge`

- [x] **Step 5: Verify the file parses**

Run: `node -e "require('./server/handlers/automation-ts-tools.js')"`
Expected: No errors

---

### Task 2: Remove Headwaters batch lifecycle tools from automation-batch-orchestration.js

**Files:**
- Modify: `server/handlers/automation-batch-orchestration.js`

- [x] **Step 1: Delete handleCacheFeatureGaps**

Remove lines 377-629 (the `CACHE_DIR` constant, `GAP_CACHE_TTL_MS` constant, and the entire `handleCacheFeatureGaps` function).

- [x] **Step 2: Delete handleExtractFeatureSpec**

Remove lines 946-1112 (the entire `handleExtractFeatureSpec` function).

- [x] **Step 3: Delete handlePlanNextBatch**

Remove lines 1114-1241 (the entire `handlePlanNextBatch` function).

- [x] **Step 4: Delete handleRunFullBatch**

Remove lines 1243-1392 (the entire `handleRunFullBatch` function).

- [x] **Step 4b: Delete handleContinuousBatchSubmission**

Remove lines 1394-1457 (the entire `handleContinuousBatchSubmission` function). This is an internal callback (not a user-facing MCP tool) that auto-chains batch workflows. It depends on `handlePlanNextBatch` and reads `continuous_batch_deluge_path` from config — both Headwaters-specific.

- [x] **Step 5: Strip Headwaters-specific defaults from handleGenerateFeatureTasks**

In `handleGenerateFeatureTasks` (line 181), remove:
- Lines 208-217: The `EventSystem.ts` event name scanning block
- Lines 221-237: The `GameScene.ts` wiring pattern scanning block
- Lines 299-312: The `tasks.wire` generation (the entire wire task description that references `GameScene.ts` and `NotificationBridge.ts`)

The wire task should be removed entirely from the generated tasks since it's Headwaters-specific. Update the output to say "Generated 5 task descriptions" and update the structured JSON output to not include `wire_task`.

- [x] **Step 6: Strip Headwaters wire references from handleRunBatch**

In `handleRunBatch` (line 631):
- Line 648: Change error message from `'feature_name is required. Use cache_feature_gaps to identify the next feature.'` to `'feature_name is required'`
- Line 735: Remove `wire_task: tasks.wire,` from the workflow creation call
- Lines 755: Change `6 + parallelTasks.length` to `5 + parallelTasks.length` and `6 feature` to `5 feature`
- Line 765: Change commit message from `` `feat: add ${featureName}System + batch tests` `` to `` `feat: add ${featureName} + batch tests` ``

- [x] **Step 7: Update module header comment**

Remove lines 7, 11, 12, 13 from the header comment (references to `cache_feature_gaps`, `extract_feature_spec`, `plan_next_batch`, `run_full_batch`).

- [x] **Step 8: Update exports and factory**

Remove from `createAutomationBatchOrchestration()` and `module.exports`:
```js
  handleCacheFeatureGaps,
  handleExtractFeatureSpec,
  handlePlanNextBatch,
  handleRunFullBatch,
  handleContinuousBatchSubmission,
```

- [x] **Step 9: Verify the file parses**

Run: `node -e "require('./server/handlers/automation-batch-orchestration.js')"`
Expected: No errors

---

### Task 3: Remove update_project_stats from automation-handlers.js

**Files:**
- Modify: `server/handlers/automation-handlers.js`

- [x] **Step 1: Delete handleUpdateProjectStats**

Remove the entire `handleUpdateProjectStats` function (starts at line 878) and its section comment.

- [x] **Step 2: Remove from exports**

Remove `handleUpdateProjectStats` from both the factory return and `module.exports`.

- [x] **Step 3: Remove Headwaters reference in file header comment**

Line 13 references "Headwaters wrappers" — remove or update to remove the reference.

- [x] **Step 4: Verify the file parses**

Run: `node -e "require('./server/handlers/automation-handlers.js')"`
Expected: No errors

---

### Task 4: Remove tool definitions from automation-defs.js

**Files:**
- Modify: `server/tool-defs/automation-defs.js`

- [x] **Step 1: Delete 10 tool definition objects**

Remove the complete tool definition objects for:
1. `cache_feature_gaps` (lines 112-124)
2. `extract_feature_spec` (lines 186-197)
3. `plan_next_batch` (lines 198-210)
4. `update_project_stats` (lines 211-222)
5. `wire_system_to_gamescene` (lines 311-326)
6. `wire_events_to_eventsystem` (lines 327-350)
7. `wire_notifications_to_bridge` (lines 351-376)
8. `run_full_batch` (lines 378-405)
9. `validate_event_consistency` (lines 406-419)
10. `audit_class_completeness` (lines 433-447)

- [x] **Step 2: Clean up Headwaters defaults in remaining defs**

In `generate_feature_tasks` definition: remove `GameEvents` from the `interface_name` description example.

In `run_batch` definition: remove `cache_feature_gaps` reference from description if present.

- [x] **Step 3: Verify the file parses**

Run: `node -e "require('./server/tool-defs/automation-defs.js')"`
Expected: No errors, returns array of tool definitions

---

### Task 5: Remove from tier registration and tool dispatch

**Files:**
- Modify: `server/core-tools.js`
- Modify: `server/tools.js`

- [x] **Step 1: Remove from TIER_2 in core-tools.js**

Remove these lines from the `TIER_2` array:
```js
  // Batch lifecycle
  'plan_next_batch', 'extract_feature_spec', 'update_project_stats',
  'cache_feature_gaps', 'run_full_batch',
  // Headwaters wiring wrappers
  'wire_system_to_gamescene', 'wire_events_to_eventsystem', 'wire_notifications_to_bridge',
  // Validation & maintenance
  'validate_event_consistency', ..., 'audit_class_completeness',
```

Keep `normalize_interface_formatting` (it's generic).

The resulting TIER_2 should have the batch lifecycle line simplified to just the generic tools that remain:
```js
  // Batch orchestration
  'generate_feature_tasks', 'generate_test_tasks', 'run_batch',
  'detect_file_conflicts', 'auto_commit_batch', 'get_batch_summary',
```

Remove the `// Batch lifecycle` comment and its 2 lines entirely.

Remove the `// Headwaters wiring wrappers` comment and its line entirely.

Change `// Validation & maintenance` to only contain `'normalize_interface_formatting',`.

- [x] **Step 2: Remove from tools.js FILE_WRITE_TOOL_NAMES and DEFAULT_FILE_WRITE_PATHS**

In `FILE_WRITE_TOOL_NAMES` (line 243), remove:
```js
  'wire_events_to_eventsystem',
  'wire_notifications_to_bridge',
  'wire_system_to_gamescene',
```

Delete the entire `DEFAULT_FILE_WRITE_PATHS` object (lines 259-275) — all 3 entries are wiring tools. The `resolveWrittenFilePaths` function will just use the generic `file_path`/`file_paths` logic for all remaining tools.

Update `resolveWrittenFilePaths` (line 281) to remove the `DEFAULT_FILE_WRITE_PATHS` check:
```js
function resolveWrittenFilePaths(toolName, args) {
  const filePaths = [];
  if (typeof args.file_path === 'string' && args.file_path.trim()) {
    filePaths.push(args.file_path.trim());
  }
  if (Array.isArray(args.file_paths)) {
    for (const filePath of args.file_paths) {
      if (typeof filePath === 'string' && filePath.trim()) {
        filePaths.push(filePath.trim());
      }
    }
  }
  return [...new Set(filePaths)];
}
```

- [x] **Step 3: Verify both files parse**

Run: `node -e "require('./server/core-tools.js')" && node -e "require('./server/tools.js')"`
Expected: No errors

---

### Task 5b: Remove continuous batch handler from workflow runtime

**Files:**
- Modify: `server/execution/workflow-runtime.js`

- [x] **Step 1: Remove continuous batch handler wiring**

Remove:
- Line 30: `let _continuousBatchHandler = null;`
- Line 50-51: `_continuousBatchHandler = null;` and `if (deps.handleContinuousBatchSubmission) _continuousBatchHandler = deps.handleContinuousBatchSubmission;`
- Lines 1078-1084: The `if (finalStatus === 'completed' && _continuousBatchHandler)` block that calls the handler

- [x] **Step 2: Remove continuous_batch_deluge_path config key**

In `server/db/config-keys.js` line 53, remove `'continuous_batch_deluge_path',` from the config keys list.

- [x] **Step 3: Verify both files parse**

Run: `node -e "require('./server/execution/workflow-runtime.js')" && node -e "require('./server/db/config-keys.js')"`
Expected: No errors

---

### Task 6: Remove REST routes and annotations

**Files:**
- Modify: `server/api/routes-passthrough.js`
- Modify: `server/api/routes.js`
- Modify: `server/tool-annotations.js`

- [x] **Step 1: Remove REST routes from routes-passthrough.js**

Remove these lines (around 101-115):
```js
  { method: 'POST', path: '/api/v2/automation/cache-feature-gaps', tool: 'cache_feature_gaps', mapBody: true },
  { method: 'POST', path: '/api/v2/automation/extract-feature-spec', tool: 'extract_feature_spec', mapBody: true },
  { method: 'POST', path: '/api/v2/automation/plan-next-batch', tool: 'plan_next_batch', mapBody: true },
  { method: 'GET', path: '/api/v2/automation/update-project-stats', tool: 'update_project_stats', mapQuery: true },
  { method: 'POST', path: '/api/v2/automation/wire-system-to-gamescene', tool: 'wire_system_to_gamescene', mapBody: true },
  { method: 'POST', path: '/api/v2/automation/wire-events-to-eventsystem', tool: 'wire_events_to_eventsystem', mapBody: true },
  { method: 'POST', path: '/api/v2/automation/wire-notifications-to-bridge', tool: 'wire_notifications_to_bridge', mapBody: true },
  { method: 'POST', path: '/api/v2/automation/validate-event-consistency', tool: 'validate_event_consistency', mapBody: true },
  { method: 'POST', path: '/api/v2/automation/audit-class-completeness', tool: 'audit_class_completeness', mapBody: true },
```

- [x] **Step 1b: Remove run_full_batch route from routes.js**

In `server/api/routes.js` line 1176, remove:
```js
  { method: 'POST', path: '/api/batch/full', tool: 'run_full_batch', mapBody: true },
```

- [x] **Step 2: Remove annotation overrides from tool-annotations.js**

Remove these lines (around 105-108):
```js
  cache_feature_gaps:              Object.freeze({ ... }),
  extract_feature_spec:            Object.freeze({ ... }),
  plan_next_batch:                 Object.freeze({ ... }),
  audit_class_completeness:        Object.freeze({ ... }),
```

- [x] **Step 3: Verify both files parse**

Run: `node -e "require('./server/api/routes-passthrough.js')" && node -e "require('./server/tool-annotations.js')"`
Expected: No errors

---

### Task 7: Clean up benchmark suite

**Files:**
- Modify: `server/orchestrator/benchmark-suite.js`

- [x] **Step 1: Replace Headwaters project structures in benchmark cases**

Change line 10:
```js
// FROM:
project_structure: 'src/systems/, src/types/, src/data/, src/scenes/GameScene.ts',
// TO:
project_structure: 'src/services/, src/types/, src/models/',
```

Change line 22:
```js
// FROM:
project_structure: 'src/systems/, src/types/, src/data/, src/scenes/GameScene.ts, src/systems/InventorySystem.ts, src/systems/EventSystem.ts',
// TO:
project_structure: 'src/services/, src/types/, src/models/, src/services/UserService.ts, src/services/AuthService.ts',
```

- [x] **Step 2: Verify the file parses**

Run: `node -e "require('./server/orchestrator/benchmark-suite.js')"`
Expected: No errors

---

### Task 8: Clean up CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [x] **Step 1: Remove Headwaters Convenience Wrappers section**

Remove the entire section documenting:
- `wire_system_to_gamescene`
- `wire_events_to_eventsystem`
- `wire_notifications_to_bridge`

- [x] **Step 2: Remove batch lifecycle tools that were deleted**

Remove documentation for:
- `cache_feature_gaps`
- `plan_next_batch`
- `run_full_batch`
- `extract_feature_spec`
- `update_project_stats`

- [x] **Step 3: Remove validation tools that were deleted**

Remove documentation for:
- `validate_event_consistency`
- `audit_class_completeness`

- [x] **Step 4: Remove Headwaters/Deluge references**

Line 284: Change `When TORQUE is the execution engine for a project (e.g., Headwaters):` to `When TORQUE is the execution engine for a project:`

Remove any remaining references to Deluge, Headwaters, GameScene, NotificationBridge.

---

### Task 9: Update and fix tests

**Files:**
- Modify: `server/tests/automation-ts-tools.test.js`
- Modify: `server/tests/automation-handlers-batch.test.js`
- Modify: `server/tests/automation-batch-orchestration.test.js`
- Modify: `server/tests/tool-annotations.test.js`
- Modify: `server/tests/tools-aggregator.test.js`
- Modify: `server/tests/p0-path-traversal.test.js`
- Modify: `server/tests/preflight-types.test.js`
- Modify: `server/tests/workflow-handlers-analysis.test.js`
- Modify: `server/tests/continuous-batch-submission.test.js`
- Modify: `server/tests/core-tools.test.js`
- Modify: `server/tests/p1-handler-safety-2.test.js`
- Modify: `server/tests/automation-handlers-config.test.js`
- Modify: `server/tests/workflow-runtime.test.js`
- Modify: `server/tests/policy-active-effects.test.js`

- [x] **Step 1: automation-ts-tools.test.js**

Remove:
- `handleWireSystemToGamescene` describe block (line ~799+)
- All test fixtures creating `GameScene.ts` or `NotificationBridge.ts` files
- `handleValidateEventConsistency` and `handleAuditClassCompleteness` test sections
- Any imports of removed handler functions

- [x] **Step 2: automation-handlers-batch.test.js**

Remove:
- `wire_system_to_gamescene` describe block (line ~563+)
- `wire_events_to_eventsystem` describe block (line ~603+)
- `wire_notifications_to_bridge` describe block (line ~638+)
- `cache_feature_gaps` tests (lines referencing `headwaters_path`)
- `audit_class_completeness` tests (lines referencing `GameScene.ts`)
- The `// Headwaters Convenience Wrappers (validation)` section header

- [x] **Step 3: automation-batch-orchestration.test.js**

Remove:
- All `cache_feature_gaps` tests (those using `headwaters_path`)
- All `plan_next_batch` tests
- All `run_full_batch` tests
- All `extract_feature_spec` tests
- Test fixtures creating `GameScene.ts`, `NotificationBridge.ts`

Update remaining `generate_feature_tasks` tests to not expect a `wire` task key.

Update remaining `run_batch` tests to expect 5 feature tasks instead of 6.

- [x] **Step 4: tool-annotations.test.js**

Remove line testing `wire_system_to_gamescene`:
```js
['wire_system_to_gamescene', IDEMPOTENT],
```

- [x] **Step 5: tools-aggregator.test.js**

Remove:
- `wire_events_to_eventsystem` path resolution tests (lines ~329-338)
- `wire_notifications_to_bridge` tool call test (lines ~592-598)

- [x] **Step 6: p0-path-traversal.test.js**

Remove:
- `handleWireSystemToGamescene` traversal test (line ~134-142)

- [x] **Step 7: preflight-types.test.js**

Replace `GameScene` class examples with generic class names (e.g., `UserService`). Lines ~128-148, ~297-315.

- [x] **Step 8: workflow-runtime.test.js**

Remove the 3 `handleContinuousBatchSubmission` tests (lines ~698-749):
- Test that calls `initRuntime({ handleContinuousBatchSubmission })` and verifies it was called on workflow completion
- Test for error handling when batch handler rejects
- Test for batch handler returning null

- [x] **Step 9: continuous-batch-submission.test.js**

Delete the entire file or remove all tests — the `handleContinuousBatchSubmission` function no longer exists. All tests in this file mock `continuous_batch_deluge_path` and call the deleted handler.

- [x] **Step 10: policy-active-effects.test.js**

Line 119: Replace `validate_event_consistency` with a generic tool name (e.g., `scan_project`) in the test fixture. This is just a string used as test data for policy evaluation.

- [x] **Step 11: Other test files**

For each of these, grep for and remove any Headwaters/wiring references:
- `workflow-handlers-analysis.test.js` (line ~830: `wire_task`)
- `core-tools.test.js` (removed tool name references)
- `p1-handler-safety-2.test.js` (removed handler references)
- `automation-handlers-config.test.js` (Deluge references)

---

### Task 10: Full verification

- [ ] **Step 1: Verify all source files parse**

Run: `node -e "require('./server/index.js')" 2>&1 | head -5`
Expected: Server starts or fails on port binding (not on require errors)

- [ ] **Step 2: Grep for remaining Headwaters references**

Run: `grep -r "Headwaters\|GameScene\|NotificationBridge\|wire_system_to_gamescene\|wire_events_to_eventsystem\|wire_notifications_to_bridge\|headwaters_path\|deluge_path\|Deluge" server/ --include="*.js" -l`

Expected: No matches (or only in docs/critique files)

- [ ] **Step 3: Run test suite**

Run: `npx vitest run` (from server/)
Expected: All tests pass. Some tests removed, remaining tests still green.

- [ ] **Step 4: Commit**

```bash
git add server/ CLAUDE.md
git commit -m "refactor: remove all Headwaters/Deluge-specific code from TORQUE

Remove 10 MCP tools that were project-specific wrappers for a single
game project (Headwaters). TORQUE is now fully project-agnostic.

Removed tools: wire_system_to_gamescene, wire_events_to_eventsystem,
wire_notifications_to_bridge, cache_feature_gaps, plan_next_batch,
run_full_batch, extract_feature_spec, update_project_stats,
validate_event_consistency, audit_class_completeness.

Also removed handleContinuousBatchSubmission (internal callback that
auto-chained Headwaters batches via plan_next_batch + Deluge config).

Generic tools (generate_feature_tasks, run_batch) retain their
project-agnostic functionality with Headwaters defaults stripped."
```
