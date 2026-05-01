# Software Factory Phase 6: Factory Loop Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the SENSE→PRIORITIZE→PLAN→EXECUTE→VERIFY→LEARN cycle into a continuous per-project loop that respects trust level approval gates and runs on configurable cadence.

**Architecture:** A factory loop controller (`server/factory/loop-controller.js`) manages the state machine for each project's factory cycle. It reads health (sense), triggers the architect (prioritize), decomposes work (plan), submits to TORQUE (execute), runs guardrail checks (verify), and records outcomes (learn). Trust level determines which transitions pause for human approval. The loop runs on a configurable interval per project via TORQUE's scheduling system.

**Tech Stack:** better-sqlite3 (existing), vitest (existing), TORQUE scheduling (existing)

---

## File Structure

```
server/factory/loop-controller.js          # Factory loop state machine per project
server/factory/loop-states.js              # State definitions and transition rules
server/db/factory-health.js                # Modify: add loop state tracking
server/handlers/factory-handlers.js        # Modify: add loop control handlers
server/tool-defs/factory-defs.js           # Modify: add loop tools
server/api-server.core.js                  # Modify: add REST routes
dashboard/src/views/Factory.jsx            # Modify: add loop status + Batch Timeline
dashboard/src/api.js                       # Modify: add loop API methods
server/tests/factory-loop.test.js          # Tests
```

### Task 1: Loop State Definitions

Create `server/factory/loop-states.js`. Define the 6 states (SENSE, PRIORITIZE, PLAN, EXECUTE, VERIFY, LEARN) with transition rules per trust level. For each trust level, specify which transitions are automatic vs. require human approval (pause). Export state machine definition and `getNextState(currentState, trustLevel, approvalStatus)`.

### Task 2: Loop Controller

Create `server/factory/loop-controller.js`. The controller:
- `startLoop(project_id)` — begins a factory cycle from SENSE
- `advanceLoop(project_id)` — moves to the next state (checks trust gates)
- `approveGate(project_id, stage)` — human approves a paused gate
- `getLoopState(project_id)` — returns current state, pending approvals, last action

Each state dispatches to existing subsystems: SENSE→scan_project_health, PRIORITIZE→runArchitectCycle, PLAN→create work items, EXECUTE→submit TORQUE workflow, VERIFY→runPostBatchChecks, LEARN→record feedback.

### Task 3: Loop State Tracking in DB

Add loop state columns to factory_projects via migration v17: `loop_state TEXT`, `loop_batch_id TEXT`, `loop_last_action_at TEXT`, `loop_paused_at_stage TEXT`. Or use config_json for flexibility.

### Task 4: MCP Tools + Handlers + Wiring

4 tools: `start_factory_loop` (begin cycle), `advance_factory_loop` (continue after approval), `approve_factory_gate` (approve a paused stage), `factory_loop_status` (current state). Handlers, tier wiring, annotations, REST routes.

### Task 5: Dashboard Loop Status

Add loop state indicator to project cards (which stage, paused/running/idle). Add Batch Timeline view showing current cycle progress through the 6 stages.

### Task 6: Tests

Test state machine transitions per trust level, approval gates, stage dispatch, loop advancement.
