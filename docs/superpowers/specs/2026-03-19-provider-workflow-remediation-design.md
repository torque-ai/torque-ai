# TORQUE Provider/Workflow Remediation Plan (Track C)

**Date:** 2026-03-19
**Scope:** 153 provider and workflow issues from Bug Hunt Round 2
**Approach:** Hybrid — critical/high manual fixes first, then medium batched by pattern, low to tech debt

---

## Phase 1 — Critical + High (20 issues, manual with review)

### Provider System

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | Host slot leak on task requeue | `execute-ollama.js:313` | Decrement host slot before requeue |
| 2 | Inverted truncation safeguard formula | `execute-hashline.js:910` | Fix math: `newLines < origLines * (threshold/100)` |
| 3 | Hashline fallback to disabled codex — tasks stuck | `fallback-retry.js:670` | Check `codex_enabled` before fallback |
| 4 | spawnSync blocks event loop | `v2-cli-providers.js:157` | Replace with async spawn + promise |
| 5 | Codex API bypasses git safety | `v2-cli-providers.js:270` | Add worktree isolation |
| 6 | Agentic cancellation broken (apiAbortControllers null) | `execution.js:579` | Wire `_apiAbortControllers` properly |
| 7 | Anthropic missing from agentic host map | `execution.js:44` | Add to `PROVIDER_HOST_MAP` |
| 8 | Provider error classified as retryable | `execution.js:987` | Exclude auth failures |
| 9 | Cost not tracked for failed API tasks | `execute-api.js:431` | Record usage on failure |
| 10 | GPU oversubscription — independent per-provider limits | `queue-scheduler.js:764` | Unified GPU capacity check |
| 11 | `max_concurrent: 0` means unlimited | `queue-scheduler.js:363` | Treat 0 as disabled |
| 12 | Slot-pull missing model for VRAM check | `v2-local-providers.js:365` | Pass model name |

### Workflow System

| # | Issue | File | Fix |
|---|-------|------|-----|
| 13 | Unbounded skip recursion — dead depth guard | `workflow-runtime.js:930` | Increment `_skipDepth` in recursive call |
| 14 | Retry sets task to `pending` — premature scheduling | `retry-framework.js:68` | Use guard status or delay |
| 15 | `handleSkipTask` duplicates eval, skips completion | `workflow/advanced.js:444` | Delegate to shared functions |
| 16 | Tokenizer splits ANDROID as AND+ROID | `workflow-engine.js:600` | Word boundary check |
| 17 | `finalizeTask` partial completion | `task-finalizer.js:417` | try/finally for post-completion |
| 18 | `handlePostCompletion` chains without try/catch | `completion-pipeline.js:163` | Individual try/catch per operation |
| 19 | Stall recovery races with exit handler | `fallback-retry.js:355` | Guard with `markTaskCleanedUp` |
| 20 | `unblockTask` stuck in pending | `workflow-runtime.js:883` | Single atomic transition |

**Gate:** All critical issues verified. No host slot leaks. No unbounded recursion.

---

## Phase 2 — Medium Provider Fixes (~30 issues, batched)

### Batch P1: Timeout normalization (5 issues)
Normalize default timeouts: hashline 10min → 30min, align agentic/non-agentic.
Files: `execute-hashline.js`, `execution.js`, `v2-local-providers.js`

### Batch P2: Error classification (5 issues)
Fix TypeError as non-retryable (network errors ARE retryable), status code substring matching, auth failure detection.
Files: `execution.js`, `fallback-retry.js`, `execute-api.js`

### Batch P3: Cost tracking accuracy (4 issues)
Fix groq flat-rate pricing, cerebras/google-ai zero-cost, CLI provider missing cost.
Files: `groq.js`, `cerebras.js`, `google-ai.js`, `v2-cli-providers.js`

### Batch P4: Model management (4 issues)
Fix hardcoded size order list, stale capability matrices, default model contradictions.
Files: `fallback-retry.js`, `adapter-registry.js`, `cerebras.js`, `execution.js`

### Batch P5: Cancel check interval leaks (4 issues)
Fix intervals not cleared on early return/fallback paths.
Files: `execute-hashline.js`, `execute-ollama.js`

### Batch P6: Context + provider parity (8 issues)
Fix context budget docs, file pattern gaps, missing signal pre-checks, cloud provider guidance.
Files: `execution.js`, `prompts.js`, `ollama-cloud.js`

**Gate:** All medium provider issues resolved. Test suite green on Omen.

---

## Phase 3 — Medium Workflow Fixes (~25 issues, batched)

### Batch W1: Condition evaluation (4 issues)
Fix `.contains()` parser for embedded `)`, number tokenizer (decimals/negatives), word boundaries for AND/OR/NOT.
Files: `workflow-engine.js`

### Batch W2: Workflow state machine (5 issues)
Fix workflow resurrection on task add, partial DAG on creation failure, pause race, fork without deps.
Files: `workflow/index.js`, `workflow/advanced.js`

### Batch W3: Output passing (3 issues)
Fix template injection sanitization, truncation inconsistency (stdout tail vs stderr head).
Files: `workflow-runtime.js`, `workflow/await.js`

### Batch W4: Retry logic (5 issues)
Add jitter to backoff, fix marker counting on truncated output, fix infinite codex fallback loop, fix edit format auto-learning direction.
Files: `fallback-retry.js`, `retry-framework.js`

### Batch W5: Progress + completion (4 issues)
Fix all-cancelled→completed status, double completion detection, acknowledged set not cleared on retry, provider usage success flag.
Files: `workflow-engine.js`, `workflow-runtime.js`, `completion-pipeline.js`, `workflow/advanced.js`

### Batch W6: Conflict resolution + auto-commit (4 issues)
Surface unresolved conflicts to user, handle merge conflicts in auto-commit git add, fix non-atomic backup writes.
Files: `conflict-resolver.js`, `workflow/await.js`

**Gate:** All medium workflow issues resolved. Test suite green on Omen.

---

## Phase 4 — Low Severity (~78 items → tech debt registry)

Append to `docs/tech-debt-registry.md` under new sections for provider and workflow code smells.

---

## Estimated Effort

| Phase | Sessions | Risk |
|-------|----------|------|
| 1 — Critical + High | 3-4 | High (core execution paths) |
| 2 — Medium Provider | 2-3 | Medium (batched by pattern) |
| 3 — Medium Workflow | 2-3 | Medium (batched by pattern) |
| 4 — Tech Debt | 1 | None |
| **Total** | **~8-11** | |
