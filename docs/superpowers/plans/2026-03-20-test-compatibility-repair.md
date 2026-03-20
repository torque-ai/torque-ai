# Test Compatibility Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix ~498 server test failures across ~124 test files caused by architectural changes from the bug hunt remediation session.

**Architecture:** Tests need updating to match code changes — NOT code bugs. The production code is correct. Each test file needs individual diagnosis via SSH to Omen (`ssh kenten@192.168.1.183`).

**Tech Stack:** Node.js (CJS), Vitest, better-sqlite3

**Reference:** `server/.codex-context/test-fix-guide.md` lists all architectural changes.

---

## Root Causes (12 identified, ordered by impact)

### RC1: Event Bus Migration (~100+ tests affected)
`process.emit('torque:queue-changed')` → `eventBus.emitQueueChanged()`
`process.on('torque:shutdown')` → `eventBus.onShutdown()`

**Files likely affected:** Any test that mocks or asserts `process.emit('torque:...')` or `process.on('torque:...')`:
- close-handler-helpers, starttask-helpers, queue-scheduler, dashboard-server
- execute-api, execute-cli, model-registry, pid-heartbeat, restart-server-tool
- All workflow handler tests

**Fix pattern:** Import `event-bus.js` and use its methods. In test mocks, spy on eventBus methods instead of process.emit.

### RC2: Provider Router Extraction (~50+ tests affected)
`resolveProviderRouting`, `tryReserveHostSlotWithFallback`, `safeConfigInt` moved from task-manager.js to `execution/provider-router.js`. Functions are re-exported via task-manager but some tests import internals directly.

**Files likely affected:** bug-001-override-provider, provider-routing, smart-routing-integration, queue-helpers, starttask-helpers, slot-pull-integration

**Fix pattern:** Update imports or verify re-exports work.

### RC3: Cerebras Default Model + Cost Changes (~15 tests)
Default model changed to `qwen-3-235b-a22b-instruct-2507`. Cost tracking added where it was 0.

**Files:** cerebras-provider, provider-cerebras, cloud-providers-e2e

### RC4: Groq Pricing Changed (~5 tests)
Flat $0.27/1M → model-specific pricing.

**Files:** groq-provider, provider-groq

### RC5: Timeout Defaults Changed (~10 tests)
hashline-ollama 10min → 30min, various providers normalized.

**Files:** execute-hashline tests, api-server-core, v2-local-providers

### RC6: Shell Metachar Regex Narrowed (~5 tests)
`/[;|&`$(){}!<>]/` → `/[;|&`$]/`. Tests asserting rejection of `(){}!<>` need updating.

**Files:** agent-server-security (already fixed), remote-agent-server, remote-command-rest

### RC7: countTasksByStatus Replaces countTasks (~10 tests)
Two `countTasks` calls → one `countTasksByStatus` call. Mocks need updating.

**Files:** api-health-probes (already fixed), dashboard-server, v2-analytics-handlers

### RC8: Codex supportsAsync Changed (~3 tests)
`supportsAsync: false` → `true`. Tests asserting rejection of async need to assert success.

**Files:** adapter-registry (already fixed), provider-adapter-registry

### RC9: Shutdown Requires X-Requested-With (~5 tests)
POST /api/shutdown now requires `X-Requested-With: XMLHttpRequest` header.

**Files:** api-server (already fixed), remote-command-rest

### RC10: MCP Protocol Auth (~10 tests)
`mcp-protocol.js` rejects unauthenticated sessions. Tests need `authenticated: true`.

**Files:** mcp-sse, mcp-modules, mcp-index

### RC11: Backup Restore Signature Changed (~3 tests)
`restoreDatabase(path, confirm)` → `restoreDatabase(path, confirm, { force: true })`.

**Files:** backup-restore-safety (already fixed), db-backup-core, database

### RC12: isOptIn Semantics Changed (~5 tests)
Now only returns true for explicit '1'/'true'/'yes'/'on'.

**Files:** provider-routing-config, policy tests

---

## Failing Test Files (124 files)

### Batch 1 — Core Execution (~10 files, ~80 failures)
Heaviest impact from RC1 (event bus) and RC2 (provider router).
- `tests/close-handler-helpers.test.js` (~30 failures)
- `tests/starttask-helpers.test.js`
- `tests/queue-helpers.test.js`
- `tests/queue-scheduler.test.js`
- `tests/retry-framework.test.js`
- `tests/fallback-retry.test.js`
- `tests/slot-pull-integration.test.js`
- `tests/resource-gating.test.js`
- `tests/smart-diagnosis-stage.test.js`
- `tests/load-stress-concurrent.test.js`

### Batch 2 — Providers (~10 files, ~30 failures)
RC3 (cerebras), RC4 (groq), RC5 (timeouts), RC8 (codex async).
- `tests/cerebras-provider.test.js`
- `tests/provider-cerebras.test.js`
- `tests/provider-google-ai.test.js`
- `tests/provider-openrouter.test.js`
- `tests/groq-provider.test.js`
- `tests/cloud-providers-e2e.test.js`
- `tests/v2-cli-providers.test.js`
- `tests/v2-local-providers.test.js`
- `tests/provider-ollama-strategic.test.js`
- `tests/provider-adapter-registry.test.js`

### Batch 3 — Workflows (~10 files, ~50 failures)
RC1 (event bus) and workflow state machine changes.
- `tests/workflow-runtime.test.js`
- `tests/workflow-engine.test.js`
- `tests/workflow-advanced.test.js`
- `tests/workflow-advanced-handlers.test.js`
- `tests/workflow-await-handlers.test.js`
- `tests/workflow-handlers-core.test.js`
- `tests/workflow-handlers-analysis.test.js`
- `tests/handler-workflow-advanced.test.js`
- `tests/handler-workflow-await.test.js`
- `tests/handler-workflow-handlers.test.js`

### Batch 4 — Routing (~10 files, ~40 failures)
RC2 (provider router extraction) and routing changes.
- `tests/bug-001-override-provider.test.js`
- `tests/provider-routing.test.js`
- `tests/provider-routing-core.test.js`
- `tests/provider-routing-config.test.js`
- `tests/provider-override-runtime.test.js`
- `tests/smart-routing-integration.test.js`
- `tests/prefer-free-routing.test.js`
- `tests/integration-routing.test.js`
- `tests/integration-routing-handlers.test.js`
- `tests/exp1-codex-provider-routing-core.test.js`

### Batch 5 — MCP + Dashboard (~10 files, ~30 failures)
RC1 (event bus), RC10 (MCP auth).
- `tests/mcp-sse.test.js`
- `tests/mcp-index.test.js`
- `tests/mcp-modules.test.js`
- `tests/dashboard-server.test.js`
- `tests/dashboard-tasks-routes.test.js`
- `tests/dashboard-v2-convergence.test.js`
- `tests/rest-control-plane-parity.test.js`
- `tests/rest-passthrough-dispatch.test.js`
- `tests/restart-server-tool.test.js`
- `tests/model-registry.test.js`

### Batch 6 — V2 API Handlers (~10 files, ~30 failures)
RC1 (event bus), RC7 (countTasksByStatus).
- `tests/v2-dispatch.test.js`
- `tests/v2-task-handlers.test.js`
- `tests/v2-workflow-handlers.test.js`
- `tests/v2-analytics-handlers.test.js`
- `tests/v2-governance-plan-projects.test.js`
- `tests/v2-inference.test.js`
- `tests/v2-inference-handlers.test.js`
- `tests/v2-discovery.test.js`
- `tests/task-operations-handlers.test.js`
- `tests/adv-intelligence-handlers.test.js`

### Batch 7 — Remote + Hosts (~10 files, ~20 failures)
RC6 (metachar), RC9 (X-Requested-With).
- `tests/remote-agent-server.test.js`
- `tests/remote-command-rest.test.js`
- `tests/remote-test-integration.test.js`
- `tests/remote/agent-registry.test.js`
- `tests/remote/integration.test.js`
- `tests/remote/remote-routing.test.js`
- `tests/host-distribution.test.js`
- `tests/host-credentials.test.js`
- `tests/hosts-routes.test.js`
- `tests/p0-timing-attack.test.js`

### Batch 8 — Database + Validation (~10 files, ~20 failures)
RC7 (countTasksByStatus), RC11 (backup signature).
- `tests/database.test.js`
- `tests/db-backup-core.test.js`
- `tests/db-provider-routing-core.test.js`
- `tests/analytics-db.test.js`
- `tests/scheduling-automation.test.js`
- `tests/credential-crypto.test.js`
- `tests/reset-for-test.test.js`
- `tests/logger.test.js`
- `tests/output-safeguards.test.js`
- `tests/validation-output-safeguards.test.js`

### Batch 9 — Execution + E2E (~10 files, ~30 failures)
RC1 (event bus), RC2 (provider router).
- `tests/execute-api.test.js`
- `tests/execute-api-workflow-termination.test.js`
- `tests/execute-cli.test.js`
- `tests/codex-worktree-isolation.test.js`
- `tests/e2e-cli-providers.test.js`
- `tests/e2e-fallback-recovery.test.js`
- `tests/e2e-hashline-ollama.test.js`
- `tests/e2e-ollama-direct.test.js`
- `tests/hashline-lite.test.js`
- `tests/hashline-local-fallback.test.js`

### Batch 10 — Policy (~10 files, ~20 failures)
RC12 (isOptIn), RC1 (event bus).
- `tests/policy-adapter-release-gate.test.js`
- `tests/policy-adapters-verify-refactor.test.js`
- `tests/policy-architecture-integration.test.js`
- `tests/policy-phase5-integration.test.js`
- `tests/policy-refactor-debt-integration.test.js`
- `tests/policy-release-integration.test.js`
- `tests/policy-task-lifecycle.test.js`
- `tests/provider-registry.test.js`
- `tests/provider-crud.test.js`
- `tests/provider-handlers-tuning.test.js`

### Batch 11 — Patches + Streaming (~10 files, ~20 failures)
Mixed root causes.
- `tests/pid-heartbeat.test.js`
- `tests/p1-handler-timeout.test.js`
- `tests/p1-process-safety.test.js`
- `tests/p1-streaming-fixes.test.js`
- `tests/p2-provider-enum.test.js`
- `tests/p2-workflow-subscribe.test.js`
- `tests/p3-exponential-backoff.test.js`
- `tests/p3-silent-catches.test.js`
- `tests/p3-sse-session-cap.test.js`
- `tests/provider-commands.test.js`

### Batch 12 — Integration + Remaining (~15 files, ~30 failures)
Mixed root causes.
- `tests/local-first-fallback.test.js`
- `tests/free-tier-fallback-codex.test.js`
- `tests/await-workflow-yield.test.js`
- `tests/cross-workflow-priority.test.js`
- `tests/experiment-handlers.test.js`
- `tests/harness-improvements.test.js`
- `tests/integration-stall-recovery.test.js`
- `tests/load-stress-queue-cleanup.test.js`
- `tests/load-stress-stall.test.js`
- `tests/orchestrator-integration.test.js`
- `tests/project-dependency-resolution.test.js`
- `tests/strategic-brain.test.js`
- `tests/task-distribution-runtime-truth.test.js`
- `tests/tda-15-placement-contract.test.js`
- `tests/test-hardening.test.js`

---

## Execution Strategy

**For each batch:**
1. SSH to Omen: `ssh kenten@192.168.1.183`
2. Run the batch: `cd C:\Users\kenten\Projects\torque-public\server && npx vitest run tests/<file> --reporter=verbose`
3. Read the error for each failing test
4. Apply the fix from the appropriate root cause (RC1-RC12)
5. Verify the file passes
6. Commit

**Recommended approach:** Fix RC1 (event bus) first — it's the highest-impact root cause. Create a shared mock helper that wraps the event bus for tests, then propagate across all affected files.

**Verification:** After all batches, run full suite on Omen:
```bash
ssh kenten@192.168.1.183 "cmd /c \"cd C:\Users\kenten\Projects\torque-public\server && npx vitest run 2>&1\""
```

Target: < 50 failures (pre-existing from concurrent sessions).
