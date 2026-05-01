# Software Factory Phase 8: Observability + Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add decision logging infrastructure, audit trail, webhook/digest notifications, and the remaining dashboard views that make the factory a true glass box.

**Architecture:** A decision logger (`server/factory/decision-log.js`) records every factory decision with structured metadata. A notification dispatcher (`server/factory/notifications.js`) sends events to configured channels (dashboard SSE, webhooks, digest). Dashboard gets the Audit Trail view and enhanced Factory Overview.

**Tech Stack:** better-sqlite3 (existing), vitest (existing), SSE (existing TORQUE transport), React (dashboard)

---

## File Structure

```
server/db/migrations.js                    # Modify: migration v19 for factory_decisions
server/db/factory-decisions.js             # Decision record storage
server/factory/decision-log.js             # Structured decision recording
server/factory/notifications.js            # Notification dispatch to channels
server/handlers/factory-handlers.js        # Modify: add observability handlers
server/tool-defs/factory-defs.js           # Modify: add observability tools
server/api-server.core.js                  # Modify: add REST routes
dashboard/src/views/Factory.jsx            # Modify: add Audit Trail + enhanced overview
dashboard/src/api.js                       # Modify: add observability API methods
server/tests/factory-observability.test.js # Tests
```

### Task 1: Migration v19 + Decision Storage

`factory_decisions` table: id, project_id, stage (sense|prioritize|plan|execute|verify|ship), actor (health_model|architect|planner|executor|verifier|human), action TEXT, reasoning TEXT, inputs_json, outcome_json, confidence REAL, batch_id, created_at. Indexes on project_id+created_at and stage. DB module with recordDecision, listDecisions (filterable by stage/actor/timerange), getDecisionContext.

### Task 2: Decision Logger

Create `server/factory/decision-log.js`. Wraps the DB module with a simple API:
- `logDecision({ project_id, stage, actor, action, reasoning, inputs, outcome, confidence, batch_id })`
- `getAuditTrail(project_id, { since, stage, actor, limit })` — filtered query
- Wire into existing factory subsystems: health model logs SENSE decisions, architect logs PRIORITIZE, etc.

### Task 3: Notification Dispatcher

Create `server/factory/notifications.js`:
- `notify({ project_id, event_type, data })` — dispatches to all configured channels
- Channel: dashboard SSE (use existing TORQUE eventBus)
- Channel: webhook (POST to configured URL with event payload)
- Channel: digest (accumulate events, flush on schedule — uses existing scheduling system)
- Configuration stored in project policy (from Phase 4)

### Task 4: MCP Tools + Handlers + Wiring

3 tools: `decision_log` (query audit trail), `factory_notifications` (list/configure notification channels), `factory_digest` (generate activity summary). Handlers, REST routes, tier wiring.

### Task 5: Dashboard — Audit Trail + Enhanced Overview

Add Audit Trail section to Factory.jsx: searchable, filterable table of all decisions with stage badges, actor badges, reasoning expandable, timestamp. Enhance the Factory Overview (project cards) with last-action indicator and notification badges.

### Task 6: Tests

Test decision recording, audit trail queries, notification dispatch to SSE/webhook, digest generation, handler integration.
