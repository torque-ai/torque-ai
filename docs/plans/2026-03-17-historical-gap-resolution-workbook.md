# Historical Plan Gap Resolution Workbook

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve 16 CRITICAL/HIGH/MEDIUM gaps identified in the 2026-03-17 historical plan gap audit. Unlocks 15 broken intelligence tools, makes cron scheduling and multi-agent coordination operational, and closes dashboard integration gaps.

**Architecture:** Six independent task groups (A–F) that can be parallelized. Group A fixes handler/DB signature mismatches in one file. Group B wires existing functions to the server scheduler. Group C adds one condition check to the workflow runtime. Group D resolves tool namespace collisions. Group E closes dashboard UI gaps. Group F handles config cleanup.

**Tech Stack:** Node.js, better-sqlite3, React, Tailwind CSS

**Backlog Reference:** `docs/plans/2026-03-17-historical-plan-gap-backlog.md`
**Original Plans:** `projects/torque/docs/archive/plans/` (Wave 4–6, scheduling, analytics, advanced features)

---

## File Map

### Group A: Intelligence Handler Fixes (C-1, C-4, H-4)
- Modify: `server/handlers/advanced/intelligence.js` — fix 15 handler→DB call signatures
- Test: `server/tests/adv-intelligence-handlers.test.js` — update expectations from "expects error" to "expects success"

### Group B: Server Scheduler Wiring (C-2, C-3, H-3)
- Modify: `server/index.js` — add scheduler intervals for cron tasks, coordination background jobs, and agent metrics

### Group C: Workflow Runtime Fix (H-1)
- Modify: `server/execution/workflow-runtime.js` — add paused check to `evaluateWorkflowDependencies`
- Test: `server/tests/workflow-runtime.test.js` — add test for paused workflow blocking

### Group D: Coordination Tool Namespace Fix (H-2, M-7)
- Modify: `server/tool-defs/advanced-defs.js` — rename agent routing rule tools
- Modify: `server/handlers/advanced/coordination.js` — fix `handleListRoutingRules` to call coordination DB
- Modify: `server/api/routes-passthrough.js` — add coordination_dashboard REST route

### Group E: Dashboard Fixes (H-5, M-1, M-2, M-3)
- Modify: `dashboard/src/views/Providers.jsx` — add codex_exhausted banner
- Modify: `dashboard/src/views/PlanProjects.jsx` — integrate WorkflowDAG component
- Modify: `dashboard/src/views/Budget.jsx` — wire to getCostForecast API
- Modify: `dashboard/src/views/Models.jsx` — add Leaderboard tab

### Group F: Config Cleanup (L-5, L-3)
- Modify: `server/db/config-keys.js` — add 6 missing config keys
- Modify: `server/tool-defs/workflow-defs.js` — remove or implement reopen_workflow stub

### Group G: Backend Enhancements (L-4, L-6, L-7, L-8, L-9, L-10)
- Modify: `server/tool-defs/webhook-defs.js` — add test_inbound_webhook tool
- Modify: `server/handlers/inbound-webhook-handlers.js` — add test handler
- Modify: `server/db/schema-migrations.js` — timezone column migration
- Modify: `server/db/scheduling-automation.js` — timezone-aware cron calculation
- Modify: `server/db/event-tracking.js` — error pattern analysis in output_stats
- Modify: `server/tool-defs/provider-defs.js` — add percentile MCP tool
- Modify: `server/handlers/provider-handlers.js` — add percentile handler
- Modify: `server/db/workflow-engine.js` — merge workflow events into history
- Modify: `server/handlers/workflow/index.js` — record workflow state change events

### Group H: Additional Dashboard UX (M-4, M-5, M-6)
- Modify: `dashboard/src/views/PlanProjects.jsx` — file picker + editable preview
- Modify: `dashboard/src/components/TaskDetailDrawer.jsx` — follow mode toggle

---

## Group A: Intelligence Handler Signature Fixes

**Resolves:** C-1 (15 broken handlers), C-4 (intelligence_dashboard field mismatch), H-4 (log_intelligence_outcome feedback loop)

**Root cause:** Handler layer passes objects; DB layer expects positional args. One file to fix: `server/handlers/advanced/intelligence.js`.

**Strategy:** For each broken handler, read the DB function's actual signature and update the handler call to match. Do NOT change the DB layer — it has real logic and tests.

---

### Task A1: Fix caching handlers (cache_task_result, lookup_cache, warm_cache)

**Files:**
- Modify: `server/handlers/advanced/intelligence.js:23-220`
- Reference: `server/db/project-cache.js:115` (`cacheTaskResult(taskId, ttlHours)`), `:146` (`lookupCache(taskDescription, workingDirectory, context, similarityThreshold)`), `:263` (`warmCache(limit, minSuccessRate, since)`)

- [ ] **Step 1: Fix handleCacheTaskResult (line 35)**

Change:
```javascript
// BEFORE (line 35):
const cacheEntry = db.cacheTaskResult(task, { ttl_hours });

// AFTER:
const cacheEntry = db.cacheTaskResult(task_id, ttl_hours || 24);
```

The DB function `cacheTaskResult(taskId, ttlHours)` fetches the task itself internally — no need to pass the task object.

- [ ] **Step 2: Fix handleLookupCache (line 58)**

Change:
```javascript
// BEFORE (lines 58-62):
const result = db.lookupCache(task_description, {
  working_directory,
  min_confidence: min_confidence || 0.7,
  use_semantic: use_semantic !== false
});

// AFTER:
const result = db.lookupCache(
  task_description,
  working_directory || null,
  null,  // context
  min_confidence || 0.85
);
```

DB signature: `lookupCache(taskDescription, workingDirectory, context, similarityThreshold)`.

- [ ] **Step 3: Fix handleWarmCache (line 200)**

Change:
```javascript
// BEFORE (approximately):
const result = db.warmCache({ limit, min_exit_code });

// AFTER:
const result = db.warmCache(limit || 100, 0.9, null);
```

DB signature: `warmCache(limit, minSuccessRate, since)`.

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/adv-intelligence-handlers.test.js -t "cache"`
Expected: Cache-related tests that previously expected errors should now pass.

- [ ] **Step 5: Commit**

```bash
git add server/handlers/advanced/intelligence.js
git commit -m "fix(C-1): align caching handler signatures with DB functions

Fixes cache_task_result, lookup_cache, warm_cache — handlers now pass
positional args matching project-cache.js function signatures."
```

---

### Task A2: Fix prioritization handlers (compute_priority, get_priority_queue, boost_priority)

**Files:**
- Modify: `server/handlers/advanced/intelligence.js:227-400`
- Reference: `server/db/analytics.js:507` (`computePriorityScore(taskId)`), `:550` (`getPriorityQueue(limit, minScore)`), `:578` (`boostPriority(taskId, boostAmount, reason)`)

- [ ] **Step 1: Fix handleComputePriority (around line 240)**

The handler reads `score.final_score` but DB returns `combined_score`. Fix the field access:
```javascript
// BEFORE:
const score = db.computePriorityScore(task_id, { recalculate: true });
output += `**Combined Score:** ${score.final_score}\n`;

// AFTER:
const score = db.computePriorityScore(task_id);
output += `**Combined Score:** ${score.combined_score}\n`;
```

Also update any references to `score.weights` → `score.factors`.

- [ ] **Step 2: Fix handleGetPriorityQueue (around line 260)**

```javascript
// BEFORE:
const queue = db.getPriorityQueue({ status, limit });

// AFTER:
const queue = db.getPriorityQueue(safeLimit(limit, 50), 0);
```

DB signature: `getPriorityQueue(limit, minScore)`.

- [ ] **Step 3: Fix handleBoostPriority (around line 374)**

The `boostPriority` DB call likely works but the follow-up `computePriorityScore` call and field read needs fixing:
```javascript
// Fix the follow-up call:
const updated = db.computePriorityScore(task_id);
// And read .combined_score not .final_score
```

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/adv-intelligence-handlers.test.js -t "priority"`

- [ ] **Step 5: Commit**

```bash
git add server/handlers/advanced/intelligence.js
git commit -m "fix(C-1): align prioritization handler signatures with DB functions

Fixes compute_priority, get_priority_queue, boost_priority.
Uses combined_score instead of final_score, positional args for getPriorityQueue."
```

---

### Task A3: Fix failure prediction handlers (predict_failure, learn_failure_pattern, suggest_intervention)

**Files:**
- Modify: `server/handlers/advanced/intelligence.js:406-620`
- Reference: `server/db/analytics.js:766` (`predictFailureForTask(taskDescription, workingDirectory)`), `:633` (`learnFailurePattern(taskId)`), `:835` (`suggestIntervention(taskDescription, workingDirectory)`)

- [ ] **Step 1: Fix handlePredictFailure (around line 420)**

```javascript
// BEFORE:
const prediction = db.predictFailureForTask(task);

// AFTER:
const prediction = db.predictFailureForTask(
  task ? task.task_description : task_description,
  task ? task.working_directory : working_directory
);
```

- [ ] **Step 2: Fix handleLearnFailurePattern (around line 460)**

```javascript
// BEFORE:
const result = db.learnFailurePattern(task_id, signature, name, description);

// AFTER:
const result = db.learnFailurePattern(task_id);
```

DB only takes `taskId` — it auto-extracts patterns.

- [ ] **Step 3: Fix handleSuggestIntervention (around line 550)**

```javascript
// BEFORE:
const suggestions = db.suggestIntervention(task);

// AFTER:
const suggestions = db.suggestIntervention(
  task.task_description,
  task.working_directory
);
```

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/adv-intelligence-handlers.test.js -t "failure|predict|intervention"`

- [ ] **Step 5: Commit**

```bash
git add server/handlers/advanced/intelligence.js
git commit -m "fix(C-1): align failure prediction handler signatures with DB functions

Fixes predict_failure, learn_failure_pattern, suggest_intervention."
```

---

### Task A4: Fix adaptive retry handlers (analyze_retry_patterns, get_retry_recommendation, retry_with_adaptation)

**Files:**
- Modify: `server/handlers/advanced/intelligence.js:628-830`
- Reference: `server/db/analytics.js:924` (`analyzeRetryPatterns(since)`), `:995` (`getRetryRecommendation(taskId, previousError)`)

- [ ] **Step 1: Fix handleAnalyzeRetryPatterns (around line 640)**

```javascript
// BEFORE:
const patterns = db.analyzeRetryPatterns({ time_range_hours, min_retries });

// AFTER:
const since = time_range_hours
  ? new Date(Date.now() - time_range_hours * 3600000).toISOString()
  : null;
const patterns = db.analyzeRetryPatterns(since);
```

- [ ] **Step 2: Fix handleGetRetryRecommendation (around line 723)**

```javascript
// BEFORE:
const recommendation = db.getRetryRecommendation(task);

// AFTER:
const recommendation = db.getRetryRecommendation(
  task_id,
  task ? task.error_output : null
);
```

- [ ] **Step 3: Fix handleRetryWithAdaptation (around line 771)**

Same `getRetryRecommendation` fix, then ensure the task restart logic uses correct args.

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/adv-intelligence-handlers.test.js -t "retry|adaptation"`

- [ ] **Step 5: Commit**

```bash
git add server/handlers/advanced/intelligence.js
git commit -m "fix(C-1): align adaptive retry handler signatures with DB functions

Fixes analyze_retry_patterns, get_retry_recommendation, retry_with_adaptation."
```

---

### Task A5: Fix experiment handlers + intelligence_dashboard + log_intelligence_outcome

**Files:**
- Modify: `server/handlers/advanced/intelligence.js:846-1060`
- Reference: `server/db/analytics.js:1039` (`createExperiment(name, strategyType, variantA, variantB, sampleSize)`), `:1160` (`concludeExperiment(experimentId, applyWinner)`), `:1191` (`getIntelligenceDashboard(since)`), `:887` (`updateIntelligenceOutcome(logId, outcome)`)

- [ ] **Step 1: Fix handleIntelligenceDashboard (C-4, around line 846)**

```javascript
// BEFORE:
const dashboard = db.getIntelligenceDashboard({ time_range_hours });
// ... references dashboard.priority.*, dashboard.retry.*

// AFTER:
const since = time_range_hours
  ? new Date(Date.now() - time_range_hours * 3600000).toISOString()
  : null;
const dashboard = db.getIntelligenceDashboard(since);
// Fix field reads: use dashboard.cache, dashboard.predictions,
// dashboard.patterns, dashboard.experiments
```

Rewrite the markdown output section to use the actual return shape: `cache`, `predictions`, `patterns`, `experiments`.

- [ ] **Step 2: Fix handleLogIntelligenceOutcome (H-4, around line 896)**

```javascript
// BEFORE:
const { task_id, operation, outcome, details } = args;
db.recordEvent(task_id, operation, outcome, details);

// AFTER:
const { log_id, outcome } = args;
db.updateIntelligenceOutcome(log_id, outcome);
```

This wires the feedback loop — `updateIntelligenceOutcome` adjusts pattern confidence (correct: +0.05, incorrect: -0.1).

- [ ] **Step 3: Fix handleCreateExperiment (around line 917)**

```javascript
// BEFORE:
const experiment = db.createExperiment({ name, description, strategy_a, strategy_b, sample_size });

// AFTER:
const experiment = db.createExperiment(
  name,
  'custom',  // strategyType
  JSON.stringify(strategy_a || variant_a),
  JSON.stringify(strategy_b || variant_b),
  sample_size || 100
);
```

- [ ] **Step 4: Fix handleConcludeExperiment (around line 1004)**

```javascript
// BEFORE:
const result = db.concludeExperiment(experiment_id, winner);

// AFTER:
const result = db.concludeExperiment(experiment_id, apply_winner !== false);
```

DB expects `(experimentId, applyWinner)` where `applyWinner` is boolean.

- [ ] **Step 5: Run tests**

Run: `cd server && npx vitest run tests/adv-intelligence-handlers.test.js -t "dashboard|experiment|outcome"`

- [ ] **Step 6: Commit**

```bash
git add server/handlers/advanced/intelligence.js
git commit -m "fix(C-1,C-4,H-4): align experiment/dashboard/outcome handlers with DB

Fixes create_experiment, conclude_experiment, intelligence_dashboard field
mismatch (cache/predictions/patterns/experiments), and wires
log_intelligence_outcome to updateIntelligenceOutcome for pattern confidence
feedback loop."
```

---

### Task A6: Run full intelligence test suite

- [ ] **Step 1: Run full suite**

Run: `cd server && npx vitest run tests/adv-intelligence-handlers.test.js`

- [ ] **Step 2: Fix any remaining test expectations**

Tests that previously `expect`-ed errors from the mismatched calls need updating to expect success responses. Read each failing test and update the assertion.

- [ ] **Step 3: Run full server test suite to check for regressions**

Run: `cd server && npx vitest run`

- [ ] **Step 4: Commit any test fixes**

```bash
git add server/tests/adv-intelligence-handlers.test.js
git commit -m "test: update intelligence handler tests for fixed signatures"
```

---

## Group B: Server Scheduler Wiring

**Resolves:** C-2 (cron schedules never fire), C-3 (coordination background jobs unwired), H-3 (agent metrics/rebalancing)

---

### Task B1: Wire user cron schedule execution (C-2)

**Files:**
- Modify: `server/index.js:756-810` (inside `startMaintenanceScheduler`)
- Reference: `server/db/scheduling-automation.js:1607` (`getDueScheduledTasks()`), `:1628` (`markScheduledTaskRun()`)

- [ ] **Step 1: Add cron schedule check to maintenance loop**

In `server/index.js`, inside the `setInterval` at line 765, after the `dueTasks` maintenance loop (around line 777), add:

```javascript
// Execute due user cron schedules
try {
  const dueSchedules = db.getDueScheduledTasks();
  for (const schedule of dueSchedules) {
    debugLog(`Firing scheduled task: ${schedule.name || schedule.id}`);
    try {
      const taskConfig = typeof schedule.task_config === 'string'
        ? JSON.parse(schedule.task_config)
        : schedule.task_config;

      const taskId = db.createTask({
        task_description: taskConfig.task_description || taskConfig.description || schedule.name,
        working_directory: taskConfig.working_directory || null,
        provider: taskConfig.provider || null,
        model: taskConfig.model || null,
        tags: taskConfig.tags || null,
        metadata: JSON.stringify({ scheduled_task_id: schedule.id, schedule_name: schedule.name })
      });

      if (taskId) {
        taskManager.startTask(taskId);
        debugLog(`Scheduled task started: ${taskId} from schedule ${schedule.name}`);
      }

      db.markScheduledTaskRun(schedule.id);
    } catch (schedErr) {
      debugLog(`Error firing schedule ${schedule.id}: ${schedErr.message}`);
    }
  }
} catch (cronErr) {
  debugLog(`Cron schedule check error: ${cronErr.message}`);
}
```

- [ ] **Step 2: Verify getDueScheduledTasks is exported**

Run: `cd server && node -e "const db = require('./database'); db.init(); console.log(typeof db.getDueScheduledTasks)"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "fix(C-2): wire user cron schedule execution to maintenance loop

getDueScheduledTasks() was implemented but never called from any timer.
Now fires due schedules on the existing 60-second maintenance interval,
creates tasks via createTask + startTask, and marks schedules as run."
```

---

### Task B2: Wire coordination background jobs (C-3)

**Files:**
- Modify: `server/index.js` — add new interval after `startMaintenanceScheduler`
- Reference: `server/db/coordination.js:233` (`checkOfflineAgents()`), `:458` (`expireStaleLeases()`), `:1341` (`cleanupExpiredLocks()`)

- [ ] **Step 1: Add 30-second coordination interval**

In `server/index.js`, after the `startMaintenanceScheduler()` call (find where other intervals are initialized), add:

```javascript
// Coordination background jobs (Wave 6 multi-agent)
let coordinationInterval = null;
function startCoordinationScheduler() {
  if (coordinationInterval) {
    clearInterval(coordinationInterval);
    coordinationInterval = null;
  }

  // 30-second interval for agent offline detection and lease expiry
  coordinationInterval = setInterval(() => {
    try {
      db.checkOfflineAgents();
    } catch (e) {
      debugLog(`checkOfflineAgents error: ${e.message}`);
    }
    try {
      db.expireStaleLeases();
    } catch (e) {
      debugLog(`expireStaleLeases error: ${e.message}`);
    }
  }, 30000);

  // 5-minute interval for lock cleanup
  setInterval(() => {
    try {
      db.cleanupExpiredLocks();
    } catch (e) {
      debugLog(`cleanupExpiredLocks error: ${e.message}`);
    }
  }, 300000);
}
```

Then call `startCoordinationScheduler()` where `startMaintenanceScheduler()` is called.

- [ ] **Step 2: Verify functions are exported**

Run: `cd server && node -e "const db = require('./database'); db.init(); console.log(typeof db.checkOfflineAgents, typeof db.expireStaleLeases, typeof db.cleanupExpiredLocks)"`
Expected: `function function function`

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "fix(C-3): wire coordination background jobs to server scheduler

Adds 30-second interval for checkOfflineAgents + expireStaleLeases,
and 5-minute interval for cleanupExpiredLocks. These DB functions
existed with full implementations and tests but were never called."
```

---

### Task B3: Add periodic agent metrics collection (H-3)

**Files:**
- Modify: `server/index.js` — extend coordination scheduler
- Reference: `server/db/coordination.js:1002` (`recordAgentMetric()`)

- [ ] **Step 1: Add metrics collection to the 5-minute interval**

In the 5-minute `setInterval` from Task B2, after `cleanupExpiredLocks`, add:

```javascript
// Collect periodic agent metrics
try {
  const agents = db.listAgents({ status: 'online' });
  const now = new Date().toISOString();
  const periodStart = new Date(Date.now() - 300000).toISOString(); // 5 min ago
  for (const agent of (agents || [])) {
    db.recordAgentMetric(agent.id, 'tasks_completed', agent.current_load || 0, periodStart, now);
  }
} catch (e) {
  debugLog(`Agent metrics collection error: ${e.message}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/index.js
git commit -m "fix(H-3): add periodic agent metrics collection

Records per-agent load metrics every 5 minutes for trend tracking.
Uses existing recordAgentMetric DB function."
```

---

## Group C: Workflow Runtime Fix

**Resolves:** H-1 (pause_workflow not enforced)

---

### Task C1: Enforce pause in workflow dependency evaluation

**Files:**
- Modify: `server/execution/workflow-runtime.js:744`
- Test: `server/tests/workflow-runtime.test.js`

- [ ] **Step 1: Write the failing test**

In `server/tests/workflow-runtime.test.js`, add:

```javascript
it('should not unblock dependents when workflow is paused', () => {
  // Create workflow with two tasks: A -> B
  const wfId = db.createWorkflow({ name: 'pause-test', tasks: [
    { node_id: 'A', task_description: 'Task A' },
    { node_id: 'B', task_description: 'Task B', depends_on: ['A'] }
  ]});

  // Start the workflow
  db.updateWorkflow(wfId, { status: 'running' });

  // Pause the workflow
  db.updateWorkflow(wfId, { status: 'paused' });

  // Complete task A
  const tasks = db.getWorkflowTasks(wfId);
  const taskA = tasks.find(t => t.workflow_node_id === 'A');
  db.updateTaskStatus(taskA.id, 'completed', { exit_code: 0 });

  // Evaluate dependencies — should NOT unblock B
  evaluateWorkflowDependencies(taskA.id, wfId);

  // Task B should still be blocked
  const taskB = db.getTask(tasks.find(t => t.workflow_node_id === 'B').id);
  expect(taskB.status).toBe('blocked');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/workflow-runtime.test.js -t "paused"`
Expected: FAIL — task B gets unblocked because pause is not checked.

- [ ] **Step 3: Add paused check to evaluateWorkflowDependencies**

In `server/execution/workflow-runtime.js:744`, change:

```javascript
// BEFORE:
if (!workflow || ['completed', 'failed', 'cancelled'].includes(workflow.status)) {
  return;
}

// AFTER:
if (!workflow || ['completed', 'failed', 'cancelled', 'paused'].includes(workflow.status)) {
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/workflow-runtime.test.js -t "paused"`
Expected: PASS

- [ ] **Step 5: Run full workflow test suite**

Run: `cd server && npx vitest run tests/workflow-runtime.test.js`
Expected: All pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add server/execution/workflow-runtime.js server/tests/workflow-runtime.test.js
git commit -m "fix(H-1): enforce pause_workflow in runtime dependency evaluation

evaluateWorkflowDependencies now returns early when workflow status is
'paused', preventing task cascading. Previously pause only set a DB flag
but dependents were still unblocked and started."
```

---

## Group D: Coordination Tool Namespace Fix

**Resolves:** H-2 (routing rules namespace collision), M-7 (coordination_dashboard REST route)

---

### Task D1: Rename agent routing rule tools to avoid collision

**Files:**
- Modify: `server/tool-defs/advanced-defs.js:1681` — rename `list_routing_rules` → `list_agent_routing_rules`
- Modify: `server/handlers/advanced/coordination.js:477` — fix handler to call coordination DB
- Modify: `server/api/routes-passthrough.js` — add REST route for coordination_dashboard, update routing rule routes

- [ ] **Step 1: Rename tool definition**

In `server/tool-defs/advanced-defs.js`, find the `list_routing_rules` tool (around line 1681). Rename to `list_agent_routing_rules`. Add a corresponding `delete_agent_routing_rule` tool def if not already present.

- [ ] **Step 2: Fix handler to call coordination.listRoutingRules**

In `server/handlers/advanced/coordination.js:477`, ensure `handleListRoutingRules` calls `db.listAgentRoutingRules()` or the coordination module's `listRoutingRules()` — NOT the smart routing `getRoutingRules()`.

- [ ] **Step 3: Add coordination_dashboard REST passthrough**

In `server/api/routes-passthrough.js`, add:
```javascript
router.get('/api/v2/advanced/coordination-dashboard', handlePassthrough('coordination_dashboard'));
```

- [ ] **Step 4: Run coordination tests**

Run: `cd server && npx vitest run tests/adv-coordination-handlers.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/advanced-defs.js server/handlers/advanced/coordination.js server/api/routes-passthrough.js
git commit -m "fix(H-2,M-7): rename agent routing tools, add coordination REST route

Renames list_routing_rules → list_agent_routing_rules to avoid collision
with smart provider routing system. Adds coordination_dashboard REST
passthrough route for dashboard access."
```

---

## Group E: Dashboard Fixes

**Resolves:** H-5, M-1, M-2, M-3

---

### Task E1: Add codex_exhausted banner to Providers view (H-5)

**Files:**
- Modify: `dashboard/src/views/Providers.jsx`
- Modify: `dashboard/src/api.js` — add config fetch if needed

- [ ] **Step 1: Add exhaustion check to Providers data fetch**

In the Providers view's data fetch, also request the routing config or status endpoint. Check for `codex_exhausted` state.

- [ ] **Step 2: Add warning banner component**

At the top of the Providers view, add a conditional banner:
```jsx
{codexExhausted && (
  <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg text-red-200">
    <span className="font-semibold">Codex Quota Exhausted</span> — All tasks routing to local LLM.
    Recovery probe runs every {probeInterval} minutes.
  </div>
)}
```

- [ ] **Step 3: Build dashboard**

Run: `cd dashboard && npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/views/Providers.jsx dashboard/src/api.js
git commit -m "fix(H-5): show codex_exhausted banner in Providers dashboard

Adds red warning banner when Codex quota is exhausted, showing current
routing mode and recovery probe interval."
```

---

### Task E2: Add dependency graph to PlanProjects view (M-1)

**Files:**
- Modify: `dashboard/src/views/PlanProjects.jsx`
- Reference: `dashboard/src/components/WorkflowDAG.jsx` — existing DAG component

- [ ] **Step 1: Import WorkflowDAG component**

In `PlanProjects.jsx`, add:
```javascript
import WorkflowDAG from '../components/WorkflowDAG';
```

- [ ] **Step 2: Transform plan project tasks to DAG format**

In the `ProjectDetail` component, transform the project tasks into the format `WorkflowDAG` expects (nodes with `node_id`, `depends_on`, `status`, `provider`, `duration`). Map `sequence_number` to `node_id`, parse `depends_on` JSON.

- [ ] **Step 3: Add Graph/Table toggle**

Add a toggle (matching the one in `Workflows.jsx`) that switches between the DAG visualization and the existing flat task list.

- [ ] **Step 4: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/PlanProjects.jsx
git commit -m "fix(M-1): add visual dependency graph to PlanProjects view

Integrates existing WorkflowDAG component into project detail view
with Graph/Table toggle. Tasks are transformed from plan project
format to DAG node format."
```

---

### Task E3: Wire Budget.jsx to getCostForecast API (M-2)

**Files:**
- Modify: `dashboard/src/views/Budget.jsx:127-130,186-188`
- Modify: `dashboard/src/api.js` — add cost forecast fetch

- [ ] **Step 1: Add forecast API call**

In `dashboard/src/api.js`, add a `getCostForecast` function that calls `/api/v2/cost-forecast` or the appropriate endpoint.

- [ ] **Step 2: Replace client-side calculation**

In `Budget.jsx`, replace the naive `dailyAvg * 30` calculation (around line 127-130) with data from the `getCostForecast` API response. Use the `projected_monthly`, `daily_avg`, and `trend_direction` fields.

- [ ] **Step 3: Update StatCard to show trend**

Update the "Projected Monthly" StatCard (around line 186-188) to include the trend indicator (up/down/stable) from the forecast API.

- [ ] **Step 4: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/views/Budget.jsx dashboard/src/api.js
git commit -m "fix(M-2): wire Budget.jsx to getCostForecast API

Replaces naive client-side dailyAvg*30 with server-side linear
regression forecast including trend analysis."
```

---

### Task E4: Add Leaderboard tab to Models.jsx (M-3)

**Files:**
- Modify: `dashboard/src/views/Models.jsx`
- Modify: `dashboard/src/api.js` — add leaderboard fetch

- [ ] **Step 1: Add leaderboard API call**

In `dashboard/src/api.js`, add a `getModelLeaderboard` function that calls `/api/v2/providers/model-leaderboard` (check `routes-passthrough.js:226` for exact path).

- [ ] **Step 2: Add Leaderboard tab component**

Add a tab to Models.jsx with a table showing: rank, model name, success rate (%), avg duration, task count, top task type. Sort by success rate descending.

- [ ] **Step 3: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/views/Models.jsx dashboard/src/api.js
git commit -m "fix(M-3): add Leaderboard tab to Models dashboard view

Wires get_model_leaderboard API to new tab showing per-model success
rates, duration, and task counts ranked by performance."
```

---

## Group F: Config Cleanup

**Resolves:** L-5 (missing config keys), L-3 (reopen_workflow stub)

---

### Task F1: Add missing config keys to VALID_CONFIG_KEYS

**Files:**
- Modify: `server/db/config-keys.js`

- [ ] **Step 1: Add 6 missing keys**

In `server/db/config-keys.js`, add to the `VALID_CONFIG_KEYS` Set (in alphabetical order):

```javascript
'discovery_advertise',
'discovery_browse',
'ollama_auto_detect_wsl_host',
'ollama_auto_start_enabled',
'ollama_auto_start_timeout_ms',
'ollama_binary_path',
```

- [ ] **Step 2: Verify no more warnings**

Run: `cd server && node -e "const { VALID_CONFIG_KEYS } = require('./db/config-keys'); console.log(VALID_CONFIG_KEYS.has('discovery_advertise'), VALID_CONFIG_KEYS.has('ollama_auto_start_enabled'))"`
Expected: `true true`

- [ ] **Step 3: Commit**

```bash
git add server/db/config-keys.js
git commit -m "fix(L-5): add 6 missing config keys to VALID_CONFIG_KEYS

Adds discovery_advertise, discovery_browse, ollama_auto_detect_wsl_host,
ollama_auto_start_enabled, ollama_auto_start_timeout_ms, ollama_binary_path.
Eliminates 'unknown key' log warnings."
```

---

### Task F2: Remove reopen_workflow stub

**Files:**
- Modify: `server/tool-defs/workflow-defs.js:540` — remove tool def
- Modify: test files that reference `EXPECTED_UNMAPPED_TOOLS` — remove `reopen_workflow` from the set

- [ ] **Step 1: Remove tool definition**

Delete the `reopen_workflow` entry from `server/tool-defs/workflow-defs.js`.

- [ ] **Step 2: Remove from EXPECTED_UNMAPPED_TOOLS**

Search for `reopen_workflow` in test files (`p2-orphaned-tools.test.js`, `test-hardening.test.js`, `tools-aggregator.test.js`) and remove it from the expected unmapped set.

- [ ] **Step 3: Run tests**

Run: `cd server && npx vitest run tests/p2-orphaned-tools.test.js tests/tools-aggregator.test.js`

- [ ] **Step 4: Commit**

```bash
git add server/tool-defs/workflow-defs.js server/tests/
git commit -m "fix(L-3): remove reopen_workflow tool stub

Tool definition existed without a handler. Removing rather than
implementing since add_workflow_task already reopens completed workflows."
```

---

## Group G: Backend Enhancements

**Resolves:** L-4 (test_inbound_webhook), L-6 (timezone scheduling), L-7 (output_stats patterns), L-9 (percentile MCP tool), L-10 (workflow history events)

Note: L-8 (time-series anomaly detection) is incorporated into L-7 as error frequency trending rather than a separate statistical anomaly system.

---

### Task G1: Add test_inbound_webhook tool (L-4)

**Files:**
- Modify: `server/tool-defs/webhook-defs.js` — add tool definition
- Modify: `server/handlers/inbound-webhook-handlers.js` — add handler
- Reference: `server/db/inbound-webhooks.js` — existing webhook CRUD

- [ ] **Step 1: Add tool definition**

Add `test_inbound_webhook` to `server/tool-defs/webhook-defs.js` with params: `webhook_name` (required string), `payload` (optional object).

- [ ] **Step 2: Add handler**

Add `handleTestInboundWebhook` to `server/handlers/inbound-webhook-handlers.js`. The handler should:
1. Look up webhook by name via `db.getInboundWebhookByName`
2. Validate it exists and is enabled
3. Parse `action_config` JSON
4. Apply `{{payload.*}}` variable substitution with a test payload
5. Return a formatted report showing resolved description, source type, and action — without actually creating a task

- [ ] **Step 3: Wire handler to tool dispatch**

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/inbound-webhook-handlers.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/webhook-defs.js server/handlers/inbound-webhook-handlers.js
git commit -m "feat(L-4): add test_inbound_webhook tool

Validates webhook config by simulating payload variable substitution
and action resolution without creating a task."
```

---

### Task G2: Add timezone support for cron schedules (L-6)

**Files:**
- Modify: `server/db/schema-migrations.js` — add timezone column migration
- Modify: `server/db/scheduling-automation.js` — timezone-aware next-run calculation
- Modify: `server/tool-defs/advanced-defs.js` — add timezone param to `create_cron_schedule`
- Modify: `dashboard/src/views/Schedules.jsx` — show/set timezone

- [ ] **Step 1: Add migration for timezone column**

Add `ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT DEFAULT NULL` migration.

- [ ] **Step 2: Update calculateNextRun to support timezone**

Modify `calculateNextRun` in `scheduling-automation.js` to accept optional `timezone` parameter. Use `Intl.DateTimeFormat` with `timeZone` option (built into Node.js, no new dependencies) to convert current time to target timezone before cron field matching.

- [ ] **Step 3: Add timezone param to create_cron_schedule tool def**

Add `timezone: { type: 'string', description: 'IANA timezone (e.g., America/New_York). Defaults to server local time.' }` to the tool's inputSchema.

- [ ] **Step 4: Pass timezone through handler and store in DB**

- [ ] **Step 5: Update Schedules dashboard**

Add optional timezone field to create form and display timezone column in schedule table.

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run tests/scheduling-automation.test.js`

- [ ] **Step 7: Commit**

```bash
git add server/db/schema-migrations.js server/db/scheduling-automation.js server/tool-defs/advanced-defs.js dashboard/src/views/Schedules.jsx
git commit -m "feat(L-6): add IANA timezone support for cron schedules

Adds timezone column, timezone-aware next-run calculation using
Intl.DateTimeFormat, and timezone param to create_cron_schedule.
Dashboard updated to show and set timezone per schedule."
```

---

### Task G3: Add error pattern frequency analysis to output_stats (L-7, L-8)

**Files:**
- Modify: `server/db/event-tracking.js:460` — extend `getOutputStats`
- Modify: `server/handlers/task/operations.js` — update handler output

- [ ] **Step 1: Add error classification query**

In `getOutputStats`, add a SQL query that classifies failed task errors into categories (timeout, memory, not_found, connection, permission, syntax, rate_limit, other) using CASE/WHEN on error_output patterns. Also add a time-bucketed trend query (errors per day for the last 7 days) to surface anomalous spikes.

- [ ] **Step 2: Return extended stats**

Return `{ ...existingStats, error_patterns: [...], error_trend: [...] }`.

- [ ] **Step 3: Update handler output**

In `handleOutputStats`, add sections rendering the error pattern frequency table and daily error trend.

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/task-operations.test.js -t "output"`

- [ ] **Step 5: Commit**

```bash
git add server/db/event-tracking.js server/handlers/task/operations.js
git commit -m "feat(L-7,L-8): add error pattern analysis and trend detection to output_stats

Classifies errors into categories with frequency counts. Adds 7-day
daily error trend for anomaly visibility."
```

---

### Task G4: Expose percentile metrics as MCP tool (L-9)

**Files:**
- Modify: `server/tool-defs/provider-defs.js` — add tool definition
- Modify: `server/handlers/provider-handlers.js` — add handler
- Reference: `server/dashboard/routes/infrastructure.js:494` — existing percentile logic

- [ ] **Step 1: Add tool definition**

Add `get_provider_percentiles` tool with params: `provider` (required string), `days` (optional number, default 7).

- [ ] **Step 2: Add handler**

Add `handleGetProviderPercentiles` that queries completed tasks for the provider, extracts durations, sorts them, and computes P50/P75/P90/P95/P99 using index-based percentile calculation (same logic as `dashboard/routes/infrastructure.js:494`).

- [ ] **Step 3: Wire handler to tool dispatch**

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/provider-handlers.test.js`

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/provider-defs.js server/handlers/provider-handlers.js
git commit -m "feat(L-9): expose provider percentile metrics as MCP tool

Adds get_provider_percentiles returning P50/P75/P90/P95/P99 duration
metrics. Reuses calculation logic from dashboard infrastructure routes."
```

---

### Task G5: Add workflow-level events to history (L-10)

**Files:**
- Modify: `server/handlers/workflow/index.js` — record events on state changes
- Modify: `server/db/workflow-engine.js:1041` — merge workflow events into history

- [ ] **Step 1: Record workflow state change events**

In `handleRunWorkflow`, `handlePauseWorkflow`, and `handleCancelWorkflow`, add calls to `db.recordCoordinationEvent` with event types `workflow_started`, `workflow_paused`, `workflow_cancelled`, including the workflow_id in the details JSON.

- [ ] **Step 2: Extend getWorkflowHistory to include workflow-level events**

In `getWorkflowHistory`, after building task-level events, query `coordination_events` for events whose details contain the workflow_id. Merge into the events array and re-sort by timestamp.

- [ ] **Step 3: Run tests**

Run: `cd server && npx vitest run tests/workflow-runtime.test.js`

- [ ] **Step 4: Commit**

```bash
git add server/db/workflow-engine.js server/handlers/workflow/index.js
git commit -m "feat(L-10): add workflow-level events to workflow_history

Records workflow_started/paused/cancelled to coordination_events.
getWorkflowHistory merges these with task events for complete audit trail."
```

---

## Group H: Additional Dashboard UX Fixes

**Resolves:** M-4 (file picker), M-5 (editable preview), M-6 (follow toggle)

---

### Task H1: Add file picker to PlanProjects import modal (M-4)

**Files:**
- Modify: `dashboard/src/views/PlanProjects.jsx` — ImportModal component

- [ ] **Step 1: Add file input above textarea**

Add an `<input type="file" accept=".md,.txt,.markdown">` with an `onChange` handler that reads the file via `FileReader` and sets the textarea content. Style with Tailwind to match existing UI.

- [ ] **Step 2: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/views/PlanProjects.jsx
git commit -m "fix(M-4): add file picker to PlanProjects import modal"
```

---

### Task H2: Make preview task descriptions editable (M-5)

**Files:**
- Modify: `dashboard/src/views/PlanProjects.jsx` — preview section

- [ ] **Step 1: Lift preview tasks into editable state**

Add `const [previewTasks, setPreviewTasks] = useState([])` and populate from the dry_run response. Replace read-only `<span>` elements with `<input>` elements bound to `previewTasks[idx].description` with `onChange` handlers.

- [ ] **Step 2: Pass edited descriptions to create endpoint**

Ensure the "Create Project" button sends the current `previewTasks` array (with user edits), not the original dry_run response.

- [ ] **Step 3: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/views/PlanProjects.jsx
git commit -m "fix(M-5): make preview task descriptions editable in import modal"
```

---

### Task H3: Add follow mode toggle to ANSI terminal (M-6)

**Files:**
- Modify: `dashboard/src/components/TaskDetailDrawer.jsx` — OutputTab

- [ ] **Step 1: Add followMode state and toggle button**

Add `const [followMode, setFollowMode] = useState(true)` and a toggle button styled as `Follow: ON/OFF` in the output panel header.

- [ ] **Step 2: Gate auto-scroll on followMode**

Wrap the existing auto-scroll useEffect with `if (followMode)` check.

- [ ] **Step 3: Auto-disable on manual scroll up**

Add `onScroll` handler to the output container that sets `followMode = false` when user scrolls away from bottom (threshold: 50px from bottom).

- [ ] **Step 4: Build dashboard**

Run: `cd dashboard && npm run build`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/TaskDetailDrawer.jsx
git commit -m "fix(M-6): add Follow mode toggle to ANSI terminal output"
```

---

## Dropped Items (superseded by better approaches)

| ID | Item | Reason |
|----|------|--------|
| L-1 | waiting_for_codex tag | Superseded by immediate routing decision — queueing indefinitely is worse |
| L-2 | local_llm_preferred_complexity config | Superseded by `complexity_routing` table — more flexible |

---

## Execution Order

Groups A–H are **fully independent** and can execute in parallel:

```
┌──────────────────────────────────────────────────────────────────────┐
│                         PARALLEL EXECUTION                            │
├──────────┬──────────┬──────────┬──────────┬──────┬──────┬─────┬─────┤
│ Group A  │ Group B  │ Group C  │ Group D  │ Grp E│ Grp F│Grp G│Grp H│
│ Intel    │ Scheduler│ Workflow │ Namespace│ Dash │Config│Back │ Dash│
│ Handlers │ Wiring   │ Runtime  │ Fix      │ UI   │Clean │ end │ UX  │
│ (C1,C4,  │ (C2,C3,  │ (H1)    │ (H2,M7)  │(H5,  │(L3,  │(L4, │(M4, │
│  H4)     │  H3)     │         │          │M1-3) │ L5)  │L6-  │M5,  │
│ 6 tasks  │ 3 tasks  │ 1 task  │ 1 task   │4 task│2 task│10)  │M6)  │
│          │          │         │          │      │      │5 tsk│3 tsk│
├──────────┴──────────┴──────────┴──────────┴──────┴──────┴─────┴─────┤
│                    FINAL: Full test suite run                         │
│           cd server && npx vitest run                                │
│           cd dashboard && npm run build                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Total:** 8 groups, 25 tasks, ~80 individual steps
**Verification:** `cd server && npx vitest run` + `cd dashboard && npm run build` after all groups complete
