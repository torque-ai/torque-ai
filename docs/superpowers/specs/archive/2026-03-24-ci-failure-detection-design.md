# CI Failure Detection & Auto-Reporting

**Date:** 2026-03-24
**Status:** Approved
**Author:** Claude

## Problem

CI failures accumulate silently across development cycles. Lint errors, test failures, and schema drift go unnoticed until someone manually checks GitHub Actions — by which point multiple commits have stacked on top of the breakage. Today's session required 16 commits across 5 hours to clean up failures that could have been caught incrementally.

## Solution

Complete the existing CI monitoring infrastructure in TORQUE so that failures are detected automatically via polling, diagnosed into structured categories, and pushed as lean notifications to all connected Claude sessions. Claude then pulls full diagnosis on demand and acts on it.

## Architecture

Three layers, each building on the previous:

### Layer 1: Detection (polling loop)

**Status:** 80% built in `server/ci/watcher.js`

The watcher polls GitHub Actions via `gh run list` at a configurable interval (default 30s). On server startup, active watches are restored from the `ci_watches` DB table. When a new failed run is detected, it triggers diagnosis and notification.

**What exists:**
- `watchRepo()` — starts a polling timer for a repo
- `_pollWatch()` — polls for new runs, checks if already diagnosed (processing logic is inlined within `_pollWatch`, not in a separate function)
- `_isFailedRun()` — determines if a run failed
- `_cacheRunDiagnostic()` — persists results to `ci_run_cache` table
- `_notifyFailure()` — pushes `ci:run:failed` events through `mcpSse.pushNotification`
- Startup restoration in `server/index.js` lines 774-780

**What's missing:**
- `awaitRun(options)` — block until a specific run completes. Implementation: poll via `provider.getRun(runId)` (not raw `gh` — use the existing provider abstraction) every `pollIntervalMs` (default 15s) until status is `completed`, `failure`, or `timed_out`. Return the run object with both `status` and `conclusion` preserved. Respect `timeoutMs` (default 30 min). Natural home: implement as `watchRun()` on the `CIProvider` base class (`server/ci/provider.js` already has a stub at line 60), with `awaitRun()` on the watcher as a thin wrapper. This unblocks `handleAwaitCiRun` in ci-handlers.js (currently returns "CI await is not available in this build" because it checks `typeof watcher.awaitRun !== 'function'`).

**Bug fix required (CRITICAL-1):**
`GitHubActionsProvider._normalizeRun()` drops the `conclusion` field — it maps `status + conclusion` into a single `status` via `_normalizeRunStatus()`. This loses the `failure` vs `timed_out` distinction. Fix: add `conclusion` to the `_normalizeRun()` output alongside the normalized `status`. Both `_isFailedRun()`, `_getConclusion()`, and `handleAwaitCiRun` read `run.conclusion`, so this is load-bearing.

**Bug fix required (CRITICAL-3):**
`handleAwaitCiRun` reads `args.timeout_ms` / `args.timeoutMs` but the tool definition specifies `timeout_minutes`. Add a minutes-to-milliseconds conversion: `const timeoutMs = (args.timeout_minutes ?? 30) * 60 * 1000`. Also wire `args.diagnose` (currently ignored) and `args.commit_sha` (currently ignored — could be used to find a run by SHA when `run_id` is unknown).

### Layer 2: Diagnosis (parse + categorize)

**Status:** 30% built in `server/ci/diagnostics.js`

The diagnostics module parses CI log output and extracts structured failure data. The core utilities exist but the categorization needs significant expansion.

**What exists:**
- `buildFailure()` — creates structured failure objects with category, file, test_name, line, message, raw_output
- `normalizeLog()` / `truncateToBytes()` — log processing utilities
- `diagnoseFailures()` — main entry point, produces `{ failures, triage }` object
- `categorizeError()` — categorizes into: `lint`, `test`, `build`, `infrastructure`, `timeout`, `unknown`
- Extraction functions: `extractTestFailure()`, `extractLintFailure()`, etc.

**What needs to be built:**

The existing `categorizeError()` uses categories: `lint`, `test`, `build`, `infrastructure`, `timeout`, `unknown`. The new taxonomy splits `test` into sub-categories and renames `infrastructure` → `infra`. This requires:

1. **New extraction functions** for each sub-category (not just heuristic additions to existing code):
   - `extractSchemaFailure()` — detect SQLite schema errors
   - `extractPlatformFailure()` — detect environment-specific errors
   - The existing `extractTestFailure()` becomes the catch-all for `test_logic`

2. **Updated `categorizeError()`** — new category names with backward-compatible mapping:
   - `lint` → `lint` (unchanged)
   - `test` → split into `test_schema`, `test_logic`, `test_platform`
   - `build` → `build` (unchanged)
   - `infrastructure` → `infra`
   - `timeout` → `infra` (merge into infra)
   - `unknown` → `unknown` (unchanged)

3. **Enhanced `diagnoseFailures()` return shape:**

```js
{
  categories: {
    lint: { count: 3, failures: [...] },
    test_schema: { count: 8, failures: [...] },
    test_logic: { count: 5, failures: [...] },
    test_platform: { count: 2, failures: [...] },
    build: { count: 0, failures: [] },
    infra: { count: 1, failures: [...] }
  },
  total_failures: 19,
  triage_summary: "19 failures: 8 schema, 5 logic, 3 lint, 2 platform, 1 infra",
  triage: "... existing markdown triage report (preserved for backward compat) ...",
  suggested_actions: [
    { category: "lint", action: "auto-fixable", description: "Run eslint --fix or submit to codex" },
    { category: "test_schema", action: "schema-sync", description: "Update test DB bootstrap" },
    { category: "test_logic", action: "manual-review", description: "Test expectations don't match behavior" }
  ]
}
```

**Category detection heuristics (new extraction functions):**
- `test_schema` — `SqliteError`, `no column named`, `FOREIGN KEY constraint`, `NOT NULL constraint`, `ON CONFLICT clause`
- `test_platform` — `spawn EPERM`, `ENOENT`, `process activity`, timing-related (`timeout of \d+ms exceeded` in test output)
- `test_logic` — `AssertionError`, `expected .* to be`, `TestingLibraryElementError`, `element could not be found`

### Layer 3: Notification (push + pull)

**Status:** 70% built

**Push (lean notification to all sessions):**

`_notifyFailure` in `watcher.js` already pushes through `mcpSse.pushNotification`. Enhance the payload:

```js
{
  type: 'ci:run:failed',
  data: {
    run_id: '23473431673',
    repo: 'torque-ai/torque-ai',
    branch: 'main',
    commit_sha: run.sha,  // NOTE: normalized runs use `sha`, map to `commit_sha` for consumers
    conclusion: run.conclusion,  // requires CRITICAL-1 fix to be available
    url: 'https://github.com/torque-ai/torque-ai/actions/runs/23473431673',
    category_counts: { lint: 3, test_schema: 8, test_logic: 5 },
    total_failures: 16,
    triage_summary: "16 failures: 8 schema, 5 logic, 3 lint"
  }
}
```

Target: ~200 tokens in Claude's context. Enough to know what happened and decide whether to act.

**Pull (full diagnosis on demand):**

`diagnose_ci_failure` MCP tool already exists. The current handler (`handleDiagnoseCiFailure`) returns only `report.triage` (a markdown string) and discards the `failures` array. Enhance to return both:

```js
// MCP response format
{
  content: [
    { type: 'text', text: report.triage },  // markdown triage for display
    { type: 'text', text: JSON.stringify({   // structured data for programmatic use
      categories: report.categories,
      total_failures: report.total_failures,
      suggested_actions: report.suggested_actions,
      failures: report.failures
    }) }
  ]
}
```

### Auto-Activation

**Status:** Not built

Currently, Claude must manually call `watch_ci_repo` to start watching. Add auto-activation:

1. When TORQUE starts, check project defaults for projects with a `ci_repo` setting and auto-activate watches
2. When a task is submitted with a `working_directory` that's a git repo, resolve the remote and auto-activate a watch if not already active. **Insertion point:** in `handleSubmitTask()` within `server/handlers/task/core.js`, after the task is created and before the response is returned. The `working_directory` is available from `args.working_directory`.
3. Store the repo in project defaults so it persists across restarts

This means: once you've used TORQUE in a repo with a GitHub remote, CI watching is automatic from then on.

## DI Consolidation Note

`watcher.js` currently does its own DB access (`_getWatch`, `_upsertWatchRecord`, `_deactivateWatchRow`, `_hasRunBeenDiagnosed`, `_cacheRunDiagnostic`) with direct SQL against the same tables that `server/db/ci-cache.js` manages. Phase 1 should consolidate: move all CI DB operations to `ci-cache.js` and have the watcher call through it. This follows the existing DI migration pattern in the codebase.

## Implementation Phases

### Phase 1: Core Pipeline (awaitRun + diagnosis + notification)

Files to modify:
- `server/ci/github-actions.js` — fix `_normalizeRun()` to preserve `conclusion` field (CRITICAL-1)
- `server/ci/provider.js` — implement `watchRun()` polling loop on base class
- `server/ci/watcher.js` — implement `awaitRun()` as thin wrapper around `provider.watchRun()`
- `server/ci/diagnostics.js` — add sub-category extraction functions, enhance `diagnoseFailures()` return shape
- `server/handlers/ci-handlers.js` — fix `handleAwaitCiRun` timeout_minutes conversion (CRITICAL-3), wire `diagnose` param, enhance `handleDiagnoseCiFailure` to return structured data
- `server/ci/watcher.js` `_notifyFailure()` — enhance payload with category counts + `conclusion`
- `server/db/ci-cache.js` — consolidate watcher's inline DB operations here
- `server/tests/ci-watcher.test.js` — test `awaitRun`, test `conclusion` preservation
- `server/tests/ci-diagnostics.test.js` — test new category detection heuristics

**Verification:** `watch_ci_repo` → push a failing commit → notification arrives with category counts → `diagnose_ci_failure` returns structured categories.

### Phase 2: Auto-Activation

Files to modify:
- `server/ci/watcher.js` — add `autoActivateForRepo(workingDirectory)` that resolves git remote → repo name, checks if watch exists, activates if not
- `server/handlers/task/core.js` — call `autoActivateForRepo` in `handleSubmitTask()` after task creation when `working_directory` is provided
- `server/index.js` — on startup, auto-activate watches for all projects with `ci_repo` in project defaults
- `server/db/config-core.js` or project defaults — persist the `ci_repo` association

**Verification:** Submit a task in a git repo → watch auto-activates → CI failures detected without manual setup.

### Phase 3: Slash Command

Files to create/modify:
- `.claude/commands/torque-ci.md` — slash command definition
- `server/handlers/ci-handlers.js` — ensure all operations are exposed as MCP tools

**Command interface:**
```
/torque-ci                  # Show watch status + recent failures
/torque-ci watch            # Activate watch for current repo
/torque-ci stop             # Stop watching
/torque-ci diagnose <run>   # Full diagnosis of a specific run
/torque-ci history          # Recent CI runs and their status
```

## Data Flow

```
git push
  ↓ (15-30s)
watcher._pollWatch()
  → provider.listRuns({ branch })
  → detect new completed run with conclusion=failure
  ↓ (inline within _pollWatch — no separate _processFailedRun function)
provider.getFailureLogs(runId)
  → diagnostics.diagnoseFailures(logs)
  → returns { categories, triage_summary, triage, suggested_actions, failures }
  ↓
ciCache.upsertCiRunCache(...)
  → persist to ci_run_cache table
  ↓
watcher._notifyFailure()
  → mcpSse.pushNotification({ type: 'ci:run:failed', data: { ...lean payload } })
  → all connected Claude sessions receive notification
  ↓
Claude session receives notification via check_notifications
  → decides to act
  → calls diagnose_ci_failure(run_id) for full structured details
  → fixes the issues
```

## Error Handling

- **`gh` CLI not available:** `checkPrerequisites()` already handles this, returns `{ ready: false, error }`. Watch silently pauses until next poll.
- **GitHub rate limits:** Current behavior (swallow error, retry at next interval) is acceptable for background polling. No exponential backoff needed — the fixed 30s interval is already conservative relative to GitHub's 5000 req/hr limit.
- **TORQUE restart:** Watches are persisted in `ci_watches` table and restored on startup (already implemented).
- **Multiple sessions:** All sessions receive the notification. First to act wins. No coordination needed — git handles the merge.
- **Stale watch:** If no new runs appear for 24h, log a debug message but keep watching. No auto-deactivation.

## Non-Goals

- GitHub webhook receiver (future — requires internet exposure)
- Auto-fix submission to codex (future — start with notification-only, graduate to tiered auto-fix once categorization is trusted)
- Non-GitHub CI providers (architecture supports it via `CIProvider` base class, but only GitHub Actions is implemented)
- Dashboard UI for CI status (future)
