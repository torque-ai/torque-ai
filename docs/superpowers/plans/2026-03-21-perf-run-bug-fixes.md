# Performance Run Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 bugs discovered during the TORQUE performance run against example-project.

**Architecture:** Each bug is an independent fix. Bugs are ordered by severity (critical first). All fixes are in `server/` — no client changes needed.

**Tech Stack:** Node.js, better-sqlite3, vitest

**Verify command:** `torque-remote "cd /path/to/torque/server && npx vitest run"`

---

### Task 1: Bug #1 — Workflow node `provider` field ignored (cerebras hijacking)

**Severity:** Critical
**Symptom:** All 6 workflow tasks routed to cerebras regardless of per-node `provider` spec (groq, openrouter, codex all overridden).
**Root cause hypothesis:** The code path from `create_workflow` → `createSeededWorkflowTasks` → `db.createTask` → `startTask` → `resolveProviderRouting` looks correct. The provider field IS passed through at every stage. The bug is likely in `categorizeQueuedTasks` (queue-scheduler.js:747) misclassifying tasks, or in the `resolveProviderRouting` function's interaction with metadata deserialization. Need a reproduction test.

**Files:**
- Test: `server/tests/workflow-provider-override.test.js`
- Investigate: `server/execution/queue-scheduler.js` (categorizeQueuedTasks)
- Investigate: `server/execution/provider-router.js:151` (resolveProviderRouting)
- Investigate: `server/db/task-core.js:231` (createTask provider storage)

- [ ] **Step 1: Write reproduction test**

```js
// server/tests/workflow-provider-override.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Workflow provider override', () => {
  it('should preserve per-node provider through create → start → route cycle', () => {
    // 1. Create a workflow with 3 nodes, each specifying different providers
    // 2. For each created task, read it back from DB
    // 3. Assert task.provider matches the node spec
    // 4. Call resolveProviderRouting on each task
    // 5. Assert routed provider matches the node spec (not default)
  });
});
```

- [ ] **Step 2: Run test, observe where provider gets lost**
- [ ] **Step 3: Fix the root cause**
- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 2: Bug #2 — Relative path errors in cerebras/google-ai agentic tool-use

**Severity:** High
**Symptom:** cerebras and google-ai pass relative paths like `example-project.Domain/Budgeting` to `list_directory`, which fails because the working directory isn't resolved.
**Root cause:** In `server/providers/execution.js`, `buildAgenticSystemPrompt` tells the LLM the working directory but the `list_directory` tool implementation doesn't resolve relative paths against it.

**Files:**
- Fix: `server/providers/execution.js` (tool executor — `list_directory` handler)
- Test: `server/tests/agentic-tool-path-resolution.test.js`

- [ ] **Step 1: Find `list_directory` implementation in the tool executor**

Search in `server/providers/execution.js` for `list_directory` or the tool executor's tool handlers.

- [ ] **Step 2: Write failing test**

```js
// Test that list_directory('example-project.Domain/Budgeting')
// resolves against workingDir to produce an absolute path
```

- [ ] **Step 3: Fix — resolve relative paths against workingDir**

In the `list_directory` handler, if the path is not absolute, resolve it:
```js
const resolvedPath = path.isAbsolute(dirPath) ? dirPath : path.resolve(workingDir, dirPath);
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: Bug #3 — Groq completed with null output

**Severity:** High
**Symptom:** Groq task completed (exit_code 0, 6 seconds) but output is null. Output buffer lost data.
**Root cause:** In `server/providers/execute-api.js`, the API response handling may not be capturing the completion text into the task output field.

**Files:**
- Investigate: `server/providers/execute-api.js` (groq execution path)
- Fix: likely in the response → output mapping

- [ ] **Step 1: Trace groq execution in execute-api.js**

Find where the API response body gets mapped to task output. Look for the final `db.updateTaskStatus` call with the output field.

- [ ] **Step 2: Write failing test**
- [ ] **Step 3: Fix output capture**
- [ ] **Step 4: Verify test passes**
- [ ] **Step 5: Commit**

---

### Task 4: Bug #5 — `workflow_status` returns provider:null, depends_on:[] for all nodes

**Severity:** Medium
**Symptom:** `workflow_status` response has `provider: null` and `depends_on: []` for every task node.
**Root cause:** The workflow status handler in `server/handlers/workflow/index.js` likely reads tasks from DB but the serialization omits provider and dependency data.

**Files:**
- Fix: `server/handlers/workflow/index.js` (handleWorkflowStatus)

- [ ] **Step 1: Find handleWorkflowStatus and check task serialization**
- [ ] **Step 2: Add provider and depends_on to the response**
- [ ] **Step 3: Write test verifying response includes provider and depends_on**
- [ ] **Step 4: Commit**

---

### Task 5: Bug #6 — Cerebras quality gap (exits 0 without completing work)

**Severity:** Medium
**Symptom:** Workflow `tests` node (cerebras) exited 0 after only listing directory (1 tool call), never wrote the test file. Quality gate should have caught this.
**Root cause:** The agentic execution loop in `server/providers/execution.js` has a max-iterations limit. When the LLM responds with text but doesn't call tools, the loop may exit early. The quality gate (file validation) only checks files that were modified, not files that should have been created.

**Files:**
- Investigate: `server/providers/execution.js` (iteration limit, output validation)
- Fix: Add minimum-tool-calls check or file-creation verification

- [ ] **Step 1: Find the iteration/tool-call limit in execution.js**
- [ ] **Step 2: Add validation: if task mentions "create" but no write_file calls were made, flag as incomplete**
- [ ] **Step 3: Write test**
- [ ] **Step 4: Commit**

---

### Task 6: Bug #7 — Cannot cancel `retry_scheduled` tasks

**Severity:** Low
**Symptom:** `cancel_task` returns `INVALID_STATUS_TRANSITION` when task status is `retry_scheduled`.
**Root cause:** The cancel handler's status transition validation doesn't include `retry_scheduled` as a valid source state.

**Files:**
- Fix: `server/handlers/task/` (cancel handler or status transition map)
- Test: `server/tests/cancel-retry-scheduled.test.js`

- [ ] **Step 1: Find the status transition validation in cancel handler**

```
grep -r "retry_scheduled" server/handlers/task/
grep -r "INVALID_STATUS_TRANSITION" server/handlers/task/
```

- [ ] **Step 2: Add `retry_scheduled` to valid source states for cancel**
- [ ] **Step 3: Write test**
- [ ] **Step 4: Commit**

---

### Task 7: Bug #8 — Anthropic enabled without API key

**Severity:** Low
**Symptom:** Anthropic shows as "enabled" in provider list but immediately fails with "ANTHROPIC_API_KEY not configured".
**Root cause:** Provider enablement doesn't validate that the required API key is present.

**Files:**
- Fix: `server/db/provider-routing-core.js` or provider config
- Alternative: Add a "status: unconfigured" for enabled-but-no-key providers in the list output

- [ ] **Step 1: Find provider list handler**
- [ ] **Step 2: Add API key presence check to provider status**
- [ ] **Step 3: Write test**
- [ ] **Step 4: Commit**

---

### Task 8: Bug #4 — Competitive feature MCP tools not visible after unlock

**Severity:** Medium (client-side behavior)
**Symptom:** After `unlock_all_tools`, ToolSearch still can't find competitive feature tools.
**Root cause:** Server correctly returns all tools at tier 3 (confirmed: `mcp-protocol.js:93` returns `[..._tools]`). The issue is that Claude Code's `ToolSearch` searches against the initial deferred-tool list from session start. The `tools/list_changed` notification triggers a refresh but the deferred tool cache may not update.

**Files:**
- This is primarily a Claude Code client behavior, not a TORQUE server bug
- Document as known limitation

- [ ] **Step 1: Verify server sends `tools/list_changed` notification after unlock**

Check `mcp-protocol.js` for notification emission when `session._toolsChanged = true`.

- [ ] **Step 2: If notification is missing, add it. If present, document as client limitation.**
- [ ] **Step 3: Commit**

---

## Execution Order

1. **Task 1** (workflow provider override) — Critical, blocks Phase 3 reliability
2. **Task 2** (relative path resolution) — High, blocks free provider usability
3. **Task 3** (groq null output) — High, data loss
4. **Task 6** (cancel retry_scheduled) — Low but quick fix
5. **Task 4** (workflow_status data) — Medium, display-only
6. **Task 5** (quality gap) — Medium, needs design thought
7. **Task 7** (anthropic status) — Low, cosmetic
8. **Task 8** (MCP tool visibility) — Medium, may be client-side

## Performance Run Results Summary

**Providers tested:** 11 (9 completed, 2 killed by user)
**Feature validation:** 40/40 assertions passed
**Workflow test:** 6/6 completed but all misrouted to cerebras
**Bugs found:** 8 (1 critical, 2 high, 3 medium, 2 low)
