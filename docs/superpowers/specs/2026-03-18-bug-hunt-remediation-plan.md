# Bug Hunt Remediation Plan

**Date:** 2026-03-18
**Input:** `docs/bug-hunt-report.md` (601 issues across 10 codebase layers)
**Execution model:** Hybrid — TORQUE batches for mechanical fixes, manual Claude sessions for architectural/security changes
**Available providers:** claude-cli, ollama (local), hashline-ollama, aider-ollama, groq, cerebras, google-ai, openrouter, ollama-cloud
**Unavailable:** codex, anthropic, deepinfra, hyperbolic

---

## Strategy: Risk-Bucketed Sprints

4 sprints ordered by blast radius. Each sprint is independently shippable.

| Sprint | Theme | Issues | TORQUE | Manual | Primary Providers |
|--------|-------|--------|--------|--------|-------------------|
| **1** | Safe mechanical fixes | ~158 | ~138 | ~20 | hashline-ollama, groq, claude-cli |
| **2** | Behavior-changing (testable) | ~158 | ~88 | ~70 | claude-cli, groq, openrouter |
| **3** | Security + architectural | ~105 | ~30 | ~75 | Manual, hashline-ollama, groq |
| **4** | Test quality + dashboard + UX | ~100 | ~60 | ~40 | claude-cli, groq, hashline-ollama |
| | **Deferred / Won't Fix** | ~90 | — | — | — |

### Sprint Definition

- **Sprint 1:** Cannot break anything. Adding null checks, replacing `||` with `??`, removing dead code, extracting duplicated functions. Pure additive safety or dead code removal.
- **Sprint 2:** Changes observable behavior. Each fix requires a companion test or existing test update. Math bugs, unit mismatches, parameter binding, config fixes.
- **Sprint 3:** Requires human judgment. SQL injection, path traversal, auth, race conditions, transaction safety. Mostly manual with TORQUE for mechanical validation additions.
- **Sprint 4:** Quality polish. Fix always-passing tests, dashboard UX, API consistency, polling optimization.

### Verification Protocol

After each batch within a sprint:
```
npx vitest run
```

After each sprint is complete:
```
1. npx vitest run                              # all tests pass
2. node server/index.js                        # server starts clean
3. curl http://127.0.0.1:3457/api/v2/providers # API responds
4. curl http://127.0.0.1:3458/sse              # MCP SSE connects
5. git diff --stat                             # review all changes
```

---

## Sprint 1: Safe Mechanical Fixes (~160 issues)

### Batch 1.1: Falsy Value Fixes — `||` to `??` (22 issues)
**Provider:** hashline-ollama
**Pattern:** `x || default` where `0`, `""`, or `false` are valid values.

| Report # | File | Line | Fix |
|----------|------|------|-----|
| 17 | server/task-manager.js | 1145 | `task.retry_count || 0` -> `task.retry_count ?? 0` |
| 31 | server/providers/config.js | 220 | `parseFloat(temperature) || 0.3` -> NaN-check then `?? 0.3` |
| 149 | server/api/v2-control-plane.js | 81 | `timeout_minutes || null` -> `timeout_minutes ?? null` |
| 224 | server/handlers/task/pipeline.js | 305 | `originalTask.priority + 1` -> `(originalTask.priority ?? 0) + 1` |
| 255 | server/handlers/validation/index.js | 838 | `parseInt(args.days) || 30` -> NaN-safe with `??` |
| 28 | server/policy-engine/evaluation-store.js | 176 | `options.limit || 50` -> `options.limit ?? 50` |
| 135 | server/api/v2-audit-handlers.js | 47 | `body.dry_run || false` -> `body.dry_run ?? false` |
| 220 | server/handlers/task/operations.js | 121 | `args.wait_seconds || 5` -> `args.wait_seconds ?? 5` + max clamp |
| + 12 more | Various | | Same `||` -> `??` pattern |

**Note:** Issue #95 (success rate precedence) is NOT a `||` -> `??` fix — it requires parenthesization. Assigned exclusively to Batch 2.1.

### Batch 1.2: Missing Null/Undefined Guards (28 issues)
**Provider:** hashline-ollama or groq

Add `?.` optional chaining or explicit null checks before property access.

| Report # | File | Line | Fix |
|----------|------|------|-----|
| 14 (misc) | server/validation/close-phases.js | 180 | `buildResult.error.substring` -> `buildResult.error?.substring` |
| 19 (misc) | server/validation/close-phases.js | 381 | `dashboard.notifyTaskUpdated` -> `dashboard?.notifyTaskUpdated` |
| 23 (misc) | server/validation/safeguard-gates.js | 37 | Add `if (!deps.db) return` guard |
| 91 | server/api-server.core.js | 498 | `provider.enabled` -> `provider?.enabled` |
| 146 | server/api/webhooks.js | 141 | `actionConfig.task_description` -> `actionConfig?.task_description` |
| 227 | server/handlers/task/project.js | 163 | Add `if (!args.task_description)` validation |
| 234 | server/handlers/workflow/templates.js | 139 | `template.dependency_graph[...]` -> `template.dependency_graph?.[...]` |
| 242 | server/handlers/provider-handlers.js | 27 | Add null check on `db.approveProviderSwitch` return |
| 243 | server/handlers/provider-handlers.js | 57 | Add null check on `db.rejectProviderSwitch` return |
| 246 | server/handlers/task/operations.js | 510 | `s.name.slice` -> `(s.name || '').slice` |
| + 18 more | Various | | Same pattern |

### Batch 1.3: Missing try/catch on JSON.parse & fs Operations (18 issues)
**Provider:** groq or cerebras

| Report # | File | Fix |
|----------|------|-----|
| 170 | server/db/workflow-engine.js:520 | Wrap `JSON.parse(t.tags)` in try/catch with fallback |
| 171 | server/db/workflow-engine.js:545 | Same for `getBlockedTasks` |
| 233 | server/handlers/workflow/await.js:607 | Wrap `JSON.parse(task.files_modified)` |
| 338 | server/mcp/schema-registry.js:20 | Wrap each schema file parse individually |
| 287 | server/routing/template-store.js:41 | Wrap preset JSON.parse, log and skip invalid |
| 13 (core) | server/task-manager.js:527 | Wrap `fs.readFileSync` in try/catch |
| 49 (misc) | server/ci/github-actions.js:54 | Wrap `JSON.parse(stdout)` |
| 286 | server/providers/adapters/openai-chat.js:123 | Wrap `JSON.parse(tc.function.arguments)` |
| + 10 more | Various | Same pattern |

### Batch 1.4: Dead Code Removal (16 issues)
**Provider:** hashline-ollama

| Report # | File | Remove |
|----------|------|--------|
| 2 (misc) | server/validation/completion-detection.js:14 | Dead import `_unused` |
| 3 (misc) | server/utils/hashline-parser.js:699 | Dead variable `_trailingEmptyLines` |
| 11 (misc) | server/utils/backoff.js:19-29 | Unused `factorial` export |
| 26 | server/database.js:664-677 | Dead second query in `resolveTaskId` |
| 30 (prov) | server/providers/registry.js:117 | Unused `_db` variable |
| 64 | server/benchmark.js:662 | Dead `showFull` parameter path |
| 67 | server/chunked-review.js:53 | Duplicate regex pattern |
| 71 | server/chunked-review.js:492 | Duplicate JSDoc block |
| 88 | server/benchmark.js:66-78 | Dead `_DESKTOP_MODELS`, `_LAPTOP_MODELS` |
| 6 (core) | server/index.js:165 | Dead `_generateRequestId` function |
| 14 (core) | server/task-manager.js:570 | Redundant `const fs = require('fs')` |
| 20 (core) | server/task-manager.js:937 | Redundant inline `require('child_process')` |
| 86 (core) | server/task-manager.js:853 | Redundant inline `require('./execution/process-lifecycle')` |
| + 3 more | Various | |

### Batch 1.5: Extract Duplicated Utilities (8 tasks, multi-file)
**Provider:** claude-cli

| Report # | Utility | Source Files | Target |
|----------|---------|-------------|--------|
| 193 | `safeJsonParse` (7 copies) | database.js, workflow-engine.js, coordination.js, host-management.js, scheduling-automation.js, analytics.js, provider-routing-core.js | `server/utils/json.js` |
| 271 | `buildErrorMessage` (5 copies) | cerebras.js, groq.js, anthropic.js, deepinfra.js, hyperbolic.js | `server/providers/shared.js` |
| 272 | `_buildPrompt` (8 copies) | All 8 API providers | `server/providers/shared.js` |
| 221 | `formatTime` (2 copies) | handlers/shared.js, handlers/task/utils.js | Remove from task/utils.js, import from shared |
| 24-26 (cli) | `readPid`/`cleanPidFile`/constants | cli/start.js, cli/stop.js | New `cli/shared.js` |
| 387 | `STATUS_COLORS` (5 copies) | 4 dashboard views + constants.js | Import from `dashboard/src/constants.js` |
| 388 | `PROVIDER_COLORS` (4 copies) | 4+ dashboard views | Add to `dashboard/src/constants.js` |
| 406 | `buildProviderOptions` (3 copies) | Kanban.jsx, History.jsx, TaskDetailDrawer.jsx | Extract to `dashboard/src/utils/providers.js` |

### Batch 1.6: Resource Leak Fixes (14 issues)
**Provider:** hashline-ollama

| Report # | File | Fix |
|----------|------|-----|
| 1 (core) | server/index.js:96 | Add `.unref()` to pidHeartbeatInterval + 5 others |
| 8 (misc) | server/utils/tsserver-client.js:679 | Add `.unref()` to idle check interval |
| 15 (misc) | server/hooks/event-dispatch.js:343 | Store initial timer handle for cancellation |
| 94 | server/api/health-probes.js:57 | Clear timeout on successful health resolve |
| 256 | server/handlers/shared.js:611 | Add periodic prune to idempotency cache (not just size-based) |
| 81 (core) | server/index.js:217 | Add `.unref()` to errorRateCleanupInterval |
| 22 (misc) | server/utils/credential-crypto.js:82 | Handle EEXIST race in key file creation |
| + 7 more | Various | clearTimeout in catch blocks, timer tracking |

### Batch 1.7: Miscellaneous Safe Fixes (14 issues)
**Provider:** hashline-ollama + groq

| Report # | File | Fix |
|----------|------|-----|
| 44 | server/constants.js:59 | Add unit comments to all timeout constants |
| 47 | server/api-server.js:5-7 | Remove void statements, add explanatory comments |
| 58 | server/api-server.core.js:224 | Remove duplicated `PROVIDER_API_KEY_ENV_KEYS` |
| 74 | server/core-tools.js:83 | `CORE_TOOL_NAMES = [...TIER_1]` (copy not reference) |
| 77 | server/constants.js:86 | Add `'codex-spark': 30` to PROVIDER_DEFAULT_TIMEOUTS |
| 100 | server/api/v2-control-plane.js:14 | Remove unused `SECURITY_HEADERS` constant |
| 147 | server/api/v2-router.js:30 | Remove duplicated `validateDecodedParamField` |
| 148 | server/api/v2-router.js:26 | Remove duplicated `buildV2Middleware` |
| 237 (handlers) | server/handlers/task/pipeline.js:22 | Remove barely-used `isQueuedStartResult` |
| 260 (handlers) | server/handlers/concurrency-handlers.js:60 | Use `db.*` methods instead of raw `db.prepare()` |
| + 4 more | Various | |

### Sprint 1 Dependency Graph

**File conflict note:** `server/task-manager.js` is touched by batches 1.1, 1.3, and 1.4. `server/handlers/task/operations.js` is touched by 1.1 and 1.2. To avoid merge conflicts, group 1 (1.1+1.4) and group 2 (1.2+1.3) run in parallel, but within each group files are serialized per-TORQUE-task.

```
Group A: Batch 1.1 (||->??) + 1.4 (dead code)  --+-- parallel groups
Group B: Batch 1.2 (null guards) + 1.3 (try/catch) --+
         |
    vitest run (verify)
         |
Batch 1.5 (dedup)     --- sequential (multi-file, potential conflicts)
         |
    vitest run (verify)
         |
Batch 1.6 (timers)    --+-- parallel
Batch 1.7 (misc)      --+
         |
    vitest run (verify)
         |
    git commit "sprint-1: safe mechanical fixes (~160 issues)"
```

**Conflict mitigation:** Each TORQUE task within a batch should target ONE file. If two batches in the same group need to edit the same file (e.g., task-manager.js), consolidate those edits into a single task in one batch and skip the file in the other.

---

## Sprint 2: Behavior-Changing Fixes (~150 issues)

### Batch 2.1: Unit/Math Bugs (12 issues)
**Provider:** claude-cli — each fix requires a companion test

| Report # | File | Bug | Fix |
|----------|------|-----|-----|
| 51 | server/api-server.core.js:330 | Timeout minutes * 1000 (should be * 60000) | `safeSeconds * 60 * 1000` + test |
| 95 | server/api/v2-analytics-handlers.js:58 | Operator precedence in success rate | `((completed + failed) || 1)` + test |
| 128 | server/api/v2-analytics-handlers.js:218 | Running average vs weighted average | Track totalDuration/totalTasks + test |
| 230 | server/handlers/task/project.js:848 | ForecastCosts division by zero | Clamp denominator + test |
| 61 | server/benchmark.js:210 | `tokensPerSecond` when evalDuration=0 | Guard: `evalDuration > 0 ? ... : 0` + test |
| 244 | server/handlers/provider-handlers.js:511 | Percentile off-by-one | `Math.min(arr.length - 1, ...)` + test |
| 9 (orch) | server/orchestrator/deterministic-fallbacks.js:161 | Score can go negative | `Math.max(0, Math.min(100, score))` + test |
| 70 | server/chunked-review.js:357 | Overlap double-counts tokens | Subtract overlap from estimate + test |
| 345 | server/economy/triggers.js:13 | 30-day month for budgets | Calendar month boundaries + test |
| 54 | server/api-server.core.js:1206 | Timeout cap 600s too low | Raise to 1800000ms (30 min) + test |
| 109 | server/api/v2-inference.js:299 | Inconsistent timeout units | Normalize both paths + test |

### Batch 2.2: Parameter Binding & Query Bugs (9 issues)
> Issue #151 (orderBy unsanitized) moved to Batch 3.1 (SQL injection) — it's a security fix, not just a behavior change.
**Provider:** claude-cli

| Report # | File | Bug | Fix |
|----------|------|-----|-----|
| 174-176 | server/db/audit-store.js:152,357,470 | `.run(params)` -> `.run(...params)` | Spread operator + tests |
| 211 | server/db/workflow-engine.js:1098 | LIKE on JSON, unparameterized | Parameterized query + test |
| 62 | server/benchmark.js:551 | Type-coerced hostId equality | `String()` both sides + test |
| 120 | server/api/v2-governance-handlers.js:174 | O(n) scan for schedule | Direct `WHERE id = ?` + test |
| 191 | server/db/workflow-engine.js:1017 | LIKE metachar escaping | Escape `%`, `_` + test |
| 166 | server/db/audit-store.js:297 | LIKE injection in getFindings | Same escaping + test |
| 245 | server/handlers/provider-handlers.js:494 | Wrong date filter param name | Match listTasks API + test |

### Batch 2.3: Config System Fixes (8 issues)
**Provider:** claude-cli — must update config.test.js

| Report # | File | Bug | Fix |
|----------|------|-----|-----|
| 39 | server/config.js:111 | `String(entry.default)` booleans | Return typed default |
| 41 | server/config.js:149 | Unknown keys default true | Default false |
| 78 | server/config.js:120 | `getInt` ignores fallback | Pass fallback to `get()` |
| 40 | server/config.js:158 | `isOptIn` fragile comparison | Use `getBool()` internally |
| 48 | server/api-server.core.js:1074 | CORS hardcoded port 3456 | Dynamic from config |
| 200 | server/db/host-management.js:54 | getConfig bypasses encryption | Use database.getConfig() |
| 42 (misc) | server/db/provider-routing-core.js:65 | Same bypass | Same fix |
~~| 77 | server/constants.js:86 | Missing codex-spark timeout | Add entry |~~ (Already in Batch 1.7, removed here)

### Batch 2.4: Provider/Routing Behavior Fixes (14 issues)
**Provider:** claude-cli (complex) + groq (simple)

| Report # | File | Bug | Fix |
|----------|------|-----|-----|
| 291 | server/providers/v2-local-providers.js:459 | Default port 80 not 11434 | `port: parsedUrl.port || 11434` |
| 281 | server/providers/execution.js:451 | Host slot decrement without increment | Add `tryReserveHostSlotWithFallback` |
| 283 | server/providers/execution.js:511 | Non-exported `_apiAbortControllers` | Export or use DI |
| 284 | server/providers/execution.js:964 | Fallback reverts all changes | Pass task description |
| 278 | server/providers/execute-api.js:329 | Mutates shared task object | Clone before mutation |
| 285 | server/providers/adapters/google-chat.js:80 | Only tracks first tool call | Track per-call |
| 111 | server/api/v2-inference.js:575 | requestId passed as status | Pass correct field |
| 110 | server/api/v2-inference.js:522 | Wrong error code for async | `'async_not_supported'` |
| 289 | server/routing/category-classifier.js:65 | REASONING_RE too broad | Tighten pattern |
| 280 | server/providers/config.js:279 | Missing opt-in providers | Add entries |
| 458 | server/utils/safe-env.js:36 | Missing 3 provider keys | Add cerebras, openrouter, ollama-cloud |
| 457 | server/utils/safe-exec.js:54 | `||` treated as `&&` | Handle OR semantics |
| 273 | server/providers/cerebras.js:247 | Hardcoded listModels | Fetch from API + fallback |
| 346 | server/economy/queue-reroute.js:163 | Economy deactivation no-op | Restore original_provider |

### Batch 2.4b: Missing Critical Behavior Bugs (8 issues)
**Provider:** claude-cli
**Note:** These were identified in spec review as missing from original plan.

| Report # | File | Bug | Fix |
|----------|------|-----|-----|
| 138/16(top25) | server/api/v2-dispatch.js:35 | `readJsonBody` string concat breaks multi-byte UTF-8 | Use `Buffer.concat(chunks).toString('utf8')` + test |
| 22 (core) | server/task-manager.js:1494 | startTask mutates DB-returned task object | Clone task before mutation + test |
| 23 (core) | server/task-manager.js:1467 | startTask doesn't release slot on routing errors | Add slot release in catch path + test |
| 25 (core) | server/task-manager.js:2011 | Wrong timeout constant (FILE_WRITE vs GIT_STATUS) | Use TASK_TIMEOUTS.GIT_STATUS + test |
| 68 | server/chunked-review.js:61 | Brace counting ignores string literals | Track `inString` state for `{` counting + test |
| 19 (core) | server/task-manager.js:810 | tryCreateAutoPR re-transitions completed task | Use updateTask for pr_url field instead + test |
| 11 (core) | server/task-manager.js:1856 | processQueue redundant double-check | Remove dead code branch + test |
| 21 (core) | server/task-manager.js:1208 | Misleading API key warning | Only warn when provider requires OPENAI/ANTHROPIC key |

### Batch 2.5: Dashboard Behavior Fixes (18 issues)
**Provider:** groq or openrouter

| Report # | File | Bug | Fix |
|----------|------|-----|-----|
| 383 | dashboard/src/components/EconomyIndicator.jsx:32 | Wrong API prefix | Use `requestV2()` |
| 389 | dashboard/src/views/Hosts.jsx:33 | VramBar division by zero | Guard `total <= 0` |
| 390 | dashboard/src/views/Hosts.jsx:17 | CapacityBar NaN | `(running || 0)` |
| 391 | dashboard/src/components/TaskDetailDrawer.jsx:927 | DiffTab null crash | `diff?.status` |
| 394-395 | dashboard/src/views/History.jsx:168,734 | Pagination broken | Compute totalPages from `Math.ceil(total/limit)` |
| 384 | dashboard/src/api.js:59 | AbortSignal fallback | Manual signal forwarding |
| 402 | dashboard/src/views/Strategy.jsx:434 | Response shape assumed | Defensive unwrap |
| 397 | dashboard/src/views/History.jsx:369 | Bulk ops sequential | `Promise.allSettled` |
| 48 (api) | dashboard/src/api.js:134,273,285,350 | Mixed legacy/v2 paths | Migrate to requestV2 |
| 398 | dashboard/src/components/WorkflowDAG.jsx:103 | Wheel blocks scroll | Conditional preventDefault |
| 399 | dashboard/src/components/WorkflowDAG.jsx:113 | Drag on container | Attach to window |
| 51 (dash) | dashboard/src/views/Approvals.jsx:24 | Stats always 0 | Fetch on mount |
| 58 (dash) | dashboard/src/views/History.jsx:86 | "This Week" mislabeled | Rename to "Last 7 Days" |
| 67 (dash) | dashboard/src/views/Budget.jsx:231 | Dead "Daily" label | Remove conditional |
| 70 (dash) | dashboard/src/views/Kanban.jsx:62 | Inconsistent sort | Use `updated_at` |
| 37 (dash) | dashboard/src/views/Models.jsx:20 | Shadowed formatDuration | Import from formatters |
| 38 (dash) | dashboard/src/views/Providers.jsx:247 | Shadowed formatDate | Import from formatters |

### Batch 2.6: State Machine & Logic Bugs (12 issues)
**Provider:** claude-cli — sequential execution, core state changes

| Report # | File | Bug | Fix |
|----------|------|-----|-----|
| 177 | server/database.js:1549 | tryClaimTaskSlot no status guard | `AND status IN ('queued','pending')` |
| 265 | server/handlers/workflow/advanced.js:399 | Resets running tasks | Skip running status |
| 216 | server/handlers/task/operations.js:640 | Double-count in batchCancel | Track unique IDs |
| 215 | server/handlers/task/project.js:893 | Non-existent error code | `ErrorCodes.RESOURCE_NOT_FOUND` |
| 73 | server/core-tools.js:79 | Returns null for tier 3 | Return full array |
| 16 | server/task-manager.js:358 | Wrong resolver reference | Filter `wrappedResolve` |
| 10 | server/task-manager.js:1858 | Timer leak in processQueue | Clear before set |
| 45 | server/constants.js:38 | Global regex stateful matching | Remove `/g` flag |
| 261 | server/handlers/provider-handlers.js:450 | Inconsistent return type | Always return array |
| 321 | server/orchestrator/response-parser.js:4 | Fails on `\r\n` | Use `\r?\n` |
| 329 | server/policy-engine/profile-store.js:63 | Objects treated as enabled | Add type check |
| 330 | server/policy-engine/engine.js:702 | Double-count failed outcomes | Count each category exclusively |

### Sprint 2 Dependency Graph

```
Batch 2.1 (math)     --+
Batch 2.2 (queries)  --+-- parallel (different files)
Batch 2.3 (config)   --+
         |
    vitest run (verify)
         |
Batch 2.4 (providers)  --+
Batch 2.4b (critical)  --+-- parallel (different files)
Batch 2.5 (dashboard)  --+
         |
    vitest run (verify)
         |
Batch 2.6 (state/logic) -- sequential (core state machine)
         |
    vitest run (verify)
         |
    git commit "sprint-2: behavior fixes with test coverage (~158 issues)"
```

**Note on benchmark.js conflict:** Issues #61 (Batch 2.1) and #62 (Batch 2.2) both modify `server/benchmark.js`. Consolidate both fixes into a single task in Batch 2.1 and skip benchmark.js in Batch 2.2.

---

## Sprint 3: Security + Architectural Fixes (~100 issues)

### Batch 3.1: SQL Injection (9 issues)
**Provider:** Manual (Claude session) — security-critical, full diff review

| Report # | File | Vulnerability | Fix |
|----------|------|--------------|-----|
| 159 | server/db/schema-tables.js:19 | Table name in PRAGMA | Whitelist validation |
| 160 | server/db/schema-tables.js:31 | Column def in ALTER | VALID_COLUMN_DEF_PATTERN check |
| 161 | server/db/schema.js:35 | Fallback safeAddColumn | Delegate to database.js |
| 162 | server/db/cost-tracking.js:311 | dateFormat interpolation | Strict enum or parameterize |
| 167 | server/db/schema-seeds.js:595 | `now` in INSERT | Parameter binding |
| 30 | server/database.js:1276 | `${table}` in DELETE | Freeze childTables Set |
| 127 | server/api/v2-analytics-handlers.js:191 | Direct db.prepare | Use abstraction |
| 189 | server/db/inbound-webhooks.js:148 | maxAgeDays in SQL | parseInt guard |
| 151 | server/api/v2-task-handlers.js:236 | orderBy unsanitized | Column whitelist |

### Batch 3.2: Path Traversal & SSRF (7 issues)
**Provider:** Manual

| Report # | File | Vulnerability | Fix |
|----------|------|--------------|-----|
| 516 | agent/index.js:245 | /sync project path traversal | Add isPathAllowed check |
| 518 | agent/index.js:420 | /peek/ proxy no auth | Add serverAuthenticate |
| 519 | agent/index.js:261 | Arbitrary repo_url | Validate URL scheme |
| 125 | server/api/v2-infrastructure-handlers.js:192 | Toggle host SSRF | Add isInternalHost check |
| 238 | server/handlers/task/operations.js:967 | Export write anywhere | Restrict to project/temp |
| 20 (prov) | server/providers/ollama-tools.js:141 | Windows UNC bypass | UNC path detection |
| 107 | server/api/webhooks.js:51 | Prototype chain access | hasOwnProperty check |

### Batch 3.3: Authentication & Authorization (7 issues)
**Provider:** Manual

| Report # | File | Vulnerability | Fix |
|----------|------|--------------|-----|
| 340 | server/mcp/index.js:281 | Missing role defaults to operator | Default to viewer |
| 114 | server/api/middleware.js:256 | checkAuth ignores Bearer | Check both headers |
| 517 | agent/index.js:399 | /probe no auth | Add serverAuthenticate |
| 6 (cli) | agent/index.js:406 | /certs no auth | Add serverAuthenticate |
| 136 | server/api/v2-infrastructure-handlers.js:71 | Secret stored plaintext | Hash before storing |
| 137 | server/api/v2-infrastructure-handlers.js:436 | Agent secret plaintext | Hash before storing |
| 106 | server/api/webhooks.js:18 | Empty secret valid HMAC | Reject empty secrets |

### Batch 3.4: Secret Exposure (4 issues)
**Provider:** Manual (Claude session) — security fixes require review

| Report # | File | Fix |
|----------|------|-----|
| 163 | server/db/inbound-webhooks.js:101 | Mask secrets in list response |
| 274 | server/providers/adapters/google-chat.js:56 | Move key to header |
| 476 | server/remote/agent-client.js:152 | Log warning when tls: false |
| 520 | cli/init.js:71 | Set .env file permissions 0o600 |

### Batch 3.5: Command Injection & Shell Safety (6 issues)
**Provider:** Manual

| Report # | File | Vulnerability | Fix |
|----------|------|--------------|-----|
| 14 (top25) | server/providers/ollama-tools.js:425 | Unrestricted shell default | Default to allowlist mode |
| 521 | agent/index.js:175 | shell:true on Windows | shell:false, resolve .cmd |
| 522 | agent/index.js:140 | Env var injection in /run | Whitelist allowed vars |
| 253 | server/handlers/validation/index.js:789 | Hook script injection | Escape checksText |
| 4 | server/index.js:447 | PID interpolation | Use execFileSync with array |
| 473 | server/validation/auto-verify-retry.js:161 | verifyCommand no validation | validateShellCommand() |

### Batch 3.5b: Architectural — Event Loop Blocking (3 issues)
**Provider:** Manual — requires architectural redesign
**Note:** These were identified in spec review as missing Top-25 issues.

| Report # | File | Issue | Fix |
|----------|------|-------|-----|
| 276/3(top25) | server/providers/v2-cli-providers.js:156 | `spawnSync` blocks event loop up to 8 hours | Convert to `spawn` (async) with stdout/stderr collection |
| 119/15(top25) | server/api/v2-governance-handlers.js:737 | 3,510 sync DB queries in provider trends | Single aggregation query with GROUP BY |
| 463 | server/validation/output-safeguards.js:380 | `getTaskFileChanges` called 9x per task | Cache result at function entry, pass through |

### Batch 3.6: Race Conditions & Transaction Safety (10 issues)
**Provider:** Manual — architectural, careful reasoning required

**Cross-sprint dependency:** Issue #35 modifies `tryClaimTaskSlot` which was also modified by Sprint 2 issue #177 (status guard). The Sprint 3 fix (convert to `db.transaction()`) must incorporate the Sprint 2 WHERE clause change. Review the Sprint 2 diff before starting this batch.

| Report # | File | Race Condition | Fix |
|----------|------|---------------|-----|
| 35 | server/database.js:1451 | Manual BEGIN in tryClaimTaskSlot | Convert to db.transaction(), preserve #177's status guard |
| 36 | server/database.js:938 | Manual BEGIN in updateTaskStatus | Convert to db.transaction() |
| 213 | server/db/host-management.js:634 | VRAM check not atomic with slot | Single db.transaction() |
| 3 | server/index.js:285 | Orphan shutdown race | Mutex on shutdownState |
| 2 | server/index.js:396 | Double shutdown timeout | Track and clear handle |
| 52 (cli) | agent/index.js:52 | readBody continues after reject | Remove data listener |
| 50 (orch) | server/mcp/index.js:1698 | Idempotency not atomic | Sync check before async |
| 9 (misc) | server/utils/tsserver-client.js:146 | Concurrent spawn race | Promise queue mutex |
| 328 | server/policy-engine/evaluation-store.js:6 | db never initialized | Wire setDb() in engine.js init |
| 331 | server/policy-engine/shadow-enforcer.js | enforceMode never called | Call from engine.js evaluate |

### Batch 3.7: ReDoS Protection (4 issues)
**Provider:** groq

| Report # | File | Fix |
|----------|------|-----|
| 164 | server/db/provider-routing-core.js:639 | Regex complexity check + timeout |
| 165 | server/db/host-complexity.js:49 | Pre-compile and cache regexes |
| 19 (prov) | server/providers/ollama-tools.js:401 | Same complexity check |
| 326 | server/orchestrator/deterministic-fallbacks.js:80 | Same treatment |

### Batch 3.8: Network Safety (5 issues)
**Provider:** hashline-ollama

| Report # | File | Fix |
|----------|------|-----|
| 257 | server/handlers/shared.js:97 | Add octal/hex/decimal IP detection |
| 258 | server/handlers/shared.js:95 | Fix ULA check: `^fd[0-9a-f]{2}:` |
| 156 | server/handlers/webhook-handlers.js:1040 | Add isInternalHost to Slack webhook |
| 157 | server/handlers/webhook-handlers.js:1100 | Add isInternalHost to Discord webhook |
| 121 | server/api/v2-governance-handlers.js:421 | Validate action against frozen Set |

### Sprint 3 Dependency Graph

```
Batch 3.1 (SQL injection)  -- sequential, manual review each fix
         |
Batch 3.2 (path traversal) -- sequential, manual review
         |
    vitest run (no regressions)
         |
Batch 3.3 (auth)      --+
Batch 3.4 (secrets)    --+-- parallel (different subsystems)
Batch 3.5 (shell)      --+
         |
    vitest run (verify)
         |
Batch 3.5b (blocking)  -- sequential (architectural redesign)
         |
Batch 3.6 (races)      -- sequential (core state machine, depends on Sprint 2 #177)
         |
    vitest run (verify)
         |
Batch 3.7 (ReDoS)      --+-- parallel
Batch 3.8 (network)    --+
         |
    vitest run (verify)
         |
    git commit "sprint-3: security and architectural fixes (~105 issues)"
```

---

## Sprint 4: Test Quality + Dashboard + UX (~100 issues)

### Batch 4.1: Fix Always-Passing Tests (18 issues)
**Provider:** claude-cli

Fix tests with `if (typeof fn === 'function') else expect(true).toBe(true)` pattern in task-manager.test.js (18 instances), placeholder `expect(true).toBe(true)` in tda-01-provider-sovereignty.test.js (3 instances), and platform-conditional no-ops in process-lifecycle.test.js (3 instances). Either import functions properly, write real assertions, or mark `.todo()`.

### Batch 4.2: Fix Overly Permissive Assertions (12 issues)
**Provider:** claude-cli

Fix tests that accept ANY status, swallow assertion failures in try/catch, have conditional assertion guards, or test inline patterns instead of importing from source. Target files: e2e-fallback-recovery.test.js, e2e-hashline-ollama.test.js, e2e-cli-providers.test.js, adaptive-retry.test.js, e2e-post-task-validation.test.js.

### Batch 4.3: Fix Mock Issues (6 issues)
**Provider:** groq

Fix Ollama mock default streaming behavior, add missing /api/chat endpoint, fix spawn mock to track array of children, fix process mock exit ordering, fix fetch mock leaks, fix vi.mock scoping.

### Batch 4.4: Fix Flaky & Order-Dependent Tests (6 issues)
**Provider:** claude-cli

Replace tight polling loops with event-based waits, remove fixed sleeps, set up independent test data in beforeEach, rename misleading "concurrent" tests or implement actual concurrency.

### Batch 4.5: Dashboard Polling Optimization (6 issues)
**Provider:** hashline-ollama

Reduce polling: PlanProjects 5s->30s, Approvals 10s->30s, FreeTier 10s->30s, Schedules 15s->60s. Add `document.hidden` check to all polling views. Debounce filter changes in History view.

### Batch 4.6: Dashboard Accessibility & UX (14 issues)
**Provider:** groq or openrouter

Add aria-labels to filter selects, add Escape handlers to modals, add notification bell click handler, convert Onboarding to Tailwind, use LoadingSkeleton, add clipboard catch blocks, fix keyboard shortcut conflicts, add proper toggle accessibility.

### Batch 4.7: API Design Consistency (8 issues)
**Provider:** claude-cli

Migrate dispatch handlers from raw res.writeHead to sendJson/sendSuccess (adds security headers). Add missing `req` parameter to 20+ sendError calls. Standardize 201 for creation endpoints. Remove legacy dual-payload pattern. Fix fake SSE endpoint.

### Sprint 4 Dependency Graph

```
Batch 4.1 (always-pass) --+
Batch 4.2 (permissive)  --+-- parallel (different test files)
Batch 4.3 (mocks)       --+
         |
    vitest run (verify tests actually fail when they should)
         |
Batch 4.4 (flaky)       -- sequential (timing-sensitive)
         |
    vitest run x3 (verify stability)
         |
Batch 4.5 (polling)     --+
Batch 4.6 (a11y/UX)     --+-- parallel (different components)
Batch 4.7 (API design)  --+
         |
    vitest run (verify)
         |
    git commit "sprint-4: test quality, dashboard, and API consistency (~100 issues)"
```

---

## TORQUE Workflow Templates

### Sprint 1 Workflow (grouped to avoid file conflicts)

```
create_workflow: "sprint-1-safe-fixes"

# Group A: batches that touch task-manager.js, constants.js
add_workflow_task: "group-a-falsy-and-dead-code"
  provider: hashline-ollama
  description: [batch 1.1 (21 || to ?? fixes) + batch 1.4 (16 dead code removals)]
  tags: [sprint-1, group-a, safe]

# Group B: batches that touch operations.js, webhooks.js, workflow files
add_workflow_task: "group-b-null-guards-and-try-catch"
  provider: groq
  description: [batch 1.2 (28 null guards) + batch 1.3 (18 try/catch additions)]
  tags: [sprint-1, group-b, safe]

# Groups A and B run in parallel (no shared files)
# Batch 1.5 depends on both groups (dedup may touch same files)

add_workflow_task: "batch-1.5-dedup"
  provider: claude-cli
  depends_on: [group-a-falsy-and-dead-code, group-b-null-guards-and-try-catch]
  description: [8 utility extraction tasks]
  tags: [sprint-1, dedup, multi-file]

add_workflow_task: "batch-1.6-timers"
  provider: hashline-ollama
  depends_on: [batch-1.5-dedup]
  description: [14 timer/leak fixes]
  tags: [sprint-1, resource-leak, safe]

add_workflow_task: "batch-1.7-misc"
  provider: hashline-ollama
  depends_on: [batch-1.5-dedup]
  description: [14 miscellaneous safe fixes]
  tags: [sprint-1, cleanup, safe]
```

### Sprint 2+ Workflows

Follow same pattern with provider routing:
- Simple edits: hashline-ollama
- Medium context: groq, cerebras, openrouter
- Complex/multi-file: claude-cli
- Security/architectural: manual Claude session

---

## Deferred / Won't Fix (~90 issues)

The bug hunt report found 601 raw issues (deduplicated to ~558 unique). This plan explicitly assigns ~470 to sprints. The remaining ~90 are categorized below:

### Low-risk CODE_SMELL (~40 issues)
Issues like naming inconsistencies, magic numbers with comments, redundant type annotations, and stylistic preferences that don't affect correctness or security. These are tracked in the report but not worth dedicated remediation effort. Example: report #46 (PROVIDER_DEFAULTS mixes concerns), #55 (core-tools.js:83 already handled).

### PERF issues with minimal real-world impact (~15 issues)
Performance issues that are theoretically suboptimal but don't cause user-visible problems at current scale. Example: report #8 (maintenance scheduler does work every minute — acceptable for a single-server system), #92 (normalizeV2AttemptMetadata creates objects — GC handles this fine).

### Test issues that are informational (~20 issues)
Test smell observations that don't indicate bugs (e.g., env var cleanup patterns, test fixture conventions, module-level mutable state that works correctly). Improving these would be nice but doesn't affect confidence in the test suite.

### Dashboard cosmetic issues (~15 issues)
Minor UX observations like "Loading..." text vs skeleton (functional but not polished), toast timer refs on unmount (app wrapper never unmounts), and useTick overflow (285 billion years away).

### Deliberately retained patterns
- Empty catch blocks in non-critical paths (e.g., cleanup code where failure is acceptable)
- `void` statements for intentional unused-variable suppression
- Platform-specific code paths that only apply to deployment targets

---

## Success Criteria

| Metric | Before | After Sprint 1 | After Sprint 4 |
|--------|--------|----------------|----------------|
| Known issues | 601 | ~440 | ~0 |
| Test pass rate | N/A | Same or better | Same or better |
| Always-passing tests | 24+ | 24+ | 0 |
| SQL injection vectors | 9 | 9 | 0 |
| Empty catch blocks | Dozens | Dozens | <5 (intentional) |
| Duplicated utilities | 8 major | 0 | 0 |
| Security issues (critical) | 15 | 15 | 0 |
