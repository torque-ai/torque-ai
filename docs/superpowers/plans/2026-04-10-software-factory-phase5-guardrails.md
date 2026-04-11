# Software Factory Phase 5: Guardrails Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the seven guardrail categories that enforce safety regardless of trust level — scope limits, quality gates, resource waste detection, silent failure detection, security scanning, conflict prevention, and loss-of-control safeguards.

**Architecture:** A guardrails module (`server/factory/guardrails.js`) implements check functions for each category. A guardrail runner (`server/factory/guardrail-runner.js`) executes all applicable checks for a given factory event (pre-batch, post-batch, pre-ship). Results are stored in a new `factory_guardrail_events` table and surfaced via MCP tools and dashboard.

**Tech Stack:** better-sqlite3 (existing), vitest (existing), React (dashboard)

---

## File Structure

```
server/db/migrations.js                    # Modify: migration v16 for factory_guardrail_events
server/db/factory-guardrails.js            # Guardrail event storage
server/factory/guardrails.js               # Check functions for all 7 categories
server/factory/guardrail-runner.js         # Orchestrates checks for factory events
server/handlers/factory-handlers.js        # Modify: add guardrail handlers
server/tool-defs/factory-defs.js           # Modify: add guardrail tools
server/api-server.core.js                  # Modify: add REST routes
dashboard/src/views/Factory.jsx            # Modify: add guardrail monitor section
dashboard/src/api.js                       # Modify: add guardrail API methods
server/tests/factory-guardrails.test.js    # Tests
```

### Task 1: Migration v16 + Guardrail Event Storage

Migration v16: `factory_guardrail_events` table (id, project_id, category, check_name, status [pass/warn/fail], details_json, batch_id, created_at). Index on project_id+created_at. DB module `server/db/factory-guardrails.js` with recordEvent, getEvents, getLatestByCategory, getGuardrailStatus (green/yellow/red per category).

### Task 2: Guardrail Check Functions

Create `server/factory/guardrails.js` with check functions per category:
- Scope: checkScopeBudget, checkBlastRadius, checkDecompositionDepth
- Quality: checkHealthDelta, checkTestRegression, checkProportionality
- Resource: checkBudgetCeiling, checkIdleCycles, checkRetryLimits
- Silent Failure: checkWorkaroundPatterns (scan for TODO/HACK/empty catch introduced by batch)
- Security: checkSecretFence (pattern match .env, *.key, credentials.*)
- Conflict: checkFileLocks (compare write sets between concurrent batches)
- Control: checkRateLimit (max batches per hour)

Each returns `{ status: 'pass'|'warn'|'fail', details: {} }`.

### Task 3: Guardrail Runner

Create `server/factory/guardrail-runner.js`. Exports:
- `runPreBatchChecks(project_id, batch_plan)` — runs scope, conflict, rate limit checks
- `runPostBatchChecks(project_id, batch_id, files_changed)` — runs quality, security, workaround, proportionality checks
- `runPreShipChecks(project_id, batch_id)` — runs test regression, health delta, secret fence
- Each records events via factory-guardrails DB module and returns summary

### Task 4: MCP Tools + Handlers + Wiring

3 tools: `guardrail_status` (get green/yellow/red per category), `run_guardrail_check` (manually trigger checks), `guardrail_events` (get event history). Handlers, tier wiring, annotations, REST routes.

### Task 5: Dashboard Guardrail Monitor

Add guardrail status section to Factory.jsx: traffic-light display per category (green/yellow/red), recent events list, expandable details.

### Task 6: Tests

Test all check functions with mock data, runner orchestration, event storage, handler integration.
