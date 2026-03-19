# TORQUE Bug Hunt Remediation Plan

**Date:** 2026-03-18
**Scope:** 469 issues found across 156K lines of source code
**Approach:** Hybrid — manual fixes for critical/security/high, TORQUE batches for medium, tech debt log for low

---

## Test Results (BahumutsOmen)

| Suite | Pass | Fail | Total |
|-------|------|------|-------|
| Server | 15,957 | 162 | 16,147 |
| Dashboard | 609 | 30 | 639 |

## Issue Distribution

| Severity | Count | Disposition |
|----------|-------|------------|
| Critical | 0 | Original finding (activeRequestCount) already fixed |
| High | ~33 | Phase 1 (security) + Phase 2 (manual fix with review) |
| Medium | ~120 | Phase 3 — hybrid: 12 manual, rest via TORQUE batches |
| Low | ~313 | Phase 4 — logged in tech debt registry |

---

## Phase 0 — Test Baseline

**Goal:** Green test suites on Omen before any remediation work.

### 0.1 — Server: 162 test failures on Omen (root cause TBD)

Cascades across 54 test files (162 failures). The error log shows `TypeError: db.onClose is not a function` in `task-manager.js:2615`, but `database.js` already exports `onClose` (line 267, exported at line 1760). The root cause is likely a test mock or module isolation issue where the test's `db` stub doesn't include `onClose`. Requires investigation on Omen.

**Fix:** Diagnose by running a single failing test with `--reporter=verbose` on Omen, inspect the `db` object the test provides. Likely fix: add `onClose: vi.fn()` to the shared test database mock.

### 0.2 — Dashboard: WebSocket mock not creating instances

All 30 failures in `websocket.test.js` — `latestSocket()` returns `undefined`. The `MockWebSocket` constructor isn't pushing instances to `MockWebSocket.instances`.

**Fix:** Align the mock constructor with the hook's expectations.

**Gate:** 0 test failures on Omen (server + dashboard).

---

## Phase 1 — Critical + Security

Each fix ships with a regression test. No TORQUE — manual with careful review.

### ~~1.1 — REMOVED: `activeRequestCount` leak already fixed~~

The `finally` block at `server/index.js:1381` already decrements `activeRequestCount` on all paths including JSON parse errors. Verified in current codebase — not a bug.

### 1.2 — RCE: Remote agent `shell: true` with no command sanitization

**Files:** `server/remote/agent-server.js:435, :397, :197`
**Bug:** 3 independent RCE paths — `/run` endpoint spawns with `shell: true`, no CWD validation, `spawnAndCapture` also `shell: true`.
**Fix:**
- Switch to `shell: false` with explicit argument arrays
- Validate CWD against configured allowlist of directories
- Sanitize/reject args containing shell metacharacters (`;`, `|`, `` ` ``, `$()`)

**Test:** Attempt command injection via semicolons, pipes, backticks — verify rejection.

### 1.3 — RCE: Command injection bypass in ollama-tools

**Files:** `server/providers/ollama-tools.js:373, :707`
**Bug:** `ALWAYS_BLOCKED` only checked when allowlist contains `'*'`. Glob-to-regex lets `npm *` match `npm test; rm -rf /`.
**Fix:**
- Always check `ALWAYS_BLOCKED` regardless of allowlist mode
- Use `shell: false` in `execSync`, split command and args properly

**Test:** Verify `rm -rf /` blocked with specific allowlist, verify metacharacter injection rejected.

### ~~1.4 — REMOVED: `file_paths` traversal already handled~~

`server/tools.js:248-252` already iterates `args.file_paths` when present and feeds them into the traversal guard. Verified in current codebase — not a bug.

### 1.5 — Timing attack in agent auth

**File:** `server/remote/agent-server.js:104`
**Bug:** String equality comparison for secret validation.
**Fix:** Replace with `crypto.timingSafeEqual()` on fixed-length buffers.
**Test:** Unit test that auth uses timing-safe comparison.

### 1.6 — Prototype pollution in config-loader deepMerge

**File:** `server/orchestrator/config-loader.js:144`
**Bug:** No `__proto__`/`constructor`/`prototype` key filtering.
**Fix:** Skip keys matching `__proto__`, `constructor`, `prototype` in the merge loop.
**Test:** Pass poisoned config object, verify prototype not polluted.

### 1.7 — ReDoS via custom diagnostic patterns

**File:** `server/orchestrator/deterministic-fallbacks.js:80`
**Bug:** User-supplied regex passed directly to `new RegExp()`.
**Fix:** Validate through `safeRegexTest` before compilation.
**Test:** Pass catastrophically backtracking pattern, verify it doesn't block.

### 1.8 — `safeRegexTest` doesn't enforce timeout

**File:** `server/utils/safe-regex.js:10`
**Bug:** `timeoutMs` parameter accepted but never used.
**Fix:** Implement timeout enforcement using worker thread or `vm.runInNewContext`.
**Test:** Verify pathological regex terminated within timeout.

### 1.9 — ReDoS in tool-registry schema validation

**File:** `server/mcp/tool-registry.js:87`
**Bug:** `new RegExp(schema.pattern)` from schema definitions without validation.
**Fix:** Validate patterns through `safeRegexTest` before compilation.
**Test:** Register tool with pathological pattern, verify rejection.

### 1.10 — Plaintext secret storage in agent registry

**File:** `server/remote/agent-registry.js:37`
**Bug:** Agent secrets stored unencrypted in SQLite.
**Fix:** Hash secrets with bcrypt/scrypt before storage, compare using constant-time hash verification.
**Test:** Verify stored value is not plaintext.

### 1.11 — Delete suspicious `_________etc_passwd.md`

**File:** `server/.codex-context/_________etc_passwd.md`
**Bug:** Likely prompt injection artifact from Codex sandbox.
**Fix:** Delete the file.

**Gate:** All new security tests green on Omen.

---

## Phase 2 — High Severity

### Group A — Database & Data Integrity

**2.1 — TOCTOU double-claim race**
`db/coordination.js:322` — `claimTask()` checks then inserts without transaction.
Fix: Wrap existence check + INSERT in IMMEDIATE transaction.
Test: Concurrent claim attempts, verify only one succeeds.

**2.2 — `restoreDatabase` closes live DB mid-traffic**
`db/backup-core.js:114` — `_db.close()` before backup completes.
Fix: Acquire global write lock, reject requests during restore, re-open after.
Test: Attempt DB query during restore, verify graceful rejection.

**2.3 — `setConfig` overwrites model settings on startup**
`db/schema-migrations.js:405` — Unconditional overwrite destroys customization.
Fix: Merge semantics — only set keys that don't exist.
Test: Set custom settings, restart, verify preserved.

**2.4 — `checkRateLimit` counts all running tasks globally**
`db/file-quality.js:600` — Not per-provider.
Fix: Filter `getRunningCount` by provider.
Test: Verify provider-specific limits enforced.

### Group B — Task Lifecycle

**2.5 — v2 cancel doesn't kill running processes**
`api-server.core.js:1380` — Only updates DB, process continues.
Fix: Call `taskManager.cancelTask()`.
Test: Cancel running task via v2 API, verify process terminated.

**2.6 — v2 cancel silently swallows errors and reports false success**
`api-server.core.js:1386-1399` — Catch block swallows DB update errors, AND the response at line 1399 unconditionally reports `cancelled: true` even when the update failed.
Fix: Let error propagate, return error status. Also guard the `cancelled: true` response on actual success.
Test: Cancel completed task, verify error response (not false `cancelled: true`).

**2.7 — Infinite loop in `acquireTaskLock`**
`execution/task-finalizer.js:200` — The outer `while(true)` loop calls `waitForTaskLock` (which has a 10-second inner timeout), but the outer loop re-enters indefinitely when the lock is still held. If the lock holder crashes, the outer loop spins forever with 10-second pauses.
Fix: Add an absolute timeout to the **outer** `acquireTaskLock` loop (e.g., 5 minutes total), not the inner `waitForTaskLock`.
Test: Simulate orphaned lock, verify eventual failure with clear error after timeout.

### ~~2.8 — REMOVED: 3-way merge base is actually correct~~

`execution/conflict-resolver.js:229` calls `mergeContents(mergedContent, baseContent, theirContent)` where the signature is `mergeContents(ours, base, theirs)`. Using the original `baseContent` as the merge base for each iteration is the correct approach for iterative 3-way merging — `git merge-file` computes diffs of ours-vs-base and theirs-vs-base independently. The accumulated `mergedContent` correctly carries forward as "ours". Not a bug.

**2.9 — Fuzzy repair on shifted line indices**
`validation/hashline-verify.js:161` — Sequential blocks on shifting content.
Fix: Apply in reverse line order or recalculate offsets.
Test: Multi-block edit with line count change, verify correct application.

### Group C — Routing & Configuration

**2.10 — Slash commands reference wrong tool names**
`.claude/commands/torque-workflow.md` — `start_workflow` should be `run_workflow`, `get_workflow_status` should be `workflow_status`. Both the `allowed-tools` list and body text reference the wrong names.
Fix: Update command file and allowed-tools list.

**2.11 — CI module missing `--repo` flag**
`ci/github-actions.js:43-75` — All `gh` commands miss `--repo`.
Fix: Add `'--repo', this.repo` to every `_runGhCommand` call.
Test: Mock `_runGhCommand`, verify `--repo` present.

**2.12 — CLI port inconsistency**
`cli/api-client.js` + `cli/shared.js` — Two URL computations.
Fix: Unify on `shared.js` export, `api-client.js` imports it.
Test: Set `TORQUE_API_PORT`, verify all commands use same port.

**2.13 — No request timeout in CLI**
`cli/api-client.js` — `fetch()` without AbortController.
Fix: Add 30-second timeout via `signal: AbortSignal.timeout(30000)` in the `fetch` init options.
Test: Mock hanging server, verify timeout.

### Group D — Frontend

**2.14 — Duplicate keyboard shortcut systems**
`Layout.jsx` + `KeyboardShortcuts.jsx` — Two `?` handlers, two overlays that can appear simultaneously. Layout.jsx handles `?`, `Escape`, and `1-7` number-row navigation. KeyboardShortcuts.jsx handles `?`, `Escape`, and `g`-prefix navigation.
Fix: Migrate Layout.jsx's number-row (`1-7`) navigation into KeyboardShortcuts.jsx, then remove Layout.jsx's shortcut system entirely. Keep one overlay with the combined shortcut set.
Test: Press `?` — verify one overlay. Press `1-7` — verify navigation still works. Press `g` then key — verify g-prefix navigation works.

**2.15 — VRAM slider fires API on every drag pixel**
`Hosts.jsx:282` — `onChange` sends request per pixel.
Fix: Change to `onMouseUp` or debounce 500ms.
Test: Drag slider, verify single API call on release.

**2.16 — `createWorkstation` bypasses API client**
`Hosts.jsx:1094` — Raw `fetch()` skips timeout/headers.
Fix: Use `workstationsApi.add()`.

**2.17 — Wrong Recharts element in Models bar chart**
`Models.jsx:203` — `<rect>` instead of `<Cell>`.
Fix: Replace with `<Cell key={entry.name} fill={...} />`.

### Group E — Tests & Agent

**2.18 — Always-truthy E2E assertion**
`dashboard.spec.js:466` — `.toBeTruthy()` on Locator always passes.
Fix: Change to `.toBeVisible()`. Also fix similar patterns at lines 526-540, 586-591, 628-641.

**2.19 — Mock-api OPTIONS double response crash**
`mock-api.js:481` — OPTIONS check after body collection.
Fix: Move OPTIONS check before `req.on('data')` registration.

**2.20 — Agent test validates wrong env filtering**
`run.test.js:244` — Expects env var that should be filtered.
Fix: Update test to expect variable is NOT present.

**2.21 — Default agent config ships with `test-secret`**
`agent/config.json` — Insecure default.
Fix: Empty string, refuse to start if empty or `test-secret`.

**Gate:** Full test suite green on Omen.

---

## Phase 3 — Medium Severity (Hybrid)

### Manual Track (12 security-adjacent issues)

| # | File | Issue |
|---|------|-------|
| 1 | `db/host-benchmarking.js:369` | SSRF — public IPs not blocked |
| 2 | `utils/shell-policy.js:55` | Naive `&&` split doesn't respect quotes |
| 3 | `db/file-tracking.js:219` | ReDoS from DB-stored patterns |
| 4 | `database.js:636` | `resolveTaskId` LIKE injection via `%`/`_` |
| 5 | `api-server.core.js:2228` | CSRF on `/api/shutdown` (partially mitigated: requires localhost or API key, but browser JS on localhost can still POST) |
| 6 | `api-server.core.js:2494` | Tool passthrough exposes all tools |
| 7 | `mcp-sse.js:1178` | `__shutdownSignal` mutates user args |
| 8 | `mcp-sse.js:1410` | `missedEvents.reverse()` mutates shared array |
| 9 | `agent/index.js:176` | `shell: true` on Windows with unsanitized args |
| 10 | `agent/index.js:431` | `/peek/` proxy has no authentication |
| 11 | `discovery.js:835` | Network topology leak via scan API |
| 12 | `remote/agent-client.js:161` | `rejectUnauthorized: false` TLS bypass |

### TORQUE Batch 1 — Null/Init Guards (~25 issues)

Pattern: modules crash if used before `init()`. Fix: add null guard with descriptive error.

Files: `auto-verify-retry.js`, `close-phases.js`, `output-safeguards.js`, `activity-monitoring.js`, `orphan-cleanup.js`, `fallback-retry.js`, `retry-framework.js`, `completion-pipeline.js`, `command-builders.js`, `providers/config.js`, `db/analytics.js`, `db/project-cache.js`

### TORQUE Batch 2 — Tool Schema Validation (~20 issues)

Pattern: missing `required` fields, inconsistent provider enums, wrong parameter types.

Files: all in `server/tool-defs/`

Tasks: Add required fields to `await_ci_run`, `delete_task`, `import_data`, `bulk_import_tasks`, `remove_workstation`, `strategic_diagnose`, `strategic_review`, `delete_routing_template`. Sync provider enums across `workflow-defs.js`, `automation-defs.js`, `task-submission-defs.js`.

### TORQUE Batch 3 — Error Handling Gaps (~15 issues)

Pattern: unhandled JSON.parse, missing try/catch, swallowed errors.

Files: `template-store.js` (parseRow crash), `mcp-sse.js` (event replay JSON.parse), `close-phases.js` (null substring calls), `process-streams.js`, `debug-lifecycle.js`

### TORQUE Batch 4 — Race Conditions & Resource Leaks (~15 issues)

Pattern: unbounded caches, timers not cleared, concurrent access gaps.

Files: `mcp-sse.js` (TRACKED_INTERVALS growth, event ID conflicts), `mcp/telemetry.js` (unbounded latency arrays), `slot-pull-scheduler.js` (capacity uses max not sum), `tsserver-client.js` (concurrent startup race), `dashboard-server.js` (unbounded pendingTaskUpdates)

### TORQUE Batch 5 — Logic Errors (~15 issues)

Pattern: wrong conditions, incorrect calculations, dead code.

Files: `cost-tracking.js` (budget TOCTOU), `coordination.js` (round-robin skips index 0), `fallback-retry.js` (status code substring matching), `workflow-runtime.js` (tags as string not array), `strategic-brain.js` (exit_code 0 → empty string), `category-classifier.js` (overly broad regex)

### TORQUE Batch 6 — Frontend Fixes (~20 issues)

Pattern: React bugs, missing abort controllers, accessibility gaps, performance.

Files: `Providers.jsx` (unmount guard), `EconomyIndicator.jsx` (abort controllers), `PlanProjects.jsx` (modal accessibility), `StrategicConfig.jsx` (inaccessible toggle), `TaskDetailDrawer.jsx` (double-load), `Kanban.jsx` (stale Date.now, column menu), `History.jsx` (keyboard nav scroll), `WorkflowDAG.jsx` (passive wheel event)

### TORQUE Batch 7 — API & Dashboard Consistency (~10 issues)

Pattern: inconsistent responses, duplicate routes, wrong status codes.

Files: `api/routes.js` (duplicate routes), `v2-cli-providers.js` (process.env leak), `dashboard/router.js`, `adapter-registry.js` (missing registrations), `execute-cli.js` (duplicated aider command builder)

**Verification:** After each batch, run full test suite on Omen with `verify_command: "npx vitest run"`.

---

## Phase 4 — Tech Debt Registry

~313 low-severity items logged to `docs/tech-debt-registry.md`, organized by category:

| Category | Count |
|----------|-------|
| Dead code | ~40 |
| Naming inconsistencies | ~30 |
| Missing documentation | ~25 |
| Minor validation gaps | ~35 |
| Code duplication | ~20 |
| Minor accessibility | ~15 |
| Test quality | ~20 |
| Minor performance | ~15 |
| Code smells | ~50 |
| Configuration | ~15 |
| Minor error handling | ~30 |
| Minor resource leaks | ~18 |

Each entry includes: file path, line number, one-line description, category.

---

## Execution Dependencies

```
Phase 0 (test baseline)
    → Gate: 0 failures on Omen
Phase 1 (critical + security)
    → Gate: all security tests green
Phase 2 (high severity, 5 groups)
    → Gate: full suite green
Phase 3 (medium, manual track + 7 TORQUE batches)
    → Gate: full suite green after each batch
Phase 4 (tech debt log)
```

## Estimated Effort

| Phase | Sessions | Method |
|-------|----------|--------|
| 0 — Test Baseline | 1 | Manual |
| 1 — Critical + Security | 2–3 | Manual with security tests |
| 2 — High Severity | 2–3 | Manual with review |
| 3 — Medium Severity | 3–4 | Hybrid (manual + TORQUE) |
| 4 — Tech Debt Log | 1 | Document generation |
| **Total** | **~10–12** | **~152 fixes + ~313 logged** |
