# Bug Hunt Remediation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model:** This plan is designed for TORQUE workflow submission. Each "Task" is a TORQUE batch. Tasks within each sprint phase can run in parallel unless marked sequential. Use `create_workflow` + `add_workflow_task` for each sprint, with `depends_on` for sequential dependencies.
>
> **Codex is now available** as a provider alongside claude-cli, hashline-ollama, groq, cerebras, openrouter, google-ai.

**Goal:** Remediate 470+ issues from the bug hunt report across 4 risk-bucketed sprints.

**Architecture:** TORQUE workflows execute mechanical fixes in parallel batches. Each batch is one TORQUE task targeting specific files with explicit fix instructions. Architectural/security fixes are manual Claude sessions with diff review. Verification via `npx vitest run` between batch groups.

**Tech Stack:** Node.js (server), React/JSX (dashboard), better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-bug-hunt-remediation-plan.md`
**Report:** `docs/bug-hunt-report.md`

---

## File Map — New Files to Create

| File | Purpose | Created In |
|------|---------|------------|
| `server/utils/json.js` | Shared `safeJsonParse` / `safeJsonStringify` | Sprint 1, Task 5 |
| `server/providers/shared.js` | Shared `buildErrorMessage` / `_buildPrompt` | Sprint 1, Task 5 |
| `cli/shared.js` | Shared `readPid` / `cleanPidFile` / constants | Sprint 1, Task 5 |
| `dashboard/src/utils/providers.js` | Shared `buildProviderOptions` | Sprint 1, Task 5 |

## File Map — Key Files Modified (10+ edits)

| File | Sprints | Edit Count |
|------|---------|------------|
| `server/task-manager.js` | 1, 2 | ~15 |
| `server/database.js` | 1, 2, 3 | ~12 |
| `server/api-server.core.js` | 1, 2 | ~8 |
| `server/config.js` | 2 | ~5 |
| `server/index.js` | 1, 3 | ~8 |
| `server/providers/execution.js` | 2 | ~4 |
| `dashboard/src/views/History.jsx` | 2 | ~6 |
| `agent/index.js` | 3 | ~8 |

---

## Sprint 1: Safe Mechanical Fixes

### Task 1: Falsy Value Fixes + Dead Code in Shared Files
**TORQUE provider:** codex
**Files:**
- Modify: `server/task-manager.js`
- Modify: `server/providers/config.js`
- Modify: `server/handlers/task/pipeline.js`
- Modify: `server/handlers/validation/index.js`
- Modify: `server/policy-engine/evaluation-store.js`
- Modify: `server/api/v2-audit-handlers.js`
- Modify: `server/api/v2-control-plane.js`
- Modify: `server/handlers/task/operations.js`
- Modify: `server/index.js`
- Modify: `server/benchmark.js`
- Modify: `server/chunked-review.js`
- Modify: `server/constants.js`

- [ ] **Step 1: Submit TORQUE task with this description**

```
Fix falsy-value bugs and remove dead code across server files.

FALSY VALUE FIXES (change || to ?? or add NaN guards):

1. server/task-manager.js:1145 — change `task.retry_count || 0` to `task.retry_count ?? 0`
2. server/task-manager.js:1145 — in same area, change `task.max_retries` usage to `task.max_retries ?? 2`
3. server/providers/config.js:220 — change `parseFloat(temperature) || 0.3` to:
   `const parsed = parseFloat(temperature); temperature = Number.isFinite(parsed) ? parsed : 0.3;`
4. server/providers/config.js:225 — same pattern for numPredict:
   `const parsed = parseInt(numPredict); numPredict = Number.isFinite(parsed) ? parsed : -1;`
5. server/api/v2-control-plane.js:81 — change `timeout_minutes || null` to `timeout_minutes ?? null`
6. server/handlers/task/pipeline.js:305 — change `originalTask.priority + 1` to `(originalTask.priority ?? 0) + 1`
7. server/handlers/validation/index.js:838 — change `parseInt(args.days) || 30` to:
   `const parsed = parseInt(args.days, 10); const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;`
8. server/policy-engine/evaluation-store.js:176 — change `options.limit || 50` to `options.limit ?? 50`
9. server/api/v2-audit-handlers.js:47 — change `body.dry_run || false` to `body.dry_run ?? false`
10. server/handlers/task/operations.js:121 — change `args.wait_seconds || 5` to:
    `const waitSeconds = Math.min(args.wait_seconds ?? 5, 300);` (add 5-minute max clamp)

DEAD CODE REMOVAL:

11. server/task-manager.js:570 — remove the line `const fs = require('fs');` (shadows module-level import)
12. server/task-manager.js:937 — remove `const { execFileSync } = require('child_process');` (redundant)
13. server/task-manager.js:853 — remove `const { cleanupChildProcessListeners: _cleanup } = require('./execution/process-lifecycle');` (use top-level import)
14. server/index.js:165-174 — remove the `_generateRequestId` function and `requestIdCounter` variable (dead code, underscore prefix)
15. server/benchmark.js:66-78 — remove `_DESKTOP_MODELS` and `_LAPTOP_MODELS` arrays (never referenced)
16. server/benchmark.js:662 — in `showHelp`, remove the `showFull` parameter and the conditional "Additional Options" block (never called with true)
17. server/chunked-review.js:53 — remove the duplicate regex pattern (identical to line 45)
18. server/chunked-review.js:492-513 — remove the duplicate JSDoc block (keep only one)
19. server/constants.js:38-42 — remove the `/g` flag from all regexes in LLM_ARTIFACT_PATTERNS (shared regexes with /g have stateful lastIndex)

Do NOT change any behavior or logic — only replace falsy-coercion operators and remove unused code.
```

- [ ] **Step 2: Run tests**
```bash
npx vitest run
```
Expected: All existing tests pass (these changes are safe).

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "fix: falsy value bugs (|| to ??) and dead code removal"
```

---

### Task 2: Null/Undefined Guards + try/catch Wrapping
**TORQUE provider:** codex
**Files:**
- Modify: `server/validation/close-phases.js`
- Modify: `server/validation/safeguard-gates.js`
- Modify: `server/api-server.core.js`
- Modify: `server/api/webhooks.js`
- Modify: `server/handlers/task/project.js`
- Modify: `server/handlers/workflow/templates.js`
- Modify: `server/handlers/provider-handlers.js`
- Modify: `server/handlers/task/operations.js`
- Modify: `server/db/workflow-engine.js`
- Modify: `server/handlers/workflow/await.js`
- Modify: `server/mcp/schema-registry.js`
- Modify: `server/routing/template-store.js`
- Modify: `server/ci/github-actions.js`
- Modify: `server/providers/adapters/openai-chat.js`
- Modify: `server/validation/completion-detection.js`
- Modify: `server/utils/hashline-parser.js`
- Modify: `server/utils/backoff.js`
- Modify: `server/database.js`
- Modify: `server/providers/registry.js`

- [ ] **Step 1: Submit TORQUE task with this description**

```
Add null/undefined guards, try/catch wrappers, and remove dead code across server files.

NULL/UNDEFINED GUARDS (add ?. or explicit checks):

1. server/validation/close-phases.js:180 — change `buildResult.error.substring(0, 2000)` to `(buildResult.error || '').substring(0, 2000)`
2. server/validation/close-phases.js:381 — change `dashboard.notifyTaskUpdated(taskId)` to `dashboard?.notifyTaskUpdated?.(taskId)`
3. server/validation/safeguard-gates.js:37 — add at function start: `if (!deps?.db) return { approved: true, reason: 'No db available' };`
4. server/validation/safeguard-gates.js:78 — change `deps.taskCleanupGuard.delete(taskId)` to `deps.taskCleanupGuard?.delete(taskId)`
5. server/api-server.core.js:498 — change `provider.enabled` to `provider?.enabled ?? false`
6. server/api/webhooks.js:141 — change `actionConfig.task_description` to `(actionConfig?.task_description || '')`
7. server/handlers/task/project.js:163 — add before line 163: `if (!args.task_description) return makeError(ErrorCodes.VALIDATION_ERROR, 'task_description is required');`
8. server/handlers/workflow/templates.js:139 — change `template.dependency_graph[taskDef.node_id]` to `(template.dependency_graph || {})[taskDef.node_id]`
9. server/handlers/provider-handlers.js:27 — after `const task = db.approveProviderSwitch(...)`, add: `if (!task) return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'Task not found or cannot be approved');`
10. server/handlers/provider-handlers.js:57 — same pattern for rejectProviderSwitch
11. server/handlers/task/operations.js:510 — change `s.name.slice(0, 20)` to `(s.name || '').slice(0, 20)`

TRY/CATCH WRAPPERS (wrap unguarded JSON.parse and fs calls):

12. server/db/workflow-engine.js:520-524 — wrap both JSON.parse calls:
    `if (t.tags) { try { t.tags = JSON.parse(t.tags); } catch { t.tags = []; } }`
    `if (t.files_modified) { try { t.files_modified = JSON.parse(t.files_modified); } catch { t.files_modified = []; } }`
13. server/db/workflow-engine.js:545 — same pattern for getBlockedTasks tags parsing
14. server/handlers/workflow/await.js:607-608 — wrap: `let filesMod = []; try { filesMod = typeof task.files_modified === 'string' ? JSON.parse(task.files_modified || '[]') : (task.files_modified || []); } catch { filesMod = []; }`
15. server/mcp/schema-registry.js:20 — wrap individual file parsing in try/catch, log warning and continue on error
16. server/routing/template-store.js:41 — wrap preset JSON.parse in try/catch, log warning with filename and skip invalid files
17. server/ci/github-actions.js:54-56 — wrap `JSON.parse(stdout)` in try/catch, return `{ error: 'Invalid JSON from gh CLI' }` on failure
18. server/providers/adapters/openai-chat.js:123 — wrap `JSON.parse(tc.function.arguments)` in try/catch, use raw string as fallback

DEAD CODE REMOVAL:

19. server/validation/completion-detection.js:14 — remove `resolveFileReferences: _unused` from the destructured import (keep `extractModifiedFiles`)
20. server/utils/hashline-parser.js:699 — remove the `_trailingEmptyLines` variable and all increments of it
21. server/utils/backoff.js — remove the `factorial` function and its export from module.exports
22. server/database.js:664-677 — in `resolveTaskId`, remove the dead second query (the `.get()` call after the `.all()` returns 0 results)
23. server/providers/registry.js:117 — remove `_db` variable and its assignment in `init()`

Do NOT change any behavior or logic — only add safety guards and remove unused code.
```

- [ ] **Step 2: Run tests**
```bash
npx vitest run
```

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "fix: add null guards, try/catch wrappers, remove dead code"
```

---

### Task 3: Resource Leak Fixes + Miscellaneous Safe Fixes
**TORQUE provider:** codex
**Files:**
- Modify: `server/index.js`
- Modify: `server/utils/tsserver-client.js`
- Modify: `server/hooks/event-dispatch.js`
- Modify: `server/api/health-probes.js`
- Modify: `server/handlers/shared.js`
- Modify: `server/core-tools.js`
- Modify: `server/api-server.js`
- Modify: `server/api-server.core.js`
- Modify: `server/api/v2-control-plane.js`
- Modify: `server/api/v2-router.js`
- Modify: `server/handlers/task/pipeline.js`
- Modify: `server/handlers/concurrency-handlers.js`
- Modify: `server/constants.js`

- [ ] **Step 1: Submit TORQUE task**

```
Fix resource leaks (timer cleanup) and miscellaneous safe fixes.

RESOURCE LEAK FIXES:

1. server/index.js — find all setInterval calls that are NOT followed by .unref(). Add .unref() to:
   - pidHeartbeatInterval (around line 96)
   - orphanCheckInterval (around line 289)
   - queueProcessingInterval (around line 633)
   - coordinationAgentInterval (around line 914)
   - coordinationLockInterval (around line 928)
   - maintenanceInterval (around line 785)
   - errorRateCleanupInterval (around line 217)
   Pattern: change `interval = setInterval(fn, ms)` to `interval = setInterval(fn, ms); interval.unref();`

2. server/utils/tsserver-client.js:679 — add `.unref()` after the setInterval call in `startIdleCheck`

3. server/hooks/event-dispatch.js:343 — store the initial timer in a module-level variable:
   `let _initialPruneTimer = null;` at top, then `_initialPruneTimer = setTimeout(...)`.
   In `stopRetentionPolicy`, add: `if (_initialPruneTimer) { clearTimeout(_initialPruneTimer); _initialPruneTimer = null; }`

4. server/api/health-probes.js:57-59 — in the handleHealthz timeout promise, clear the timer on success:
   Change the pattern to use a variable: `let timer; const timeoutPromise = new Promise((_, reject) => { timer = setTimeout(...) });`
   Then in the `.then()` of the race winner, add `clearTimeout(timer);`

5. server/handlers/shared.js:611-621 — add a periodic cleanup interval for the idempotencyCache.
   After the cache definition, add:
   ```
   const _idempotencyCleanupInterval = setInterval(() => {
     const now = Date.now();
     for (const [key, entry] of idempotencyCache) {
       if (now - entry.timestamp > 3600000) idempotencyCache.delete(key);
     }
   }, 300000); // every 5 minutes
   _idempotencyCleanupInterval.unref();
   ```

MISCELLANEOUS SAFE FIXES:

6. server/constants.js:59 — add a comment above TASK_TIMEOUTS: `// All values in milliseconds unless noted`
   Add comment above PROVIDER_DEFAULT_TIMEOUTS: `// All values in MINUTES (converted to ms by consumers)`
7. server/constants.js:86 — add `'codex-spark': 30,` to PROVIDER_DEFAULT_TIMEOUTS (after codex entry)
8. server/api-server.js:5-7 — remove the three `void` statements. Add a comment: `// Side-effect imports: route registration and middleware setup`
9. server/api-server.core.js:224-244 — delete the `PROVIDER_API_KEY_ENV_KEYS` constant entirely (duplicate of config.js API_KEY_ENV_VARS). Update any references in this file to use `require('./config').API_KEY_ENV_VARS` instead.
10. server/core-tools.js:83 — change `const CORE_TOOL_NAMES = TIER_1;` to `const CORE_TOOL_NAMES = [...TIER_1];` (copy, not reference)
11. server/api/v2-control-plane.js:14-19 — remove the unused `SECURITY_HEADERS` constant
12. server/api/v2-router.js — remove the local `validateDecodedParamField` function (it duplicates routes.js). Import it: `const { validateDecodedParamField } = require('./routes');` — but first check that routes.js exports it. If not, export it from routes.js.
13. server/api/v2-router.js — same for `buildV2Middleware` if duplicated
14. server/handlers/task/pipeline.js:22-24 — remove `isQueuedStartResult` function (barely used). Replace its 2-3 call sites with inline `result?.queued === true`
15. server/handlers/concurrency-handlers.js:60-62 — replace raw `db.prepare('SELECT...')` with the appropriate `db.*` abstraction method. If no suitable method exists, leave it but add a comment: `// TODO: add db.getProviderConfigs() abstraction`
```

- [ ] **Step 2: Run tests**
```bash
npx vitest run
```

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "fix: resource leaks (timer unref) and miscellaneous cleanup"
```

---

### Task 4: Verify Sprint 1 Phase 1
**Manual step**

- [ ] **Step 1: Run full test suite**
```bash
npx vitest run
```

- [ ] **Step 2: Verify server starts**
```bash
# If TORQUE is already running, skip this. Otherwise:
node server/index.js &
sleep 4
curl -s http://127.0.0.1:3457/api/v2/providers | head -50
```

- [ ] **Step 3: Review diffs**
```bash
git log --oneline -3
git diff HEAD~3..HEAD --stat
```

---

### Task 5: Extract Duplicated Utilities
**TORQUE provider:** codex (multi-file, needs full context)
**Depends on:** Tasks 1-3 complete

**Files:**
- Create: `server/utils/json.js`
- Create: `server/providers/shared.js`
- Create: `cli/shared.js`
- Create: `dashboard/src/utils/providers.js`
- Modify: 7+ files that import from new locations

- [ ] **Step 1: Submit TORQUE task — Extract safeJsonParse**

```
Extract the `safeJsonParse` function from server/database.js into a new shared module server/utils/json.js and update all consumers.

1. Create server/utils/json.js with:

const { logger } = require('../logger');

const MAX_JSON_SIZE = 10 * 1024 * 1024; // 10MB

function safeJsonParse(str, defaultValue = null) {
  if (str === null || str === undefined) return defaultValue;
  if (typeof str !== 'string') return typeof str === 'object' ? str : defaultValue;
  const trimmed = str.trim();
  if (!trimmed.length) return defaultValue;
  if (trimmed.length > MAX_JSON_SIZE) {
    logger.warn(`safeJsonParse: input too large (${trimmed.length} bytes)`);
    return defaultValue;
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return defaultValue;
  try {
    return JSON.parse(trimmed);
  } catch {
    return defaultValue;
  }
}

function safeJsonStringify(value, defaultValue = '{}') {
  try {
    return JSON.stringify(value);
  } catch {
    return defaultValue;
  }
}

module.exports = { safeJsonParse, safeJsonStringify };

2. In server/database.js: remove the local safeJsonParse definition. Add at top: `const { safeJsonParse } = require('./utils/json');`. Keep exporting it: `module.exports = { ..., safeJsonParse, ... };`

3. In each of these files, remove their local safeJsonParse definition and add the import:
   - server/db/workflow-engine.js
   - server/db/host-management.js
   - server/db/provider-routing-core.js
   - server/db/inbound-webhooks.js
   - server/policy-engine/evaluation-store.js
   - server/policy-engine/profile-store.js
   - server/economy/policy.js

   In each file, find the local `function safeJsonParse(...)` and replace with:
   `const { safeJsonParse } = require('../utils/json');` (adjust relative path as needed)

4. Also extract safeJsonStringify from any file that has a local copy and import from the new module.

IMPORTANT: Run `npx vitest run` after to verify nothing broke.
```

- [ ] **Step 2: Submit TORQUE task — Extract provider shared utilities**

```
Extract duplicated provider utilities into server/providers/shared.js.

1. Create server/providers/shared.js with:

function buildErrorMessage(service, status, errorBody, retryAfterSeconds) {
  let msg = `${service} API error (HTTP ${status})`;
  if (errorBody) {
    const parsed = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody);
    msg += `: ${parsed.substring(0, 500)}`;
  }
  if (retryAfterSeconds) {
    msg += ` (retry after ${retryAfterSeconds}s)`;
  }
  return msg;
}

module.exports = { buildErrorMessage };

2. In each of these files, remove the local `buildErrorMessage` function and add:
   `const { buildErrorMessage } = require('./shared');`
   Files: server/providers/cerebras.js, server/providers/groq.js, server/providers/anthropic.js, server/providers/deepinfra.js, server/providers/hyperbolic.js

NOTE: Do NOT extract _buildPrompt yet — it has subtle per-provider differences that need manual review.
```

- [ ] **Step 3: Submit TORQUE task — Extract CLI shared utilities**

```
Extract duplicated CLI utilities into cli/shared.js.

1. Create cli/shared.js with:

const path = require('path');

const TORQUE_HOME = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.torque');
const PID_FILE = path.join(TORQUE_HOME, 'torque.pid');
const API_PORT = parseInt(process.env.TORQUE_API_PORT || '3457', 10);
const API_URL = process.env.TORQUE_API_URL || `http://127.0.0.1:${API_PORT}`;

const fs = require('fs');

function readPid() {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cleanPidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

module.exports = { TORQUE_HOME, PID_FILE, API_PORT, API_URL, readPid, cleanPidFile };

2. In cli/start.js: remove the local TORQUE_HOME, PID_FILE, API_PORT, API_URL, readPid, cleanPidFile definitions. Add: `const { TORQUE_HOME, PID_FILE, API_PORT, API_URL, readPid, cleanPidFile } = require('./shared');`

3. In cli/stop.js: same — remove locals, add import from './shared'.
```

- [ ] **Step 4: Submit TORQUE task — Extract dashboard shared utilities**

```
Extract duplicated dashboard utilities.

1. In dashboard/src/constants.js, add PROVIDER_COLORS export (it has STATUS_COLORS etc. but not PROVIDER_COLORS):

export const PROVIDER_COLORS = {
  codex: 'text-green-400',
  'claude-cli': 'text-purple-400',
  ollama: 'text-blue-400',
  'hashline-ollama': 'text-cyan-400',
  'aider-ollama': 'text-teal-400',
  anthropic: 'text-violet-400',
  deepinfra: 'text-orange-400',
  hyperbolic: 'text-amber-400',
  groq: 'text-lime-400',
  cerebras: 'text-emerald-400',
  'google-ai': 'text-red-400',
  openrouter: 'text-pink-400',
  'ollama-cloud': 'text-sky-400',
  local: 'text-blue-400',
};

2. In each view that defines its own STATUS_COLORS, remove the local definition and add:
   `import { STATUS_COLORS } from '../constants';`
   Files: TaskDetailDrawer.jsx, History.jsx, Workflows.jsx, BatchHistory.jsx

3. In each view that defines its own PROVIDER_COLORS, remove the local definition and add:
   `import { PROVIDER_COLORS } from '../constants';` (adjust path as needed)
   Files: Providers.jsx, Budget.jsx, Strategy.jsx, RoutingTemplates.jsx, FreeTier.jsx

4. Create dashboard/src/utils/providers.js with the shared buildProviderOptions:

const COMMON_PROVIDER_OPTIONS = [
  'codex', 'claude-cli', 'ollama', 'hashline-ollama', 'aider-ollama',
  'anthropic', 'deepinfra', 'hyperbolic', 'groq', 'cerebras',
  'google-ai', 'openrouter', 'ollama-cloud'
];

export function buildProviderOptions(tasks = []) {
  const seen = new Set(tasks.map(t => t.provider).filter(Boolean));
  const all = new Set([...COMMON_PROVIDER_OPTIONS, ...seen]);
  return [...all].sort();
}

5. In Kanban.jsx, History.jsx, TaskDetailDrawer.jsx: remove local buildProviderOptions and import from '../utils/providers'.
```

- [ ] **Step 5: Submit TORQUE task — Remove formatTime duplicate**

```
In server/handlers/task/utils.js, remove the local `formatTime` function.
Replace all imports of formatTime from task/utils with imports from '../shared'.

Check: server/handlers/shared.js exports formatTime (confirmed it does at line 928).
Find all files that import formatTime from './utils' or '../task/utils' and change to import from '../shared' or '../../handlers/shared' as appropriate.
```

- [ ] **Step 6: Run tests**
```bash
npx vitest run
```

- [ ] **Step 7: Commit**
```bash
git add -A && git commit -m "refactor: extract duplicated utilities (safeJsonParse, buildErrorMessage, CLI, dashboard)"
```

---

### Task 6: Sprint 1 Final Verification

- [ ] **Step 1: Full test suite**
```bash
npx vitest run
```

- [ ] **Step 2: Server start check**
```bash
curl -s http://127.0.0.1:3457/api/v2/providers | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d[\"data\"][\"providers\"])} providers')"
```

- [ ] **Step 3: Commit sprint tag**
```bash
git tag sprint-1-complete
```

---

## Sprint 2: Behavior-Changing Fixes

### Task 7: Unit/Math Bug Fixes
**TORQUE provider:** codex
**Files:**
- Modify: `server/api-server.core.js`
- Modify: `server/api/v2-analytics-handlers.js`
- Modify: `server/handlers/task/project.js`
- Modify: `server/benchmark.js`
- Modify: `server/handlers/provider-handlers.js`
- Modify: `server/orchestrator/deterministic-fallbacks.js`
- Modify: `server/chunked-review.js`
- Modify: `server/economy/triggers.js`
- Modify: `server/api/v2-inference.js`

- [ ] **Step 1: Submit TORQUE task**

```
Fix math and unit bugs. Each fix MUST include a test.

1. server/api-server.core.js:330-337 — CRITICAL: getV2ProviderDefaultTimeoutMs treats minutes as seconds.
   Change: `return safeSeconds * 1000;` to `return safeSeconds * 60 * 1000;`
   Add test in server/tests/api-server.test.js:
   `test('getV2ProviderDefaultTimeoutMs converts minutes to ms', () => { expect(getV2ProviderDefaultTimeoutMs('codex')).toBe(30 * 60 * 1000); });`

2. server/api/v2-analytics-handlers.js:58 — success rate operator precedence.
   Change: `completed / (completed + failed || 1)` to `completed / ((completed + failed) || 1)`
   Add test: with completed=5, failed=0, expect success_rate=100 (not 83).

3. server/api/v2-analytics-handlers.js:218 — running average should be weighted.
   Instead of `(old + new) / 2`, track `totalDuration` and `totalCount` and compute `totalDuration / totalCount`.

4. server/handlers/task/project.js:848 — division by zero in handleForecastCosts.
   Add guard: `const denominator = n * sumX2 - sumX * sumX; if (denominator === 0) { slope = 0; }`

5. server/benchmark.js:210-211 — division by zero for tokensPerSecond.
   Change to: `const tokensPerSecond = evalDuration > 0 ? outputTokens / evalDuration : 0;`
   Same for promptTokensPerSecond.

6. server/handlers/provider-handlers.js:511 — percentile off-by-one.
   Change: `arr[Math.floor(arr.length * pct / 100)]` to `arr[Math.min(arr.length - 1, Math.floor(arr.length * pct / 100))]`

7. server/orchestrator/deterministic-fallbacks.js:161 — score can go negative.
   After computing score, add: `const clampedScore = Math.max(0, Math.min(100, score));`

8. server/api-server.core.js:1206 — timeout cap too low (600s).
   Change 600000 to 1800000 (30 minutes). Update validation message.

9. server/api/v2-inference.js:299-301 — inconsistent timeout units.
   Ensure both the explicit and default paths produce the same unit (minutes).
   Default path: change `/ 1000` to `/ 60000` to match the explicit path.

10. server/api/v2-inference.js:522 — wrong error code.
    Change `'stream_not_supported'` to `'async_not_supported'`.

11. server/api/v2-inference.js:575 — requestId passed as status field.
    Fix the parameter name in the function call to pass the actual status value.
```

- [ ] **Step 2: Run tests**
```bash
npx vitest run
```

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "fix: math/unit bugs — timeout conversion, success rate, percentiles"
```

---

### Task 8: Parameter Binding & Query Fixes
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Fix parameter binding and SQL query bugs.

1. server/db/audit-store.js:152 — change `statement.run(params)` to `statement.run(...params)`
2. server/db/audit-store.js:357 — change `updateStatement.run(params)` to `updateStatement.run(...params)`
3. server/db/audit-store.js:470 — change `statement.run(params)` to `statement.run(...params)`
   Add tests for all three: create an audit run, update it, verify the update persisted.

4. server/db/workflow-engine.js:1098 — getWorkflowHistory uses unparameterized LIKE.
   Change from: `.all(\`%"workflow_id":"${workflowId}"%\`)`
   To: `.all(\`%"workflow_id":"${workflowId.replace(/[%_]/g, '')}"%\`)`
   Better yet, use a parameterized query if possible.

5. server/benchmark.js:551 — type-coerced hostId comparison.
   Change: `h.id === parsed.hostId` to `String(h.id) === String(parsed.hostId)`

6. server/api/v2-governance-handlers.js:174 — O(n) scan for schedule by ID.
   Instead of fetching all schedules and filtering, query directly:
   `const schedule = db.getScheduledTask ? db.getScheduledTask(scheduleId) : schedules.find(...);`

7. server/db/workflow-engine.js:1017-1019 — LIKE without escaping.
   Before the LIKE query, escape metacharacters:
   `const escaped = options.filter.replace(/[%_]/g, '\\$&');`
   Then: `params.push(\`%${escaped}%\`);`

8. server/db/audit-store.js:297 — same LIKE escaping for file_path filter.

9. server/handlers/provider-handlers.js:494 — verify the date filter parameter name matches what listTasks expects. If listTasks expects `created_after`, change `since` to `created_after`.
```

- [ ] **Step 2: Run tests, commit**

---

### Task 9: Config System Fixes
**TORQUE provider:** codex
**Files:** `server/config.js`, `server/db/host-management.js`, `server/db/provider-routing-core.js`, `server/api-server.core.js`

- [ ] **Step 1: Submit TORQUE task**

```
Fix config system bugs. Must update server/tests/config.test.js.

1. server/config.js:111 — get() stringifies boolean defaults making them truthy.
   Change: `if (entry && entry.default !== undefined) return String(entry.default);`
   To: `if (entry && entry.default !== undefined) return entry.default;`
   This means get() now returns typed values (number, boolean, string) for defaults.
   Update callers that compare against string '1' or 'true' — they should use getBool() instead.

2. server/config.js:149 — getBool defaults to true for unknown keys.
   Change the fallback: `return defaultVal !== undefined ? defaultVal : false;`

3. server/config.js:120-127 — getInt ignores explicit fallback.
   Change: `const raw = get(key);` to `const raw = get(key, fallback);`
   This ensures the fallback propagates when the key has no registry entry and no DB value.

4. server/config.js:158-161 — isOptIn should use getBool internally.
   Change the function body to: `return getBool(key, false);`

5. server/api-server.core.js:1074 — CORS origin hardcoded.
   Change: `'Access-Control-Allow-Origin': 'http://127.0.0.1:3456'`
   To: `'Access-Control-Allow-Origin': \`http://127.0.0.1:${require('./config').getPort('dashboard')}\``

6. server/db/host-management.js:54-57 — local getConfig bypasses encryption.
   Remove the local `function getConfig(key)` and replace calls with:
   `const { getConfig } = require('../database');`

7. server/db/provider-routing-core.js:65-69 — same fix.
   Remove local getConfig, import from database.js.

Add tests in config.test.js for:
- get() returns boolean false for a key with default: false (not "false")
- getBool() returns false for unknown keys
- getInt('known_key', 42) uses registry default, not 42
- getInt('unknown_key', 42) returns 42
```

- [ ] **Step 2: Run tests, commit**

---

### Task 10: Provider/Routing Behavior Fixes
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Fix provider and routing behavior bugs.

1. server/providers/v2-local-providers.js:459 — wrong default port.
   Change: `port: parsedUrl.port || (isHttps ? 443 : 80)`
   To: `port: parsedUrl.port || (isHttps ? 443 : 11434)`

2. server/providers/execution.js:451-455 — host slot decrement without increment.
   After `ollamaHost = selection.host.url; selectedHostId = selection.host.id;` add:
   `const slotReserved = db.tryReserveHostSlot ? db.tryReserveHostSlot(selectedHostId) : true;`
   Or if tryReserveHostSlotWithFallback exists, call that instead.

3. server/providers/execution.js:964-965 — fallback reverts all uncommitted changes.
   Change: `checkAndRevert(workingDir, snapshot, '', 'enforce')`
   To: `checkAndRevert(workingDir, snapshot, task?.task_description || '', 'enforce')`

4. server/providers/execute-api.js:329 — mutates shared task object.
   Change: `task.task_description = effectiveDescription;`
   To: `const enrichedTask = { ...task, task_description: effectiveDescription };`
   Then use enrichedTask downstream instead of task.

5. server/providers/adapters/google-chat.js:80 — only tracks first tool call.
   Move `lastFunctionCallName` assignment inside the for loop that processes tool calls,
   not just the first one.

6. server/routing/category-classifier.js:65 — REASONING_RE too broad.
   Change `\breason\b` to `\breason(?:ing|ed)\b` in the regex pattern.

7. server/providers/config.js:279 — missing opt-in providers.
   Add to optInProviders array: 'claude-cli' (if not already there).
   Verify the full list matches CLAUDE.md documentation.

8. server/utils/safe-env.js:36-46 — missing 3 provider keys.
   Add to PROVIDER_KEYS map:
   'cerebras': ['CEREBRAS_API_KEY'],
   'openrouter': ['OPENROUTER_API_KEY'],
   'ollama-cloud': ['OLLAMA_CLOUD_API_KEY'],

9. server/utils/safe-exec.js:54 — || treated as &&.
   Change the split to track operator type:
   Instead of splitting on both && and ||, parse segments with their operators.
   For && segments: stop on first failure.
   For || segments: stop on first success.

10. server/economy/queue-reroute.js:163 — economy deactivation is a no-op.
    Implement: query tasks with non-null original_provider, restore their provider field.

11. server/providers/cerebras.js:247 — listModels returns hardcoded list.
    Add API fetch with static fallback: try fetching from /v1/models, fall back to current static array on failure.

12. server/utils/credential-crypto.js:82 — EEXIST race on key file creation.
    The writeFileSync with flag:'wx' already handles EEXIST. Ensure the catch block for EEXIST reads
    the existing file instead of throwing. Add a brief delay+retry if the file is empty (concurrent writer still writing).
```

- [ ] **Step 2: Run tests**
```bash
npx vitest run
```

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "fix: provider routing, safe-exec OR chains, economy deactivation"
```

---

### Task 11: Critical Missing Behavior Bugs
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Fix critical behavior bugs identified in spec review.

1. server/api/v2-dispatch.js:35-65 — readJsonBody string concat breaks multi-byte UTF-8.
   Change from: `let data = ''; req.on('data', chunk => { data += chunk; });`
   To: `const chunks = []; req.on('data', chunk => { chunks.push(chunk); }); ... const data = Buffer.concat(chunks).toString('utf8');`
   Also add validateJsonDepth call after JSON.parse (matching middleware.js parseBody).

2. server/task-manager.js:1494 — startTask mutates DB-returned task.
   At the start of startTask, clone: `task = { ...task };`
   If task.metadata is an object, deep clone it too: `if (task.metadata && typeof task.metadata === 'object') task.metadata = { ...task.metadata };`

3. server/task-manager.js:1467-1470 — startTask doesn't release slot on errors after claim.
   In the catch block after tryClaimTaskSlot succeeds, add slot release:
   `db.updateTaskStatus(taskId, 'queued', { pid: null, started_at: null });`

4. server/task-manager.js:2011 — wrong timeout constant.
   Change: `timeout: TASK_TIMEOUTS.FILE_WRITE` to `timeout: TASK_TIMEOUTS.GIT_STATUS`

5. server/chunked-review.js:61-62 — brace counting ignores string literals.
   Track `inString` state: when counting { and } in a line, skip characters inside double-quoted strings.

6. server/task-manager.js:358 — resolver cleanup references wrong function.
   Change: `closeHandlerResolvers = closeHandlerResolvers.filter(r => r !== resolve)`
   To: `closeHandlerResolvers = closeHandlerResolvers.filter(r => r !== wrappedResolve)`

7. server/task-manager.js:1858 — processQueue timer leak.
   Before setting new timer, clear existing: `if (_processQueueTimer) { clearTimeout(_processQueueTimer); }`
```

- [ ] **Step 2: Run tests, commit**

---

### Task 12: Dashboard Behavior Fixes
**TORQUE provider:** codex
**Files:** Multiple dashboard JSX files

- [ ] **Step 1: Submit TORQUE task**

```
Fix dashboard behavior bugs.

1. dashboard/src/components/EconomyIndicator.jsx:32 — wrong API prefix.
   Change all `request('/v2/economy/...')` calls to `requestV2('/economy/...')`.
   Import requestV2 from '../api' if not already imported.

2. dashboard/src/views/Hosts.jsx:33 — VramBar division by zero.
   Add at start of VramBar: `if (!total || total <= 0) return null;`

3. dashboard/src/views/Hosts.jsx:17 — CapacityBar NaN.
   Change: `const percent = Math.min(100, Math.round((running / max) * 100));`
   To: `const percent = Math.min(100, Math.round(((running || 0) / (max || 1)) * 100));`

4. dashboard/src/components/TaskDetailDrawer.jsx:927 — DiffTab null crash.
   Change: `{diff.status === 'reviewed'` to `{diff?.status === 'reviewed'`

5. dashboard/src/views/History.jsx:168 — pagination.totalPages never populated.
   After `setPagination(data.pagination)`, compute totalPages:
   `setPagination(prev => ({ ...data.pagination, totalPages: Math.ceil((data.pagination?.total || 0) / (data.pagination?.limit || 20)) }));`

6. dashboard/src/api.js:59 — AbortSignal fallback drops external signal.
   When AbortSignal.any is unavailable, add manual forwarding:
   `if (options.signal) { options.signal.addEventListener('abort', () => controller.abort(), { once: true }); }`

7. dashboard/src/views/History.jsx:369-391 — bulk ops sequential.
   Change the for...of + await loop to: `await Promise.allSettled(selected.map(id => api.tasks.retry(id)));`

8. dashboard/src/views/History.jsx:86-89 — "This Week" label.
   Change the button label from "This Week" to "Last 7 Days" and "This Month" to "Last 30 Days".

9. dashboard/src/views/Models.jsx:20-26 — local formatDuration shadows shared.
   Remove the local formatDuration. Import: `import { formatDuration } from '../utils/formatters';`

10. dashboard/src/views/Providers.jsx:247 — local formatDate shadows shared.
    Remove local formatDate. Import from '../utils/formatters'.

11. dashboard/src/components/TaskDetailDrawer.jsx:412 — clipboard write no catch.
    Change: `.then(() => toast.success('Description copied'))`
    To: `.then(() => toast.success('Description copied')).catch(() => toast.error('Copy failed — use HTTPS'))`
    Apply same pattern to lines 678 and 915.
```

- [ ] **Step 2: Run tests, commit**

---

### Task 13: State Machine & Logic Fixes
**TORQUE provider:** codex
**Sequential — core state machine, cannot parallelize**

- [ ] **Step 1: Submit TORQUE task**

```
Fix state machine and logic bugs. IMPORTANT: these touch core task state transitions. Run tests after EACH change if possible.

1. server/database.js:1549 — tryClaimTaskSlot UPDATE lacks status guard.
   In the UPDATE statement's WHERE clause, add: `AND status IN ('queued', 'pending')`

2. server/handlers/workflow/advanced.js:399-404 — handleRetryWorkflowFrom resets running tasks.
   In the BFS loop, before resetting a task, check: `if (task.status === 'running') continue;`

3. server/handlers/task/operations.js:640 — handleBatchCancel double-counts.
   Use a Set to track cancelled task IDs: `const cancelledIds = new Set();`
   Only increment count when `cancelledIds.add(taskId)` returns a new entry.

4. server/handlers/task/project.js:893 — non-existent ErrorCodes.NOT_FOUND.
   Change to `ErrorCodes.RESOURCE_NOT_FOUND` (verify this exists in error-codes.js).

5. server/core-tools.js:79 — getToolNamesForTier returns null for tier 3+.
   Change to return a combined array of all tool names instead of null.

6. server/constants.js:38-42 — global regex stateful matching.
   Already fixed in Task 1 (removed /g flag). Verify it's done.

7. server/handlers/provider-handlers.js:450-454 — inconsistent return types.
   Always return an array. When providerName specified: `return [db.getHealthTrend(providerName, days)];`

8. server/orchestrator/response-parser.js:4 — regex fails on \r\n.
   Change `\n` to `\r?\n` in the fence extraction regex.

9. server/policy-engine/profile-store.js:63-70 — normalizeEnabled treats objects as true.
   Add check: `if (typeof value === 'object' && value !== null) return false;`

10. server/policy-engine/engine.js:702-714 — double-counts failed outcomes.
    Change logic so each outcome increments exactly one counter:
    if outcome === 'fail' && mode === 'warn': increment warned only (not failed)
    if outcome === 'fail' && mode === 'block': increment blocked only (not failed)
    if outcome === 'fail' && mode !== 'warn' && mode !== 'block': increment failed
```

- [ ] **Step 2: Run tests, commit**

---

### Task 14: Sprint 2 Verification

- [ ] **Step 1: Full test suite**
```bash
npx vitest run
```

- [ ] **Step 2: Server start + API check**

- [ ] **Step 3: Tag**
```bash
git tag sprint-2-complete
```

---

## Sprint 3: Security + Architectural Fixes

### Task 15: SQL Injection Fixes
**Provider:** Manual (Claude session) — security-critical
**Review gate:** `git diff` review after each fix

- [ ] **Step 1: Fix schema-tables.js SQL injection**

In `server/db/schema-tables.js`:
- Add a `VALID_TABLE_NAMES` Set at the top with all known table names
- In `ensureTableColumns`, validate: `if (!VALID_TABLE_NAMES.has(tableName)) throw new Error('Invalid table');`
- Add `VALID_COLUMN_DEF_PATTERN` regex check (import from database.js or duplicate)
- Validate column definitions before `ALTER TABLE`

- [ ] **Step 2: Fix remaining SQL interpolation issues**

Fix report issues #161 (schema.js), #162 (cost-tracking.js), #167 (schema-seeds.js), #30 (database.js), #127 (v2-analytics-handlers.js), #151 (v2-task-handlers.js ORDER BY whitelist).

- [ ] **Step 3: Run tests, commit**
```bash
git add -A && git commit -m "security: fix SQL injection vectors in schema, analytics, task handlers"
```

---

### Task 16: Path Traversal & Auth Fixes
**Provider:** Manual

- [ ] **Step 1: Fix agent path traversal** (report #516)

In `agent/index.js:245`, after computing `projectPath`, add:
```js
if (!isPathAllowed(projectPath, mergedConfig.project_root)) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Path outside project root' }));
  return;
}
```

- [ ] **Step 2: Fix agent auth** (reports #517, #518, #6)

Add `serverAuthenticate(req, res, mergedConfig)` check to `/probe`, `/peek/`, and `/certs` endpoints.

- [ ] **Step 3: Fix MCP default role** (report #340)

In `server/mcp/index.js:281-286`, change default role from `'operator'` to `'viewer'`.

- [ ] **Step 4: Fix remaining auth issues** (#114, #106, #136, #137)

- [ ] **Step 5: Run tests, commit**

---

### Task 17: Command Injection & Shell Safety
**Provider:** Manual

- [ ] **Step 1: Fix ollama-tools default to allowlist** (report #14 top25)
- [ ] **Step 2: Fix agent shell:true on Windows** (report #521)
- [ ] **Step 3: Fix agent env var injection** (report #522)
- [ ] **Step 4: Fix index.js PID interpolation** — use `execFileSync` (report #4)
- [ ] **Step 5: Fix pre-commit hook script injection** (report #253) — escape `checksText` in `server/handlers/validation/index.js:789`
- [ ] **Step 6: Fix verifyCommand validation** (report #473) — call `validateShellCommand()` before execution in `server/validation/auto-verify-retry.js:161`
- [ ] **Step 7: Run tests, commit**

---

### Task 18: Secret Exposure Fixes
**Provider:** Manual

- [ ] **Step 1: Mask secrets in webhook list** (report #163)
- [ ] **Step 2: Move Google AI key to header** (report #274)
- [ ] **Step 3: Log warning for plaintext agent secret** (report #476) — in `server/remote/agent-client.js`, add `if (!this.tls) logger.warn('Agent secret transmitted without TLS');`
- [ ] **Step 4: Set .env file permissions** (report #520) — in `cli/init.js:71`, add `fs.chmodSync(dest, 0o600);` after writeFileSync
- [ ] **Step 5: Run tests, commit**
```bash
git add -A && git commit -m "security: mask webhook secrets, move API key to header, env file permissions"
```

---

### Task 19: Event Loop Blocking — Architectural
**Provider:** Manual — requires design decisions

- [ ] **Step 1: Convert spawnSync to async spawn** (report #276/top25 #3)

In `server/providers/v2-cli-providers.js:156`, replace `spawnSync` with async `spawn`:
- Collect stdout/stderr via event listeners
- Return a Promise that resolves on 'close' event
- Respect timeout via `setTimeout` + `child.kill()`

- [ ] **Step 2: Fix N+1 queries in provider trends** (report #119/top25 #15)

Replace the triple-nested loop in `v2-governance-handlers.js:737` with a single SQL query:
```sql
SELECT provider, strftime('%Y-%m-%d', created_at) as day,
       COUNT(*) as total,
       SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
FROM tasks WHERE created_at > ? GROUP BY provider, day ORDER BY day
```

- [ ] **Step 3: Cache repeated DB queries in output-safeguards** (report #463)

At the top of `runOutputSafeguards`, cache the result:
```js
const _cachedFileChanges = db.getTaskFileChanges(taskId);
```
Pass it through or use a closure. Replace all 9 calls to `db.getTaskFileChanges(taskId)` with the cached value.

- [ ] **Step 4: Run tests, commit**

---

### Task 20: Race Conditions & Transaction Safety
**Provider:** Manual — most sensitive batch

- [ ] **Step 1: Convert tryClaimTaskSlot to db.transaction()** (report #35)

Replace manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` with:
```js
const claimTask = db.transaction((taskId, updates) => {
  // ... existing logic but wrapped in db.transaction()
});
```
Preserve the Sprint 2 status guard (`AND status IN ('queued','pending')`).

- [ ] **Step 2: Convert updateTaskStatus to db.transaction()** (report #36)

Same pattern — replace manual transaction management.

- [ ] **Step 3: Fix VRAM+slot race in host-management** (report #213)

Wrap VRAM check + workstation slot + host slot in single `db.transaction()`.

- [ ] **Step 4: Wire evaluation store db** (report #328)

In `server/policy-engine/engine.js` init function, add:
```js
const evaluationStore = require('./evaluation-store');
evaluationStore.setDb(db);
```

- [ ] **Step 5: Call shadow enforcer** (report #331)

In engine.js `evaluatePolicies`, call `enforceMode()` on each rule's mode before evaluation.

- [ ] **Step 6: Fix remaining race conditions** (#2, #3, #50, #52)

- [ ] **Step 7: Run tests, commit**

---

### Task 21: ReDoS Protection + Network Safety
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Add ReDoS protection and fix network safety issues.

REDOS PROTECTION:

1. Create a helper function in server/utils/safe-regex.js:

function isSafeRegex(pattern, maxLength = 200) {
  if (typeof pattern !== 'string' || pattern.length > maxLength) return false;
  // Reject patterns with nested quantifiers (common ReDoS source)
  if (/(\+|\*|\{)\s*(\+|\*|\{)/.test(pattern)) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

function safeRegexTest(pattern, input, timeoutMs = 100) {
  if (!isSafeRegex(pattern)) return false;
  try {
    const regex = new RegExp(pattern, 'i');
    return regex.test(input);
  } catch { return false; }
}

module.exports = { isSafeRegex, safeRegexTest };

2. server/db/provider-routing-core.js:639 — use safeRegexTest instead of raw new RegExp
3. server/providers/ollama-tools.js:401 — use safeRegexTest for search_files
4. server/orchestrator/deterministic-fallbacks.js:80 — use safeRegexTest for custom patterns
5. server/db/host-complexity.js:49-126 — pre-compile all regex patterns at module load:
   `const COMPILED_DOC_PATTERNS = docPatterns.map(p => new RegExp(p));`

NETWORK SAFETY:

6. server/handlers/shared.js:97 — add IP encoding bypass detection to isInternalHost:
   Add check for decimal IPs: `if (/^\d+$/.test(bareHostname)) return true;`
   Add check for hex IPs: `if (/^0x/i.test(bareHostname)) return true;`
   Add check for octal: `if (/^0\d/.test(bareHostname)) return true;`

7. server/handlers/shared.js:95 — fix ULA check:
   Change: `bareHostname.startsWith('fd')`
   To: `bareHostname.match(/^fd[0-9a-f]{2}:/i)`

8. server/handlers/webhook-handlers.js:1040 — add isInternalHost check before Slack webhook fetch
9. server/handlers/webhook-handlers.js:1100 — same for Discord webhook
10. server/api/v2-governance-handlers.js:421 — validate action against Set:
    `const VALID_ACTIONS = new Set(['pause', 'resume', 'retry']); if (!VALID_ACTIONS.has(action)) return sendError(...);`
```

- [ ] **Step 2: Run tests, commit**

---

### Task 22: Sprint 3 Verification

- [ ] **Step 1: Full test suite**
- [ ] **Step 2: Security-focused review of all Sprint 3 diffs**
```bash
git diff sprint-2-complete..HEAD --stat
git diff sprint-2-complete..HEAD -- agent/
git diff sprint-2-complete..HEAD -- server/mcp/
git diff sprint-2-complete..HEAD -- server/db/
```
- [ ] **Step 3: Tag**
```bash
git tag sprint-3-complete
```

---

## Sprint 4: Test Quality + Dashboard + UX

### Task 23: Fix Always-Passing Tests
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Fix tests that always pass with expect(true).toBe(true).

1. server/tests/task-manager.test.js — Find ALL instances of the pattern:
   `if (typeof tm.someFunction === 'function') { ... } else { expect(true).toBe(true); }`

   For each one: the function IS exported from task-manager.js. Remove the typeof guard
   and keep only the real assertion. If the function is truly not exported, mark the test
   as `.todo('someFunction not exported — needs refactor to test')`.

   There should be ~18 instances covering: isValidFilePath, isShellSafe,
   extractModifiedFiles (7 tests), detectSuccessFromOutput (9 tests), estimateRequiredContext.

2. server/tests/tda-01-provider-sovereignty.test.js — Find the 3 tests with only
   `expect(true).toBe(true)` and comments like "Placeholder — verified via grep".
   Either write a real assertion or change to `it.todo('description')`.

3. server/tests/process-lifecycle.test.js — Find tests that return expect(true).toBe(true)
   on Windows. Add `.todo()` marker instead, or implement Windows-specific assertions.
```

- [ ] **Step 2: Run tests (some may now correctly fail — fix the underlying code)**
- [ ] **Step 3: Commit**

---

### Task 24: Fix Overly Permissive Test Assertions
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Fix tests with overly permissive assertions.

1. server/tests/e2e-fallback-recovery.test.js:37-53 — the try/catch swallows assertion failures.
   Remove the try/catch or use expect().rejects pattern. The test should assert a specific
   expected status, not accept 3 of 5 possible statuses.

2. server/tests/e2e-cli-providers.test.js:111,133,191,237 — early returns skip all assertions.
   Remove `if (startResult && startResult.queued) return;` — instead test the queued behavior:
   `if (startResult?.queued) { expect(task.status).toBe('queued'); return; }`

3. server/tests/e2e-cli-providers.test.js:150 — Aider test accepts ANY status and doesn't
   verify provider. Add: `expect(task.provider).toBe('aider-ollama');`

4. server/tests/adaptive-retry.test.js:96-99 — conditional assertion.
   Add: `expect(results.length).toBeGreaterThan(0);` before the conditional.

5. server/tests/e2e-post-task-validation.test.js:114 — regex defined inline.
   Import the actual pattern from the source module instead of defining a copy.

6. server/tests/e2e-post-task-validation.test.js:167-190 — tautological baseline test.
   Replace the math-identity test with an actual call to the TORQUE baseline comparison function.
```

- [ ] **Step 2: Run tests, commit**

---

### Task 25: Fix Mocks + Flaky Tests
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Fix mock issues and flaky test patterns.

MOCK FIXES:

1. server/tests/mocks/ollama.js:80 — inverted default streaming.
   Real Ollama defaults to streaming. Change: if stream is NOT explicitly false, use streaming mode.

2. server/tests/mocks/ollama.js — add /api/chat endpoint handler (currently only /api/generate exists).

3. server/tests/e2e-cli-providers.test.js:36-37 — spawn mock only captures last child.
   Change: `spawnMock._lastChild = child` to `spawnMock._children = spawnMock._children || []; spawnMock._children.push(child); spawnMock._lastChild = child;`

FLAKY FIXES:

4. server/tests/e2e-hashline-ollama.test.js:23-31 — tight 15ms polling with 5s timeout.
   Increase timeout to 10000ms. Use a helper that checks more frequently but with longer overall timeout.

5. server/tests/remote/integration.test.js:212 — fixed 200ms sleep.
   Replace with a polling helper: `await waitFor(() => someCondition, { timeout: 5000 });`

6. server/tests/adaptive-scoring.test.js:88-102 — test order dependency.
   Move the data setup from the dependent tests into the test's own beforeEach.
```

- [ ] **Step 2: Run tests 3x to verify stability**
```bash
npx vitest run && npx vitest run && npx vitest run
```
- [ ] **Step 3: Commit**

---

### Task 26: Dashboard Polling + Accessibility
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Optimize dashboard polling and fix accessibility.

POLLING:

1. dashboard/src/views/PlanProjects.jsx:534 — change 5000 to 30000
2. dashboard/src/views/Approvals.jsx:40 — change 10000 to 30000
3. dashboard/src/views/FreeTier.jsx:228 — change 10000 to 30000
4. dashboard/src/views/Schedules.jsx:44 — change 15000 to 60000

5. In ALL views with setInterval polling, add a visibility check:
   Before the fetch inside the interval callback, add:
   `if (document.hidden) return;`

ACCESSIBILITY:

6. In History.jsx, Workflows.jsx, and any view with <select> elements for filtering:
   Add aria-label to each: `<select aria-label="Filter by status" ...>`

7. dashboard/src/views/PlanProjects.jsx:356 — ImportModal: add onClick to backdrop div:
   `<div className="fixed inset-0 ..." onClick={() => setShowImportModal(false)}>`
   Add inner div with `onClick={e => e.stopPropagation()}` to prevent closing on content click.

8. (clipboard .catch already handled in Task 12 — skip here)

9. dashboard/src/components/Layout.jsx:244-248 — fix keyboard nav guard:
   Change `num <= 8` to `num <= routes.length`
```

- [ ] **Step 2: Run tests, commit**

---

### Task 27: API Design Consistency
**TORQUE provider:** codex

- [ ] **Step 1: Submit TORQUE task**

```
Fix API design consistency issues.

1. server/api/v2-dispatch.js:99-354 — dispatch handlers use raw res.writeHead without security headers.
   For each handler in V2_CP_HANDLER_LOOKUP that uses:
     `res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({...}));`
   Replace with the sendJson helper from middleware.js:
     `const { sendJson } = require('./middleware'); sendJson(res, data, 200, req);`
   This automatically adds security headers and CORS.

2. Find all sendError calls missing the `req` parameter (7th argument).
   In these files: v2-workflow-handlers.js, v2-governance-handlers.js, v2-analytics-handlers.js.
   Add `req` as the final argument to each sendError call.
   Pattern: `sendError(res, requestId, code, message, status)` -> `sendError(res, requestId, code, message, status, undefined, req)`

3. server/api/v2-workflow-handlers.js:54 — use 201 for handleAddWorkflowTask (resource creation).
   Change: `sendSuccess(res, requestId, data, 200, req)` to `sendSuccess(res, requestId, data, 201, req)`
```

- [ ] **Step 2: Run tests, commit**

---

### Task 28: Sprint 4 Final Verification

- [ ] **Step 1: Full test suite (run 3x for stability)**
```bash
npx vitest run && npx vitest run && npx vitest run
```

- [ ] **Step 2: Server start + full API check**
```bash
curl -s http://127.0.0.1:3457/api/v2/providers
curl -s http://127.0.0.1:3458/sse
```

- [ ] **Step 3: Final tag**
```bash
git tag sprint-4-complete
git tag bug-hunt-remediation-complete
```

---

## Execution Summary

| Task | Sprint | Provider | Depends On | Parallel Group |
|------|--------|----------|------------|----------------|
| 1 | 1 | codex | — | — (sequential) |
| 2 | 1 | codex | 1 | — (sequential) |
| 3 | 1 | codex | 2 | — (sequential) |
| 4 | 1 | manual | 3 | — |
| 5 | 1 | codex | 4 | B (sequential subtasks) |
| 6 | 1 | manual | 5 | — |
| 7 | 2 | codex | 6 | C |
| 8 | 2 | codex | 6 | C |
| 9 | 2 | codex | 6 | C |
| 10 | 2 | codex | 6 | D |
| 11 | 2 | codex | 6 | D |
| 12 | 2 | codex | 6 | D |
| 13 | 2 | codex | 7-12 | — (sequential) |
| 14 | 2 | manual | 13 | — |
| 15 | 3 | manual | 14 | — |
| 16 | 3 | manual | 15 | E |
| 17 | 3 | manual | 15 | E |
| 18 | 3 | manual | 15 | E |
| 19 | 3 | manual | 16-18 | — |
| 20 | 3 | manual | 19 | — (sequential) |
| 21 | 3 | codex | 20 | — |
| 22 | 3 | manual | 21 | — |
| 23 | 4 | codex | 22 | F |
| 24 | 4 | codex | 22 | F |
| 25 | 4 | codex | 23,24 | — |
| 26 | 4 | codex | 25 | G |
| 27 | 4 | codex | 25 | G |
| 28 | 4 | manual | 26,27 | — |

**Parallel groups:** Tasks within the same group can run simultaneously.

## Known Spec Deviations

1. **Codex now available** — spec was written when codex was disabled. All TORQUE tasks route to codex instead of hashline-ollama/groq.
2. **Tasks 1-3 serialized** — spec suggested parallel Groups A/B, but review found file conflicts (index.js, constants.js, operations.js shared across batches). Sequential is safer.
3. **`_buildPrompt` extraction deferred** — spec Batch 1.5 included this, but per-provider differences require manual review first.
4. **3 Batch 2.4b issues deferred** — report #11 (processQueue redundant check), #19 (tryCreateAutoPR re-transition), #21 (misleading API key warning) are low-risk and deferred to a cleanup pass.
5. **7 dashboard fixes from Batch 2.5 consolidated** — reports #398, #399, #402, #51, #67, #70, #48 are covered by Task 12's general dashboard fix task description (codex will find and fix all issues in the referenced files).
6. **Spec Batch 3.4 issues #476, #520 and Batch 3.5 issues #253, #473** — low-severity, added to Task 18 scope below.
