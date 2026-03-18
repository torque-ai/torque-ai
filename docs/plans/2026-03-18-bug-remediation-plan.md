# TORQUE Bug Remediation Plan

**Source:** `docs/investigations/2026-03-18-bug-hunt-summary.md` (475 issues)
**Created:** 2026-03-18
**Approach:** 8 batches organized by risk + file proximity. Each batch is independently deployable. Estimated ~40 batches of work total if all 475 issues are addressed — this plan covers the top ~200 highest-priority issues across 8 phases.

---

## Phase 1: Security — Critical Attack Vectors (28 issues)

**Risk:** Exploitable in any deployment. Fix immediately.

### Batch 1A: Request Handling & Input Validation (8 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 1 | `server/api/v2-dispatch.js:31` | `readJsonBody` has no size limit — OOM DoS | Add `MAX_BODY_SIZE` check matching `middleware.js` pattern (10MB) |
| 2 | `server/api/v2-dispatch.js:489` | Custom query parser skips duplicate keys | Replace with `URLSearchParams` |
| 3 | `server/api/middleware.js:192` | `parseBody` continues buffering after size limit hit | Add `return` after `reject` |
| 4 | `server/api/middleware.js:227` | CORS origin hardcoded to `http://127.0.0.1:3456` | Derive from dashboard port config |
| 5 | `server/api/middleware.js:254` | Timing leak in API key comparison | Hash both sides to fixed length before `timingSafeEqual` |
| 6 | `server/api/v2-governance-handlers.js:483` | Predictable temp file path — symlink attack | Use `crypto.randomUUID()` in filename |
| 7 | `server/api/v2-governance-handlers.js:1001` | Config set has no value length limit | Cap at 64KB |
| 8 | `server/api/v2-governance-handlers.js:118` | `decided_by` field not sanitized | Validate length + alphanumeric |

### Batch 1B: File & Path Security (7 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 9 | `server/utils/context-stuffing.js:126` | Reads files outside working directory | Validate all paths resolve within `working_directory` |
| 10 | `server/utils/git-worktree.js:245` | `srcFile` not validated against worktree path | Add `resolveSafePath` check on source |
| 11 | `server/utils/safe-exec.js:38` | Doesn't handle quoted arguments | Use proper shell-word splitting or pass args as array |
| 12 | `server/utils/safe-exec.js:22` | Doesn't handle `||` operator | Split on `&&` and `||` with proper precedence |
| 13 | `server/providers/ollama-tools.js:187` | `search_files` no symlink cycle detection | Track visited realpaths in a Set |
| 14 | `server/providers/ollama-tools.js:241` | Wildcard `*` in command allowlist permits everything | Refuse `*` or add dangerous-command blocklist |
| 15 | `server/providers/agentic-git-safety.js:103` | Short substring matching authorizes all paths | Require minimum 8-char match or use working_directory prefix |

### Batch 1C: Credential & Secret Handling (7 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 16 | `server/providers/google-ai.js:54,136` | API key in URL query string | Move to `X-Goog-Api-Key` header |
| 17 | `server/providers/agentic-git-safety.js:142` | `captureSnapshot` swallows errors silently | Log warning + set safety-disabled flag |
| 18 | `server/logger.js:14` | Missing redaction for Google/AWS/GitHub key formats | Add patterns for `AIza`, `AKIA`, `ghp_`, `github_pat_` |
| 19 | `server/utils/safe-env.js:37` | `GOOGLE_API_KEY` exposed to child processes unnecessarily | Scope to only AI-related providers |
| 20 | `server/config.js:193` | Silent `require()` failure hides broken decryption | Add `logger.warn` on catch |
| 21 | `server/utils/credential-crypto.js:83` | Key cached before file durably written | Add `fs.fsyncSync` after write |
| 22 | `server/mcp-sse.js:819` | Session subscription uses unvalidated sessionId | Validate session ownership before persist |

### Batch 1D: Handler Input Validation (6 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 23 | `server/api/v2-task-handlers.js:166` | Context-stuff resolves relative to `process.cwd()` | Require explicit `working_directory` |
| 24 | `server/api/v2-task-handlers.js:496` | Git SHA regex matches any 7-char hex | Anchor to word boundary + validate with `git cat-file` |
| 25 | `server/handlers/automation-batch-orchestration.js:29` | `hasShellMetacharacters` misses `|`, `>`, `\n` | Expand blocklist |
| 26 | `server/handlers/snapscope-handlers.js:19` | `SNAPSCOPE_CLI_PROJECT` allows path traversal | Validate resolved path |
| 27 | `server/handlers/automation-ts-tools.js:46` | Regex special chars in member name not escaped | Escape before interpolating |
| 28 | `server/api/v2-middleware.js:166` | Internal error messages leaked to clients | Use generic message for non-v2 errors |

---

## Phase 2: Data Integrity — Race Conditions & Transactions (18 issues)

**Risk:** Silent data corruption under concurrent load.

### Batch 2A: Transaction Safety (8 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 29 | `database.js:940` | Manual `BEGIN IMMEDIATE` pattern — COMMIT-then-throw | Migrate to `db.transaction()` wrapper |
| 30 | `database.js:1000` | Non-critical path lacks `AND status = ?` guard | Add optimistic concurrency check |
| 31 | `database.js:880` | Mutates caller's `additionalFields` | Clone before modifying |
| 32 | `workflow-runtime.js:138` | Non-transactional read-modify-write on project counters | Wrap in `db.transaction()` |
| 33 | `workflow-runtime.js:186` | Same for failure counters | Wrap in `db.transaction()` |
| 34 | `workflow-engine.js:318` | `deleteWorkflow` doesn't delete child tasks — FK violation | Delete or nullify tasks first |
| 35 | `workflow-engine.js:334` | `cleanupOldWorkflows` same FK issue | Same fix |
| 36 | `experiment-handlers.js:58` | A/B test creates two tasks without transaction | Wrap in transaction |

### Batch 2B: Status & Queue Integrity (10 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 37 | `database.js:1371` | `getNextQueuedTask` excludes NULL-provider tasks | Use `IS DISTINCT FROM` or `COALESCE` |
| 38 | `workflow-runtime.js:860` | `unblockTask` bypasses `updateTaskStatus` guards | Use `updateTaskStatus` instead of raw SQL |
| 39 | `workflow-runtime.js:596` | `applyOutputInjection` calls updateTaskStatus with same status | Use direct `updateTask` for description changes |
| 40 | `queue-reroute.js:146` | Direct SQL UPDATE bypasses task manager hooks | Use `updateTaskStatus` or `updateTask` |
| 41 | `slot-pull-scheduler.js:82` | `getUnassignedQueuedTasks` bypasses module wrapper | Use `db.listQueuedTasksLightweight` |
| 42 | `slot-pull-scheduler.js:101` | Empty `eligible_providers` blocks all tasks | Treat empty array as "all providers eligible" |
| 43 | `v2-task-handlers.js:103` | Task created in DB before policy check | Move `createTask` after `startTask` approval |
| 44 | `v2-task-handlers.js:187,382` | `_taskManager` used without null check | Add guard with descriptive error |
| 45 | `v2-task-handlers.js:344` | Retry inherits pinned provider from smart-routed task | Clear provider for smart-routed retries |
| 46 | `database.js:889` | Legacy mode requeue keeps failed provider | Clear provider on requeue |

---

## Phase 3: Reliability — Cancellation, Timeouts, Cleanup (20 issues)

**Risk:** Tasks run indefinitely, resources leak, shutdown fails.

### Batch 3A: Agentic Pipeline (6 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 47 | `execution.js:391` | Agentic tasks bypass host slot reservation | Call `tryReserveHostSlotWithFallback` |
| 48 | `execution.js:449` | Agentic abort controllers not registered | Add to `apiAbortControllers` map |
| 49 | `ollama-tools.js:408` | `run_command` uses sync `execSync` | Switch to async `execFile` with timeout |
| 50 | `ollama-agentic.js:349` | Malformed conversation history on early-stop | Push placeholder results for unexecuted tool calls |
| 51 | `ollama-tools.js:291` | `write_file` doesn't validate content is string | Add type check |
| 52 | `execution.js:609` | Hardcoded 16K context budget for all cloud models | Derive from model context window |

### Batch 3B: Provider Timeouts & Cancellation (8 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 53 | `execute-hashline.js:739` | No cancel or timeout mechanism | Add interval+timeout pattern from execute-ollama |
| 54 | `execute-hashline.js:199` | Promise resolved multiple times | Add `resolved` guard flag |
| 55 | `execute-cli.js:70` | Proxy functions lack null guards | Throw descriptive "not initialized" error |
| 56 | `execute-cli.js:775` | Windows force-kill doesn't emit synthetic close | Emit `close(1)` after kill |
| 57 | `groq.js:46` + 3 others | Abort signal race if already aborted | Check `signal.aborted` after adding listener |
| 58 | `openrouter.js:280` | Timeout vs cancellation conflated | Check abort reason to distinguish |
| 59 | `v2-cli-providers.js:156` | `spawnSync` blocks event loop for entire CLI duration | Switch to async spawn |
| 60 | `execute-cli.js:609` | `execFileSync` for git baseline blocks event loop | Switch to async `execFile` |

### Batch 3C: Shutdown & Lifecycle (6 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 61 | `index.js:374` | Shutdown cancels orphan tasks (opposite of intent) | Fix `cancelTasks` flag for orphan-complete |
| 62 | `index.js:285` | `isShuttingDown = false` reset creates re-entrancy window | Use a state enum instead of boolean |
| 63 | `index.js:444` | `wmic` deprecated on Windows 11 | Use PowerShell `Get-Process` or `tasklist` |
| 64 | `mcp-sse.js:1337` | Session `res.end()` before new `res` assignment — notification race | Assign new `res` before ending old |
| 65 | `mcp-sse.js:757` | Aggregation buffer timers not tracked for shutdown | Add to `TRACKED_INTERVALS` |
| 66 | `workflow-runtime.js:700` | `terminalGuards` map never cleaned on workflow deletion | Clean on delete |

---

## Phase 4: Dashboard — Performance & Memory (22 issues)

**Risk:** Browser tab crashes, stale data, excessive network.

### Batch 4A: Polling & Performance (8 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 67 | `History.jsx:289` | 5-second polling interval — extremely aggressive | Increase to 30s, rely on WebSocket |
| 68 | `TaskDetailDrawer.jsx:655` | Output chunks re-concatenated every render | `useMemo` |
| 69 | `TaskDetailDrawer.jsx:740` | ANSI parsing on every chunk every render | `useMemo` per chunk |
| 70 | `BatchHistory.jsx:401` | JSON.parse called multiple times per workflow | Cache in local variable |
| 71 | `App.jsx:140` | Streaming output array grows unbounded | Cap at 10K chunks |
| 72 | `History.jsx:196` | `uniqueTags` recomputed on every 5s poll | Stabilize with deep comparison |
| 73 | `Approvals.jsx:44` | Full history fetched every 10s regardless of tab | Only fetch on active tab |
| 74 | `v2-analytics-handlers.js:33` | 2×N DB queries for N-day time series | Single aggregate query |

### Batch 4B: Memory Leaks & State (8 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 75 | `websocket.js:57` | Double WebSocket connection if called during CONNECTING | Check `readyState !== CONNECTING` |
| 76 | `websocket.js:100` | Reconnect timeout can duplicate on rapid close/reopen | Clear timeout before creating new |
| 77 | `Providers.jsx:349` | Orphaned setTimeout after key save | Store in ref, clear on unmount |
| 78 | `TaskSubmitForm.jsx:43` | No AbortController on provider/host fetches | Add controller, abort on unmount |
| 79 | `api.js:54` | Caller abort signal ignored — overridden by timeout signal | Compose signals with `AbortSignal.any()` |
| 80 | `App.jsx:152` | REST poll + WebSocket both update host activity | Deduplicate or disable REST when WS connected |
| 81 | `KeyboardShortcuts.jsx:70` | `pendingG` timeout not cleaned on unmount | Store in ref, clear in cleanup |
| 82 | `Providers.jsx:312` | Polling interval reset on every `loadData` recreation | Separate stable interval from reactive fetch |

### Batch 4C: Error Handling & UX (6 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 83 | `ErrorBoundary.jsx:32` | "Try Again" doesn't reset child state | Use key prop to force remount |
| 84 | `History.jsx:132` | `URL.revokeObjectURL` called synchronously after click | Delay revocation by 100ms |
| 85 | `Providers.jsx:218` | Key input not cleared on save error | Move `setKeyValue('')` to finally block |
| 86 | `App.jsx:244` | Onboarding flashes before first data load | Guard with `!isLoading` check |
| 87 | `RoutingTemplates.jsx:54` | No error state on API failure | Add error banner |
| 88 | `Layout.jsx:244` | Key `8` navigates to `undefined` | Add 8th route or cap shortcut range |

---

## Phase 5: Server Core Quality (18 issues)

### Batch 5A: Logger, Config, Constants (8 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 89 | `logger.js:200` | Child logger shares stream but independent size counter | Share size counter via reference |
| 90 | `logger.js:36` | Log dir defaults to source directory | Default to `TORQUE_DATA_DIR/logs` |
| 91 | `config.js:95` | `getBool` treats `'FALSE'` as truthy | Case-insensitive comparison |
| 92 | `config.js:109` | `get()` returns `String(entry.default)` — type coercion hazard | Document return type contract |
| 93 | `constants.js:85` | Minutes vs milliseconds naming inconsistency | Add `_MINUTES` suffix |
| 94 | `mcp-sse.js:31` | Allowed origins computed before DB init | Lazy-load on first request |
| 95 | `mcp-sse.js:1032` | `body += chunk` corrupts binary | Use `Buffer.concat` |
| 96 | `mcp-sse.js:896` | Subscription limit checks hypothetical total | Check `args.task_ids.length` only |

### Batch 5B: Workflow & Queue Logic (10 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 97 | `workflow-runtime.js:426` | `$` in prev_output causes replacement injection | Use function replacement: `.replace(..., () => prevOutput)` |
| 98 | `workflow-runtime.js:921` | Recursive skip propagation can overflow stack | Convert to iterative with explicit stack |
| 99 | `workflow-runtime.js:977` | `cancelDependentTasks` has no cycle detection | Track visited set |
| 100 | `workflow-runtime.js:777` | Dependency evaluation uses stale `depends_on_status` | Refresh from source task status |
| 101 | `workflow-engine.js:210` | `updateWorkflow` allows arbitrary column names | Whitelist columns |
| 102 | `workflow-engine.js:241` | `listWorkflows` triggers `reconcileStaleWorkflows` every call | Debounce or run periodically |
| 103 | `queue-scheduler.js:779` | `pendingFreeProviderOverflow` accumulates non-capacity failures | Filter to capacity-only failures |
| 104 | `queue-scheduler.js:869` | Fallback scan uses null provider category | Use `_effectiveProvider` |
| 105 | `execute-ollama.js:307` | Requeue on slot-race doesn't call `processQueue` | Schedule `processQueue()` with delay |
| 106 | `index.js:862` | Scheduled task duplicate if `startTask` fails after `createTask` | Wrap in transaction or mark schedule before create |

---

## Phase 6: Provider Quality (14 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 107 | `execute-hashline.js:895` | Rejected rewrite doesn't release host slot | Call `decrementHostTasks` on early return |
| 108 | `execute-hashline.js:619` | File context map key inconsistency | Normalize all keys to absolute paths |
| 109 | `execute-ollama.js:798` | Health cache invalidated on every task completion | Only invalidate on error paths |
| 110 | `execute-ollama.js:351` | OOM requeue bypasses `safeUpdateTaskStatus` | Use safe wrapper |
| 111 | `execution.js:47` | Groq default model mismatch between execution.js and groq.js | Align to same value |
| 112 | `adapter-registry.js:103` | Key comparison may fail for non-standard property names | Use version counter instead |
| 113 | `v2-local-providers.js:261` | `_selectExecutionTarget` queries DB twice for same model | Cache first result |
| 114 | `v2-local-providers.js:300` | Recursive `_selectExecutionTarget` with no depth limit | Add depth parameter, cap at 3 |
| 115 | `prompts.js:331` | `.replace()` only replaces first occurrence | Use `.replaceAll()` or regex with `g` flag |
| 116 | `openrouter.js:81` | Rate limit detection only matches string fragments | Also check `err.status === 429` |
| 117 | `codex-intelligence.js:119` | `execFileSync` for tsc blocks event loop | Switch to async |
| 118 | `ollama-strategic.js:16` | Provider name hardcoded as `'ollama'` not `'ollama-strategic'` | Fix name |
| 119 | `strategic-brain.js:128` | `timeout: 5` — ambiguous unit | Add comment or use explicit `timeout_minutes` |
| 120 | `economy/policy.js:47` | Shallow merge loses sub-keys of `provider_tiers` | Deep merge `provider_tiers` |

---

## Phase 7: Dashboard Accessibility (15 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 121 | `Providers.jsx:107` | Toggle button has no aria-label | Add `aria-label={provider.enabled ? 'Disable' : 'Enable'}` |
| 122 | `Providers.jsx:651` | Pie chart inaccessible to screen readers | Add `role="img"` + `aria-label` |
| 123 | `TaskDetailDrawer.jsx:874` | Diff copy button has no accessible name | Add `aria-label="Copy diff"` |
| 124 | `History.jsx:568` | Select-all checkbox has no aria-label | Add `aria-label="Select all tasks"` |
| 125 | `Layout.jsx:194` | Shortcut modal has no `role="dialog"` or focus trap | Add ARIA attrs + focus trap |
| 126 | `Budget.jsx:195` | Click-to-toggle uses div, not button | Use `<button>` with keyboard handler |
| 127 | `Budget.jsx:17` | Progress ring has no ARIA value attributes | Add `role="progressbar"` + value attrs |
| 128 | `Workflows.jsx:86` | Table rows clickable but not keyboard accessible | Add `role="button"` + `tabIndex` + `onKeyDown` |
| 129 | `BatchHistory.jsx:551` | Empty state `colSpan={7}` but table has 6 columns | Fix to `colSpan={6}` |
| 130 | Multiple | Recharts have no accessible alternatives | Add `role="img"` + summary `aria-label` |
| 131 | Multiple | `toBeTruthy()` on `getByText()` is meaningless | Replace with `toBeInTheDocument()` |
| 132 | `TaskDetailDrawer.jsx:100` | No focus trap in drawer dialog | Add focus trap |
| 133 | `App.jsx:98` | Fake ESLint rule `react-hooks/purity` | Remove invalid suppress comment |
| 134 | `Budget.jsx:226` | Label says "Monthly" but period can be "Weekly" | Dynamic label from period |
| 135 | `Approvals.jsx:196` | Both buttons show `...` during action | Separate loading state per button |

---

## Phase 8: Test Coverage (20 issues)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 136 | `adv-intelligence.test.js` | Near-duplicate of 2 other test files | Delete stale file, keep canonical |
| 137 | `execution.js:339` | No test for `executeOllamaTaskWithAgentic` | Write integration test |
| 138 | `execution.js:530` | No test for `executeApiProviderWithAgentic` | Write integration test |
| 139 | `ollama-tools.js` | No test for `list_directory`, `search_files` | Write unit tests |
| 140 | `ollama-agentic.js:65` | `truncateOldestToolResults` untested | Write unit test |
| 141 | `execute-ollama.js:391` | HTTPS enforcement untested | Write unit test |
| 142 | `execute-ollama.js:345` | OOM/memory-error path untested | Write unit test |
| 143 | `execute-ollama.js:554` | Context limit exceeded path untested | Write unit test |
| 144 | `RoutingTemplates.test.jsx` | Only 2 tests for complex UI | Add CRUD, activate, error state tests |
| 145 | `Strategy.test.jsx:570` | Sort tests don't verify row order | Assert actual element order |
| 146 | `strategic.spec.js:354` | 16-second hardcoded wait | Use `waitForRequest` |
| 147 | `strategic.spec.js:131` | Catch-all returns empty `{}` for all APIs | Return typed defaults |
| 148 | Multiple test files | `toBeTruthy()` on `getByText()` pattern | Bulk replace with `toBeInTheDocument()` |
| 149 | `ollama-tools.js:9` | No test for symlink path-jail escape | Write security test |
| 150 | `agentic-tools.test.js` | No test for `edit_file` with `replace_all` | Write unit test |
| 151 | `agentic-tools.test.js` | No test for `MAX_FILE_READ_BYTES` truncation | Write unit test |
| 152 | `agentic-tools.test.js` | No test for `MAX_COMMAND_TIMEOUT_MS` | Write unit test |
| 153 | `execute-ollama.test.js:342` | Pre-routed host test doesn't verify host used | Assert request URL |
| 154 | `execute-ollama.test.js` | No test for host-slot decrement on failure | Assert `decrementHostTasks` called |
| 155 | `anthropic-provider.test.js` | Tests a demoted provider | Update or mark as opt-in |

---

## Execution Strategy

**Parallel lanes:** Phases 1-3 (server security/integrity/reliability) can run in parallel with Phase 4 (dashboard) and Phase 7 (accessibility). Phase 8 (tests) runs last since many tests need the fixes to land first.

**Per-batch workflow:**
1. Create feature branch per batch (e.g., `fix/phase-1a-request-validation`)
2. Fix all issues in the batch
3. Run full test suite
4. Merge to main

**Estimated effort per phase:**
- Phase 1 (Security): 4-6 hours
- Phase 2 (Data Integrity): 3-4 hours
- Phase 3 (Reliability): 4-5 hours
- Phase 4 (Dashboard): 3-4 hours
- Phase 5 (Server Quality): 3-4 hours
- Phase 6 (Provider Quality): 2-3 hours
- Phase 7 (Accessibility): 2-3 hours
- Phase 8 (Tests): 4-5 hours

**Total estimated:** ~25-34 hours of focused remediation work.

**Remaining ~320 low-priority issues** (dead code removal, naming inconsistencies, minor performance, documentation) can be addressed opportunistically during normal development.
