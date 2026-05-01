# Infrastructure Circuit Breaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Detect systemic infrastructure failures (provider down, host unreachable) across multiple tasks and auto-disable the affected provider/host instead of failing tasks one by one.

**Architecture:** A CircuitBreaker class per provider tracks consecutive failures with classification. After N consecutive failures of the same type (default 3), the circuit trips: the provider is temporarily disabled and a notification is emitted. After a recovery timeout (default 60s), a single probe task is allowed through (half-open). If the probe succeeds, the circuit closes. If it fails, the circuit re-trips with doubled timeout.

**Tech Stack:** In-memory state (Map), existing health-check system, event bus for notifications

**Inspired by:** agent-orchestrator (track-level circuit breaker), Gobby (MCP connection circuit breaker)

---

### Task 1: CircuitBreaker class

**Files:**
- Create: `server/execution/circuit-breaker.js`
- Test: `server/tests/circuit-breaker.test.js`

States: CLOSED (normal), OPEN (tripped), HALF_OPEN (probing).

Methods:
- `recordSuccess(provider)` -- reset failure count, close circuit
- `recordFailure(provider, category)` -- increment consecutive count; trip if >= threshold
- `isOpen(provider)` -- returns true if tripped and recovery timeout not elapsed
- `isHalfOpen(provider)` -- returns true if recovery timeout elapsed but not yet probed
- `allowRequest(provider)` -- returns true if CLOSED or HALF_OPEN (allows one probe)
- `getState(provider)` -- returns { state, consecutiveFailures, lastFailureCategory, trippedAt, recoveryTimeoutMs }
- `getAllStates()` -- all providers with non-CLOSED state

Failure categories (pattern-matched from error output):
- `connectivity` -- ECONNREFUSED, ETIMEDOUT, DNS resolution
- `rate_limit` -- 429, too many requests, overloaded
- `auth` -- 401, 403, unauthorized
- `resource` -- out of memory, disk full, GPU OOM
- `unknown` -- default

Config: threshold (default 3), base recovery timeout (default 60s), max recovery timeout (default 600s), backoff multiplier (default 2).

- [ ] Step 1: Write failing tests for each state transition
- [ ] Step 2: Implement CircuitBreaker class
- [ ] Step 3: Write failing tests for failure classification
- [ ] Step 4: Implement classifyFailure(errorOutput) using regex patterns
- [ ] Step 5: Run all tests
- [ ] Step 6: Commit

---

### Task 2: Wire into task execution and queue processing

**Files:**
- Modify: `server/execution/provider-router.js` -- check circuit before dispatching
- Modify: `server/handlers/task/pipeline.js` -- record success/failure after completion
- Test: `server/tests/circuit-breaker.test.js` (integration)

- [ ] Step 1: In provider selection, call `circuitBreaker.allowRequest(provider)` -- skip providers with open circuits
- [ ] Step 2: In task completion, call `recordSuccess` or `recordFailure` based on exit code and error output
- [ ] Step 3: When circuit trips, emit event via event bus for notification system
- [ ] Step 4: Write integration test: 3 consecutive connectivity failures trip circuit, subsequent tasks skip that provider
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 3: Half-open probe and auto-recovery

**Files:**
- Modify: `server/execution/circuit-breaker.js`
- Test: `server/tests/circuit-breaker.test.js`

- [ ] Step 1: Write test -- after recovery timeout, one request is allowed (half-open)
- [ ] Step 2: Write test -- probe success closes circuit
- [ ] Step 3: Write test -- probe failure re-trips with doubled timeout
- [ ] Step 4: Implement half-open logic
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 4: MCP tool + notification

**Files:**
- Modify: MCP tool definitions -- add `get_circuit_breaker_status` tool
- Modify: `server/tool-annotations.js`
- Modify: notification handlers -- emit `circuit_tripped` and `circuit_recovered` events

- [ ] Step 1: Add MCP tool
- [ ] Step 2: Add notification events
- [ ] Step 3: Run tests
- [ ] Step 4: Commit
