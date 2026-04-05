# Quality Sweep
Date: 2026-04-05
Variant: quality
Scope: `server/` (full project)
Agent: TORQUE Scout

## Baseline
- Reviewed prior scans under `docs/findings/` before scanning current code.
- Excluded already-reported/fixed themes called out in the request: the old handler DI bypasses, `normalizeMetadata` dedup, `getEffectiveGlobalMaxConcurrent` dedup, `RemoteAgentRegistry` dedup, and the earlier inline-`require()` cleanup work.

## Summary
5 new findings: 1 high, 4 medium.

## Findings

### [HIGH] Six unreported `database.js` DI bypasses still fail the repo's own direct-import guard
- Files:
  - `server/dashboard/router.js:79-127`
  - `server/handlers/governance-handlers.js:66-95`
  - `server/handlers/integration/routing.js:304-318`
  - `server/handlers/task/core.js:300-314`
  - `server/providers/v2-local-providers.js:84-92`
  - `server/tools.js:297-307`
- Description: Running `node server/scripts/check-no-direct-db-import.js` still reports 10 source violations. Four of those were already documented on 2026-04-04 (`execution/completion-pipeline.js`, `execution/fallback-retry.js`, `handlers/discovery-handlers.js`, `handlers/model-registry-handlers.js`). The six files above are newly identified by this sweep. Each path still reaches for `require('../database')` or `getDbInstance()` from request/tool code instead of using injected services. The most concerning cases are `dashboard/router.js` and `governance-handlers.js`, which both do container lookup first and then silently fall back to a direct database require, and `tools.js`, which rebuilds remote-agent handlers outside the plugin install path.
- Suggested fix: Finish the DI migration for these six files and make `check-no-direct-db-import.js` pass without relying on the fallback facade in request-time code.

### [MEDIUM] Version-intent enforcement is duplicated across four write paths and already diverges
- Files:
  - `server/handlers/task/core.js:298-314`
  - `server/handlers/integration/routing.js:304-318`
  - `server/handlers/workflow/index.js:638-660`
  - `server/db/cron-scheduling.js:380-466`
- Description: The same "versioned project requires `version_intent`" rule is implemented four times. The `submit_task` and `smart_submit_task` variants use raw `require('../../database').getDbInstance()` and swallow all lookup failures with `catch (_e) { /* ... allow */ }`. The workflow path uses `defaultContainer.get('db')` and returns an MCP error object instead of throwing. The cron paths inline-require the version-intent module inside the function and rethrow only when the error message happens to contain `version_intent`. This is the same rule, but it now has three different data-access paths and three different failure behaviors.
- Suggested fix: Extract a single helper such as `enforceVersionIntentForProject({ db, workingDirectory, intent, mode })` and call it from all four entry points.

### [MEDIUM] `server/auth/mcp-config-injector.js` looks like dead duplicated production code
- Files:
  - `server/auth/mcp-config-injector.js:13-56`
  - `server/index.js:201-252`
  - `server/plugins/auth/config-injector.js:27-98`
- Description: The repository currently has three separate implementations of "inject TORQUE into `.claude/.mcp.json`": `ensureGlobalMcpConfig()` in `server/auth/mcp-config-injector.js`, `ensureLocalMcpConfig()` in `server/index.js`, and `ensureGlobalMcpConfig()` in `server/plugins/auth/config-injector.js`. The `server/auth/mcp-config-injector.js` copy appears to be dead in production: a repo-wide search found no non-test imports of it, while `server/tests/mcp-config-injector.test.js` still exercises it directly. All three copies independently maintain the same JSON merge, temp-file rename, and Windows `icacls` logic, so behavior can drift.
- Suggested fix: Consolidate on one implementation and either delete `server/auth/mcp-config-injector.js` or turn it into a thin adapter used by both startup and the auth plugin.

### [MEDIUM] Provider quota telemetry failures are silently swallowed in three adapters
- Files:
  - `server/providers/openrouter.js:128-138,207-217`
  - `server/providers/groq.js:62-72,160-170`
  - `server/providers/cerebras.js:66-76,158-168`
  - `server/db/provider-quotas.js:10-10`
- Description: All three adapters wrap `getQuotaStore().updateFromHeaders(...)` and `record429(...)` in empty `catch {}` blocks. `provider-quotas.js` is not cosmetic state: it feeds both the dashboard quota endpoints and smart-routing exhaustion checks. If quota parsing or store initialization breaks, the system loses rate-limit telemetry silently and routing decisions continue with stale or missing quota state. Because the catches are empty, there is no debug signal when this happens.
- Suggested fix: Route quota updates through one shared helper that logs at least debug-level failures, or return a boolean/result so the adapters can record telemetry errors explicitly.

### [MEDIUM] `executeOllamaTask()` is a new 763-line complexity hotspot in the local-provider path
- File: `server/providers/execute-ollama.js:182-944`
- Description: `executeOllamaTask()` now combines model fallback, host discovery, exact/variant model matching, VRAM admission control, slot reservation, task requeueing, dashboard notification, process scheduling, request dispatch, and cleanup in one function. The function contains multiple nested "select host -> requeue -> notify -> retry" branches, and the same requeue/error-output pattern appears in several branches. This file was not called out in the 2026-04-04 quality scans, but it is now one of the largest single functions in the server tree.
- Suggested fix: Split it into explicit phases: resolve requested model, choose host, reserve slot, execute request, and handle requeue/release.
