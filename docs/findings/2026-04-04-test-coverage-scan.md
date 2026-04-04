# Test Coverage Scan - 2026-04-04

**Variant:** test-coverage
**Scope:** server/ - cross-reference source files vs test files
**Scanner:** Claude Opus 4.6 (1M context)

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Source files scanned | 326 (focus areas) |
| Files with tests | 299 (91.7%) |
| Files without tests | 27 (8.3%) |
| Total source lines | 167,272 |
| Total test lines | 314,847 |
| Test-to-source ratio | 1.88x |
| Total test files | 688 (server/tests/) + 30 (plugin-local) |
| Total test cases (it blocks) | 17,163 |
| Total assertions (expect calls) | 37,481 |

**Overall assessment: STRONG.** 91.7% of source files have at least one corresponding test. The test-to-source ratio of 1.88x indicates thorough testing discipline. However, several critical execution-path modules remain untested.

---

## Untested Source Files

### CRITICAL (1 file, 914 lines)

| Status | File | Lines | Description |
|--------|------|-------|-------------|
| UNTESTED | `server/execution/task-startup.js` | 914 | **Task startup pipeline** - orchestrates provider routing, process spawning, and task execution initiation. Every task flows through this module. Failure here could silently break all task execution. |

**Recommendation:** Highest priority. This module has DI via `init()` making it testable with mocks. Test cases needed: provider routing dispatch, VRAM gate checks, queue timeout handling, process spawn error paths.

### HIGH (3 files, 2,040 lines)

| Status | File | Lines | Description |
|--------|------|-------|-------------|
| UNTESTED | `server/db/cron-scheduling.js` | 811 | Cron expression parsing, validation, next-run calculation, schedule overlap detection, and schedule CRUD. Critical for `/torque-config` scheduling features. |
| UNTESTED | `server/mcp/tool-mapping.js` | 641 | Translates v1 namespaced tool names to internal tool calls, validates argument semantics. All MCP tool dispatch goes through this module. |
| UNTESTED | `server/providers/ollama-agentic.js` | 588 | Adapter-agnostic agentic execution loop for all Ollama tool-calling tasks. Handles tool call parsing, iteration limits, stuck-loop detection. |

**Recommendation:** These are core pipeline modules. `cron-scheduling.js` has pure functions ideal for unit testing. `tool-mapping.js` is pure data translation. `ollama-agentic.js` handles the agentic loop - critical for all local task execution.

### MEDIUM (9 files, 3,730 lines)

| Status | File | Lines | Description |
|--------|------|-------|-------------|
| UNTESTED | `server/db/resource-health.js` | 599 | Health checks, resource metrics, memory pressure monitoring, slow query detection |
| UNTESTED | `server/db/approval-workflows.js` | 536 | Approval workflow CRUD and state management |
| UNTESTED | `server/db/host-capacity.js` | 487 | Host capacity tracking, VRAM gating |
| UNTESTED | `server/api/routes-passthrough.js` | 468 | REST API passthrough route definitions |
| UNTESTED | `server/db/ollama-health.js` | 464 | Ollama host health tracking DB layer |
| UNTESTED | `server/db/pipeline-crud.js` | 405 | Pipeline CRUD operations |
| UNTESTED | `server/execution/file-context-builder.js` | 298 | File context building for context-stuffed tasks |
| UNTESTED | `server/handlers/auto-commit-batch.js` | 289 | Auto-commit batch handler |
| UNTESTED | `server/policy-engine/task-execution-hooks.js` | 184 | Mid-execution policy hooks |

### LOW (14 files, 1,543 lines)

| Status | File | Lines | Description |
|--------|------|-------|-------------|
| UNTESTED | `server/providers/adapters/google-chat.js` | 279 | Google AI chat adapter |
| UNTESTED | `server/providers/adapters/openai-chat.js` | 258 | OpenAI-compatible chat adapter |
| UNTESTED | `server/db/ci-cache.js` | 204 | CI cache DB layer |
| UNTESTED | `server/providers/adapters/ollama-chat.js` | 200 | Ollama chat adapter |
| UNTESTED | `server/utils/proxy-agent.js` | 157 | HTTP proxy agent utility |
| UNTESTED | `server/execution/plan-project-resolver.js` | 135 | Plan project resolution |
| UNTESTED | `server/utils/sensitive-keys.js` | 81 | Sensitive key detection |
| UNTESTED | `server/mcp/catalog-v1.js` | 56 | V1 tool catalog definition |
| UNTESTED | `server/execution/effective-concurrency.js` | 54 | Effective concurrency calculation |
| UNTESTED | `server/mcp/schema-hash.js` | 37 | Schema hashing utility |
| UNTESTED | `server/utils/normalize-metadata.js` | 30 | Metadata normalization utility |
| UNTESTED | `server/check_retry.js` | 22 | Retry check utility |
| UNTESTED | `server/timer-registry.js` | 16 | Timer registry |
| UNTESTED | `server/mcp/tool-list-modes.js` | 14 | Tool list mode constants |

---

## Plugin Test Coverage

### auth plugin (5 of 10 source files directly tested)

| Status | File | Lines |
|--------|------|-------|
| TESTED | config-injector.js | 110 |
| TESTED | key-manager.js | 180 |
| TESTED | middleware.js | 102 |
| **UNTESTED** | **index.js** | **311** |
| **UNTESTED** | **rate-limiter.js** | **77** |
| **UNTESTED** | **resolvers.js** | **76** |
| **UNTESTED** | **role-guard.js** | **31** |
| **UNTESTED** | **session-manager.js** | **152** |
| **UNTESTED** | **sse-auth.js** | **107** |
| **UNTESTED** | **user-manager.js** | **221** |

**Note:** The auth plugin is enterprise-only and opt-in. However, `session-manager.js` (152 lines) and `user-manager.js` (221 lines) contain security-sensitive code (password hashing, session tokens) that should have dedicated tests. The `user-session.test.js` may partially cover `session-manager.js` and `user-manager.js` but not directly.

### version-control plugin (8 of 10 source files tested) - GOOD

All core modules tested: commit-generator, config-resolver, policy-engine, pr-preparer, release-manager, worktree-manager, changelog-generator. Only `handlers.js` and `tool-defs.js` lack dedicated tests (covered implicitly by plugin.test.js).

### remote-agents plugin (8 of 8 source files tested, 15 test files) - EXCELLENT

Comprehensive test suite including security tests, TLS tests, routing tests, integration tests, and v2 handler tests.

### snapscope plugin (15 of 18 handler files tested, 43+ test files) - GOOD

Three untested handler files:
- `handlers/cli.js` (661 lines) - CLI interaction handlers, notable gap
- `handlers/verify.js` (48 lines) - small
- `handlers/watch.js` (44 lines) - small

---

## Test Quality Sampling

### High-Quality Examples

**`queue-scheduler.test.js`** (2,086 lines, 90 test cases, 153 assertions)
- Comprehensive mocking of DI dependencies
- Tests VRAM-aware scheduling, provider routing fallback, queue timeout handling
- Edge cases: empty queue, all hosts down, model not available
- Rating: EXCELLENT

**`circuit-breaker.test.js`** (241 lines, 35 test cases, 29 assertions)
- Tests all state transitions: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
- Uses fake timers for recovery timeout testing
- Tests exponential backoff, probe allowance
- Rating: EXCELLENT

**`completion-pipeline.test.js`** (566 lines, 48 test cases, 41 assertions)
- Thorough mock setup via DI
- Tests terminal hooks, model outcome recording, post-completion handling
- Rating: GOOD

**`task-core-handlers.test.js`** (110+ test cases)
- Extensive handler coverage
- Rating: GOOD

### Thin Tests (potential quality concerns)

| File | Tests | Lines | Concern |
|------|-------|-------|---------|
| `slot-pull-scheduler-smoke.test.js` | 1 | 15 | Smoke-only, no edge cases |
| `debug-run-workflow.test.js` | 1 | 21 | Minimal coverage |
| `script-smoke.test.js` | 1 | 21 | Smoke-only |
| `event-bus.test.js` | 3 | 50 | Thin for a core module (event-bus.js is critical infrastructure) |
| `db-stats-cache.test.js` | 1 | 58 | Single assertion |
| `evidence-risk-integration.test.js` | 1 | 106 | Single integration scenario |

**`event-bus.test.js`** is notable: the event bus is foundational infrastructure used by the entire notification system, yet has only 3 test cases and 4 assertions. This should be expanded to cover: multiple subscribers, error in listener, wildcard events, unsubscribe behavior.

---

## Coverage by Directory

| Directory | Source Files | Tested | Untested | Coverage |
|-----------|-------------|--------|----------|----------|
| server/ (root) | 29 | 27 | 2 | 93.1% |
| server/api/ | 22 | 21 | 1 | 95.5% |
| server/handlers/ | 72 | 71 | 1 | 98.6% |
| server/db/ | 67 | 57 | 10 | 85.1% |
| server/execution/ | 29 | 23 | 6 | 79.3% |
| server/mcp/ | 12 | 8 | 4 | 66.7% |
| server/utils/ | 31 | 29 | 2 | 93.5% |
| server/providers/ | 34 | 30 | 4 | 88.2% |
| server/policy-engine/ | 18 | 17 | 1 | 94.4% |
| server/audit/ | 7 | 7 | 0 | 100% |
| server/hooks/ | 3 | 3 | 0 | 100% |
| server/contracts/ | 2 | 2 | 0 | 100% |

**Weakest areas:** `server/mcp/` (66.7%) and `server/execution/` (79.3%) have the lowest coverage rates. These are both critical code paths.

---

## Actionable Findings

### P0 - Write Immediately

| # | Finding | File | Lines | Rationale |
|---|---------|------|-------|-----------|
| 1 | No test for task startup pipeline | `server/execution/task-startup.js` | 914 | Every task execution flows through this module. A bug here breaks all task processing silently. DI pattern makes it testable. |
| 2 | No test for agentic execution loop | `server/providers/ollama-agentic.js` | 588 | All local agentic tasks depend on this loop. Tool call parsing, iteration limits, abort conditions all untested. |

### P1 - Write Soon

| # | Finding | File | Lines | Rationale |
|---|---------|------|-------|-----------|
| 3 | No test for cron scheduling | `server/db/cron-scheduling.js` | 811 | Pure functions, easy to test. Cron parsing bugs could schedule tasks at wrong times. |
| 4 | No test for tool mapping | `server/mcp/tool-mapping.js` | 641 | All MCP tool dispatch goes through this. Argument validation bugs silently drop/mangle tool calls. |
| 5 | Thin test for event bus | `server/tests/event-bus.test.js` | 50 | Core infrastructure, 3 tests is insufficient. Expand coverage. |
| 6 | No test for CLI handlers | `server/plugins/snapscope/handlers/cli.js` | 661 | Largest untested handler in snapscope. |
| 7 | Auth session-manager untested | `server/plugins/auth/session-manager.js` | 152 | Security-sensitive session token management. |
| 8 | Auth user-manager untested | `server/plugins/auth/user-manager.js` | 221 | Security-sensitive password hashing and user CRUD. |

### P2 - Backlog

| # | Finding | File | Lines | Rationale |
|---|---------|------|-------|-----------|
| 9 | No test for resource health | `server/db/resource-health.js` | 599 | Health checks and memory pressure monitoring. |
| 10 | No test for approval workflows | `server/db/approval-workflows.js` | 536 | Approval state machine CRUD. |
| 11 | No test for host capacity | `server/db/host-capacity.js` | 487 | VRAM gating calculations. |
| 12 | No test for file context builder | `server/execution/file-context-builder.js` | 298 | Context stuffing file resolution. |
| 13 | No test for auto-commit batch | `server/handlers/auto-commit-batch.js` | 289 | Batch commit orchestration. |
| 14 | No test for chat adapters | `server/providers/adapters/*.js` | 737 | Three chat adapters (google, openai, ollama) untested. |
| 15 | No test for task-execution-hooks | `server/policy-engine/task-execution-hooks.js` | 184 | Mid-execution policy enforcement. |

### DEFERRED

Small utility files under 100 lines (`sensitive-keys.js`, `catalog-v1.js`, `effective-concurrency.js`, `schema-hash.js`, `normalize-metadata.js`, `check_retry.js`, `timer-registry.js`, `tool-list-modes.js`) - low risk, can be tested opportunistically.

---

## Positive Observations

1. **Test discipline is strong.** 688 test files for ~326 source files, with a 1.88x test-to-source ratio.
2. **Critical paths are well-covered.** Queue scheduler (90 tests), completion pipeline (48 tests), fallback retry (90 tests), task core handlers (110 tests) all have thorough suites.
3. **Plugin testing is thorough.** remote-agents has 15 test files, version-control has 8, snapscope has 43+ (across server/tests/).
4. **Security testing exists.** Dedicated P0 tests for SQL injection, path traversal, CORS/CSRF, budget atomicity.
5. **Integration tests exist** alongside unit tests for complex subsystems (e.g., context-stuffing has both unit + integration tests).
6. **DI patterns enable testability.** Most modules use `init()` or `setDb()` injection, making mocking straightforward.

---

*Scan completed 2026-04-04. Findings should be triaged and prioritized for the next development cycle.*
