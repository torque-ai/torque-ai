# Stall Detection + Retry Framework

> Canonical reference for the four interlocking subsystems that decide what happens when a task stops making progress, fails outright, or needs to fall back to a different provider. If you are about to add a config knob, classifier rule, recovery strategy, or retry path, **start here** — incremental fixes are how this surface grew into the chaos it became.

This doc covers the **execution-layer** retry path. The factory's auto-recovery engine and the verify-fail loop layer cross-reference here but are documented separately:

- [`docs/recovery-decisions.md`](recovery-decisions.md) — factory recovery engine + replan/rejected sweeps + execution-layer retry catalog (how this layer's decisions surface in the factory)
- [`docs/factory.md`](factory.md) — verify-stall recovery for the factory loop (a peer of execution-stall recovery, separate cadence)

---

## The four subsystems

| Subsystem | Owner | Role | Triggered by |
|-----------|-------|------|--------------|
| **Stall detection** | `server/maintenance/orphan-cleanup.js` (`checkStalledTasks`) | Periodic sweep that finds running tasks with no recent output and routes them to recovery or cancel. | 60s interval started in `startTimers` |
| **Retry framework** | `server/execution/retry-framework.js` (`handleRetryLogic`) | Phase 1 of close-handler. On `code !== 0`, classifies the error and either schedules a same-provider retry with exponential backoff or falls through to normal failure. | Subprocess close handler |
| **Fallback retry** | `server/execution/fallback-retry.js` (`tryStallRecovery`, `tryLocalFirstFallback`, `tryOllamaCloudFallback`, `tryHashlineTieredFallback`) | Switches edit format, escalates model size, jumps providers, or routes to cloud when same-provider retry won't help. | `tryStallRecovery` (from `checkStalledTasks`); also called from host-failover cleanup, codex banner-only short-circuit, and ollama-down auto-pivot |
| **Auto-verify retry** | `server/validation/auto-verify-retry.js` (`handleAutoVerifyRetry`) | Phase 6.5 of close-handler. After a Codex/Codex-Spark task succeeds, runs the project's `verify_command` and auto-submits an error-feedback fix task on failure. | Subprocess close handler (success path only) |

A stalled task can pass through three of these in one lifetime: stall detection picks it up → tryStallRecovery picks a strategy → if attempts exhausted, fallback to provider chain → eventual failure triggers retry framework if classification says retryable.

---

## End-to-end lifecycle

### Path A — task stalls (no output)

1. Task running. Activity monitor records `lastOutputAt` per chunk via `armActivity` in `process-streams.js`.
2. Every 60 seconds, `checkStalledTasks` (orphan-cleanup) iterates `runningProcesses`:
   - Computes `lastActivitySeconds = now - lastOutputAt`.
   - Looks up `stallThreshold` via `getStallThreshold(model, provider)` — runtime config override > model-size heuristic > provider default. Returns `null` for excluded providers (codex/claude-cli are NULL by default).
   - **PID-alive grace:** if the subprocess PID is still live and `lastActivitySeconds <= threshold * 1.5`, the threshold is extended in-place and `stall_threshold_extended` runtime problem is reported. Catches long I/O waits where the process isn't actually dead.
   - **Session-monitor defer:** if a Claude session is `await_task`-ing this id (via SSE `isTaskMonitored`), emits `task:stall_warning` event with `deferred_to_session: true` and SKIPS auto-cancel — Claude's heartbeat decides whether to cancel.
   - **80% warning:** at `lastActivitySeconds >= threshold * 0.8`, emits `task:stall_warning` once via `_stallWarningEmitted` Set.
3. On stall + `autoCancel=true` + `stall_recovery_enabled` config:
   - Calls `tryStallRecovery(taskId, activity)` from fallback-retry.
4. `tryStallRecovery` decides strategy by attempt count (in `_stallRecoveryAttempts` Map):
   - **Attempt 1**: switch edit format `diff → whole` (if not already).
   - **Attempt 2** (ollama-only): `findLargerAvailableModel(currentModel)` — climbs `1b → 3b → 4b → 7b → ... → 405b`. If found, switches model. If not, tries `tryLocalFirstFallback({ skipSameModel: true })`.
   - **Attempt 3+**: `tryLocalFirstFallback` (jumps to next provider in `getProviderFallbackChain(currentProvider)`).
   - **Exhausted** (≥ `stall_recovery_max_attempts`, default 3): `cancelTask(reason='Stall recovery exhausted', cancel_reason='fallback_retry_exhausted')`.
5. Selected strategy: `_markTaskCleanedUp` → `_stopTaskForRestart` → record `failover_event` → re-queue with `status='queued'`, `started_at=null`, `pid=null`, `progress_percent=0`, error_output appended with `[STALL RECOVERY] Attempt N: <strategy>`. Resume context prepended via `withResumeContextPrompt`. Re-queue debounced via `STALL_REQUEUE_DEBOUNCE_MS`.
6. Factory worktree grace refreshed via `refreshGraceForOwningTask(taskId)` so loop-controller's pre-reclaim sweep doesn't kill the requeued attempt as overstayed.

### Path B — task exits non-zero (close handler Phase 1)

1. Subprocess `close` event arrives in execute-cli's close handler.
2. `handleRetryLogic(ctx)` runs:
   - `classifyError(proc.errorOutput, code)` returns `{ retryable, reason, retryAfterSeconds? }`.
   - If retryable AND `incrementRetry(taskId).shouldRetry`:
     - `recordRetryAttempt` writes to retry table.
     - Status → `retry_scheduled` with sanitized output + appended error tag.
     - Resume context built via `buildRetryResumeFields` (calls `prependResumeContextToPrompt` which strips any pre-existing `## Previous Attempt` preamble first — anti-stacking contract shared with fallback-retry's `withResumeContextPrompt`).
     - SSE `retry` event dispatched + retry webhook fired.
     - `setTimeout(delayMs)` schedules re-queue. `pendingRetryTimeouts.set(taskId, handle)` for cancel-time reaping.
     - **delayMs = `db.calculateRetryDelay(task) * 1000`** (typically exponential with jitter from `getRetryDelayMs` — base 5s, max 2min, ±50% jitter).
   - On timer fire: status-allow-list check (`status === 'retry_scheduled'`, NOT a deny-list) before re-queue. Tasks moved to `failed` / `cancelled` / `completed` / `shipped` / `unactionable` / `escalation_exhausted` during the delay window are NOT resurrected (regression fix from 2026-05-06).
   - Sets `ctx.earlyExit = true` so close handler skips normal failure path.
3. If `!retryable` OR retries exhausted: `handleRetryLogic` returns without setting `earlyExit`; close handler proceeds to normal `db.updateTaskStatus(taskId, 'failed', ...)`.

### Path C — task succeeds, verify_command fails (close handler Phase 6.5)

1. Close handler reaches `handleAutoVerifyRetry(ctx)` after status set to `completed`.
2. Guards: skip `factory:internal` tagged, skip read-only factory scout tasks, skip if no `working_directory`, skip if no `verify_command` configured for project.
3. Provider gate: `auto_verify_on_completion` flag — defaults ON for `AUTO_VERIFY_PROVIDERS = {codex, codex-spark}`, defaults OFF for others (opt-in via `set_project_defaults`).
4. Resource gate: `checkResourceGate(hostActivityCache, hostId)` — if host overloaded, skip verify.
5. Execute verify: `runVerifyCommandInSandbox(task, verifyCommand, sandboxConfig)` — routes to remote workstation if `prefer_remote_tests` and runner registered, else local.
6. On non-zero exit: parses failing tests, builds error-feedback prompt, **submits a NEW task** with parent task id in metadata. The new task is what runs the fix; the original stays `completed` with its verify result tagged.

### Path D — host goes down mid-task

1. Health check detects host failure → `cleanupOrphanedHostTasks(hostId, hostName)`.
2. For each running task on the failed host:
   - Removed from `runningProcesses`, timeouts cleared, `stallRecoveryAttempts` cleared.
   - Status → `failed` with `[HOST FAILOVER] Host '<name>' became unavailable...` appended.
   - `db.incrementRetry(taskId)` + if `shouldRetry`, `tryLocalFirstFallback` requeues on next provider in chain.
3. `processQueue()` to admit retried tasks.

---

## Decision: which path fires?

```
Subprocess running
├─ produces output → activity recorded → no action
├─ stops producing output (>threshold)
│   └─ checkStalledTasks → tryStallRecovery → strategy chosen → re-queue OR exhaust→cancel
├─ exits with code !== 0
│   └─ Phase 1: handleRetryLogic → classifyError
│       ├─ retryable + retries left → retry_scheduled → setTimeout → queued
│       └─ non-retryable OR exhausted → failed
└─ exits with code === 0
    └─ Phase 6.5: handleAutoVerifyRetry → verify_command runs
        ├─ pass → done
        └─ fail → submit new error-feedback fix task; original stays completed
```

`tryStallRecovery` and `handleRetryLogic` can both fire for the same task across one execution (stall recovery requeues → eventual non-zero exit → retry framework picks up). The two systems do NOT coordinate on attempt counts — `_stallRecoveryAttempts` (in-memory Map) and `tasks.retry_count` (DB column) are independent. This is intentional but undocumented; see open question #1.

---

## Configuration knobs

All set via `configure_stall_detection` MCP tool, `set_project_defaults`, or direct `setConfig` calls. **No hardcoded defaults inside the modules** — thresholds live in the `config` table.

### Stall thresholds (per provider)

Config keys map via `PROVIDER_STALL_CONFIG_KEYS` in `orphan-cleanup.js:229-240`:

| Provider | Config key | Default behavior |
|----------|------------|------------------|
| `ollama` | `stall_threshold_ollama` | 120s |
| `claude-cli` | `stall_threshold_claude` | NULL (excluded — no auto-cancel) |
| `codex` | `stall_threshold_codex` | NULL (excluded) |
| `anthropic` | `stall_threshold_claude` | NULL (excluded — shares claude key) |
| `groq` | `stall_threshold_ollama` | 120s (shares ollama key) |
| `ollama-cloud` | `stall_threshold_ollama_cloud` | 120s |
| `cerebras` | `stall_threshold_cerebras` | 120s |
| `google-ai` | `stall_threshold_google_ai` | 120s |
| `openrouter` | `stall_threshold_openrouter` | 120s |
| `deepinfra`, `hyperbolic`, `claude-ollama`, `claude-code-sdk` | (no entry) | excluded — never stall-detected |

Config value `'null'` or `'0'` explicitly disables for that provider. PROVIDERS not in the map are silently excluded.

### Other knobs

| Config key | Purpose | Default |
|------------|---------|---------|
| `auto_cancel_stalled` | Whether the 60s sweep does anything beyond reporting | OFF |
| `stall_recovery_enabled` | Use `tryStallRecovery` vs direct `cancelTask` | OFF |
| `stall_recovery_max_attempts` | Strategy-attempt cap before exhaustion | 3 |
| `unknown_error_retryable` | classify long unknown errors as retryable | OFF |
| `max_task_lifetime_seconds` | Force-stall any task running longer than this regardless of activity | 0 (disabled, max 86400) |
| `large_model_threshold_b` | Model size that counts as "large" for VRAM guard | 30 |
| `max_large_models_per_host` | Concurrent large-model cap per host | 1 |
| `aider_edit_format` | Default edit format (used as starting point for stall recovery escalation) | `diff` |
| `STALL_REQUEUE_DEBOUNCE_MS` | Delay before `processQueue()` after re-queue | (in `constants.js`) |
| `BASE_RETRY_DELAY_MS` | First-retry delay (exponential base) | 5000 |
| `MAX_RETRY_DELAY_MS` | Cap on exponential backoff | 120000 |

### Per-task retry config

`tasks.max_retries` / `tasks.retry_count` / `tasks.retry_strategy` / `tasks.retry_delay_seconds` / `tasks.last_retry_at`. Set at submit time or via `set_project_defaults`.

### Per-project verify config

`project_defaults`:
- `verify_command` — required for auto-verify Phase 6.5
- `auto_verify_on_completion` — null/undefined defaults ON for codex+codex-spark, OFF for others; explicit `0`/`false` disables; explicit `1`/`true` enables for any provider
- `prefer_remote_tests` — route verify to registered remote workstation

---

## Error classification matrix

`classifyError(errorOutput, exitCode)` in `fallback-retry.js:1028-1204`. Returns `{retryable: bool, reason: string, retryAfterSeconds?: number}`.

### Always retryable (regardless of stack trace heuristic)

| Trigger | Reason |
|---------|--------|
| `getWindowsNativeCrashExitReason(exitCode)` matches | Windows native crash (STATUS_ACCESS_VIOLATION etc.) |
| `isCodexStartupBannerOnlyOutput` | Codex startup banner only — no task output |
| `/no heartbeat.*stale session cleanup/i` | Stale session cleanup after no heartbeat |

### Retryable patterns

Network: `econnreset`, `econnrefused`, `etimedout`, `enetunreach`, `socket hang up`, `network error`. Rate limit: `rate limit`, HTTP 429, `too many requests`. Server: HTTP 500/502/503/504, `internal server error`, `service unavailable`. Resource: `resource busy`, `try again`, `temporarily unavailable`.

### Non-retryable patterns

Git/repo: `not inside a trusted directory`, `not a git repository`, `permission denied`, `access denied`. Syntax/logic: `syntax error`, `command not found`, `no such file or directory`. Auth: `authentication failed`, `invalid credentials`, `unauthorized`, `invalid api key`. Disk: `disk full`, `no space left`, `read-only file system`. Module: `cannot find module`, `module not found`, `cannot resolve`. Type/compile: `typeerror` (NOT network-layer), `reference error`. Config: `invalid configuration`, `missing required.*config`.

### Heuristics (after pattern check)

| Heuristic | Result |
|-----------|--------|
| Stack trace `/at \w+\s+\(/` OR `TypeError:`/`ReferenceError:`/`RangeError:` (excluding network TypeErrors) | non-retryable: "Code error detected" |
| `ENOENT|no such file|file not found` | non-retryable: "File not found" |
| `ENOSPC|no space left|disk full` | non-retryable: "Disk space exhausted" |
| `ENOMEM|out of memory|heap out of memory|JavaScript heap` | retryable: "Out of memory — may recover with smaller input" |
| `exitCode === 1 && errorText.length < 100` | retryable: "Unknown short error — may be transient" |

### Subprocess sentinels (numeric exit codes from execute-cli)

| Code | Meaning | Classification |
|------|---------|----------------|
| `-101` | EXIT_SPAWN_INSTANT_EXIT | retryable |
| `-102` | EXIT_CLOSE_HANDLER_EXCEPTION | retryable |
| `-103` | EXIT_SPAWN_ERROR | retryable |
| `-1` (with <50 chars output) | premature exit, no diagnostics | retryable |
| `[process-exit] terminated by signal SIG<X>` (legacy or structured format) | killed by OS | retryable: "Process killed by signal X" |

### Fallthrough

`errorText.length > 500 && !unknown_error_retryable` → non-retryable. Otherwise → retryable: "Unknown error — attempting retry".

### Anti-drift hooks

The `[process-exit]` annotation parsing has been bitten three times in this audit's history: codex banner false-classify (8651798b), missing `stopTaskForRestart` export (82388112), and the retry-framework status allow-list regression (2026-05-06). Format helpers live in `server/utils/process-exit-format.js` so writer and reader can't drift.

---

## Cross-subsystem invariants

### Resume-context strip-first contract

Both `retry-framework.handleRetryLogic` and `fallback-retry.tryStallRecovery` may build a resume context for the same task across one lifetime (stall → exhaust → exit non-zero → retry). Both call `prependResumeContextToPrompt(task.task_description, ctx)` from `server/utils/resume-context.js`, which strips any existing `## Previous Attempt` preamble before re-prepending. **Without this, retry would stack two preambles.** This contract is documented in `recovery-decisions.md` conflict #3 and unit-tested via `buildRetryResumeFields` exposure for cross-call-site assertion.

### retry_scheduled status allow-list

The `setTimeout` callback in `handleRetryLogic` MUST gate on `currentTask.status === 'retry_scheduled'` (allow-list), NOT `status !== 'cancelled'` (deny-list). Pre-2026-05-06 the deny-list let `failed` / `completed` / `shipped` / `unactionable` rows get reset to `queued` and re-run when the timer fired — see `cancellation-cleanup.md` for the full pattern.

### Re-queue side effects

`tryStallRecovery`'s re-queue path MUST refresh the factory worktree grace via `refreshGraceForOwningTask(taskId)`. Without it, `loop-controller`'s `pre_reclaim_before_create` sweep treats the row's old `created_at` as overstay and cancels the in-flight retry. Same shape as the `pre_reclaim_before_create` race documented in `factory.md`.

### Independent attempt counters

`_stallRecoveryAttempts` (in-memory Map keyed by taskId, holds `{attempts, lastStrategy}`) and `tasks.retry_count` (DB column, incremented by `db.incrementRetry`) are independent. A task that exhausts stall recovery (3 attempts) AND retry framework (max_retries) consumes both budgets. Documented intentional separation but operators frequently conflate them — see open question #1.

### Stall warning event vs cancel decision

`task:stall_warning` event fires at 80% threshold AND when threshold breached but session-monitored (`deferred_to_session: true`). Operators relying on the warning event to decide cancellation must consume both signals — the second one is not a "still warning, not cancelled yet" — it's "stalled but waiting on Claude."

---

## Failover chains

### Default chain table (`getProviderFallbackChain` in `db/smart-routing.js:1024-1036`)

| Origin | Chain order |
|--------|-------------|
| `codex` | claude-cli → deepinfra → ollama-cloud → ollama |
| `claude-cli` | codex → deepinfra → ollama-cloud → ollama |
| `groq` | ollama-cloud → cerebras → deepinfra → claude-cli → ollama |
| `ollama-cloud` | cerebras → deepinfra → claude-cli |
| `cerebras` | google-ai → ollama-cloud → deepinfra → codex |
| `google-ai` | openrouter → cerebras → ollama-cloud → deepinfra → codex |
| `openrouter` | google-ai → cerebras → ollama-cloud → deepinfra → codex |
| `hyperbolic` | deepinfra → ollama-cloud → claude-cli → codex → ollama |
| `deepinfra` | ollama-cloud → hyperbolic → claude-cli → codex → ollama |
| `ollama` | ollama-cloud → deepinfra → codex → claude-cli |
| (any other) | ollama → deepinfra → codex → claude-cli |

User overrides via `setConfig('fallback_chain_<provider>', JSON.stringify([...]))`. **`anthropic` is intentionally NOT in any default chain** (cost guard).

### Chain reordering by score

If `getAllProviderScores({trustedOnly:true})` returns scores, the chain is stable-sorted: scored providers first by `composite_score` desc, unscored providers keep relative order. Membership preserved — only order changes.

### `cloudOnly` filter

`tryOllamaCloudFallback` calls `getProviderFallbackChain(provider, {cloudOnly:true})`. Filters via `LOCAL_PROVIDERS` set so Ollama-down paths can skip back to local.

---

## Tool reference

| Tool | Purpose | Owner |
|------|---------|-------|
| `configure_stall_detection` | Set per-provider stall thresholds + `stall_recovery_max_attempts` + auto-cancel toggle | `automation-handlers.js` |
| `configure_fallback_chain` | Set `fallback_chain_<provider>` config key | provider-handlers |
| `auto_verify_and_fix` | Manual one-shot: run verify + auto-submit fix on failure | validation handlers |
| `set_project_defaults` | Set `verify_command`, `auto_verify_on_completion`, `prefer_remote_tests`, `max_retries`, `retry_strategy`, `retry_delay_seconds` | core handlers |

---

## Test coverage map

| Concern | Test file |
|---------|-----------|
| classifyError matrix | `tests/fallback-retry.test.js` |
| handleRetryLogic happy path + status-allow-list | `tests/retry-framework.test.js` |
| tryStallRecovery strategy progression | `tests/integration-stall-recovery.test.js` |
| Auto-verify Phase 6.5 codex flow | `tests/auto-verify-retry.test.js` |
| Auto-verify dotnet Phase X8 | `tests/phasex8-verify-retry-dotnet.test.js` |
| Adaptive retry envelope | `tests/adaptive-retry.test.js` |
| Base-provider Retry-After header parsing | `tests/base-provider-retry-after.test.js` |
| Cancel during retry_scheduled window | `tests/cancel-retry-scheduled.test.js` |
| Stall detection load/stress | `tests/load-stress-stall.test.js` |
| Verify-stall recovery (factory layer) | `tests/verify-stall-recovery.test.js`, `verify-stall-recovery-decisions.test.js`, `verify-stall-recovery-persistence.test.js` |
| Provider quota fallback (codex 429 → cloud) | `tests/quota-fallback-codex.test.js` |
| Loop-controller codex fallback | `tests/loop-controller-codex-fallback.test.js` |
| Codex fallback phase smoke (1/2/3) | `tests/integration/codex-fallback-phase{1,2,3}-smoke.test.js` |
| Local-first fallback | `tests/local-first-fallback.test.js` |
| Dynamic fallback model | `tests/dynamic-fallback-model.test.js` |
| Deterministic fallbacks (orchestrator) | `tests/deterministic-fallbacks.test.js` |

---

## Open questions / risks

These are the known soft spots — incremental fixes here without a unifying audit are how this surface accreted. Address them before adding new strategies, classifier rules, or chain entries.

### 1. ✅ ~~Two independent attempt counters with no joint cap~~ RESOLVED 2026-05-07

Opt-in `combined_max_attempts` config (default `0` = disabled). When set to a positive integer, both `tryStallRecovery` and `handleRetryLogic` check `task.retry_count + task.stall_recovery_attempts >= combined_max_attempts` before allowing further recovery. On hit:

- `tryStallRecovery` cancels the task with `cancel_reason='combined_attempts_exhausted'` and the reason string `Combined attempt cap reached (stall=N + retry=M >= K)`.
- `handleRetryLogic` returns without setting `ctx.earlyExit`, so the close handler proceeds with normal failure handling. Log line records the cap hit so operators can see why no retry fired.

Default unset preserves existing behavior — independent counters with worst-case `stall_max × (retry_max + 1)` total runs. Operators wanting a hard combined ceiling set the value via `configCore.setConfig('combined_max_attempts', '6')` or similar.

### 2. ✅ ~~`_stallRecoveryAttempts` Map is purely in-memory~~ RESOLVED 2026-05-07

Migration v58 adds `tasks.stall_recovery_attempts INTEGER NOT NULL DEFAULT 0`. `tryStallRecovery` now seeds `recovery.attempts` from `task.stall_recovery_attempts` when the in-memory Map is empty (post-restart sweep) and takes `max(memEntry.attempts, persistedAttempts)` when both are present. Persisted on every Map write — folded into the main re-queue's `updateFields` and called via `persistStallRecoveryAttempts(taskId, attempts)` on the two early-return paths that call `tryLocalFirstFallback`. No re-adoption restore needed at the execute-cli layer — the read happens lazily on the next stall sweep, which fires every 60s.

Strategy ladder is purely attempt-count-driven (`recovery.attempts === 0` → switch_edit_format, `<= 1 + ollama` → switch_model, else → local_first_fallback) so the integer alone is sufficient. `lastStrategy` was log-only and remains in-memory; not persisted.

5 unit tests in `tests/fallback-retry.test.js` (`stall_recovery_attempts persistence` describe block):
1. Persists on the main re-queue path (attempt 1 → DB shows 1)
2. Persists on the local-first early-return path (attempt 3+ → DB shows 3)
3. Seeds from persisted column when Map is empty (post-restart simulation: DB=1, Map empty → next attempt is 2)
4. Exhausts via persisted count when Map is empty and DB is at max (DB=3, Map empty, max=3 → cancelled)
5. Takes max(persisted, memory) when both are present (Map=1, DB=3, max=3 → cancelled)

### 3. ✅ ~~PID-alive grace path inconsistent with session-monitor defer~~ RESOLVED 2026-05-07

The session-monitor defer (`isTaskMonitored`) now runs BEFORE the alive-grace threshold extension in `checkStalledTasks`. When a Claude session is monitoring a stalled task, the iteration emits `task:stall_warning` with `deferred_to_session: true` and continues — the alive-grace block (which would silently mutate `activity.stallThreshold` and clear `isStalled`) never fires. This matches the operator's mental model: the monitor is the source of truth for "what to do about stalls," not the alive-grace's silent threshold extension.

Two reasons for short-circuiting first:
1. **Cheaper** — no `isProcessAlive(pid)` syscall when the answer is "Claude handles it"
2. **Honest** — the monitor's `task:stall_warning` event carries the actual configured threshold, not a silently-extended value the monitor didn't know about

### 4. ✅ ~~`claude-cli` and `codex` excluded from stall detection by default~~ RESOLVED 2026-05-07

`logStallDetectionAudit()` runs once from `orphan-cleanup.startTimers()` at server boot. It iterates `PROVIDER_STALL_CONFIG_KEYS` (de-duping shared config keys like anthropic↔claude-cli, groq↔ollama) and emits up to three info-level log lines:

1. `[StallAudit] auto_cancel_stalled=OFF` — only when the master toggle is off (stall detection runs but won't act)
2. `[StallAudit] Stall detection DISABLED for: codex(stall_threshold_codex), claude-cli(stall_threshold_claude)...` — names every provider whose threshold is unset/null/0; always names the config key so the operator can paste it into a `setConfig` call
3. `[StallAudit] Stall detection enabled: ollama=120s, ollama-cloud=120s | recovery=ON` — confirms what IS being protected

Default-config operators see disabled providers immediately on `tail -f torque.log` at boot. Doesn't change behavior — operators who *want* codex/claude-cli stall detection disabled can ignore the line.

### 5. `max_task_lifetime_seconds` is global, not per-provider

The hard cap fires regardless of provider. Codex tasks legitimately running 30-60 min would need the cap set high enough to cover them, which makes it useless as a watchdog for fast providers. **Action:** Make it per-provider (mirror the threshold map) OR document it as "codex-aware: should be set to 2× longest expected codex run."

### 6. ✅ ~~Auto-verify Phase 6.5 has no per-provider chain~~ RESOLVED 2026-05-07

`handleAutoVerifyRetry` now reads `config.auto_verify_fix_provider` (per-project, set via `set_project_defaults`) and passes it as the `provider` field on the new fix task instead of `null`. Default unset = current behavior (smart routing picks). When set, the fix task is pinned to the override provider and `metadata.fix_provider_override` records the choice for audit.

Use case: a provider that succeeds the implementation but fails the test-fix loop (cerebras succeeding simple files but looping on test failures) gets unstuck by routing fix tasks to codex-spark or codex.

Config example:

```js
configCore.setProjectConfig('myproject', {
  auto_verify_fix_provider: 'codex-spark',
});
```

Log line `[auto-verify] Task X: routing fix task to override provider 'codex-spark' (auto_verify_fix_provider)` confirms the routing on each fix submission.

### 7. `tryHashlineTieredFallback` overlaps with chain-based fallback

`fallback-retry.js` exports both `tryHashlineTieredFallback` (escalates by hashline-format capability) and `tryLocalFirstFallback` (chain-based). The two strategies can fight: hashline-tiered may pick a model that the chain would have skipped. **Action:** Document precedence (currently: tryStallRecovery uses chain-based; codex banner short-circuit uses hashline-tiered) OR unify under one selector.

### 8. `STALL_REQUEUE_DEBOUNCE_MS` lives in constants.js but `BASE_RETRY_DELAY_MS` lives in fallback-retry.js

Two different "delay before requeue" knobs in two different files. The first protects against thundering-herd on the queue scheduler; the second protects against rate-limited retries. They serve different purposes but the naming + location asymmetry hides the relationship. **Action:** Co-locate constants OR cross-reference in jsdoc.

### 9. `recordFailoverEvent` fires for stall recovery but not for Phase 1 retry

A stall-recovery requeue records `failover_events` row (RB-029); a Phase 1 retry of the same task does NOT. Operators querying failover events miss a major class of provider-switch behavior. **Action:** Have `handleRetryLogic` record a failover event when retrying with provider switch (it doesn't currently switch — only retries same-provider — but the event would still be useful for retry analytics).

### 10. ✅ ~~Retry-After header parsed but not always honored~~ RESOLVED 2026-05-07

`handleRetryLogic` now uses `Math.max(baseDelaySec, retryAfterSec) * 1000` for the `setTimeout` delay. The exponential schedule is preserved for later attempts where it exceeds the server's hint (e.g. retry_count=4 with hint=2s still sleeps 8s). When the hint exceeds the base delay, an info-level log line records the inflation: `retry delay raised by Retry-After hint: <base>s → <hint>s server-suggested`. Invalid hints (negative, zero, NaN, undefined) fall through cleanly — `Math.max(base, 0) === base`.

4 unit tests in `tests/retry-framework.test.js` (`Retry-After hint` describe block):
1. Hint 120s overrides 1s exponential base
2. Hint 2s ignored when 8s base is higher
3. No `retryAfterSeconds` field → falls back to base unchanged
4. Negative hint treated as zero

`delay_used` recorded in `recordRetryAttempt` still reflects the calculator's value (base, not max) — that's a UX detail for retry analytics and the existing contract.

### 11. ✅ ~~`verify-stall-recovery.js` has its own attempt counter and threshold~~ RESOLVED 2026-05-07

`docs/factory.md` now carries a `## Verify-Stall Recovery (peer subsystem)` section above the auto-recovery decision actions table. It explicitly contrasts the two layers (this doc owns execution-layer; factory.md owns factory-loop verify-stall) with a side-by-side table covering owner / trigger / threshold / counter / docs link. Closes the "next person looking for stall recovery accidentally adds a third layer" risk.

### 12. ✅ ~~`unknown_error_retryable` opt-in is silent~~ RESOLVED 2026-05-07

Two visibility hooks added to `fallback-retry.js`:
1. `logUnknownErrorRetryableOptInState()` is called from `orphan-cleanup.startTimers()` at server boot. Logs `[ClassifyError] unknown_error_retryable opt-in is ENABLED` once when the opt-in is set; silent when default-OFF.
2. `_maybeLogUnknownErrorOptInTriggered()` fires from `classifyError` when the long-unknown path is hit AND opt-in is on. Rate-limited to one log per 5 minutes via `_unknownRetryOptInLastLogAt` so a flapping task can't spam.

Operators flipping the opt-in for one project then forgetting it can now correlate "all unknown errors retrying forever" with the config flag in `torque.log` instead of grep'ing the DB.

---

## Recently shipped fixes touching this surface

These memory-resident fixes are why this audit exists. Each one was a single-shape bug in a 4-subsystem architecture that nobody had a unified picture of:

- `8651798b` (2026-05-05) — codex banner regex misclassified blank lines as banner-only, freezing `lastOutputAt` for every codex task → false stalls.
- `82388112` (2026-05-06) — `stopTaskForRestart` defined but missing from module.exports → `tryStallRecovery` crashed with TypeError on every periodic check.
- `3b39d45a` (2026-05-06) — `reAdoptDetachedSubprocess` set `lastOutputAt = Date.now()` on restart → stall detection silent for hours after re-adoption.
- `1cdbbb59` (2026-05-06) — `getTaskProgress` reported "bytes since re-adoption" not disk total; `max_task_lifetime_seconds` cap added.
- `2026-05-06` — retry-framework status check changed from deny-list (`!== 'cancelled'`) to allow-list (`=== 'retry_scheduled'`) after callback resurrected terminal-status tasks.
- `1168c9f9` (2026-05-06) — orphan-cleanup zombie sweep now skips `cancel_reason='server_restart'` rows so abandon-detached PIDs aren't killed.
- `9a8e5f49` (recent) — stall CPU baseline reset on cumulative regression (PID reuse) — pinned in `tests/stall-detection.test.js`.

Future fixes in this surface should land here in this section so the next audit doesn't have to reconstruct the timeline from `git log`.
